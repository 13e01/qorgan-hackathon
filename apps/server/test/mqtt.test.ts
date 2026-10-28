// Внешний датчик через MQTT: логика адаптера (управляемые часы) и настоящая передача по TCP через брокер.
// Путь: сообщение MQTT → адаптер → POST /api/telemetry → SQLite → риск T2 → предупреждения → снимок WebSocket.

import { createHash } from 'node:crypto';
import mqtt from 'mqtt';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { migrate, openDb, type Db } from '../src/db/connection';
import { seed } from '../src/db/seed';
import { startBroker } from '../src/mqtt/broker';
import { telemetryTopic } from '../src/mqtt/protocol';
import { buildSnapshot } from '../src/realtime/snapshot';
import { TEST_USERS } from './helpers';
import { simApp, TestClock } from './sim-helpers';

const DEVICE = 'PY-TEST-01';
const TOKEN = 'device-test-token-1234567890';
const SERVICE = { username: 'qorgan-server', password: 'service-test-password-123' };
const HOUR_MS = 2000;

function sensorDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  seed(db, TEST_USERS, [{ deviceId: DEVICE, name: 'Тестовый датчик', stationCode: 'QRG-03', token: TOKEN }]);
  return db;
}

const message = (over: Record<string, unknown> = {}) => ({
  v: 1, deviceId: DEVICE, stationId: 'QRG-03', type: 'water_level', value: 320, unit: 'cm',
  timestamp: new Date().toISOString(), seq: 1, bootId: 'boot-aaaa', source: 'PYTHON_SENSOR', mode: 'NORMAL', ...over,
});

const deviceRows = (db: Db, runId: number) =>
  db
    .prepare("SELECT m.value, m.measured_at, m.source, m.tick FROM measurements m JOIN stations s ON s.id = m.station_id WHERE s.code = 'QRG-03' AND m.run_id = ? ORDER BY m.tick")
    .all(runId);

