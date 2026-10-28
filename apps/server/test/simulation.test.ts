// T3: симулятор паводковой волны — полный путь «симулятор → POST /api/telemetry → SQLite → T2 → API».
// Время управляемое: ManualScheduler (тики по команде) и TestClock (реальные часы). Реальных задержек нет.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../src/db/connection';
import { MIGRATIONS } from '../src/db/migrations';
import { AppError } from '../src/errors';
import { ingest } from '../src/telemetry/ingest';
import { testDb } from './helpers';
import { CODES, H, levels, risks, simApp } from './sim-helpers';

const BASE: Record<string, number> = { 'QRG-01': 300, 'QRG-02': 280, 'QRG-03': 320, 'QRG-04': 260 };
const START = '2026-04-10T00:00:00.000Z';
const vt = (tick: number) => new Date(Date.parse(START) + tick * H).toISOString();
const RANK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const QUIET = { levelNoiseCm: 0, levelDailyAmplitudeCm: 0 };

async function started(scenarioId: string, extra: Record<string, unknown> = {}) {
  const s = await simApp();
  const res = await s.post('/api/simulation/start', { scenarioId, seed: 42, tickMs: 1000, virtualStart: START, ...extra });
  expect(res.status).toBe(200);
  return { ...s, runId: res.body.run.id as number };
}

const count = (s: { db: ReturnType<typeof testDb> }, sql: string, ...args: Array<string | number>) =>
  Number(s.db.prepare(sql).get(...args)?.n ?? 0);

describe('1–3. сценарии целиком', () => {
  it('NORMAL: 72 тика → COMPLETED, все станции LOW, уровни в пределах базового ± 2 см', async () => {
    const s = await started('NORMAL');
    expect(await s.run()).toBe(72);
    const state = (await s.get('/api/simulation/state')).body;
    expect(state).toMatchObject({ state: 'COMPLETED', run: { currentTick: 71, progress: 1 } });
    expect(s.scheduler.pending).toBe(0);
    for (const code of CODES) {
      const r = risks(s.db, s.runId, code);
      expect(r).toHaveLength(72);
      expect(r.every((x) => x.risk === 'LOW'), code).toBe(true);
      for (const l of levels(s.db, s.runId, code)) expect(Math.abs(l.value - BASE[code]!)).toBeLessThanOrEqual(2.05);
    }
  });

  it('GRADUAL_FLOOD: каждая станция по очереди доходит до MEDIUM, HIGH не возникает; пики 470/441.5/489.6/412.6 ± 5', async () => {
    const s = await started('GRADUAL_FLOOD');
    expect(await s.run()).toBe(240);
    const expectedPeak: Record<string, number> = { 'QRG-01': 470, 'QRG-02': 441.5, 'QRG-03': 489.575, 'QRG-04': 412.6 };
    const firstMedium: number[] = [];
    for (const code of CODES) {
      const r = risks(s.db, s.runId, code);
      expect(Math.max(...r.map((x) => RANK[x.risk]!)), code).toBe(1);
      firstMedium.push(r.find((x) => x.risk === 'MEDIUM')!.tick);
      const peak = Math.max(...levels(s.db, s.runId, code).map((l) => l.value));
      expect(Math.abs(peak - expectedPeak[code]!), code).toBeLessThanOrEqual(5);
    }
    expect([...firstMedium].sort((a, b) => a - b)).toEqual(firstMedium);
  });

  it('RAPID_FLOOD: все станции доходят до HIGH строго по очереди; QRG-01 предупреждён по дождю до подъёма воды', async () => {
    const s = await started('RAPID_FLOOD');
    expect(await s.run()).toBe(260);
    const firstHigh = CODES.map((code) => risks(s.db, s.runId, code).find((x) => x.risk === 'HIGH')?.tick ?? -1);
    expect(firstHigh.every((t) => t >= 0)).toBe(true);
    for (let i = 1; i < 4; i += 1) expect(firstHigh[i]!).toBeGreaterThan(firstHigh[i - 1]!);

    // Тик 8: дождь 4 мм/ч на тиках 4–8 = 20 мм ≥ 20 → +2 балла → MEDIUM; волна стартует только с тика 11.
    const row = s.db
      .prepare("SELECT r.risk, r.level_cm, r.assessment_json FROM risk_assessments r JOIN stations st ON st.id = r.station_id WHERE r.run_id = ? AND st.code = 'QRG-01' AND r.tick = 8")
      .get(s.runId)!;
    expect(row.risk).toBe('MEDIUM');
    expect(Number(row.level_cm)).toBeLessThan(310);
    expect(JSON.parse(String(row.assessment_json)).reasons[0]).toMatchObject({ code: 'HEAVY_RAIN', params: { mm: 20 } });
  });
});

