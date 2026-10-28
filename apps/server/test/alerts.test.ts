// T5 / Genesis: автоматические предупреждения (ТЗ §5.6). Полный путь: симулятор → POST /api/telemetry → риск → alerts.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb } from '../src/db/connection';
import { seed } from '../src/db/seed';
import { buildSnapshot } from '../src/realtime/snapshot';
import { TEST_USERS } from './helpers';
import { CODES, simApp } from './sim-helpers';

const START = '2026-04-10T00:00:00.000Z';

type Row = Record<string, unknown>;
const alertsOf = (db: ReturnType<typeof openDb>, runId: number): Row[] =>
  db.prepare('SELECT a.*, s.code FROM alerts a JOIN stations s ON s.id = a.station_id WHERE run_id = ? ORDER BY a.id').all(runId);
const eventsOf = (db: ReturnType<typeof openDb>, alertId: number): string[] =>
  db.prepare('SELECT type FROM alert_events WHERE alert_id = ? ORDER BY id').all(alertId).map((e) => String(e.type));

describe('создание предупреждений', () => {
  it('NORMAL: обычный режим не создаёт ни одного предупреждения', async () => {
    const s = await simApp();
    const { body } = await s.post('/api/simulation/start', { scenarioId: 'NORMAL', virtualStart: START });
    await s.run();
    expect(alertsOf(s.db, body.run.id)).toHaveLength(0);
  });

  it('RAPID_FLOOD: каждая станция по очереди получает предупреждение, оно обостряется до HIGH; дублей нет', async () => {
    const s = await simApp();
    const { body } = await s.post('/api/simulation/start', { scenarioId: 'RAPID_FLOOD', seed: 42, virtualStart: START });
    const runId = body.run.id;
    // Ход по тикам: в любой момент не больше одного активного предупреждения на станцию.
    let ticks = 0;
    while (s.scheduler.pending > 0) {
      await s.fire();
      ticks += 1;
      const dup = s.db.prepare('SELECT station_id, COUNT(*) AS n FROM alerts WHERE run_id = ? AND is_active = 1 GROUP BY station_id HAVING n > 1').all(runId);
      expect(dup, `тик ${ticks}`).toHaveLength(0);
    }
    const all = alertsOf(s.db, runId);
    for (const code of CODES) {
      const mine = all.filter((a) => a.code === code);
      expect(mine.length, code).toBeGreaterThanOrEqual(1);
      const first = mine[0]!;
      expect(first).toMatchObject({ hazard_type: 'flood', status: 'NEW' });
      expect(eventsOf(s.db, Number(first.id))[0]).toBe('OPENED');
      // Хотя бы одно предупреждение станции дошло до HIGH (через ESCALATED или сразу).
      expect(mine.some((a) => a.severity === 'HIGH' || eventsOf(s.db, Number(a.id)).includes('ESCALATED')), code).toBe(true);
    }
    // Порядок первых предупреждений = порядок станций по течению (волна идёт сверху вниз).
    const firstOpen = CODES.map((c) => Number(all.find((a) => a.code === c)!.opened_tick));
    expect([...firstOpen].sort((a, b) => a - b)).toEqual(firstOpen);
    // Прогон завершён — активных предупреждений не осталось, история сохранена.
    expect(all.every((a) => Number(a.is_active) === 0)).toBe(true);
  });

  it('уровень выше опасного порога → причина DANGER_LEVEL; в причинах — коды факторов T2', async () => {
    const s = await simApp();
    const { body } = await s.post('/api/simulation/start', { scenarioId: 'RAPID_FLOOD', seed: 42, virtualStart: START });
    await s.run(40);
    const a = alertsOf(s.db, body.run.id).find((x) => x.code === 'QRG-01')!;
    expect(a).toMatchObject({ severity: 'HIGH', trigger: 'DANGER_LEVEL', is_active: 1 });
    const reasons = JSON.parse(String(a.reasons_json)) as Array<{ code: string }>;
    expect(reasons.map((r) => r.code)).toContain('LEVEL_ABOVE_DANGER');
  });

  it('риск LOW 3 оценки подряд снимает условие (CLEARED); новое ухудшение — новое предупреждение', async () => {
    const s = await simApp();
    const { body } = await s.post('/api/simulation/runs', { scenarioId: 'NORMAL', virtualStart: START, params: { levelNoiseCm: 0, levelDailyAmplitudeCm: 0, totalTicks: 200 } });
    const runId = body.run.id;
    for (let i = 0; i < 4; i += 1) await s.post('/api/simulation/step');
    // Уровень выше опасного → HIGH и предупреждение.
    await s.post('/api/simulation/interventions', { type: 'MANUAL_READING', stationCode: 'QRG-04', parameter: 'water_level', value: 520 });
    await s.post('/api/simulation/step');
    await s.post('/api/simulation/interventions', { type: 'MANUAL_READING', stationCode: 'QRG-04', parameter: 'water_level', value: 520 });
    await s.post('/api/simulation/step');
    let list = alertsOf(s.db, runId).filter((a) => a.code === 'QRG-04');
    expect(list).toHaveLength(1);
    expect(Number(list[0]!.is_active)).toBe(1);
    // Возврат к норме: через несколько спокойных тиков условие снимается.
    for (let i = 0; i < 12; i += 1) await s.post('/api/simulation/step');
    list = alertsOf(s.db, runId).filter((a) => a.code === 'QRG-04');
    expect(Number(list[0]!.is_active)).toBe(0);
    expect(eventsOf(s.db, Number(list[0]!.id)).at(-1)).toBe('CLEARED');
  });
});

