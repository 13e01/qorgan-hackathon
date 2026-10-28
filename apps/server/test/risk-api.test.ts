// API оценки риска на проверочных данных (src/db/fixture.ts). Ожидаемые числа вычислены вручную.

import { describe, expect, it } from 'vitest';
import { FIXTURE_AS_OF, insertFixture } from '../src/db/fixture';
import { login, testApp, testDb } from './helpers';

async function fixtureApp() {
  const db = testDb();
  const runId = insertFixture(db);
  const ctx = await testApp(db);
  return { ...ctx, runId };
}

const get = async (app: Awaited<ReturnType<typeof testApp>>['app'], url: string, cookie?: string) =>
  app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

describe('GET /api/stations/:id/risk', () => {
  it('без измерений: 200, данных нет, риск LOW, прогон не выбран', async () => {
    const { app } = await testApp();
    const res = await get(app, '/api/stations/1/risk');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ runId: null, risk: 'LOW', score: 0, dataQuality: { status: 'NO_DATA', confidence: 'LOW' } });
    expect(body.level.currentCm).toBeNull();
  });

  it('проверочные данные: QRG-01 HIGH, QRG-02 MEDIUM, QRG-03 LOW, QRG-04 MEDIUM', async () => {
    const { app, runId } = await fixtureApp();
    const expected: Array<[string, string, number, number]> = [
      ['QRG-01', 'HIGH', 10, 580],
      ['QRG-02', 'MEDIUM', 3, 300],
      ['QRG-03', 'LOW', 1, 340],
      ['QRG-04', 'MEDIUM', 2, 415],
    ];
    for (const [code, risk, score, levelCm] of expected) {
      const res = await get(app, `/api/stations/${code}/risk`);
      expect(res.statusCode, code).toBe(200);
      const body = res.json();
      expect(body, code).toMatchObject({
        station: { code },
        runId,
        asOf: FIXTURE_AS_OF,
        risk,
        score,
        maxScore: 12,
        level: { currentCm: levelCm, measuredAt: FIXTURE_AS_OF, ageH: 0 },
        model: { id: 'QORGAN-RULES-1', demo: true, configVersion: 1 },
      });
    }
  });

  it('станцию можно указать по id и по коду; самые важные причины идут первыми', async () => {
    const { app } = await fixtureApp();
    const byId = (await get(app, '/api/stations/1/risk')).json();
    const byCode = (await get(app, '/api/stations/qrg-01/risk')).json();
    // computedAt и context.realTime — реальное время ответа, у двух запросов оно может отличаться.
    const strip = (b: Record<string, any>) => ({ ...b, computedAt: null, context: { ...b.context, realTime: null } });
    expect(strip(byId)).toEqual(strip(byCode));
    expect(byId.topReasons).toEqual([
      { code: 'LEVEL_ABOVE_DANGER', params: { levelCm: 580, dangerCm: 550 } },
      { code: 'RISING', params: { rateCmH: 20 } },
      { code: 'HEAVY_RAIN', params: { mm: 24, hours: 6 } },
    ]);
    expect(byId.trend).toEqual({ direction: 'RISING', rateCmH: 20 });
  });

  it('неизвестная станция → 404 STATION_NOT_FOUND', async () => {
    const { app } = await testApp();
    for (const id of ['999', 'QRG-99']) {
      const res = await get(app, `/api/stations/${id}/risk`);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('STATION_NOT_FOUND');
    }
  });
});

describe('GET /api/stations/:id/risk/explanation', () => {
  it('QRG-01: вклад каждого фактора, сумма = 10 баллов', async () => {
    const { app } = await fixtureApp();
    const body = (await get(app, '/api/stations/QRG-01/risk/explanation')).json();
    expect(body.factors.map((f: { code: string; points: number; value: number }) => [f.code, f.points, f.value])).toEqual([
      ['LEVEL', 4, 580],
      ['TREND', 3, 20],
      ['RAIN', 2, 24],
      ['MELT', 1, 6],
      ['UPSTREAM', 0, null],
    ]);
    expect(body.factors.reduce((s: number, f: { points: number }) => s + f.points, 0)).toBe(body.score);
    expect(body.dataQuality).toEqual({ status: 'OK', confidence: 'HIGH', pointsExcluded: 0, issues: [] });
  });

  it('QRG-02: MEDIUM из-за волны с QRG-01 (51 ч) и потепления, хотя уровень воды обычный', async () => {
    const { app } = await fixtureApp();
    const body = (await get(app, '/api/stations/QRG-02/risk/explanation')).json();
    expect(body.reasons).toEqual([
      { code: 'UPSTREAM_WAVE', params: { station: 'QRG-01', risk: 'HIGH', hours: 51 } },
      { code: 'SNOWMELT', params: { tempC: 6, hours: 24 } },
    ]);
  });

  it('QRG-04: выброс 545 см отброшен, скорость −5 см/ч, датчиков осадков и температуры нет', async () => {
    const { app } = await fixtureApp();
    const body = (await get(app, '/api/stations/QRG-04/risk/explanation')).json();
    expect(body.trend).toMatchObject({ direction: 'FALLING', rateCmH: -5, pointsUsed: 5 });
    expect(body.dataQuality).toEqual({
      status: 'DEGRADED',
      confidence: 'MEDIUM',
      pointsExcluded: 1,
      issues: [{ code: 'SPIKE_IGNORED', params: { count: 1 } }],
    });
    const status = Object.fromEntries(body.factors.map((f: { code: string; status: string }) => [f.code, f.status]));
    expect(status).toEqual({ LEVEL: 'OK', TREND: 'OK', RAIN: 'NO_SENSOR', MELT: 'NO_SENSOR', UPSTREAM: 'OK' });
    expect(body).not.toHaveProperty('forecast');
  });
});