describe('стабильность риска', () => {
  it('нет «мигания»: RAPID — ровно LOW→MEDIUM→HIGH→MEDIUM→LOW, GRADUAL — LOW→MEDIUM→LOW на каждой станции', async () => {
    for (const [id, expected] of [['RAPID_FLOOD', ['LOW', 'MEDIUM', 'HIGH', 'MEDIUM', 'LOW']], ['GRADUAL_FLOOD', ['LOW', 'MEDIUM', 'LOW']]] as const) {
      const s = await started(id);
      await s.run();
      for (const code of CODES) {
        const seq = risks(s.db, s.runId, code).map((r) => r.risk).filter((r, i, a) => i === 0 || r !== a[i - 1]);
        expect(seq, `${id} ${code}`).toEqual(expected);
      }
    }
  });
});

describe('4–6. цепочка станций, виртуальные задержки, ускорение времени', () => {
  it('волна проходит станции по порядку: превышение базового уровня на 20 см с интервалами ≈ 51, 51, 17 ч', async () => {
    const s = await started('RAPID_FLOOD');
    await s.run(200);
    const reach = CODES.map((code) => levels(s.db, s.runId, code).find((l) => l.value > BASE[code]! + 20)!.tick);
    const gaps = [reach[1]! - reach[0]!, reach[2]! - reach[1]!, reach[3]! - reach[2]!];
    expect(Math.abs(gaps[0]! - 51)).toBeLessThanOrEqual(4);
    expect(Math.abs(gaps[1]! - 51)).toBeLessThanOrEqual(4);
    expect(Math.abs(gaps[2]! - 17)).toBeLessThanOrEqual(4);
  });

  it('без шума подъём начинается точно на тиках 11, 62, 113, 130 (виртуальные часы)', async () => {
    const s = await started('RAPID_FLOOD', { params: QUIET });
    await s.run(140);
    const onset = CODES.map((code) => levels(s.db, s.runId, code).find((l) => l.value > BASE[code]!)!.tick);
    expect(onset).toEqual([11, 62, 113, 130]);
  });

  it('скорость (tickMs) меняет только реальные паузы между тиками, но не данные и не виртуальное время', async () => {
    const slow = await started('RAPID_FLOOD', { tickMs: 1000 });
    const fast = await started('RAPID_FLOOD', { tickMs: 50 });
    await slow.fire();
    await fast.fire();
    expect([slow.scheduler.nextDelay, fast.scheduler.nextDelay]).toEqual([1000, 50]);
    await slow.run(29);
    await fast.run(29);
    const rows = (s: typeof slow) =>
      s.db.prepare('SELECT station_id, parameter_code, value, measured_at, tick FROM measurements WHERE run_id = ? ORDER BY tick, station_id, parameter_code').all(s.runId);
    expect(rows(fast)).toEqual(rows(slow));
    expect(rows(fast).at(-1)).toMatchObject({ tick: 29, measured_at: vt(29) });
    expect((await slow.get('/api/simulation/state')).body.run.acceleration).toBe(3600);
    expect((await fast.get('/api/simulation/state')).body.run.acceleration).toBe(72_000);
  });

  it('смена скорости во время хода перепланирует единственный таймер', async () => {
    const s = await started('RAPID_FLOOD');
    await s.fire();
    expect(s.scheduler.nextDelay).toBe(1000);
    const res = await s.app.inject({ method: 'PATCH', url: '/api/simulation/speed', headers: { cookie: s.operator }, payload: { tickMs: 200 } });
    expect(res.statusCode).toBe(200);
    expect([s.scheduler.pending, s.scheduler.nextDelay]).toEqual([1, 200]);
  });

  it('виртуальное время по умолчанию начинается с текущего реального часа (UTC) и отличается от реального', async () => {
    const s = await simApp();
    const res = await s.post('/api/simulation/runs', { scenarioId: 'NORMAL' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ state: 'CREATED', run: { simStart: '2026-10-28T10:00:00.000Z', currentTick: null, virtualTime: null } });
    await s.post('/api/simulation/step');
    await s.post('/api/simulation/step');
    const state = (await s.get('/api/simulation/state')).body;
    expect(state.run.virtualTime).toBe('2026-10-28T11:00:00.000Z');
    expect(state.realTime).toBe('2026-10-28T10:37:12.000Z');
  });
});

