// Доступ к прогонам симуляции в БД. Единственный источник виртуального времени —
// sim_runs: virtualTime(tick) = sim_start + tick · step_minutes. Реальное время приходит только из `now()`.

import { EXTERNAL_SCENARIO_ID, type DataSource, type Intervention, type ParameterCode, type ScenarioId, type ScenarioParams, type StationModel } from '@qorgan/shared';
import type { Db } from '../db/connection';

export type RunStatus = 'CREATED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'STOPPED';
export const LIVE_STATUSES: readonly RunStatus[] = ['CREATED', 'RUNNING', 'PAUSED'];

export interface RunInfo {
  id: number;
  scenarioId: string;
  seed: number;
  params: ScenarioParams;
  status: RunStatus;
  tickMs: number;
  stepMinutes: number;
  simStart: string;
  /** Последний переданный тик; null — данных ещё нет. */
  currentTick: number | null;
  totalTicks: number | null;
  startedAt: string;
  finishedAt: string | null;
  stoppedAt: string | null;
  lastError: string | null;
}

function toRun(r: Record<string, unknown>): RunInfo {
  return {
    id: Number(r.id),
    scenarioId: String(r.scenario_id),
    seed: Number(r.seed),
    params: JSON.parse(String(r.params_json)) as ScenarioParams,
    status: r.status as RunStatus,
    tickMs: Number(r.tick_ms),
    stepMinutes: Number(r.step_minutes),
    simStart: String(r.sim_start),
    currentTick: r.current_tick === null ? null : Number(r.current_tick),
    totalTicks: r.total_ticks === null ? null : Number(r.total_ticks),
    startedAt: String(r.started_at),
    finishedAt: r.finished_at === null ? null : String(r.finished_at),
    stoppedAt: r.stopped_at === null ? null : String(r.stopped_at),
    lastError: r.last_error === null ? null : String(r.last_error),
  };
}

/** Прогон «Внешние датчики»: данные только от устройств (MQTT), встроенный симулятор не работает. */
export function isExternalRun(run: Pick<RunInfo, 'scenarioId'>): boolean {
  return run.scenarioId === EXTERNAL_SCENARIO_ID;
}

export function dataSourceOf(run: Pick<RunInfo, 'scenarioId'> | null): DataSource | null {
  return run === null ? null : isExternalRun(run) ? 'EXTERNAL_SENSOR' : 'INTERNAL_SIMULATION';
}

/**
 * Час модели для показания внешнего датчика: реальное время показания переводится в часы модели
 * по масштабу прогона (tick_ms реальных мс = 1 час модели), как «1 ч симуляции = 0,5 с» у встроенного симулятора.
 */
export function externalTickAt(run: Pick<RunInfo, 'startedAt' | 'tickMs'>, realMs: number): number {
  return Math.round((realMs - Date.parse(run.startedAt)) / run.tickMs);
}

export function getRun(db: Db, id: number): RunInfo | null {
  const row = db.prepare('SELECT * FROM sim_runs WHERE id = ?').get(id);
  return row ? toRun(row) : null;
}

export function listRuns(db: Db, limit = 50): RunInfo[] {
  return db.prepare('SELECT * FROM sim_runs ORDER BY id DESC LIMIT ?').all(limit).map(toRun);
}

/** Прогон, на который указывает sim_control (может быть уже завершён); null — симулятор в состоянии IDLE. */
export function activeRun(db: Db): RunInfo | null {
  const row = db.prepare('SELECT run_id FROM sim_control WHERE id = 1').get();
  return row?.run_id === null || row?.run_id === undefined ? null : getRun(db, Number(row.run_id));
}

export function setActiveRun(db: Db, runId: number | null, now: string): void {
  db.prepare('UPDATE sim_control SET run_id = ?, updated_at = ? WHERE id = 1').run(runId, now);
}

export function virtualTime(run: Pick<RunInfo, 'simStart' | 'stepMinutes'>, tick: number): string {
  return new Date(Date.parse(run.simStart) + tick * run.stepMinutes * 60_000).toISOString();
}

/** Текущее виртуальное время прогона; null, если тиков ещё не было и измерений нет. */
export function runClock(db: Db, run: RunInfo): string | null {
  if (run.currentTick !== null) return virtualTime(run, run.currentTick);
  // Прогоны без часов (проверочные данные T2) — по последнему измерению.
  const row = db.prepare('SELECT MAX(measured_at) AS t FROM measurements WHERE run_id = ?').get(run.id);
  return row?.t ? String(row.t) : null;
}

