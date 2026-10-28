// MQTT-адаптер: превращает сообщение датчика в обычный пакет телеметрии QORGAN.
// Он только проверяет то, что относится к MQTT (формат, устройство, повторы, частота, время, источник данных),
// а запись, проверка диапазонов, риск T2, предупреждения и WebSocket — существующий POST /api/telemetry (через inject).

import { EXTERNAL_SCENARIO_ID } from '@qorgan/shared';
import type { Db } from '../db/connection';
import { activeRun, externalTickAt, LIVE_STATUSES, virtualTime } from '../simulation/repository';
import { parseTopic, sensorMessageSchema } from './protocol';

/** Часы датчика могут немного спешить; дальше — «показание из будущего». */
export const MAX_FUTURE_MS = 30_000;
/** Старше — устаревшее показание (например, долго лежало в буфере устройства без связи). */
export const MAX_AGE_MS = 5 * 60_000;
/** Показания устройства не чаще, чем раз в это время — по времени ИЗМЕРЕНИЯ (буфер после обрыва связи приходит пачкой, это нормально). */
export const MIN_INTERVAL_MS = 500;
/** Защита от потока сообщений: не больше стольких сообщений устройства в секунду по времени прихода. */
export const MAX_MESSAGES_PER_S = 20;

export type AdapterResult =
  | 'ACCEPTED'
  | 'DUPLICATE'
  | 'IGNORED_TOPIC'
  | 'STATUS'
  | 'RETAINED'
  | 'BAD_JSON'
  | 'BAD_FORMAT'
  | 'SPOOFED_DEVICE'
  | 'UNKNOWN_DEVICE'
  | 'DEVICE_DISABLED'
  | 'STATION_MISMATCH'
  | 'FUTURE'
  | 'STALE'
  | 'RATE_LIMITED'
  | 'SOURCE_CONFLICT'
  | 'NO_EXTERNAL_RUN'
  | 'REJECTED';

export interface AdapterDeps {
  db: Db;
  now: () => Date;
  /** Передать пакет в POST /api/telemetry от имени устройства (app.inject с токеном адаптера). */
  deliver: (body: unknown) => Promise<{ status: number; body: any }>;
  /** Состояние устройства изменилось (для снимка WebSocket). */
  onDeviceChange?: () => void;
}