describe('7–10. пауза, остановка, повторный запуск, сброс', () => {
  it('пауза: таймер снят, виртуальное время стоит, хотя реальное идёт; продолжение — со следующего тика', async () => {
    const s = await started('RAPID_FLOOD', { tickMs: 500 });
    await s.run(5);
    const paused = await s.post('/api/simulation/pause');
    expect(paused.body).toMatchObject({ state: 'PAUSED', run: { currentTick: 4, virtualTime: vt(4) } });
    expect(s.scheduler.pending).toBe(0);
    s.clock.advance(10 * H);
    expect((await s.get('/api/simulation/state')).body.run.virtualTime).toBe(vt(4));
    expect(count(s, 'SELECT COUNT(*) AS n FROM measurements WHERE run_id = ?', s.runId)).toBe(50);
    expect((await s.post('/api/simulation/pause')).status).toBe(409);

    const resumed = await s.post('/api/simulation/resume');
    expect(resumed.body.state).toBe('RUNNING');
    expect(s.scheduler.nextDelay).toBe(500);
    await s.fire();
    expect((await s.get('/api/simulation/state')).body.run).toMatchObject({ currentTick: 5, virtualTime: vt(5) });
  });

  it('остановка: данные сохраняются, таймер снят, «застрявший» тик и телеметрия этого прогона не пишутся', async () => {
    const s = await started('RAPID_FLOOD');
    await s.run(3);
    const stale = [...s.scheduler.tasks.values()][0]!.fn;
    const stopped = await s.post('/api/simulation/stop');
    expect(stopped.body).toMatchObject({ state: 'STOPPED', run: { currentTick: 2 } });
    expect(s.scheduler.pending).toBe(0);
    stale();
    await s.app.simulation.idle();
    expect(count(s, 'SELECT COUNT(*) AS n FROM measurements WHERE run_id = ?', s.runId)).toBe(30);
    expect(() => ingest(s.db, { kind: 'simulator' }, { runId: s.runId, tick: 3, records: [] }, new Date().toISOString())).toThrow(AppError);
    for (const cmd of ['stop', 'resume', 'pause', 'step']) expect((await s.post(`/api/simulation/${cmd}`)).status, cmd).toBe(409);
  });

  it('повторный «Старт» не создаёт второй таймер и второй прогон', async () => {
    const s = await started('RAPID_FLOOD');
    expect((await s.post('/api/simulation/start', { scenarioId: 'NORMAL' })).body.error.code).toBe('ALREADY_RUNNING');
    expect((await s.post('/api/simulation/start')).status).toBe(409);
    expect(s.scheduler.pending).toBe(1);
    expect(count(s, 'SELECT COUNT(*) AS n FROM sim_runs')).toBe(1);
  });

  it('после завершения «Старт» со сценарием создаёт новый прогон', async () => {
    const s = await started('NORMAL', { params: { totalTicks: 3 } });
    await s.run();
    const again = await s.post('/api/simulation/start', { scenarioId: 'NORMAL', params: { totalTicks: 3 } });
    expect(again.status).toBe(200);
    expect(again.body.run.id).not.toBe(s.runId);
  });

  it('сброс: прогон остановлен, симулятор в IDLE, данные не удалены; новый прогон хранится отдельно', async () => {
    const s = await started('RAPID_FLOOD');
    await s.run(3);
    const reset = await s.post('/api/simulation/reset');
    expect(reset.body).toMatchObject({ state: 'IDLE', run: null });
    expect(s.scheduler.pending).toBe(0);
    expect(s.db.prepare('SELECT status FROM sim_runs WHERE id = ?').get(s.runId)?.status).toBe('STOPPED');
    const second = await s.post('/api/simulation/start', { scenarioId: 'NORMAL', virtualStart: START });
    await s.run(2);
    const secondId = second.body.run.id;
    expect(count(s, 'SELECT COUNT(*) AS n FROM measurements WHERE run_id = ?', s.runId)).toBe(30);
    expect(count(s, 'SELECT COUNT(*) AS n FROM measurements WHERE run_id = ?', secondId)).toBe(20);
    // Повторный сброс в IDLE безопасен.
    await s.post('/api/simulation/stop');
    expect((await s.post('/api/simulation/reset')).status).toBe(200);
    expect((await s.post('/api/simulation/reset')).status).toBe(200);
  });
});