describe('MQTT-адаптер (логика, управляемые часы)', () => {
  async function setup() {
    const clock = new TestClock();
    const s = await simApp(sensorDb(), clock);
    let seq = 0;
    const send = (over: Record<string, unknown> = {}, packet: { retain?: boolean } = {}) => {
      seq += 1;
      return s.app.sensorAdapter.handle(telemetryTopic(DEVICE), Buffer.from(JSON.stringify(message({ seq, timestamp: clock.now().toISOString(), ...over }))), packet);
    };
    return { s, clock, send };
  }

  it('без режима внешних датчиков показания не записываются: нет прогона → NO_EXTERNAL_RUN, идёт симуляция → SOURCE_CONFLICT', async () => {
    const { s, send } = await setup();
    expect(await send()).toBe('NO_EXTERNAL_RUN');
    const { body } = await s.post('/api/simulation/start', { scenarioId: 'NORMAL', virtualStart: '2026-04-10T00:00:00.000Z' });
    await s.run(3);
    expect(await send()).toBe('SOURCE_CONFLICT');
    // Симулятор продолжает работать, его данные не смешиваются с датчиком.
    expect(deviceRows(s.db, body.run.id).every((r) => r.source === 'simulator')).toBe(true);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM device_log WHERE code = 'MQTT_SOURCE_CONFLICT'").get()?.n).toBe(1);
  });

  it('режим внешних датчиков: показание проходит обычный приём, часы прогона идут по показаниям, снимок показывает устройство', async () => {
    const { s, clock, send } = await setup();
    const started = await s.post('/api/simulation/external/start', { hourMs: HOUR_MS });
    expect(started.body).toMatchObject({ state: 'RUNNING', dataSource: 'EXTERNAL_SENSOR', run: { scenarioId: 'EXTERNAL_SENSORS', tickMs: HOUR_MS } });
    const runId = started.body.run.id;
    for (let i = 0; i < 4; i += 1) {
      expect(await send({ value: 320 + i })).toBe('ACCEPTED');
      clock.advance(HOUR_MS);
    }
    const rows = deviceRows(s.db, runId);
    expect(rows.map((r) => [r.tick, r.value, r.source])).toEqual([[0, 320, 'device'], [1, 321, 'device'], [2, 322, 'device'], [3, 323, 'device']]);
    // Время измерения — часы модели (1 час = 2 с реального времени), а не реальное время.
    expect(new Date(String(rows[1]!.measured_at)).getTime() - new Date(String(rows[0]!.measured_at)).getTime()).toBe(3_600_000);
    const snap = buildSnapshot(s.db, s.app.simulation, clock.now().toISOString());
    expect(snap.simulation.dataSource).toBe('EXTERNAL_SENSOR');
    expect(snap.devices[0]).toMatchObject({ deviceId: DEVICE, stationCode: 'QRG-03', lastValue: 323, accepted: 4, lastResult: 'ACCEPTED' });
    expect(snap.stations.find((x) => x.code === 'QRG-03')!.latest.water_level).toMatchObject({ value: 323, source: 'device' });
    // Другие станции без датчика — без данных (симулятор их не заполняет).
    expect(snap.stations.find((x) => x.code === 'QRG-01')!.latest.water_level).toBeUndefined();
  });

  it('повторная доставка не дублирует; новый запуск датчика (другой bootId) принимается', async () => {
    const { s, clock, send } = await setup();
    const { body } = await s.post('/api/simulation/external/start', { hourMs: HOUR_MS });
    expect(await send({ seq: 7, bootId: 'boot-1111' })).toBe('ACCEPTED');
    clock.advance(HOUR_MS);
    expect(await send({ seq: 7, bootId: 'boot-1111' })).toBe('DUPLICATE');
    expect(await send({ seq: 5, bootId: 'boot-1111' })).toBe('DUPLICATE');
    expect(await send({ seq: 1, bootId: 'boot-2222' })).toBe('ACCEPTED');
    expect(deviceRows(s.db, body.run.id)).toHaveLength(2);
  });

  it('отклоняются: подмена устройства, чужая станция, будущее, устаревшее, слишком часто, retain, не JSON, неверный формат, вне диапазона', async () => {
    const { s, clock, send } = await setup();
    await s.post('/api/simulation/external/start', { hourMs: HOUR_MS });
    const t = (ms: number) => new Date(clock.now().getTime() + ms).toISOString();
    expect(await send({ deviceId: 'OTHER-DEVICE' })).toBe('SPOOFED_DEVICE');
    expect(await send({ stationId: 'QRG-01' })).toBe('STATION_MISMATCH');
    expect(await send({ timestamp: t(120_000) })).toBe('FUTURE');
    expect(await send({ timestamp: t(-10 * 60_000) })).toBe('STALE');
    expect(await send({}, { retain: true })).toBe('RETAINED');
    expect(await s.app.sensorAdapter.handle(telemetryTopic(DEVICE), Buffer.from('not json'))).toBe('BAD_JSON');
    expect(await send({ value: 'high' })).toBe('BAD_FORMAT');
    expect(await send({ unit: 'm' })).toBe('BAD_FORMAT');
    expect(await send({ value: 99999 })).toBe('REJECTED');
    expect(await send()).toBe('ACCEPTED');
    clock.advance(100);
    expect(await send()).toBe('RATE_LIMITED');
    expect(await s.app.sensorAdapter.handle(telemetryTopic('UNKNOWN-1'), Buffer.from(JSON.stringify(message({ deviceId: 'UNKNOWN-1' }))))).toBe('UNKNOWN_DEVICE');
    const dev = buildSnapshot(s.db, s.app.simulation, clock.now().toISOString()).devices[0]!;
    expect(dev.accepted).toBe(1);
    expect(dev.rejected).toBeGreaterThanOrEqual(10);
  });

  it('режим DANGER: быстрый подъём → модель риска T2 поднимает оценку и создаёт предупреждение с причиной', async () => {
    const { s, clock, send } = await setup();
    const { body } = await s.post('/api/simulation/external/start', { hourMs: HOUR_MS });
    let level = 320;
    for (let i = 0; i < 6; i += 1) {
      await send({ value: level + (i % 2 ? 0.5 : -0.5), mode: 'NORMAL' });
      clock.advance(HOUR_MS);
    }
    expect((await s.get('/api/stations/QRG-03/risk', '')).body.risk).toBe('LOW');
    for (let i = 0; i < 16; i += 1) {
      level += 18;
      expect(await send({ value: level, mode: 'DANGER' })).toBe('ACCEPTED');
      clock.advance(HOUR_MS);
    }
    const risk = await s.get('/api/stations/QRG-03/risk', '');
    expect(risk.body.risk).toBe('HIGH');
    const alerts = (await s.get(`/api/alerts?runId=${body.run.id}`)).body.items;
    const own = alerts.filter((a: { stationCode: string }) => a.stationCode === 'QRG-03');
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ severity: 'HIGH', trigger: 'DANGER_LEVEL' });
    expect(own[0].reasons.map((r: { code: string }) => r.code)).toContain('LEVEL_ABOVE_DANGER');
    // Ниже по течению (Соколовка) — предупреждение об угрозе сверху: модель T2 передаёт опасность по цепочке станций.
    const downstream = alerts.find((a: { stationCode: string }) => a.stationCode === 'QRG-04');
    expect(downstream.reasons.map((r: { code: string }) => r.code)).toContain('UPSTREAM_WAVE');
  });

  it('команды симулятора к режиму датчиков неприменимы; остановка закрывает режим; после перезапуска режим продолжается', async () => {
    const { s } = await setup();
    await s.post('/api/simulation/external/start', { hourMs: HOUR_MS });
    for (const cmd of ['pause', 'step', 'resume']) expect((await s.post(`/api/simulation/${cmd}`)).body.error.code, cmd).toBe('EXTERNAL_RUN');
    expect((await s.post('/api/simulation/start', { scenarioId: 'NORMAL' })).body.error.code).toBe('EXTERNAL_RUN');
    expect((await s.post('/api/simulation/external/start', {})).body.error.code).toBe('ACTIVE_RUN_EXISTS');
    expect((await s.post('/api/simulation/external/start', {}, '')).status).toBe(401);
    // Перезапуск сервера: встроенные прогоны встают на паузу, а режим датчиков (без таймера) продолжает приём.
    expect(s.app.simulation.recover()).toEqual([]);
    expect(s.app.simulation.state().state).toBe('RUNNING');
    const stop = await s.post('/api/simulation/stop');
    expect(stop.body.state).toBe('STOPPED');
  });

  it('администратор: регистрирует устройство (токен один раз, в БД — хеш), отключает — показания отклоняются', async () => {
    const { s, send } = await setup();
    const req = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
      s.app.inject({ method, url, headers: { cookie: s.admin }, ...(payload ? { payload } : {}) }).then((r) => ({ status: r.statusCode, body: r.json() }));
    const created = await req('POST', '/api/admin/devices', { deviceId: 'PY-SENSOR-77', name: 'Второй датчик', stationCode: 'QRG-02' });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^qs_/);
    const stored = s.db.prepare("SELECT token_hash FROM devices WHERE device_id = 'PY-SENSOR-77'").get();
    expect(String(stored?.token_hash)).toBe(createHash('sha256').update(created.body.token).digest('hex'));
    expect((await s.app.inject({ method: 'GET', url: '/api/admin/devices', headers: { cookie: s.operator } })).statusCode).toBe(403);
    await s.post('/api/simulation/external/start', { hourMs: HOUR_MS });
    const id = (await req('GET', '/api/admin/devices')).body.items.find((d: { deviceId: string }) => d.deviceId === DEVICE).id;
    await req('PATCH', `/api/admin/devices/${id}`, { status: 'disabled' });
    expect(await send()).toBe('DEVICE_DISABLED');
  });
});