export function createSensorAdapter(deps: AdapterDeps) {
  const { db } = deps;
  const lastMeasured = new Map<string, number>();
  const arrivals = new Map<string, number[]>();
  const lastLogged = new Map<string, number>();

  const findDevice = (deviceId: string) =>
    db
      .prepare('SELECT d.id, d.device_id, d.status, d.last_boot_id, d.last_seq, d.last_sensor_at, s.code AS station_code FROM devices d JOIN stations s ON s.id = d.station_id WHERE d.device_id = ?')
      .get(deviceId);

  const note = (deviceId: string, stationCode: string | null, result: AdapterResult, details: Record<string, unknown>) => {
    const at = deps.now();
    db.prepare("UPDATE devices SET last_result = ?, rejected_count = rejected_count + 1, updated_at = ? WHERE device_id = ?").run(result, at.toISOString(), deviceId);
    // Журнал диагностики — не чаще раза в 10 с на устройство и причину (поток плохих сообщений не раздувает БД).
    const key = `${deviceId}:${result}`;
    if ((lastLogged.get(key) ?? 0) + 10_000 <= at.getTime()) {
      lastLogged.set(key, at.getTime());
      const station = stationCode ? db.prepare('SELECT id FROM stations WHERE code = ?').get(stationCode) : undefined;
      db.prepare("INSERT INTO device_log (station_id, level, code, details_json, created_at) VALUES (?, 'warn', ?, ?, ?)").run(
        station ? Number(station.id) : null,
        `MQTT_${result}`,
        JSON.stringify({ deviceId, ...details }),
        at.toISOString(),
      );
    }
    deps.onDeviceChange?.();
    return result;
  };

  // Каждое сообщение показания учитывается в счётчике «устройство × прогон × итог» (run_id = 0 — приём не был включён),
  // поэтому видно, сколько и почему отклонено именно в текущем прогоне.
  const tally = (deviceId: string, result: AdapterResult) => {
    const at = deps.now().toISOString();
    const run = activeRun(db);
    const runId = run && LIVE_STATUSES.includes(run.status) ? run.id : 0;
    db.prepare(
      `INSERT INTO device_run_results (device_id, run_id, result, count, last_at)
       SELECT id, ?, ?, 1, ? FROM devices WHERE device_id = ?
       ON CONFLICT (device_id, run_id, result) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
    ).run(runId, result, at, deviceId);
  };

  async function handleMessage(topic: string, payload: Buffer | string, packet: { retain?: boolean }): Promise<AdapterResult> {
    const parsedTopic = parseTopic(topic);
    if (!parsedTopic) return 'IGNORED_TOPIC';
    const { deviceId } = parsedTopic;
    const device = findDevice(deviceId);
    if (!device) return 'UNKNOWN_DEVICE';
    const stationCode = String(device.station_code);
    const at = deps.now();
    // Поток сообщений (не путать с пачкой из буфера): больше MAX_MESSAGES_PER_S за секунду — отбрасываем.
    const recent = (arrivals.get(deviceId) ?? []).filter((t) => t > at.getTime() - 1000);
    recent.push(at.getTime());
    arrivals.set(deviceId, recent);
    if (recent.length > MAX_MESSAGES_PER_S) return note(deviceId, stationCode, 'RATE_LIMITED', { perSecond: recent.length });

    if (parsedTopic.kind === 'status') {
      const text = String(payload).trim().toLowerCase();
      if (text === 'online' || text === 'offline') {
        db.prepare('UPDATE devices SET mqtt_status = ?, updated_at = ? WHERE device_id = ?').run(text, at.toISOString(), deviceId);
        deps.onDeviceChange?.();
      }
      return 'STATUS';
    }

    // Сохранённое брокером (retained) показание может быть сколь угодно старым — такие не принимаем.
    if (packet.retain) return note(deviceId, stationCode, 'RETAINED', {});
    let json: unknown;
    try {
      json = JSON.parse(String(payload));
    } catch {
      return note(deviceId, stationCode, 'BAD_JSON', {});
    }
    const parsed = sensorMessageSchema.safeParse(json);
    if (!parsed.success) return note(deviceId, stationCode, 'BAD_FORMAT', { issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`) });
    const msg = parsed.data;
    if (msg.deviceId !== deviceId) return note(deviceId, stationCode, 'SPOOFED_DEVICE', { claimed: msg.deviceId });
    if (device.status !== 'active') return note(deviceId, stationCode, 'DEVICE_DISABLED', {});
    if (msg.stationId !== stationCode) return note(deviceId, stationCode, 'STATION_MISMATCH', { claimed: msg.stationId });

    // Повторная доставка MQTT (QoS 1) или повтор после переподключения: тот же запуск и номер не новее последнего.
    if (device.last_boot_id === msg.bootId && device.last_seq !== null && msg.seq <= Number(device.last_seq)) {
      db.prepare("UPDATE devices SET last_result = 'DUPLICATE', updated_at = ? WHERE device_id = ?").run(at.toISOString(), deviceId);
      return 'DUPLICATE';
    }

    const measuredMs = Date.parse(msg.timestamp);
    if (measuredMs > at.getTime() + MAX_FUTURE_MS) return note(deviceId, stationCode, 'FUTURE', { timestamp: msg.timestamp });
    if (measuredMs < at.getTime() - MAX_AGE_MS) return note(deviceId, stationCode, 'STALE', { timestamp: msg.timestamp });
    const prevMeasured = lastMeasured.get(deviceId) ?? (device.last_sensor_at ? Date.parse(String(device.last_sensor_at)) : null);
    if (prevMeasured !== null && measuredMs > prevMeasured - MIN_INTERVAL_MS && measuredMs < prevMeasured + MIN_INTERVAL_MS && measuredMs !== prevMeasured) {
      return note(deviceId, stationCode, 'RATE_LIMITED', { timestamp: msg.timestamp });
    }

    // Один источник данных на прогон: во время встроенной симуляции показания датчика не записываются.
    const run = activeRun(db);
    if (!run || !LIVE_STATUSES.includes(run.status)) return note(deviceId, stationCode, 'NO_EXTERNAL_RUN', {});
    if (run.scenarioId !== EXTERNAL_SCENARIO_ID) return note(deviceId, stationCode, 'SOURCE_CONFLICT', { runId: run.id, scenario: run.scenarioId });
    const tick = externalTickAt(run, measuredMs);
    if (tick < 0) return note(deviceId, stationCode, 'STALE', { timestamp: msg.timestamp, reason: 'before run start' });

    const res = await deps.deliver({
      runId: run.id,
      tick,
      deviceId,
      records: [{ stationCode, parameter: msg.type, value: msg.value, unit: msg.unit, measuredAt: virtualTime(run, tick) }],
    });
    const accepted = res.status === 200 && Number(res.body?.accepted ?? 0) > 0;
    const duplicate = res.status === 200 && Number(res.body?.duplicates ?? 0) > 0;
    if (!accepted && !duplicate) {
      const code = res.status === 200 ? String(res.body?.rejected?.[0]?.code ?? 'REJECTED') : String(res.body?.error?.code ?? res.status);
      return note(deviceId, stationCode, 'REJECTED', { code, value: msg.value });
    }
    lastMeasured.set(deviceId, measuredMs);
    db.prepare(
      `UPDATE devices SET last_seen_at = ?, last_boot_id = ?, last_seq = ?, last_value = ?, last_unit = ?, last_sensor_at = ?, last_mode = ?,
         last_result = ?, accepted_count = accepted_count + ?, updated_at = ? WHERE device_id = ?`,
    ).run(at.toISOString(), msg.bootId, msg.seq, msg.value, msg.unit, new Date(measuredMs).toISOString(), msg.mode ?? null, accepted ? 'ACCEPTED' : 'DUPLICATE', accepted ? 1 : 0, at.toISOString(), deviceId);
    deps.onDeviceChange?.();
    return accepted ? 'ACCEPTED' : 'DUPLICATE';
  }

  return {
    async handle(topic: string, payload: Buffer | string, packet: { retain?: boolean } = {}): Promise<AdapterResult> {
      const result = await handleMessage(topic, payload, packet);
      const parsedTopic = parseTopic(topic);
      if (parsedTopic?.kind === 'telemetry' && result !== 'UNKNOWN_DEVICE') tally(parsedTopic.deviceId, result);
      return result;
    },
  };
}