describe('11–12. ручное управление', () => {
  async function stepped(n: number) {
    const s = await simApp();
    const created = await s.post('/api/simulation/runs', { scenarioId: 'NORMAL', virtualStart: START, params: QUIET });
    for (let i = 0; i < n; i += 1) expect((await s.post('/api/simulation/step')).status).toBe(200);
    return { ...s, runId: created.body.run.id as number };
  }

  it('LEVEL_SHIFT +40 у QRG-01 действует со следующего тика и не меняет прошлое', async () => {
    const s = await stepped(3);
    const res = await s.post('/api/simulation/interventions', { type: 'LEVEL_SHIFT', stationCode: 'QRG-01', value: 40 });
    expect(res.status).toBe(201);
    expect(res.body.effectiveTick).toBe(3);
    await s.post('/api/simulation/step');
    expect(levels(s.db, s.runId, 'QRG-01').map((l) => l.value)).toEqual([300, 300, 300, 340]);
  });

  it('MANUAL_READING: одна запись на тик с источником manual; повторный ввод заменяет значение; дальше — снова симулятор', async () => {
    const s = await stepped(4);
    await s.post('/api/simulation/interventions', { type: 'MANUAL_READING', stationCode: 'QRG-02', value: 290 });
    await s.post('/api/simulation/interventions', { type: 'MANUAL_READING', stationCode: 'QRG-02', value: 295 });
    expect(count(s, "SELECT COUNT(*) AS n FROM sim_interventions WHERE type = 'MANUAL_READING'")).toBe(1);
    await s.post('/api/simulation/step');
    await s.post('/api/simulation/step');
    expect(levels(s.db, s.runId, 'QRG-02').slice(4)).toEqual([
      { tick: 4, value: 295, source: 'manual' },
      { tick: 5, value: 280, source: 'simulator' },
    ]);
  });

  it('сдвиг +260 у QRG-01: тик k — скачок не подтверждён (LOW), тик k+1 — подтверждён (HIGH), у QRG-02 — волна сверху', async () => {
    const s = await stepped(6);
    await s.post('/api/simulation/interventions', { type: 'LEVEL_SHIFT', stationCode: 'QRG-01', value: 260 });
    await s.post('/api/simulation/step');
    expect(risks(s.db, s.runId, 'QRG-01').at(-1)).toMatchObject({ tick: 6, risk: 'LOW' });
    await s.post('/api/simulation/step');
    expect(risks(s.db, s.runId, 'QRG-01').at(-1)).toMatchObject({ tick: 7, risk: 'HIGH' });
    const up = (await s.get('/api/stations/QRG-01/risk/explanation')).body;
    expect(up.reasons.map((r: { code: string }) => r.code)).toEqual(expect.arrayContaining(['LEVEL_ABOVE_DANGER', 'SUDDEN_JUMP']));
    const down = (await s.get('/api/stations/QRG-02/risk')).body;
    expect(down.risk).toBe('MEDIUM');
    expect(down.topReasons[0]).toEqual({ code: 'UPSTREAM_WAVE', params: { station: 'QRG-01', risk: 'HIGH', hours: 51 } });
  });

  it('проверка входных данных вмешательств', async () => {
    const s = await stepped(1);
    const cases: Array<[unknown, number, string]> = [
      [{ type: 'MANUAL_READING', stationCode: 'QRG-01', value: 2000 }, 400, 'VALIDATION'],
      [{ type: 'MANUAL_READING', stationCode: 'QRG-04', parameter: 'precipitation', value: 1 }, 400, 'UNKNOWN_PARAM'],
      [{ type: 'LEVEL_SHIFT', stationCode: 'QRG-99', value: 10 }, 404, 'STATION_NOT_FOUND'],
      [{ type: 'LEVEL_SHIFT', stationCode: 'QRG-01', value: 1000 }, 400, 'VALIDATION'],
      [{ type: 'RISE_RATE', stationCode: 'QRG-01', value: 5 }, 400, 'VALIDATION'],
      [{ type: 'TELEPORT', stationCode: 'QRG-01', value: 5 }, 400, 'VALIDATION'],
    ];
    for (const [body, status, code] of cases) {
      const res = await s.post('/api/simulation/interventions', body);
      expect([res.status, res.body.error.code], JSON.stringify(body)).toEqual([status, code]);
    }
    expect(count(s, 'SELECT COUNT(*) AS n FROM sim_interventions')).toBe(0);
  });
});