describe('настоящая передача по MQTT (брокер + клиенты по TCP)', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0).reverse()) await c();
  });

  async function stack(port = 0) {
    const db = sensorDb();
    const deviceTokenHash = (id: string) => {
      const r = db.prepare("SELECT token_hash FROM devices WHERE device_id = ? AND status = 'active'").get(id);
      return r ? String(r.token_hash) : null;
    };
    const broker = await startBroker({ host: '127.0.0.1', port, service: SERVICE, deviceTokenHash });
    closers.push(broker.close);
    return { db, broker, deviceTokenHash };
  }

  const connect = (port: number, username?: string, password?: string) =>
    new Promise<mqtt.MqttClient>((resolve, reject) => {
      const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { username, password, reconnectPeriod: 0, connectTimeout: 3000 });
      c.once('connect', () => resolve(c));
      c.once('error', (e) => {
        c.end(true);
        reject(e);
      });
    });

  const until = async (cond: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return cond();
  };

  it('брокер: аноним и неверный пароль — отказ; устройство не может писать в чужой топик и подписываться', async () => {
    const { broker } = await stack();
    await expect(connect(broker.port)).rejects.toThrow();
    await expect(connect(broker.port, DEVICE, 'wrong-password')).rejects.toThrow();
    const dev = await connect(broker.port, DEVICE, TOKEN);
    const denied = await new Promise<boolean>((resolve) => dev.subscribe(telemetryTopic(DEVICE), { qos: 1 }, (err, granted) => resolve(Boolean(err) || granted?.[0]?.qos === 128)));
    expect(denied).toBe(true);
    dev.end(true);
  });

  it('датчик → брокер → подписчик QORGAN → SQLite → риск → WebSocket-снимок; чужой топик и retain не доходят; переподключение после перезапуска брокера', async () => {
    const { db, broker, deviceTokenHash } = await stack();
    const app = await buildApp({ db, sessionSecret: 'x'.repeat(40), sessionTtlHours: 1, mqtt: { url: `mqtt://127.0.0.1:${broker.port}`, ...SERVICE } });
    closers.push(() => app.close());
    const cookie = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'operator', password: 'operator-test-pass' } })).cookies.find((c) => c.name === 'qorgan_sid')!;
    await app.inject({ method: 'POST', url: '/api/simulation/external/start', headers: { cookie: `qorgan_sid=${cookie.value}` }, payload: { hourMs: 500 } });
    const snapMqtt = () => buildSnapshot(db, app.simulation, new Date().toISOString()).mqtt;
    expect(await until(() => app.sensorAdapter !== undefined && (app as unknown as { realtime: unknown }).realtime !== undefined)).toBe(true);

    const sensor = await connect(broker.port, DEVICE, TOKEN);
    const runId = Number(db.prepare('SELECT run_id FROM sim_control').get()?.run_id);
    const count = () => deviceRows(db, runId).length;
    // Подписчик подключается асинхронно — публикуем, пока не появится первое показание.
    let seq = 0;
    const publish = (client: mqtt.MqttClient, topic: string, value: number, opts: { retain?: boolean } = {}) =>
      new Promise<void>((resolve) => {
        seq += 1;
        client.publish(topic, JSON.stringify(message({ seq, value, timestamp: new Date().toISOString() })), { qos: 1, retain: opts.retain ?? false }, () => resolve());
      });
    expect(await until(() => {
      void publish(sensor, telemetryTopic(DEVICE), 321);
      return count() > 0;
    }, 8000)).toBe(true);
    void snapMqtt;

    // Попытка записать от имени другого устройства и retained-показание: брокер отключает нарушителя, данные не доходят.
    const before = count();
    for (const [topic, retain] of [[telemetryTopic('PY-OTHER-02'), false], [telemetryTopic(DEVICE), true]] as const) {
      const rogue = await connect(broker.port, DEVICE, TOKEN);
      const closed = new Promise<boolean>((resolve) => rogue.once('close', () => resolve(true)));
      seq += 1;
      rogue.publish(topic, JSON.stringify(message({ seq, value: 999, timestamp: new Date().toISOString() })), { qos: 1, retain });
      expect(await Promise.race([closed, new Promise<boolean>((r) => setTimeout(() => r(false), 3000))])).toBe(true);
      rogue.end(true);
    }
    expect(count()).toBe(before);

    // Перезапуск брокера на том же порту: подписчик и датчик переподключаются, приём продолжается.
    sensor.end(true);
    await broker.close();
    closers.splice(closers.indexOf(broker.close), 1);
    const again = await startBroker({ host: '127.0.0.1', port: broker.port, service: SERVICE, deviceTokenHash });
    closers.push(again.close);
    const sensor2 = await connect(again.port, DEVICE, TOKEN);
    const after = count();
    expect(await until(() => {
      void publish(sensor2, telemetryTopic(DEVICE), 340);
      return count() > after;
    }, 10000)).toBe(true);
    sensor2.end(true);
    const snap = buildSnapshot(db, app.simulation, new Date().toISOString());
    expect(snap.stations.find((x) => x.code === 'QRG-03')!.latest.water_level?.source).toBe('device');
    expect(snap.devices[0]!.lastValue).toBe(340);
  }, 30000);
});
