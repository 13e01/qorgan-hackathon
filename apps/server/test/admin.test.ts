// T6 / Genesis: панель администратора (ТЗ §5.7). Проверяем не только CRUD, но и то, что изменения влияют на систему:
// новая станция получает данные симулятора, новый порог меняет оценку, токен устройства принимается POST /api/telemetry.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { login, testDb } from './helpers';
import { simApp } from './sim-helpers';

const START = '2026-04-10T00:00:00.000Z';

async function req(app: Awaited<ReturnType<typeof simApp>>['app'], method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, cookie: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

describe('доступ к администрированию', () => {
  it('гость → 401, оператор → 403, администратор → 200 на всех разделах', async () => {
    const s = await simApp();
    for (const url of ['/api/admin/stations', '/api/admin/users', '/api/admin/risk-config', '/api/admin/sources', '/api/admin/device-log', '/api/admin/audit']) {
      expect((await req(s.app, 'GET', url, '')).status, url).toBe(401);
      expect((await req(s.app, 'GET', url, s.operator)).status, url).toBe(403);
      expect((await req(s.app, 'GET', url, s.admin)).status, url).toBe(200);
    }
    expect((await req(s.app, 'POST', '/api/admin/stations', s.operator, { code: 'QRG-09' })).status).toBe(403);
  });
});

describe('станции', () => {
  it('создание станции ниже по течению → она в списке, на карте и получает данные симулятора; аудит записан', async () => {
    const s = await simApp();
    const created = await req(s.app, 'POST', '/api/admin/stations', s.admin, {
      code: 'QRG-05', name: 'Новая', stationType: 'hydro', lat: 55.2, lon: 69.3, upstreamCode: 'QRG-04', travelHours: 10, attenuation: 0.9, responseHours: 2, baseLevelCm: 250,
    });
    expect(created.status).toBe(201);
    expect(created.body.station).toMatchObject({ code: 'QRG-05', upstreamCode: 'QRG-04', status: 'active', parameters: [{ code: 'water_level', warning: null, danger: null }] });

    const pub = await req(s.app, 'GET', '/api/stations', '');
    expect(pub.body.items.map((x: { code: string }) => x.code)).toContain('QRG-05');

    await req(s.app, 'PUT', `/api/admin/stations/${created.body.station.id}/parameters`, s.admin, { parameters: [{ code: 'water_level', warning: 350, danger: 450 }] });
    const { body } = await s.post('/api/simulation/start', { scenarioId: 'NORMAL', virtualStart: START });
    await s.run(5);
    const n = s.db.prepare("SELECT COUNT(*) AS n FROM measurements m JOIN stations st ON st.id = m.station_id WHERE st.code = 'QRG-05' AND m.run_id = ?").get(body.run.id);
    expect(Number(n?.n)).toBe(5);
    const risk = await req(s.app, 'GET', '/api/stations/QRG-05/risk', '');
    expect(risk.body.risk).toBe('LOW');

    const audit = await req(s.app, 'GET', '/api/admin/audit', s.admin);
    expect(audit.body.items.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['STATION_CREATE', 'STATION_PARAMETERS']));
    expect(audit.body.items.find((a: { action: string }) => a.action === 'STATION_CREATE')).toMatchObject({ user: 'admin', entityId: String(created.body.station.id) });
  });

  it('проверки: занятый код, нет станции выше, кольцо в цепочке, порог W ≥ D, неизвестный показатель', async () => {
    const s = await simApp();
    const base = { name: 'Пост', stationType: 'hydro', lat: 54, lon: 69 };
    expect((await req(s.app, 'POST', '/api/admin/stations', s.admin, { ...base, code: 'QRG-01' })).body.error.code).toBe('STATION_CODE_TAKEN');
    expect((await req(s.app, 'POST', '/api/admin/stations', s.admin, { ...base, code: 'QRG-06', upstreamCode: 'NOPE', travelHours: 3 })).body.error.code).toBe('UPSTREAM_NOT_FOUND');
    expect((await req(s.app, 'POST', '/api/admin/stations', s.admin, { ...base, code: 'QRG-06', upstreamCode: 'QRG-04' })).body.error.code).toBe('TRAVEL_HOURS_REQUIRED');
    expect((await req(s.app, 'POST', '/api/admin/stations', s.admin, { ...base, code: 'bad code' })).status).toBe(400);
    expect((await req(s.app, 'POST', '/api/admin/stations', s.admin, { ...base, code: 'QRG-07', lat: 120 })).status).toBe(400);
    // QRG-01 не может стать ниже QRG-04: QRG-04 сам ниже QRG-01.
    expect((await req(s.app, 'PATCH', '/api/admin/stations/1', s.admin, { upstreamCode: 'QRG-04', travelHours: 5 })).body.error.code).toBe('UPSTREAM_CYCLE');
    expect((await req(s.app, 'PUT', '/api/admin/stations/1/parameters', s.admin, { parameters: [{ code: 'water_level', warning: 600, danger: 550 }] })).body.error.code).toBe('THRESHOLD_ORDER');
    expect((await req(s.app, 'PUT', '/api/admin/stations/1/parameters', s.admin, { parameters: [{ code: 'humidity' }] })).status).toBe(400);
    expect((await req(s.app, 'PATCH', '/api/admin/stations/999', s.admin, { name: 'Пост' })).status).toBe(404);
  });

  it('новый порог меняет оценку риска со следующего расчёта', async () => {
    const s = await simApp();
    await s.post('/api/simulation/runs', { scenarioId: 'NORMAL', virtualStart: START, params: { levelNoiseCm: 0, levelDailyAmplitudeCm: 0 } });
    for (let i = 0; i < 4; i += 1) await s.post('/api/simulation/step');
    expect((await req(s.app, 'GET', '/api/stations/QRG-01/risk', '')).body.risk).toBe('LOW');
    // Уровень QRG-01 ≈ 300 см. Опасный порог 290 → уровень уже выше опасного.
    const put = await req(s.app, 'PUT', '/api/admin/stations/1/parameters', s.admin, {
      parameters: [{ code: 'water_level', warning: 250, danger: 290 }, { code: 'precipitation' }, { code: 'air_temp' }],
    });
    expect(put.status).toBe(200);
    expect((await req(s.app, 'GET', '/api/stations/QRG-01/risk', '')).body.risk).toBe('HIGH');
    await s.post('/api/simulation/step');
    const alerts = await s.get('/api/alerts');
    expect(alerts.body.items.find((a: { stationCode: string }) => a.stationCode === 'QRG-01')).toMatchObject({ severity: 'HIGH', trigger: 'DANGER_LEVEL' });
  });

  it('отключение станции: статус disabled, история сохранена, симулятор её больше не опрашивает', async () => {
    const s = await simApp();
    const { body } = await s.post('/api/simulation/start', { scenarioId: 'NORMAL', virtualStart: START });
    await s.run(3);
    const del = await req(s.app, 'DELETE', '/api/admin/stations/4', s.admin);
    expect(del.body.station.status).toBe('disabled');
    await s.run(3);
    const ticks = s.db.prepare('SELECT MAX(tick) AS t, COUNT(*) AS n FROM measurements WHERE run_id = ? AND station_id = 4').get(body.run.id);
    expect(Number(ticks?.n)).toBe(3);
    expect(Number(ticks?.t)).toBe(2);
  });

  it('токен устройства: показывается один раз, в БД только хеш; устройство передаёт показание своей станции', async () => {
    const s = await simApp();
    const tok = await req(s.app, 'POST', '/api/admin/stations/2/token', s.admin);
    expect(tok.body.token).toMatch(/^qd_/);
    const stored = s.db.prepare('SELECT device_token_hash FROM stations WHERE id = 2').get();
    expect(String(stored?.device_token_hash)).not.toContain(tok.body.token);
    expect(JSON.stringify((await req(s.app, 'GET', '/api/admin/audit', s.admin)).body)).not.toContain(tok.body.token);

    await s.post('/api/simulation/runs', { scenarioId: 'NORMAL', virtualStart: START });
    await s.post('/api/simulation/step');
    await s.post('/api/simulation/step');
    // Показание устройства между тиками симулятора (00:30) — своё время измерения, не дубль.
    const DEVICE_AT = '2026-04-10T00:30:00.000Z';
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/telemetry',
      headers: { 'x-device-token': tok.body.token },
      payload: { records: [{ stationCode: 'QRG-02', parameter: 'water_level', value: 281.5, unit: 'cm', measuredAt: DEVICE_AT }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 1 });
    const wrong = await s.app.inject({
      method: 'POST',
      url: '/api/telemetry',
      headers: { 'x-device-token': tok.body.token },
      payload: { records: [{ stationCode: 'QRG-03', parameter: 'water_level', value: 300, unit: 'cm', measuredAt: DEVICE_AT }] },
    });
    expect(wrong.json().rejected).toEqual([{ index: 0, code: 'STATION_MISMATCH' }]);
    const sources = await req(s.app, 'GET', '/api/admin/sources', s.admin);
    expect(sources.body.items.find((x: { code: string }) => x.code === 'QRG-02')).toMatchObject({ hasDeviceToken: true, rejected24h: 1 });
  });
});