export interface NewRun {
  scenarioId: ScenarioId | typeof EXTERNAL_SCENARIO_ID;
  seed: number;
  params: ScenarioParams;
  tickMs: number;
  totalTicks: number | null;
  simStart: string;
  userId: number | null;
}

export function insertRun(db: Db, run: NewRun, now: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO sim_runs (scenario_id, seed, params_json, tick_ms, sim_start, started_at, status, total_ticks, step_minutes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'CREATED', ?, 60, ?)`,
      )
      .run(run.scenarioId, run.seed, JSON.stringify(run.params), run.tickMs, run.simStart, now, run.totalTicks, run.userId)
      .lastInsertRowid,
  );
}

export function updateRun(
  db: Db,
  id: number,
  fields: Partial<{ status: RunStatus; tickMs: number; currentTick: number; finishedAt: string; stoppedAt: string; lastError: string | null }>,
): void {
  const columns: Record<string, string> = {
    status: 'status',
    tickMs: 'tick_ms',
    currentTick: 'current_tick',
    finishedAt: 'finished_at',
    stoppedAt: 'stopped_at',
    lastError: 'last_error',
  };
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sql = `UPDATE sim_runs SET ${entries.map(([k]) => `${columns[k]} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...entries.map(([, v]) => v as string | number | null), id);
}

/** Физические параметры станций для генератора (активные станции; станции в ремонте тоже передают данные). */
export function stationModels(db: Db): StationModel[] {
  const rows = db
    .prepare(
      `SELECT s.code, s.base_level_cm, u.code AS upstream_code, s.travel_hours, s.attenuation, s.response_hours
       FROM stations s LEFT JOIN stations u ON u.id = s.upstream_station_id
       WHERE s.status <> 'disabled' ORDER BY s.id`,
    )
    .all();
  const sensors = db.prepare('SELECT s.code, sp.parameter_code FROM station_parameters sp JOIN stations s ON s.id = sp.station_id').all();
  return rows.map((r) => ({
    code: String(r.code),
    baseLevelCm: r.base_level_cm === null ? 0 : Number(r.base_level_cm),
    upstreamCode: r.upstream_code === null ? null : String(r.upstream_code),
    travelHours: r.travel_hours === null ? null : Number(r.travel_hours),
    attenuation: Number(r.attenuation),
    responseHours: Number(r.response_hours),
    sensors: sensors.filter((s) => s.code === r.code).map((s) => s.parameter_code as ParameterCode),
  }));
}

export interface InterventionRow extends Intervention {
  id: number;
  stationId: number;
  userId: number | null;
  createdAt: string;
}

export function listInterventions(db: Db, runId: number): InterventionRow[] {
  return db
    .prepare(
      `SELECT i.*, s.code AS station_code FROM sim_interventions i JOIN stations s ON s.id = i.station_id
       WHERE i.run_id = ? ORDER BY i.effective_tick, i.id`,
    )
    .all(runId)
    .map((r) => ({
      id: Number(r.id),
      type: r.type as Intervention['type'],
      stationId: Number(r.station_id),
      stationCode: String(r.station_code),
      effectiveTick: Number(r.effective_tick),
      value: Number(r.value),
      parameter: r.parameter_code === null ? null : (r.parameter_code as ParameterCode),
      durationH: r.duration_h === null ? null : Number(r.duration_h),
      userId: r.user_id === null ? null : Number(r.user_id),
      createdAt: String(r.created_at),
    }));
}

/** Удаляет завершённый прогон со всеми его данными (только по явной команде администратора). */
export function deleteRunData(db: Db, runId: number): void {
  db.prepare('DELETE FROM alert_events WHERE alert_id IN (SELECT id FROM alerts WHERE run_id = ?)').run(runId);
  db.prepare('DELETE FROM alerts WHERE run_id = ?').run(runId);
  db.prepare('DELETE FROM ml_assessments WHERE run_id = ?').run(runId);
  db.prepare('DELETE FROM risk_assessments WHERE run_id = ?').run(runId);
  db.prepare('DELETE FROM measurements WHERE run_id = ?').run(runId);
  db.prepare('DELETE FROM sim_interventions WHERE run_id = ?').run(runId);
  db.prepare('DELETE FROM device_run_results WHERE run_id = ?').run(runId);
  db.prepare('UPDATE sim_control SET run_id = NULL WHERE run_id = ?').run(runId);
  db.prepare('DELETE FROM sim_runs WHERE id = ?').run(runId);
}
