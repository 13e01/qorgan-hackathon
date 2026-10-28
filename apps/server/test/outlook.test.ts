// Прогноз по реке через настоящий путь: симулятор → POST /api/telemetry → SQLite → GET /api/outlook.

import { describe, expect, it } from 'vitest';
import { simApp } from './sim-helpers';

const START = '2026-04-10T00:00:00.000Z';
type St = { code: string; method: string; horizonH: number; danger: { status: string; h: number | null; earliestH: number | null; latestH: number | null } };

describe('GET /api/outlook', () => {
  it('доступ: гость → 401; без прогона — outlook = null', async () => {
    const s = await simApp();
    expect((await s.get('/api/outlook', '')).status).toBe(401);
    expect((await s.get('/api/outlook/verification', '')).status).toBe(401);
    const r = await s.get('/api/outlook');
    expect(r.status).toBe(200);
    expect(r.body.outlook).toBeNull();
    expect((await s.get('/api/outlook?runId=999')).status).toBe(404);
  });

  it('RAPID_FLOOD, час 40: опасность в Петропавловске ожидается за ~4 суток — задолго до местного подъёма', async () => {
    const s = await simApp();
    await s.post('/api/simulation/start', { scenarioId: 'RAPID_FLOOD', seed: 42, virtualStart: START });
    await s.run(41);
    const { body } = await s.get('/api/outlook');
    expect(body.context.mode).toBe('LIVE');
    expect(body.outlook).toMatchObject({ model: 'QORGAN-ROUTE-1', demo: true, asOf: '2026-04-11T16:00:00.000Z' });
    const by = Object.fromEntries((body.outlook.stations as St[]).map((x) => [x.code, x]));
    expect(by['QRG-01']).toMatchObject({ method: 'TREND', horizonH: 3, danger: { status: 'ALREADY_ABOVE' } });
    expect(by['QRG-02']).toMatchObject({ method: 'ROUTED', horizonH: 51, danger: { status: 'EXPECTED' } });
    expect(by['QRG-03']).toMatchObject({ method: 'ROUTED', horizonH: 102, danger: { status: 'EXPECTED' } });
    expect(by['QRG-04']!.horizonH).toBe(119);
    // Местный уровень в Петропавловске ещё обычный, а время до опасного порога уже известно.
    const d3 = by['QRG-03']!.danger;
    expect(d3.h!).toBeGreaterThan(72);
    expect(d3.earliestH!).toBeLessThanOrEqual(d3.h!);
    const risk = await s.get('/api/stations/QRG-03/risk', '');
    expect(risk.body.situation.localLevel).toBe('NORMAL');
    // Проверка задним числом: фактическое превышение должно попасть в окно прогноза ±6 ч.
    await s.run();
    const actual = s.db
      .prepare("SELECT MIN(m.tick) AS t FROM measurements m JOIN stations st ON st.id = m.station_id WHERE st.code = 'QRG-03' AND m.parameter_code = 'water_level' AND m.value >= 580")
      .get();
    expect(Math.abs(Number(actual?.t) - (40 + d3.h!))).toBeLessThanOrEqual(6);
  });

  it('проверка на истории: прогноз по реке лучше persistence и предупреждает об опасности раньше локального тренда', async () => {
    const s = await simApp();
    await s.post('/api/simulation/start', { scenarioId: 'RAPID_FLOOD', seed: 42, virtualStart: START });
    await s.run();
    const { body } = await s.get('/api/outlook/verification?leadH=24');
    expect(body.leadH).toBe(24);
    const by = Object.fromEntries(body.items.map((x: { code: string }) => [x.code, x]));
    for (const code of ['QRG-02', 'QRG-03', 'QRG-04']) {
      const v = by[code];
      expect(v.method, code).toBe('ROUTED');
      expect(v.samples, code).toBeGreaterThan(100);
      expect(v.skill, code).toBeGreaterThan(0.5);
      expect(v.maeCm, code).toBeLessThan(v.persistenceMaeCm);
      expect(v.danger.outlookLeadH, code).toBeGreaterThan(2 * v.danger.localTrendLeadH);
    }
    // Петропавловск: местный приток модель не знает — ошибка заметно больше, чем у Явленки (честная неидеальность).
    expect(by['QRG-03'].maeCm).toBeGreaterThan(by['QRG-02'].maeCm);
    // Исток: прогноз по реке невозможен (выше станций нет) — только короткий тренд.
    expect(by['QRG-01'].method).toBe('TREND');
  });

  it('администратор меняет время добегания → горизонт прогноза меняется сразу', async () => {
    const s = await simApp();
    await s.post('/api/simulation/start', { scenarioId: 'NORMAL', virtualStart: START });
    await s.run(5);
    const before = (await s.get('/api/outlook')).body.outlook.stations.find((x: St) => x.code === 'QRG-02');
    expect(before.horizonH).toBe(51);
    await s.app.inject({ method: 'PATCH', url: '/api/admin/stations/2', headers: { cookie: s.admin }, payload: { travelHours: 30 } });
    const after = (await s.get('/api/outlook')).body.outlook.stations.find((x: St) => x.code === 'QRG-02');
    expect(after.horizonH).toBe(30);
  });
});