describe('коэффициенты модели', () => {
  it('изменение коэффициента: версия растёт, следующая оценка использует новое значение; несогласованные значения отклоняются', async () => {
    const s = await simApp();
    const before = await req(s.app, 'GET', '/api/admin/risk-config', s.admin);
    expect(before.body).toMatchObject({ version: 1, config: { categories: { highScore: 5, mediumScore: 2 } } });

    const put = await req(s.app, 'PUT', '/api/admin/risk-config', s.admin, { categories: { mediumScore: 1 } });
    expect(put.body).toMatchObject({ version: 2, config: { categories: { highScore: 5, mediumScore: 1 } } });
    const bad = await req(s.app, 'PUT', '/api/admin/risk-config', s.admin, { categories: { mediumScore: 6 } });
    expect(bad.body.error.code).toBe('RISK_CONFIG_INCONSISTENT');
    expect((await req(s.app, 'PUT', '/api/admin/risk-config', s.admin, { windowSize: 'big' })).status).toBe(400);
    expect((await req(s.app, 'PUT', '/api/admin/risk-config', s.admin, { unknownField: 1 })).status).toBe(400);

    await s.post('/api/simulation/runs', { scenarioId: 'NORMAL', virtualStart: START });
    for (let i = 0; i < 4; i += 1) await s.post('/api/simulation/step');
    const exp = await req(s.app, 'GET', '/api/stations/QRG-01/risk/explanation', '');
    expect(exp.body.assessment?.model?.configVersion ?? exp.body.model?.configVersion).toBe(2);
  });
});