describe('13–15. хранение, дубли, перезапуск сервера', () => {
  it('каждый тик: 10 измерений (3+3+3+1 датчик) и 4 оценки; у записи есть всё, что требует ТЗ §5.2', async () => {
    const s = await started('RAPID_FLOOD');
    await s.run(10);
    expect(count(s, 'SELECT COUNT(*) AS n FROM measurements WHERE run_id = ?', s.runId)).toBe(100);
    expect(count(s, 'SELECT COUNT(*) AS n FROM risk_assessments WHERE run_id = ?', s.runId)).toBe(40);
    const row = s.db
      .prepare("SELECT m.*, st.code FROM measurements m JOIN stations st ON st.id = m.station_id WHERE m.run_id = ? AND m.tick = 9 AND st.code = 'QRG-01' AND m.parameter_code = 'precipitation'")
      .get(s.runId)!;
    expect(row).toMatchObject({ code: 'QRG-01', parameter_code: 'precipitation', value: 4, unit: 'mm/h', measured_at: vt(9), tick: 9, source: 'simulator', quality: 'ok' });
    expect(String(row.received_at)).toMatch(/^2026-10-28T/); // реальное время приёма ≠ виртуальное время измерения
  });

  it('повторная отправка тика не создаёт дублей; тик «через один» отклоняется', async () => {
    const s = await started('RAPID_FLOOD');
    await s.run(5);
    const records = s.db
      .prepare('SELECT st.code AS stationCode, m.parameter_code AS parameter, m.value, m.unit, m.measured_at AS measuredAt FROM measurements m JOIN stations st ON st.id = m.station_id WHERE m.run_id = ? AND m.tick = 3')
      .all(s.runId) as unknown as Parameters<typeof ingest>[2]['records'];
    const before = count(s, 'SELECT COUNT(*) AS n FROM measurements');
    const result = ingest(s.db, { kind: 'simulator' }, { runId: s.runId, tick: 3, records }, new Date().toISOString());
    expect([result.accepted, result.duplicates, result.rejected.length]).toEqual([0, 10, 0]);
    expect(count(s, 'SELECT COUNT(*) AS n FROM measurements')).toBe(before);
    expect(() => ingest(s.db, { kind: 'simulator' }, { runId: s.runId, tick: 9, records }, new Date().toISOString())).toThrow(/Ожидался тик/);
  });

  it('ошибка БД во время приёма: пакет не записан частично, прогон встаёт на паузу с описанием ошибки', async () => {
    const s = await started('RAPID_FLOOD');
    await s.run(3);
    s.db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON measurements BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    await s.fire();
    const state = (await s.get('/api/simulation/state')).body;
    expect(state).toMatchObject({ state: 'PAUSED', run: { currentTick: 2 } });
    expect(state.run.lastError).toMatch(/^DELIVERY_FAILED 500/);
    expect(count(s, 'SELECT COUNT(*) AS n FROM risk_assessments WHERE run_id = ? AND tick = 3', s.runId)).toBe(0);
    expect(s.scheduler.pending).toBe(0);
    s.db.exec('DROP TRIGGER fail_insert');
    await s.post('/api/simulation/resume');
    await s.fire();
    expect((await s.get('/api/simulation/state')).body.run).toMatchObject({ currentTick: 3, lastError: null });
  });

  it('перезапуск сервера: идущий прогон встаёт на паузу и продолжается без дублей с теми же данными', async () => {
    const db = testDb();
    const s1 = await simApp(db);
    const runId = (await s1.post('/api/simulation/start', { scenarioId: 'RAPID_FLOOD', seed: 42, virtualStart: START })).body.run.id;
    await s1.run(21);
    await s1.app.close();

    const s2 = await simApp(db);
    const state = (await s2.get('/api/simulation/state')).body;
    expect(state).toMatchObject({ state: 'PAUSED', run: { id: runId, currentTick: 20, lastError: 'SERVER_RESTART' } });
    expect(s2.scheduler.pending).toBe(0);
    await s2.post('/api/simulation/resume');
    await s2.run(2);
    expect(count(s2, 'SELECT COUNT(*) AS n FROM measurements WHERE run_id = ?', runId)).toBe(230);
    expect(count(s2, "SELECT COUNT(*) AS n FROM device_log WHERE code = 'SIM_RECOVERED_PAUSED'")).toBe(1);

    const reference = await started('RAPID_FLOOD');
    await reference.run(23);
    expect(levels(db, runId, 'QRG-01')).toEqual(levels(reference.db, reference.runId, 'QRG-01'));
  });

  it('миграция v1 → v2 сохраняет существующие данные', () => {
    const db = openDb(':memory:');
    migrate(db, 1);
    const now = '2026-10-28T00:00:00.000Z';
    db.exec(`INSERT INTO stations (code, name, station_type, lat, lon, created_at, updated_at) VALUES ('QRG-02', 'Явленка', 'combined', 54, 68, '${now}', '${now}')`);
    db.exec(`INSERT INTO parameters (code, unit, min_valid, max_valid) VALUES ('water_level', 'cm', 0, 1500)`);
    db.exec(`INSERT INTO sim_runs (scenario_id, seed, params_json, tick_ms, sim_start, started_at) VALUES ('TEST_FIXTURE', 0, '{}', 1000, '${now}', '${now}')`);
    db.exec(`INSERT INTO sim_control (id, status, tick_ms, updated_at) VALUES (1, 'IDLE', 1000, '${now}')`);
    db.exec(`INSERT INTO measurements (run_id, station_id, parameter_code, value, unit, measured_at, received_at, source) VALUES (1, 1, 'water_level', 300, 'cm', '${now}', '${now}', 'manual')`);
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)?.version);
    expect(db.prepare('SELECT status, current_tick, step_minutes FROM sim_runs').get()).toEqual({ status: 'COMPLETED', current_tick: null, step_minutes: 60 });
    expect(db.prepare('SELECT response_hours FROM stations').get()?.response_hours).toBe(6);
    expect(db.prepare('SELECT run_id FROM sim_control').get()?.run_id).toBeNull();
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM measurements').get()?.n)).toBe(1);
  });
});