describe('журнал и отметки оператора', () => {
  async function withAlert() {
    const s = await simApp();
    const { body } = await s.post('/api/simulation/start', { scenarioId: 'RAPID_FLOOD', seed: 42, virtualStart: START });
    await s.run(25);
    await s.post('/api/simulation/pause');
    const list = await s.get('/api/alerts');
    return { s, runId: body.run.id as number, alert: list.body.items.find((a: { stationCode: string }) => a.stationCode === 'QRG-01') };
  }

  it('гость видит только активные предупреждения; фильтры журнала и отметки — после входа', async () => {
    const { s } = await withAlert();
    const guest = await s.get('/api/alerts', '');
    expect(guest.status).toBe(200);
    expect(guest.body.items.length).toBeGreaterThan(0);
    expect(guest.body.items.every((a: { isActive: boolean }) => a.isActive)).toBe(true);
    expect((await s.get('/api/alerts?status=NEW', '')).status).toBe(401);
    expect((await s.get('/api/alerts?active=false', '')).status).toBe(401);
    const id = guest.body.items[0].id;
    expect((await s.post(`/api/alerts/${id}/view`, {}, '')).status).toBe(401);
    expect((await s.get(`/api/alerts/${id}/events`, '')).status).toBe(401);
  });

  it('NEW → VIEWED → RESOLVED с комментарием и автором; повтор — 409; неизвестное — 404', async () => {
    const { s, alert } = await withAlert();
    expect(alert).toMatchObject({ status: 'NEW', hazardType: 'flood', isActive: true });
    expect(alert.openedAt).toMatch(/^2026-04-1/);

    const viewed = await s.post(`/api/alerts/${alert.id}/view`);
    expect(viewed).toMatchObject({ status: 200, body: { alert: { status: 'VIEWED' } } });
    expect((await s.post(`/api/alerts/${alert.id}/view`)).body.error.code).toBe('ALERT_ALREADY_VIEWED');

    const resolved = await s.post(`/api/alerts/${alert.id}/resolve`, { comment: 'Бригада выехала' });
    expect(resolved.body.alert.status).toBe('RESOLVED');
    expect((await s.post(`/api/alerts/${alert.id}/resolve`, {})).status).toBe(409);
    expect((await s.post('/api/alerts/99999/view')).status).toBe(404);
    expect((await s.post(`/api/alerts/${alert.id}/resolve`, { comment: 'x'.repeat(600) })).status).toBe(400);

    const ev = await s.get(`/api/alerts/${alert.id}/events`);
    const marks = ev.body.events.filter((e: { type: string }) => e.type === 'VIEWED' || e.type === 'RESOLVED');
    expect(marks).toEqual([
      expect.objectContaining({ type: 'VIEWED', user: 'operator', comment: null }),
      expect.objectContaining({ type: 'RESOLVED', user: 'operator', comment: 'Бригада выехала' }),
    ]);
  });

  it('обострение после обработки возвращает предупреждение в NEW — нужна новая реакция', async () => {
    const s = await simApp();
    await s.post('/api/simulation/start', { scenarioId: 'RAPID_FLOOD', seed: 42, virtualStart: START });
    // QRG-01: MEDIUM по дождю раньше подъёма воды (ARCHITECTURE §6.4), затем HIGH.
    await s.run(9);
    await s.post('/api/simulation/pause');
    const a = (await s.get('/api/alerts')).body.items.find((x: { stationCode: string }) => x.stationCode === 'QRG-01');
    expect(a.severity).toBe('MEDIUM');
    await s.post(`/api/alerts/${a.id}/resolve`, { comment: 'Наблюдаем' });
    await s.post('/api/simulation/resume');
    await s.run(30);
    await s.post('/api/simulation/pause');
    const ev = await s.get(`/api/alerts/${a.id}/events`);
    expect(ev.body.alert).toMatchObject({ severity: 'HIGH', status: 'NEW' });
    expect(ev.body.events.map((e: { type: string }) => e.type)).toContain('ESCALATED');
  });

  it('остановка прогона закрывает активные предупреждения (RUN_ENDED), журнал сохраняется', async () => {
    const { s, runId } = await withAlert();
    await s.post('/api/simulation/stop');
    const rows = alertsOf(s.db, runId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((a) => Number(a.is_active) === 0)).toBe(true);
    const ev = await s.get(`/api/alerts/${rows[0]!.id}/events`);
    expect(ev.body.events.at(-1)).toMatchObject({ type: 'CLEARED', comment: 'RUN_ENDED' });
    expect((await s.get(`/api/alerts?runId=${runId}`)).body.items).toHaveLength(rows.length);
  });

  it('«требуют внимания»: необработанные остаются в списке и после снятия условия; обработанные — уходят', async () => {
    const { s, runId, alert } = await withAlert();
    await s.post(`/api/alerts/${alert.id}/resolve`, { comment: 'ok' });
    await s.post('/api/simulation/stop');
    const attention = (await s.get(`/api/alerts?runId=${runId}&unhandled=true`)).body.items;
    expect(attention.length).toBeGreaterThan(0);
    expect(attention.every((a: { status: string; isActive: boolean }) => a.status !== 'RESOLVED' && !a.isActive)).toBe(true);
    expect(attention.find((a: { id: number }) => a.id === alert.id)).toBeUndefined();
    expect((await s.get('/api/alerts?unhandled=true', '')).status).toBe(401);
  });

  it('снимок WebSocket содержит активные предупреждения и число необработанных', async () => {
    const { s, runId } = await withAlert();
    const snap = buildSnapshot(s.db, s.app.simulation, new Date().toISOString());
    expect(snap.alerts.runId).toBe(runId);
    expect(snap.alerts.active.length).toBeGreaterThan(0);
    expect(snap.alerts.unhandled).toBeGreaterThanOrEqual(snap.alerts.active.length);
    expect(snap.alerts.active[0]).toMatchObject({ stationCode: 'QRG-01', severity: 'HIGH' });
  });
});