describe('GET /api/stations/:id/forecast и права доступа', () => {
  it('гость → 401; оператор и админ → 200', async () => {
    const { app } = await fixtureApp();
    expect((await get(app, '/api/stations/QRG-01/forecast')).statusCode).toBe(401);
    const operator = await login(app, 'operator', 'operator-test-pass');
    const admin = await login(app, 'admin', 'admin-test-pass');
    expect((await get(app, '/api/stations/QRG-01/forecast', operator)).statusCode).toBe(200);
    expect((await get(app, '/api/stations/QRG-01/forecast', admin)).statusCode).toBe(200);
  });

  it('QRG-01: прогноз на 3 ч = 580 + 3·20 = 640 см; порог уже превышен', async () => {
    const { app } = await fixtureApp();
    const operator = await login(app, 'operator', 'operator-test-pass');
    const body = (await get(app, '/api/stations/QRG-01/forecast', operator)).json();
    expect(body.forecast).toEqual({ status: 'OK', horizonH: 3, levelCm: 640, lowCm: 640, highCm: 640 });
    expect(body.eta).toEqual({ status: 'ALREADY_EXCEEDED', hours: 0, lowH: 0, highH: 0 });
  });

  it('QRG-04: спад → прогноз 400 см, превышение не ожидается', async () => {
    const { app } = await fixtureApp();
    const operator = await login(app, 'operator', 'operator-test-pass');
    const body = (await get(app, '/api/stations/QRG-04/forecast', operator)).json();
    expect(body.forecast.levelCm).toBe(400);
    expect(body.eta).toEqual({ status: 'NOT_EXPECTED', hours: null, lowH: null, highH: null });
  });

  it('оценка на прошлый момент (at = 06:00) использует только данные до 06:00', async () => {
    const { app, runId } = await fixtureApp();
    const operator = await login(app, 'operator', 'operator-test-pass');
    const at = '2026-04-02T06:00:00.000Z';
    const body = (await get(app, `/api/stations/QRG-01/forecast?runId=${runId}&at=${at}`, operator)).json();
    // В 06:00 уровень 460 см, рост 20 см/ч → до 550 см: (550 − 460) / 20 = 4.5 ч.
    expect(body.asOf).toBe(at);
    expect(body.level.currentCm).toBe(460);
    expect(body.eta).toEqual({ status: 'ESTIMATED', hours: 4.5, lowH: 4.5, highH: 4.5 });
    expect(body.forecast.levelCm).toBe(520);
    const risk = (await get(app, `/api/stations/QRG-01/risk?at=${at}`, operator)).json();
    expect([risk.risk, risk.score]).toEqual(['HIGH', 6]); // 2 (≥W) + 3 (ETA ≤ 6 ч) + 0 (дождя ещё не было) + 1 (+6 °C)
  });

  it('гостю недоступны runId и at → 401; неверные параметры → 400; неизвестный прогон → 404', async () => {
    const { app } = await fixtureApp();
    expect((await get(app, '/api/stations/1/risk?at=2026-04-02T06:00:00Z')).statusCode).toBe(401);
    const operator = await login(app, 'operator', 'operator-test-pass');
    for (const q of ['at=yesterday', 'runId=abc', 'runId=-1']) {
      const res = await get(app, `/api/stations/1/risk?${q}`, operator);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION');
    }
    const missing = await get(app, '/api/stations/1/risk?runId=999', operator);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('RUN_NOT_FOUND');
  });

  it('изменённые администратором коэффициенты применяются сразу', async () => {
    const { app, db } = await fixtureApp();
    const stored = JSON.parse(String(db.prepare('SELECT json FROM risk_config').get()?.json));
    stored.points.upstreamHigh = 0;
    db.prepare('UPDATE risk_config SET json = ?, version = 2').run(JSON.stringify(stored));
    const body = (await get(app, '/api/stations/QRG-02/risk')).json();
    expect([body.risk, body.score, body.model.configVersion]).toEqual(['LOW', 1, 2]);
  });
});

describe('надёжность ответов', () => {
  it('во всех ответах нет NaN/Infinity (JSON их не допускает — проверяем, что числа конечные)', async () => {
    const { app } = await fixtureApp();
    const operator = await login(app, 'operator', 'operator-test-pass');
    const walk = (x: unknown): void => {
      if (typeof x === 'number') expect(Number.isFinite(x)).toBe(true);
      else if (x && typeof x === 'object') Object.values(x).forEach(walk);
    };
    for (const code of ['QRG-01', 'QRG-02', 'QRG-03', 'QRG-04']) {
      for (const path of ['risk', 'risk/explanation', 'forecast']) {
        const res = await get(app, `/api/stations/${code}/${path}`, operator);
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toMatch(/NaN|Infinity/);
        walk(res.json());
      }
    }
  });

  it('повторная запись проверочных данных не создаёт дублей', async () => {
    const { db } = await fixtureApp();
    insertFixture(db);
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM sim_runs WHERE scenario_id = 'TEST_FIXTURE'").get()?.n)).toBe(1);
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM measurements').get()?.n)).toBe(12 * (3 + 3 + 3 + 1));
  });
});
