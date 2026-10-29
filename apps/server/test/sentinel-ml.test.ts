// QORGAN Sentinel на сервере: параллельная оценка ML в транзакции приёма, API объяснений, работа без модели.
// Полный путь: симулятор → POST /api/telemetry → риск T2 → ML → предупреждения → снимок.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Полные прогоны паводка (до 2 × 200 тиков) — дольше стандартных 5 с на медленной машине.
vi.setConfig({ testTimeout: 60_000 });
import { loadMlRuntime, type MlRuntime } from '../src/ml/service';
import { buildSnapshot } from '../src/realtime/snapshot';
import { simApp } from './sim-helpers';

const MODEL = resolve(import.meta.dirname, '../../../ml/models/sentinel-model.json');
const START = '2026-04-10T00:00:00.000Z';
const ml = loadMlRuntime(MODEL);
const tmp = mkdtempSync(join(tmpdir(), 'qorgan-ml-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Row = Record<string, unknown>;

async function rapid(runtime: MlRuntime | undefined, ticks = 80) {
  const s = await simApp(undefined, undefined, runtime ? { ml: runtime } : {});
  const { body } = await s.post('/api/simulation/start', { scenarioId: 'RAPID_FLOOD', seed: 42, virtualStart: START });
  await s.run(ticks);
  return { s, runId: Number(body.run.id) };
}

describe('Sentinel: загрузка модели', () => {
  it('настоящий файл модели → READY; нет файла → MISSING; повреждённый → INVALID; путь не задан → DISABLED', () => {
    expect(ml.status).toBe('READY');
    expect(ml.model?.modelVersion).toMatch(/^sentinel-/);
    expect(loadMlRuntime(join(tmp, 'nope.json')).status).toBe('MISSING');
    const bad = join(tmp, 'bad.json');
    writeFileSync(bad, '{ not json');
    expect(loadMlRuntime(bad)).toMatchObject({ status: 'INVALID', problem: 'JSON' });
    const wrong = join(tmp, 'wrong.json');
    writeFileSync(wrong, JSON.stringify({ format: 'qorgan-sentinel-model', formatVersion: 1, featureSchemaVersion: 999 }));
    expect(loadMlRuntime(wrong)).toMatchObject({ status: 'INVALID', problem: 'FEATURE_SCHEMA' });
    expect(loadMlRuntime(null).status).toBe('DISABLED');
  });
});

describe('Sentinel: параллельная оценка в транзакции приёма', () => {
  it('на каждый тик и станцию — строка ml_assessments с оценкой T2 того же тика; ML доходит до HIGH во время волны', async () => {
    const { s, runId } = await rapid(ml);
    const ticks = Number(s.db.prepare('SELECT current_tick FROM sim_runs WHERE id = ?').get(runId)?.current_tick) + 1;
    const rows = s.db.prepare('SELECT m.*, r.risk FROM ml_assessments m JOIN risk_assessments r USING (run_id, station_id, tick) WHERE m.run_id = ?').all(runId) as Row[];
    expect(rows).toHaveLength(ticks * 4);
    for (const r of rows) expect(r.rules_risk).toBe(r.risk);
    expect(rows.some((r) => r.category === 'HIGH')).toBe(true);
    expect(rows.every((r) => r.status === 'OK' || r.status === 'INSUFFICIENT_DATA')).toBe(true);
    // Признаки считаются только по данным до asOf тика: результат повторного расчёта по БД совпадает с сохранённым.
    const sample = rows.find((r) => r.category === 'HIGH')!;
    const { assessStation } = await import('../src/ml/service');
    const again = assessStation(s.db, ml.model!, runId, Number(sample.station_id), String(sample.as_of));
    expect(again.pDanger).toBe(Number(sample.p_danger));
    await s.app.close();
  });

  it('ML не подавляет и не создаёт предупреждения: журнал совпадает с прогоном без модели', async () => {
    const withMl = await rapid(ml, 150);
    const without = await rapid(undefined, 150);
    const pick = (db: typeof withMl.s.db, runId: number) =>
      db.prepare('SELECT station_id, severity, trigger, opened_tick, last_tick, is_active FROM alerts WHERE run_id = ? ORDER BY id').all(runId);
    const events = (db: typeof withMl.s.db) => db.prepare('SELECT alert_id, tick, type FROM alert_events ORDER BY id').all();
    expect(pick(withMl.s.db, withMl.runId)).toEqual(pick(without.s.db, without.runId));
    expect(events(withMl.s.db)).toEqual(events(without.s.db));
    expect(Number(without.s.db.prepare('SELECT COUNT(*) AS n FROM ml_assessments').get()?.n)).toBe(0);
    await withMl.s.app.close();
    await without.s.app.close();
  });

  it('ошибка модели не откатывает пакет: измерения, риск T2 и предупреждения сохраняются', async () => {
    const broken: MlRuntime = {
      status: 'READY',
      problem: null,
      model: new Proxy({} as NonNullable<MlRuntime['model']>, {
        get() {
          throw new Error('boom');
        },
      }),
    };
    const { s, runId } = await rapid(broken, 40);
    expect(Number(s.db.prepare('SELECT COUNT(*) AS n FROM risk_assessments WHERE run_id = ?').get(runId)?.n)).toBe(40 * 4);
    expect(Number(s.db.prepare('SELECT current_tick FROM sim_runs WHERE id = ?').get(runId)?.current_tick)).toBe(39);
    expect(Number(s.db.prepare('SELECT COUNT(*) AS n FROM ml_assessments').get()?.n)).toBe(0);
    await s.app.close();
  });
});

describe('Sentinel: API и снимок', () => {
  it('GET /api/stations/:id/ml — оценка, вероятности, вклады SHAP, оценка T2 на тот же момент; гостю доступно', async () => {
    const { s } = await rapid(ml, 30);
    const res = await s.get('/api/stations/QRG-01/ml', '');
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.model).toMatchObject({ status: 'READY', demo: true, horizonH: 6 });
    expect(b.context.virtualTime).toBe(b.assessment.asOf);
    expect(b.rules.model).toBe('QORGAN-RULES-1');
    expect(b.assessment.rulesRisk).toBe(b.rules.risk);
    expect(['OK', 'INSUFFICIENT_DATA']).toContain(b.assessment.status);
    const r = b.assessment.result;
    expect(r.contributions.length).toBeGreaterThan(0);
    expect(r.contributions[0]).toHaveProperty('feature');
    expect(r.contributions[0]).toHaveProperty('shap');
    // Вклады + база = логит объясняемой модели.
    const sum = r.contributions.reduce((a: number, c: { shap: number }) => a + c.shap, r.baseValue);
    const p = r.explained === 'danger' ? r.pDanger : r.pWarning;
    expect(1 / (1 + Math.exp(-sum))).toBeCloseTo(p, 2);
    expect((await s.get('/api/stations/QRG-99/ml')).status).toBe(404);
    expect((await s.get('/api/stations/QRG-01/ml?runId=1', '')).status).toBe(401);
    expect((await s.get('/api/stations/QRG-01/ml/history', '')).status).toBe(401);
    const hist = await s.get('/api/stations/QRG-01/ml/history?limit=10');
    expect(hist.status).toBe(200);
    expect(hist.body.items).toHaveLength(10);
    expect((await s.get('/api/stations/QRG-01/ml/history?limit=0')).status).toBe(400);
    const model = await s.get('/api/ml/model', '');
    expect(model.body).toMatchObject({ status: 'READY', model: { demo: true, horizonH: 6 } });
    expect(model.body.model).not.toHaveProperty('targets');
    await s.app.close();
  });

  it('снимок WebSocket содержит оценку ML станции и состояние модели; без модели — ml: null и статус DISABLED', async () => {
    const { s } = await rapid(ml, 20);
    const snap = buildSnapshot(s.db, s.app.simulation, new Date().toISOString(), 'disabled', ml);
    expect(snap.mlModel.status).toBe('READY');
    expect(snap.stations[0]!.ml?.tick).toBe(19);
    expect(snap.stations[0]!.ml).not.toHaveProperty('result');
    const plain = buildSnapshot(s.db, s.app.simulation, new Date().toISOString());
    expect(plain.mlModel.status).toBe('DISABLED');
    expect(plain.stations[0]!.ml).toBeNull();
    await s.app.close();
  });

  it('без модели API отвечает статусом MISSING, а не ошибкой', async () => {
    const { s } = await rapid(loadMlRuntime(join(tmp, 'absent.json')), 5);
    const res = await s.get('/api/stations/QRG-01/ml', '');
    expect(res.status).toBe(200);
    expect(res.body.model.status).toBe('MISSING');
    expect(res.body.assessment).toBeNull();
    expect(res.body.rules.risk).toBeDefined();
    await s.app.close();
  });
});
