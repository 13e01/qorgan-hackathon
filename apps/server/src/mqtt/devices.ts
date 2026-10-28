// Внешние устройства для интерфейса: публичная сводка (без токенов) и состояние связи.

import type { Db } from '../db/connection';
import { activeRun, isExternalRun } from '../simulation/repository';

export type DeviceLink = 'ONLINE' | 'STALE' | 'OFFLINE' | 'NEVER';

export interface DeviceSummary {
  deviceId: string;
  name: string;
  stationCode: string;
  stationName: string;
  status: string;
  link: DeviceLink;
  /** Последнее сообщение MQTT о состоянии: online / offline (завещание при обрыве связи). */
  mqttStatus: string | null;
  lastValue: number | null;
  lastUnit: string | null;
  /** Реальное время измерения на устройстве и время приёма сервером. */
  lastSensorAt: string | null;
  lastSeenAt: string | null;
  lastMode: string | null;
  lastResult: string | null;
  lastSeq: number | null;
  accepted: number;
  rejected: number;
}

export function deviceSummaries(db: Db, now: Date): DeviceSummary[] {
  const run = activeRun(db);
  // «На связи» — показание пришло не позже трёх интервалов (часа модели) прогона внешних датчиков; минимум 10 с.
  const interval = run && isExternalRun(run) ? run.tickMs : 2000;
  const online = Math.max(10_000, 3 * interval);
  return db
    .prepare('SELECT d.*, s.code AS station_code, s.name AS station_name FROM devices d JOIN stations s ON s.id = d.station_id ORDER BY d.id')
    .all()
    .map((r) => {
      const seen = r.last_seen_at === null ? null : Date.parse(String(r.last_seen_at));
      const age = seen === null ? null : now.getTime() - seen;
      const link: DeviceLink = age === null ? 'NEVER' : age <= online ? 'ONLINE' : age <= 3 * online ? 'STALE' : 'OFFLINE';
      return {
        deviceId: String(r.device_id),
        name: String(r.name),
        stationCode: String(r.station_code),
        stationName: String(r.station_name),
        status: String(r.status),
        link,
        mqttStatus: r.mqtt_status === null ? null : String(r.mqtt_status),
        lastValue: r.last_value === null ? null : Number(r.last_value),
        lastUnit: r.last_unit === null ? null : String(r.last_unit),
        lastSensorAt: r.last_sensor_at === null ? null : String(r.last_sensor_at),
        lastSeenAt: r.last_seen_at === null ? null : String(r.last_seen_at),
        lastMode: r.last_mode === null ? null : String(r.last_mode),
        lastResult: r.last_result === null ? null : String(r.last_result),
        lastSeq: r.last_seq === null ? null : Number(r.last_seq),
        accepted: Number(r.accepted_count),
        rejected: Number(r.rejected_count),
      };
    });
}