describe('16–18. интеграция с T2: риск, ETA, отсутствие будущих данных', () => {
  it('полный путь: ответ API = измерение в БД = сохранённая оценка; режим LIVE, виртуальное ≠ реальное время', async () => {
    const s = await started('RAPID_FLOOD');
    await s.run(41);
    const api = (await s.get('/api/stations/QRG-01/risk', '')).body;
    const lvl = levels(s.db, s.runId, 'QRG-01')[40]!;
    const stored = risks(s.db, s.runId, 'QRG-01')[40]!;
    expect(api.context).toMatchObject({ mode: 'LIVE', runId: s.runId, runStatus: 'RUNNING', scenarioId: 'RAPID_FLOOD', virtualTime: vt(40) });
    expect(api.context.realTime).toBe(s.clock.now().toISOString()); // реальное время — из того же источника, что у симулятора
    expect(api.asOf).toBe(vt(40));
    expect(api.level).toMatchObject({ currentCm: lvl.value, measuredAt: vt(40), ageH: 0 });
    expect([api.risk, api.score]).toEqual([stored.risk, stored.score]);
    await s.post('/api/simulation/pause');
    expect((await s.get('/api/stations/QRG-01/risk', '')).body.context.mode).toBe('PAUSED');
    await s.post('/api/simulation/stop');
    expect((await s.get('/api/stations/QRG-01/risk', '')).body.context.mode).toBe('HISTORICAL');
  });

  it('ETA без шума на тике 20: уровень 466.7, скорость 16.674 см/ч → до 550 см ≈ 5 ч, QRG-01 HIGH, у QRG-02 волна через 51 ч', async () => {
    // Окно тиков 15–20: 383.3, 400, 416.7, 433.3, 450, 466.7 → наклон 291.8 / 17.5 = 16.674; (550 − 466.7) / 16.674 = 4.996
    const s = await started('RAPID_FLOOD', { params: QUIET });
    await s.run(21);
    const f = (await s.get('/api/stations/QRG-01/forecast')).body;
    expect(f.level.currentCm).toBe(466.7);
    expect(f.trend.rateCmH).toBe(16.674);
    expect(f.eta.status).toBe('ESTIMATED');
    expect(f.eta.hours).toBeCloseTo(5, 1);
    expect(f.forecast.levelCm).toBeCloseTo(466.7 + 3 * 16.674, 1);
    expect((await s.get('/api/stations/QRG-01/risk')).body.risk).toBe('HIGH');
    const down = (await s.get('/api/stations/QRG-02/forecast')).body;
    expect(down.eta.status).toBe('NOT_EXPECTED');
    expect((await s.get('/api/stations/QRG-02/risk')).body.topReasons[0]).toMatchObject({ code: 'UPSTREAM_WAVE', params: { hours: 51 } });
  });

  it('оценка на прошлый момент (at = тик 20) после 60 тиков совпадает с той, что была сохранена на тике 20', async () => {
    const s = await started('RAPID_FLOOD');
    await s.run(61);
    const past = (await s.get(`/api/stations/QRG-02/risk/explanation?at=${vt(20)}`)).body;
    const stored = JSON.parse(
      String(
        s.db
          .prepare("SELECT r.assessment_json FROM risk_assessments r JOIN stations st ON st.id = r.station_id WHERE r.run_id = ? AND st.code = 'QRG-02' AND r.tick = 20")
          .get(s.runId)?.assessment_json,
      ),
    );
    expect(past.context.mode).toBe('HISTORICAL');
    expect(past.asOf).toBe(vt(20));
    expect({ risk: past.risk, score: past.score, level: past.level, factors: past.factors, reasons: past.reasons }).toEqual({
      risk: stored.risk,
      score: stored.score,
      level: stored.level,
      factors: stored.factors,
      reasons: stored.reasons,
    });
  });

  it('история: оператору — все тики, гостю — последние 24 виртуальных часа текущего прогона', async () => {
    const s = await started('RAPID_FLOOD');
    await s.run(41);
    const guest = (await s.get('/api/stations/QRG-01/measurements?parameter=water_level', '')).body;
    expect(guest.items).toHaveLength(24);
    expect(guest.items[0].measuredAt).toBe(vt(17));
    const op = (await s.get('/api/stations/QRG-01/measurements?parameter=water_level')).body;
    expect(op.items).toHaveLength(41);
    const hist = (await s.get('/api/stations/QRG-01/risk/history')).body;
    expect(hist.items.map((i: { tick: number }) => i.tick)).toEqual(Array.from({ length: 41 }, (_, i) => i));
    const details = (await s.get(`/api/simulation/runs/${s.runId}`)).body;
    expect(details.counts).toEqual({ measurements: 410, assessments: 164, interventions: 0 });
  });
});