describe('аудит: граничные случаи', () => {
  it('отключение станции администратором закрывает её активное предупреждение (STATION_DISABLED)', async () => {
    const s = await simApp();
    const { body } = await s.post('/api/simulation/start', { scenarioId: 'RAPID_FLOOD', seed: 42, virtualStart: START });
    await s.run(25);
    await s.post('/api/simulation/pause');
    const active = alertsOf(s.db, body.run.id).find((a) => a.code === 'QRG-01' && Number(a.is_active) === 1)!;
    await s.app.inject({ method: 'DELETE', url: '/api/admin/stations/1', headers: { cookie: s.admin } });
    const after = alertsOf(s.db, body.run.id).find((a) => a.id === active.id)!;
    expect(Number(after.is_active)).toBe(0);
    const ev = await s.get(`/api/alerts/${active.id}/events`);
    expect(ev.body.events.at(-1)).toMatchObject({ type: 'CLEARED', comment: 'STATION_DISABLED' });
    expect(buildSnapshot(s.db, s.app.simulation, new Date().toISOString()).alerts.active.find((a) => a.stationCode === 'QRG-01')).toBeUndefined();
  });

  it('повторная отправка старого тика не открывает снятое предупреждение заново', async () => {
    const s = await simApp();
    const { body } = await s.post('/api/simulation/runs', { scenarioId: 'NORMAL', virtualStart: START, params: { levelNoiseCm: 0, levelDailyAmplitudeCm: 0, totalTicks: 100 } });
    const runId = body.run.id;
    for (let i = 0; i < 4; i += 1) await s.post('/api/simulation/step');
    // Два показания подряд выше опасного (одно — «неподтверждённый скачок» в модели T2) → HIGH и предупреждение.
    for (let i = 0; i < 2; i += 1) {
      await s.post('/api/simulation/interventions', { type: 'MANUAL_READING', stationCode: 'QRG-04', parameter: 'water_level', value: 520 });
      await s.post('/api/simulation/step');
    }
    for (let i = 0; i < 12; i += 1) await s.post('/api/simulation/step'); // снято
    const before = alertsOf(s.db, runId).filter((a) => a.code === 'QRG-04');
    expect(before).toHaveLength(1);
    expect(Number(before[0]!.is_active)).toBe(0);
    // Тот же пакет тика 5 (HIGH) приходит повторно (например, после сбоя сети): измерения — дубли, предупреждения не меняются.
    const m = s.db.prepare("SELECT measured_at FROM measurements m JOIN stations st ON st.id = m.station_id WHERE st.code = 'QRG-04' AND m.run_id = ? AND m.tick = 5").get(runId);
    const { ingest } = await import('../src/telemetry/ingest');
    const r = ingest(s.db, { kind: 'simulator' }, { runId, tick: 5, records: [{ stationCode: 'QRG-04', parameter: 'water_level', value: 520, unit: 'cm', measuredAt: String(m?.measured_at) }] }, new Date().toISOString());
    expect(r.duplicates).toBe(1);
    expect(r.alerts).toEqual([]);
    expect(alertsOf(s.db, runId).filter((a) => a.code === 'QRG-04')).toHaveLength(1);
  });
});

describe('сохранение после перезапуска', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('предупреждения и отметки остаются в файле БД после перезапуска сервера', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qorgan-alerts-'));
    dirs.push(dir);
    const file = join(dir, 'q.db');
    const db1 = openDb(file);
    migrate(db1);
    seed(db1, TEST_USERS);
    const s1 = await simApp(db1);
    await s1.post('/api/simulation/start', { scenarioId: 'RAPID_FLOOD', seed: 42, virtualStart: START });
    await s1.run(25);
    const id = (await s1.get('/api/alerts')).body.items[0].id;
    await s1.post(`/api/alerts/${id}/view`);
    await s1.app.close();
    db1.close();

    const db2 = openDb(file);
    migrate(db2);
    const s2 = await simApp(db2);
    const list = (await s2.get('/api/alerts?active=true')).body.items;
    expect(list.find((a: { id: number }) => a.id === id)).toMatchObject({ status: 'VIEWED', isActive: true });
    await s2.app.close();
    db2.close();
  });
});
