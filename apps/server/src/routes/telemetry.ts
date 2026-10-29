// POST /api/telemetry — приём телеметрии (ТЗ §5.3). Заголовок X-Device-Token:
//   • токен встроенного симулятора (создаётся при старте сервера, хранится только в памяти, наружу не выдаётся);
//   • токен устройства станции (в БД хранится только его SHA-256, выпускает администратор — T6).

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/connection';
import { AppError, parse } from '../errors';
import { ingest, type IngestExtensions, type Sender } from '../telemetry/ingest';

const sha256 = (s: string) => createHash('sha256').update(s).digest();

const bodySchema = z.object({
  runId: z.number().int().positive().optional(),
  /** Только для MQTT-адаптера: внешнее устройство, от имени которого передаются показания. */
  deviceId: z.string().min(1).max(64).optional(),
  tick: z.number().int().min(0).optional(),
  records: z
    .array(
      z.object({
        stationCode: z.string().min(1).max(32),
        parameter: z.string().min(1).max(32),
        value: z.number(),
        unit: z.string().min(1).max(16),
        measuredAt: z.iso.datetime({ offset: true }),
        source: z.enum(['simulator', 'manual']).optional(),
      }),
    )
    .min(1)
    .max(500),
});

export function telemetryRoutes(
  db: Db,
  simulatorToken: string,
  now: () => Date,
  onIngested: () => void,
  mqttAdapterToken?: string,
  extensions: IngestExtensions = {},
) {
  const simulatorDigest = sha256(simulatorToken);
  const adapterDigest = mqttAdapterToken ? sha256(mqttAdapterToken) : null;
  return async (app: FastifyInstance) => {
    app.post('/api/telemetry', async (request) => {
      const token = request.headers['x-device-token'];
      if (typeof token !== 'string' || token.length < 16 || token.length > 256) {
        throw new AppError(401, 'BAD_DEVICE_TOKEN', 'Нужен заголовок X-Device-Token');
      }
      let sender: Sender | null = null;
      const digest = sha256(token);
      if (timingSafeEqual(digest, simulatorDigest)) sender = { kind: 'simulator' };
      else if (adapterDigest && timingSafeEqual(digest, adapterDigest)) {
        // MQTT-адаптер (в том же процессе, токен только в памяти) передаёт показания от имени зарегистрированного устройства.
        const deviceId = (request.body as { deviceId?: unknown } | null)?.deviceId;
        const device =
          typeof deviceId === 'string'
            ? db.prepare("SELECT s.id, s.code FROM devices d JOIN stations s ON s.id = d.station_id WHERE d.device_id = ? AND d.status = 'active'").get(deviceId)
            : undefined;
        if (!device) throw new AppError(403, 'UNKNOWN_DEVICE', 'Устройство не зарегистрировано или отключено');
        sender = { kind: 'device', stationId: Number(device.id), stationCode: String(device.code) };
      } else {
        const station = db.prepare('SELECT id, code FROM stations WHERE device_token_hash = ?').get(sha256(token).toString('hex'));
        if (station) sender = { kind: 'device', stationId: Number(station.id), stationCode: String(station.code) };
      }
      if (!sender) {
        // Не чаще одной записи в минуту — перебор токенов не должен раздувать журнал.
        const at = now();
        const recent = db
          .prepare("SELECT 1 FROM device_log WHERE code = 'BAD_TOKEN' AND created_at > ? LIMIT 1")
          .get(new Date(at.getTime() - 60_000).toISOString());
        if (!recent) {
          db.prepare("INSERT INTO device_log (level, code, details_json, created_at) VALUES ('error', 'BAD_TOKEN', ?, ?)").run(
            JSON.stringify({ ip: request.ip }),
            at.toISOString(),
          );
        }
        throw new AppError(401, 'BAD_DEVICE_TOKEN', 'Неизвестный токен устройства');
      }

      const body = parse(bodySchema, request.body);
      if (body.deviceId !== undefined && !(adapterDigest && timingSafeEqual(digest, adapterDigest))) {
        throw new AppError(400, 'VALIDATION', 'Поле deviceId передаёт только MQTT-адаптер');
      }
      if (sender.kind === 'device' && body.records.some((r) => r.source !== undefined)) {
        throw new AppError(400, 'VALIDATION', 'Поле source задаёт только симулятор');
      }
      const result = ingest(db, sender, body, now().toISOString(), extensions);
      onIngested();
      return {
        runId: result.runId,
        tick: result.tick,
        virtualTime: result.virtualTime,
        accepted: result.accepted,
        duplicates: result.duplicates,
        rejected: result.rejected,
        risks: result.evaluations.map((e) => ({ stationCode: e.station.code, risk: e.assessment.risk, score: e.assessment.score })),
      };
    });
  };
}
