// Чтение предупреждений из БД: общие запросы для API журнала и снимка WebSocket.

import type { Db } from '../db/connection';
import { currentRunId } from '../risk/service';

export interface AlertRow {
  id: number;
  runId: number;
  stationCode: string;
  stationName: string;
  hazardType: string;
  severity: string;
  trigger: string;
  status: string;
  isActive: boolean;
  openedTick: number;
  lastTick: number;
  clearedTick: number | null;
  /** Виртуальное время открытия (часы прогона) и реальное время записи. */
  openedAt: string;
  createdAt: string;
  updatedAt: string;
  reasons: unknown[];
}

export const SELECT = `SELECT a.*, s.code AS station_code, s.name AS station_name, r.sim_start, r.step_minutes
  FROM alerts a JOIN stations s ON s.id = a.station_id JOIN sim_runs r ON r.id = a.run_id`;

export function toAlert(r: Record<string, unknown>): AlertRow {
  const openedAt = new Date(Date.parse(String(r.sim_start)) + Number(r.opened_tick) * Number(r.step_minutes) * 60_000).toISOString();
  return {
    id: Number(r.id),
    runId: Number(r.run_id),
    stationCode: String(r.station_code),
    stationName: String(r.station_name),
    hazardType: String(r.hazard_type),
    severity: String(r.severity),
    trigger: String(r.trigger),
    status: String(r.status),
    isActive: Number(r.is_active) === 1,
    openedTick: Number(r.opened_tick),
    lastTick: Number(r.last_tick),
    clearedTick: r.cleared_tick === null ? null : Number(r.cleared_tick),
    openedAt,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    reasons: JSON.parse(String(r.reasons_json)) as unknown[],
  };
}

/** Сводка для снимка WebSocket: активные предупреждения текущего прогона (публичные данные, видит и гость). */
export function alertSummary(db: Db): { runId: number | null; active: AlertRow[]; unhandled: number } {
  const runId = currentRunId(db);
  if (runId === null) return { runId, active: [], unhandled: 0 };
  const active = db
    .prepare(`${SELECT} WHERE a.run_id = ? AND a.is_active = 1 ORDER BY CASE a.severity WHEN 'HIGH' THEN 0 ELSE 1 END, a.opened_tick`)
    .all(runId)
    .map(toAlert);
  const unhandled = Number(db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE run_id = ? AND status <> 'RESOLVED'").get(runId)?.n ?? 0);
  return { runId, active, unhandled };
}
