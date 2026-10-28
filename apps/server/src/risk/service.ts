// Загрузка данных станции из БД и вызов модуля оценки риска (packages/shared/risk).
// Пока нет симулятора (T3), оценка считается по запросу из сохранённых измерений;
// в T3 тот же вызов будет выполняться при приёме каждого пакета телеметрии.

import {
  assessRisk,
  resolveRiskConfig,
  type MeasurementPoint,
  type ParameterCode,
  type RiskAssessment,
  type RiskConfig,
  type StationStatus,
  type UpstreamInfo,
} from '@qorgan/shared';
import type { Db } from '../db/connection';

const MS_PER_HOUR = 3_600_000;

export interface StationRef {
  id: number;
  code: string;
  name: string;
  status: StationStatus;
}

interface StationRow extends StationRef {
  upstreamId: number | null;
  travelHours: number | null;
}

export interface StationEvaluation {
  station: StationRef;
  /** Прогон симуляции, по данным которого выполнена оценка; null — данных нет. */
  runId: number | null;
  assessment: RiskAssessment;
}

export interface EvaluateOptions {
  runId?: number;
  /** Момент оценки (ISO). По умолчанию — модельное время прогона (время последнего измерения в нём). */
  at?: string;
  computedAt?: string;
}

function toStation(row: Record<string, unknown>): StationRow {
  return {
    id: Number(row.id),
    code: String(row.code),
    name: String(row.name),
    status: row.status as StationStatus,
    upstreamId: row.upstream_station_id === null ? null : Number(row.upstream_station_id),
    travelHours: row.travel_hours === null ? null : Number(row.travel_hours),
  };
}

const STATION_COLUMNS = 'id, code, name, status, upstream_station_id, travel_hours';

/** Станция по числовому id или по коду (например, `QRG-01`). */
export function findStation(db: Db, idOrCode: string): StationRow | null {
  const row = /^\d+$/.test(idOrCode)
    ? db.prepare(`SELECT ${STATION_COLUMNS} FROM stations WHERE id = ?`).get(Number(idOrCode))
    : db.prepare(`SELECT ${STATION_COLUMNS} FROM stations WHERE code = ? COLLATE NOCASE`).get(idOrCode);
  return row ? toStation(row) : null;
}

export function loadRiskConfig(db: Db): { config: RiskConfig; version: number | null } {
  const row = db.prepare('SELECT json, version FROM risk_config WHERE id = 1').get();
  if (!row) return { config: resolveRiskConfig(null), version: null };
  return { config: resolveRiskConfig(JSON.parse(String(row.json))), version: Number(row.version) };
}

/** Текущий прогон: заданный в sim_control, иначе последний, в котором есть измерения. */
export function currentRunId(db: Db): number | null {
  const control = db.prepare('SELECT run_id FROM sim_control WHERE id = 1').get();
  if (control?.run_id !== null && control?.run_id !== undefined) return Number(control.run_id);
  const latest = db.prepare('SELECT MAX(run_id) AS id FROM measurements').get();
  return latest?.id === null || latest?.id === undefined ? null : Number(latest.id);
}

export function runExists(db: Db, runId: number): boolean {
  return db.prepare('SELECT 1 FROM sim_runs WHERE id = ?').get(runId) !== undefined;
}

/** Модельное время прогона — время самого позднего измерения в нём. */
function runModelTime(db: Db, runId: number): string | null {
  const row = db.prepare('SELECT MAX(measured_at) AS t FROM measurements WHERE run_id = ?').get(runId);
  return row?.t ? String(row.t) : null;
}

function series(
  db: Db,
  runId: number,
  stationId: number,
  parameter: ParameterCode,
  asOf: string,
  options: { since?: string; limit?: number },
): MeasurementPoint[] {
  const rows = db
    .prepare(
      `SELECT measured_at, value FROM measurements
       WHERE run_id = ? AND station_id = ? AND parameter_code = ? AND measured_at <= ? AND measured_at > ?
       ORDER BY measured_at DESC LIMIT ?`,
    )
    .all(runId, stationId, parameter, asOf, options.since ?? '', options.limit ?? -1);
  return rows.reverse().map((r) => ({ measuredAt: String(r.measured_at), value: Number(r.value) }));
}

export function evaluateStation(db: Db, stationId: number, options: EvaluateOptions = {}): StationEvaluation {
  const { config, version } = loadRiskConfig(db);
  const runId = options.runId ?? currentRunId(db);
  const asOf = options.at ?? (runId !== null ? runModelTime(db, runId) : null) ?? new Date().toISOString();
  const asOfIso = new Date(asOf).toISOString();
  const asOfMs = Date.parse(asOfIso);
  const hoursBefore = (h: number) => new Date(asOfMs - h * MS_PER_HOUR).toISOString();
  const computedAt = options.computedAt ?? new Date().toISOString();
  const memo = new Map<number, StationEvaluation>();

  const evaluate = (id: number, visiting: Set<number>): StationEvaluation => {
    const cached = memo.get(id);
    if (cached) return cached;
    const row = db.prepare(`SELECT ${STATION_COLUMNS} FROM stations WHERE id = ?`).get(id);
    if (!row) throw new Error(`station ${id} not found`);
    const station = toStation(row);
    visiting.add(id);

    const params = db
      .prepare('SELECT parameter_code, warning, danger FROM station_parameters WHERE station_id = ?')
      .all(id);
    const sensors = params.map((p) => p.parameter_code as ParameterCode);
    const levelRow = params.find((p) => p.parameter_code === 'water_level');
    const thresholds = {
      warning: levelRow?.warning === null || levelRow?.warning === undefined ? null : Number(levelRow.warning),
      danger: levelRow?.danger === null || levelRow?.danger === undefined ? null : Number(levelRow.danger),
    };

    let upstream: UpstreamInfo | null = null;
    if (station.upstreamId !== null && !visiting.has(station.upstreamId)) {
      const up = evaluate(station.upstreamId, visiting);
      upstream = { stationCode: up.station.code, risk: up.assessment.risk, travelHours: station.travelHours };
    }

    const data: Partial<Record<ParameterCode, MeasurementPoint[]>> = {};
    if (runId !== null) {
      data.water_level = series(db, runId, id, 'water_level', asOfIso, { limit: config.windowSize * 3 });
      data.precipitation = series(db, runId, id, 'precipitation', asOfIso, { since: hoursBefore(config.rainWindowH + config.maxGapH) });
      data.air_temp = series(db, runId, id, 'air_temp', asOfIso, { since: hoursBefore(config.meltWindowH) });
    }

    const assessment = assessRisk({
      asOf: asOfIso,
      thresholds,
      sensors,
      series: data,
      upstream,
      config,
      configVersion: version,
      computedAt,
    });
    const { upstreamId: _u, travelHours: _t, ...ref } = station;
    const result: StationEvaluation = { station: ref, runId, assessment };
    memo.set(id, result);
    visiting.delete(id);
    return result;
  };

  return evaluate(stationId, new Set());
}