describe('пользователи', () => {
  it('создание → вход; смена роли закрывает сессию; отключение блокирует вход; последнего админа не понизить', async () => {
    const s = await simApp();
    const created = await req(s.app, 'POST', '/api/admin/users', s.admin, { username: 'duty1', password: 'duty-pass-123', role: 'operator' });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain('duty-pass-123');
    expect((await req(s.app, 'POST', '/api/admin/users', s.admin, { username: 'duty1', password: 'duty-pass-123', role: 'operator' })).body.error.code).toBe('USERNAME_TAKEN');
    expect((await req(s.app, 'POST', '/api/admin/users', s.admin, { username: 'duty2', password: 'short', role: 'operator' })).status).toBe(400);

    const cookie = await login(s.app, 'duty1', 'duty-pass-123');
    expect((await req(s.app, 'GET', '/api/auth/me', cookie)).body.user.role).toBe('operator');
    await req(s.app, 'PATCH', `/api/admin/users/${created.body.user.id}`, s.admin, { role: 'admin' });
    expect((await req(s.app, 'GET', '/api/auth/me', cookie)).body.user).toBeNull();

    await req(s.app, 'PATCH', `/api/admin/users/${created.body.user.id}`, s.admin, { isActive: false });
    const denied = await s.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'duty1', password: 'duty-pass-123' } });
    expect(denied.statusCode).toBe(401);

    const adminId = Number(s.db.prepare("SELECT id FROM users WHERE username = 'admin'").get()?.id);
    expect((await req(s.app, 'PATCH', `/api/admin/users/${adminId}`, s.admin, { role: 'operator' })).body.error.code).toBe('LAST_ADMIN');
    expect((await req(s.app, 'DELETE', `/api/admin/users/${adminId}`, s.admin)).body.error.code).toBe('SELF_DELETE');
  });

  it('удаление: без истории — удаляется; с историей действий — 409, предлагается отключить', async () => {
    const s = await simApp();
    const fresh = await req(s.app, 'POST', '/api/admin/users', s.admin, { username: 'temp', password: 'temp-pass-123', role: 'operator' });
    expect((await req(s.app, 'DELETE', `/api/admin/users/${fresh.body.user.id}`, s.admin)).body).toEqual({ deleted: fresh.body.user.id });
    await s.post('/api/simulation/runs', { scenarioId: 'NORMAL', virtualStart: START });
    const opId = Number(s.db.prepare("SELECT id FROM users WHERE username = 'operator'").get()?.id);
    expect((await req(s.app, 'DELETE', `/api/admin/users/${opId}`, s.admin)).body.error.code).toBe('USER_HAS_HISTORY');
  });
});

