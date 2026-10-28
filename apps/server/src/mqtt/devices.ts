// Внешние устройства для интерфейса: публичная сводка (без токенов) и состояние связи.

import type { Db } from '../db/connection';
import { activeRun, isExternalRun } from '../simulation/repository';

export type DeviceLink = 'ONLINE' | 'STALE' | 'OFFLINE' | 'NEVER';
/** Последнее показание относительно учебных порогов станции (station_parameters): ниже предупредительного / между / не ниже опасного. */
export type DeviceLevel = 'NORMAL' | 'WARNING' | 'DANGER';

/** Итоги сообщений устройства в одном прогоне: принято, повторы, отклонено и разбивка отклонённых по причинам. */
export interface DeviceRunStats {
  runId: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  reasons: Record<string, number>;
}

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
  /** За всё время работы устройства (все прогоны). */
  accepted: number;
  rejected: number;
  /** Текущий (или последний остановленный) прогон приёма датчиков; null — прогона нет. */
  run: DeviceRunStats | null;
  lastLevel: DeviceLevel | null;
}

const NOT_REJECTED = new Set(['ACCEPTED', 'DUPLICATE']);

function runStats(db: Db, deviceRowId: number, runId: number): DeviceRunStats {
  const stats: DeviceRunStats = { runId, accepted: 0, duplicates: 0, rejected: 0, reasons: {} };
  for (const r of db.prepare('SELECT result, count FROM device_run_results WHERE device_id = ? AND run_id = ?').all(deviceRowId, runId)) {
    const result = String(r.result);
    const n = Number(r.count);
    if (result === 'ACCEPTED') stats.accepted += n;
    else if (result === 'DUPLICATE') stats.duplicates += n;
    if (!NOT_REJECTED.has(result)) {
      stats.rejected += n;
      stats.reasons[result] = n;
    }
  }
  return stats;
}

export function deviceSummaries(db: Db, now: Date): DeviceSummary[] {
  const run = activeRun(db);
  // «На связи» — показание пришло не позже трёх интервалов (часа модели) прогона внешних датчиков; минимум 10 с.
  const interval = run && isExternalRun(run) ? run.tickMs : 2000;
  const online = Math.max(10_000, 3 * interval);
  const externalRun = run && isExternalRun(run) ? run.id : null;
  return db
    .prepare(
      `SELECT d.*, s.code AS station_code, s.name AS station_name, sp.warning AS warning_cm, sp.danger AS danger_cm
       FROM devices d JOIN stations s ON s.id = d.station_id
       LEFT JOIN station_parameters sp ON sp.station_id = d.station_id AND sp.parameter_code = 'water_level'
       ORDER BY d.id`,
    )
    .all()
    .map((r) => {
      const seen = r.last_seen_at === null ? null : Date.parse(String(r.last_seen_at));
      const age = seen === null ? null : now.getTime() - seen;
      const link: DeviceLink = age === null ? 'NEVER' : age <= online ? 'ONLINE' : age <= 3 * online ? 'STALE' : 'OFFLINE';
      const value = r.last_value === null ? null : Number(r.last_value);
      const danger = r.danger_cm === null ? null : Number(r.danger_cm);
      const warning = r.warning_cm === null ? null : Number(r.warning_cm);
      const lastLevel: DeviceLevel | null =
        value === null ? null : danger !== null && value >= danger ? 'DANGER' : warning !== null && value >= warning ? 'WARNING' : 'NORMAL';
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
        run: externalRun === null ? null : runStats(db, Number(r.id), externalRun),
        lastLevel,
      };
    });
}