describe('19. права доступа', () => {
  it('гость видит состояние, но не управляет; оператор не удаляет прогоны; админ удаляет только завершённые', async () => {
    const s = await started('RAPID_FLOOD');
    await s.run(2);
    expect((await s.get('/api/simulation/state', '')).status).toBe(200);
    expect((await s.get('/api/simulation/scenarios', '')).status).toBe(200);
    for (const url of ['/api/simulation/start', '/api/simulation/pause', '/api/simulation/stop', '/api/simulation/reset', '/api/simulation/runs', '/api/simulation/interventions']) {
      expect((await s.post(url, { scenarioId: 'NORMAL' }, '')).status, url).toBe(401);
    }
    expect((await s.get('/api/simulation/runs', '')).status).toBe(401);
    expect((await s.get('/api/stations/QRG-01/risk/history', '')).status).toBe(401);
    expect((await s.get('/api/stations/QRG-01/measurements?runId=1', '')).status).toBe(401);

    const del = (cookie: string) => s.app.inject({ method: 'DELETE', url: `/api/simulation/runs/${s.runId}`, headers: { cookie } });
    expect((await del(s.operator)).statusCode).toBe(403);
    expect((await del(s.admin)).statusCode).toBe(409);
    await s.post('/api/simulation/stop');
    expect((await del(s.admin)).statusCode).toBe(200);
    expect(count(s, 'SELECT COUNT(*) AS n FROM measurements')).toBe(0);
    expect(count(s, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'SIM_DELETE'")).toBe(1);
  });

  it('телеметрия без токена или с чужим токеном → 401 и запись в журнал устройств', async () => {
    const s = await started('RAPID_FLOOD');
    const post = (headers: Record<string, string>) =>
      s.app.inject({ method: 'POST', url: '/api/telemetry', headers, payload: { records: [] } });
    expect((await post({})).statusCode).toBe(401);
    const bad = await post({ 'x-device-token': 'x'.repeat(40) });
    expect([bad.statusCode, bad.json().error.code]).toEqual([401, 'BAD_DEVICE_TOKEN']);
    expect(count(s, "SELECT COUNT(*) AS n FROM device_log WHERE code = 'BAD_TOKEN'")).toBe(1);
    for (let i = 0; i < 5; i += 1) await post({ 'x-device-token': 'y'.repeat(40) });
    expect(count(s, "SELECT COUNT(*) AS n FROM device_log WHERE code = 'BAD_TOKEN'")).toBe(1); // не чаще раза в минуту
    s.clock.advance(61_000);
    await post({ 'x-device-token': 'z'.repeat(40) });
    expect(count(s, "SELECT COUNT(*) AS n FROM device_log WHERE code = 'BAD_TOKEN'")).toBe(2);
  });

  it('устройство станции: принимается только своё, допустимое и не из будущего; источник — device', async () => {
    const s = await started('RAPID_FLOOD');
    const token = 'qrg04-device-token-0123456789';
    s.db.prepare("UPDATE stations SET device_token_hash = ? WHERE code = 'QRG-04'").run(createHash('sha256').update(token).digest('hex'));
    await s.run(3);
    await s.post('/api/simulation/pause');
    const at = (tick: number, minutes = 0) => new Date(Date.parse(vt(tick)) + minutes * 60_000).toISOString();
    const record = (over: Record<string, unknown>) => ({ stationCode: 'QRG-04', parameter: 'water_level', value: 262, unit: 'cm', measuredAt: at(2, -30), ...over });
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/telemetry',
      headers: { 'x-device-token': token },
      payload: {
        records: [
          record({}),
          record({ stationCode: 'QRG-01' }),
          record({ measuredAt: at(3) }),
          record({ unit: 'm' }),
          record({ value: 5000, measuredAt: at(1, -15) }),
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      tick: 2,
      accepted: 1,
      rejected: [
        { index: 1, code: 'STATION_MISMATCH' },
        { index: 2, code: 'REJECTED_TIME' },
        { index: 3, code: 'REJECTED_UNIT' },
        { index: 4, code: 'REJECTED_RANGE' },
      ],
    });
    const row = s.db.prepare("SELECT source, quality FROM measurements WHERE source = 'device'").get();
    expect(row).toEqual({ source: 'device', quality: 'late' });
    expect(count(s, "SELECT COUNT(*) AS n FROM device_log WHERE level = 'warn'")).toBe(4);
  });
});

describe('20. обработка ошибок', () => {
  it('неверные параметры и недопустимые переходы состояний дают понятные коды', async () => {
    const s = await simApp();
    const cases: Array<[string, unknown, number, string]> = [
      ['/api/simulation/runs', { scenarioId: 'TSUNAMI' }, 400, 'VALIDATION'],
      ['/api/simulation/runs', { scenarioId: 'NORMAL', tickMs: 10 }, 400, 'VALIDATION'],
      ['/api/simulation/runs', { scenarioId: 'NORMAL', hack: true }, 400, 'VALIDATION'],
      ['/api/simulation/runs', { scenarioId: 'NORMAL', params: { amplitudeCm: -5 } }, 400, 'VALIDATION'],
      ['/api/simulation/start', undefined, 409, 'NO_ACTIVE_RUN'],
      ['/api/simulation/step', undefined, 409, 'NO_ACTIVE_RUN'],
      ['/api/simulation/interventions', { type: 'LEVEL_SHIFT', stationCode: 'QRG-01', value: 5 }, 409, 'NO_ACTIVE_RUN'],
    ];
    for (const [url, body, status, code] of cases) {
      const res = await s.post(url, body);
      expect([res.status, res.body.error.code], `${url} ${JSON.stringify(body)}`).toEqual([status, code]);
    }
    await s.post('/api/simulation/start', { scenarioId: 'NORMAL' });
    expect((await s.post('/api/simulation/step')).body.error.code).toBe('ALREADY_RUNNING');
    expect((await s.post('/api/simulation/resume')).body.error.code).toBe('NOT_PAUSED');
    expect((await s.post('/api/simulation/runs', { scenarioId: 'NORMAL' })).body.error.code).toBe('ACTIVE_RUN_EXISTS');
  });

  it('число прогонов ограничено — база не растёт бесконтрольно', async () => {
    const s = await simApp();
    const insert = s.db.prepare("INSERT INTO sim_runs (scenario_id, seed, params_json, tick_ms, sim_start, started_at, status) VALUES ('NORMAL', 1, '{}', 1000, ?, ?, 'STOPPED')");
    for (let i = 0; i < 50; i += 1) insert.run(START, START);
    const res = await s.post('/api/simulation/runs', { scenarioId: 'NORMAL' });
    expect([res.status, res.body.error.code]).toEqual([409, 'RUN_LIMIT']);
  });
});

describe('WebSocket', () => {
  it('при подключении — снимок; после тика — новый снимок с теми же данными, что и в API', async () => {
    const s = await started('RAPID_FLOOD');
    await s.app.ready();
    // Подписка до открытия соединения: первый снимок сервер отправляет сразу при подключении.
    const queue: any[] = [];
    const waiters: Array<(m: any) => void> = [];
    const ws = await s.app.injectWS('/ws', {}, {
      onInit: (socket) =>
        socket.on('message', (m: Buffer) => {
          const msg = JSON.parse(m.toString());
          const w = waiters.shift();
          if (w) w(msg);
          else queue.push(msg);
        }),
    });
    const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise<any>((resolve) => waiters.push(resolve)));
    expect(await next()).toMatchObject({ type: 'snapshot', data: { simulation: { state: 'RUNNING' } } });
    await s.fire();
    const snap = await next();
    expect(snap.data.simulation.run.currentTick).toBe(0);
    const station = snap.data.stations.find((x: { code: string }) => x.code === 'QRG-01');
    expect(station.latest.water_level).toMatchObject({ value: levels(s.db, s.runId, 'QRG-01')[0]!.value, measuredAt: vt(0) });
    expect(snap.data.context).toMatchObject({ mode: 'LIVE', virtualTime: vt(0) });
    ws.terminate();
  });
});