describe('источники и резервная копия', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('состояние источников: IDLE без прогона, ONLINE во время хода, STALE/OFFLINE при молчании', async () => {
    const s = await simApp();
    let src = await req(s.app, 'GET', '/api/admin/sources', s.admin);
    expect(src.body.items.every((x: { link: string }) => x.link === 'IDLE')).toBe(true);
    await s.post('/api/simulation/start', { scenarioId: 'NORMAL', virtualStart: START, tickMs: 1000 });
    await s.run(2);
    src = await req(s.app, 'GET', '/api/admin/sources', s.admin);
    expect(src.body.items.every((x: { link: string }) => x.link === 'ONLINE')).toBe(true);
    s.clock.advance(5000);
    expect((await req(s.app, 'GET', '/api/admin/sources', s.admin)).body.items[0].link).toBe('STALE');
    s.clock.advance(20_000);
    expect((await req(s.app, 'GET', '/api/admin/sources', s.admin)).body.items[0].link).toBe('OFFLINE');
  });

  it('резервная копия создаёт файл и не раскрывает путь на сервере', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qorgan-bak-'));
    dirs.push(dir);
    const app = await buildApp({ db: testDb(), sessionSecret: 'x'.repeat(40), sessionTtlHours: 1, backupDir: dir });
    const cookie = await login(app, 'admin', 'admin-test-pass');
    const res = await app.inject({ method: 'POST', url: '/api/admin/backup', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().file).toMatch(/^qorgan-\d{8}-\d{6}-\d{3}(-\d+)?\.db$/);
    expect(res.body).not.toContain(dir.replace(/\\/g, '\\\\'));
    expect(readdirSync(dir)).toHaveLength(1);
    // Вторая копия в ту же секунду — не ошибка 500, а отдельный файл.
    const again = await app.inject({ method: 'POST', url: '/api/admin/backup', headers: { cookie } });
    expect(again.statusCode).toBe(200);
    expect(readdirSync(dir)).toHaveLength(2);
    await app.close();
  });
});
