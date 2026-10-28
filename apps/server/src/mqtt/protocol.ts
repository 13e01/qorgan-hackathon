// Протокол обмена с внешними датчиками по MQTT (docs/PYTHON_SENSOR.md).
//
//   qorgan/v1/sensors/{deviceId}/telemetry — показание (QoS 1, без retain), JSON ниже
//   qorgan/v1/sensors/{deviceId}/status    — "online" / "offline" (retain; "offline" — завещание LWT при обрыве)
//
// Устройство подключается к брокеру с логином = deviceId и паролем = токен устройства; брокер разрешает ему
// публиковать только в свои топики. Поэтому deviceId в топике нельзя подменить, а в теле он сверяется с топиком.

import { z } from 'zod';

export const TOPIC_PREFIX = 'qorgan/v1/sensors';
export const TELEMETRY_SUBSCRIPTION = `${TOPIC_PREFIX}/+/telemetry`;
export const STATUS_SUBSCRIPTION = `${TOPIC_PREFIX}/+/status`;

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

export const telemetryTopic = (deviceId: string) => `${TOPIC_PREFIX}/${deviceId}/telemetry`;
export const statusTopic = (deviceId: string) => `${TOPIC_PREFIX}/${deviceId}/status`;

export function parseTopic(topic: string): { deviceId: string; kind: 'telemetry' | 'status' } | null {
  const parts = topic.split('/');
  if (parts.length !== 5 || `${parts[0]}/${parts[1]}/${parts[2]}` !== TOPIC_PREFIX) return null;
  const [, , , deviceId, kind] = parts;
  if (!deviceId || !DEVICE_ID.test(deviceId) || (kind !== 'telemetry' && kind !== 'status')) return null;
  return { deviceId, kind };
}

export const SENSOR_MODES = ['NORMAL', 'RISING', 'DANGER', 'FALLING'] as const;

/** Сообщение показания. Время — реальное время измерения на устройстве (ISO 8601 с часовым поясом). */
export const sensorMessageSchema = z
  .object({
    v: z.literal(1),
    deviceId: z.string().regex(DEVICE_ID),
    stationId: z.string().min(1).max(32),
    type: z.literal('water_level'),
    value: z.number().finite(),
    unit: z.literal('cm'),
    timestamp: z.iso.datetime({ offset: true }),
    /** Номер показания в текущем запуске устройства (растёт на 1). */
    seq: z.number().int().min(0).max(1_000_000_000),
    /** Случайный идентификатор запуска устройства: после перезапуска seq начинается заново. */
    bootId: z.string().min(4).max(64),
    source: z.literal('PYTHON_SENSOR'),
    mode: z.enum(SENSOR_MODES).optional(),
  })
  .strict();

export type SensorMessage = z.infer<typeof sensorMessageSchema>;
