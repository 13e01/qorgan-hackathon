// QORGAN Sentinel на сервере (docs/SENTINEL_ARCHITECTURE.md): загрузка модели при старте и параллельная оценка
// станций в транзакции приёма пакета, сразу после правил T2. Категорию T2 и предупреждения ML не меняет.
//
// Модели нет / файл несовместим → статус MISSING / INVALID, QORGAN работает как раньше, оценки ML не пишутся.
// Ошибка расчёта по одной станции → строка со статусом ERROR; приём пакета из-за ML не откатывается.

import { existsSync, readFileSync } from 'node:fs';
import {
  assessWithModel,
  compareWithRules,
  LEVEL_HISTORY_H,
  UPSTREAM_HISTORY_EXTRA_H,
  validateModel,
  type MeasurementPoint,
  type MlAssessment,
  type RiskLevel,
  type SentinelModel,
} from '@qorgan/shared';
import type { Db } from '../db/connection';
import type { StationEvaluation } from '../risk/service';

const MS_PER_HOUR = 3_600_000;

export type MlRuntimeStatus = 'READY' | 'DISABLED' | 'MISSING' | 'INVALID';

export interface MlRuntime {
  status: MlRuntimeStatus;
  /** Код проблемы для INVALID (FORMAT, FEATURE_SCHEMA, JSON, …). */
  problem: string | null;
  model: SentinelModel | null;
}

export const ML_DISABLED: MlRuntime = { status: 'DISABLED', problem: null, model: null };

/** Загрузка модели один раз при старте. Тяжёлого обучения на сервере нет — только чтение JSON. */
export function loadMlRuntime(path: string | null): MlRuntime {
  if (!path) return ML_DISABLED;
  if (!existsSync(path)) return { status: 'MISSING', problem: null, model: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { status: 'INVALID', problem: 'JSON', model: null };
  }
  const v = validateModel(raw);
  return v.ok ? { status: 'READY', problem: null, model: v.model } : { status: 'INVALID', problem: v.problem, model: null };
}

/** Публичные сведения о модели (без деревьев и примеров паритета). */
export function mlInfo(rt: MlRuntime) {
  const m = rt.model;
  return {
    status: rt.status,
    problem: rt.problem,
    model: m
      ? {
          version: m.modelVersion,
          algorithm: m.algorithm,
          horizonH: m.horizonH,
          demo: m.demo,
          features: m.featureNames,
          thresholds: { danger: m.targets.danger.threshold, warning: m.targets.warning.threshold },
          trees: { danger: m.targets.danger.booster.trees.length, warning: m.targets.warning.booster.trees.length },
          trainedWith: m.trainedWith,
          dataset: m.dataset,
          metrics: m.metrics,
        }
      : null,
  };
}

interface StationMlRow {
  id: number;
  upstreamId: number | null;
  travelHours: number | null;
  warning: number | null;
  danger: number | null;
  sensors: Set<string>;
}

function stationInfo(db: Db, id: number): StationMlRow | null {
  const s = db.prepare('SELECT id, upstream_station_id, travel_hours FROM stations WHERE id = ?').get(id);
  if (!s) return null;
  const params = db.prepare('SELECT parameter_code, warning, danger FROM station_parameters WHERE station_id = ?').all(id);
  const level = params.find((p) => p.parameter_code === 'water_level');
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id,
    upstreamId: num(s.upstream_station_id),
    travelHours: num(s.travel_hours),
    warning: num(level?.warning),
    danger: num(level?.danger),
    sensors: new Set(params.map((p) => String(p.parameter_code))),
  };
}

function series(db: Db, runId: number, stationId: number, parameter: string, asOf: string, hours: number): MeasurementPoint[] {
  const since = new Date(Date.parse(asOf) - hours * MS_PER_HOUR).toISOString();
  return db
    .prepare(
      `SELECT measured_at, value FROM measurements
       WHERE run_id = ? AND station_id = ? AND parameter_code = ? AND measured_at <= ? AND measured_at >= ?
       ORDER BY measured_at`,
    )
    .all(runId, stationId, parameter, asOf, since)
    .map((r) => ({ measuredAt: String(r.measured_at), value: Number(r.value) }));
}

/** Оценка одной станции моделью по данным БД на момент asOf (только измерения с временем ≤ asOf). */
export function assessStation(db: Db, model: SentinelModel, runId: number, stationId: number, asOf: string): MlAssessment {
  const st = stationInfo(db, stationId);
  if (!st) throw new Error(`station ${stationId} not found`);
  const up = st.upstreamId !== null ? stationInfo(db, st.upstreamId) : null;
  return assessWithModel(model, {
    asOf,
    thresholds: { warning: st.warning, danger: st.danger },
    level: series(db, runId, st.id, 'water_level', asOf, LEVEL_HISTORY_H),
    precipitation: st.sensors.has('precipitation') ? series(db, runId, st.id, 'precipitation', asOf, 7) : null,
    airTemp: st.sensors.has('air_temp') ? series(db, runId, st.id, 'air_temp', asOf, 24) : null,
    upstream: up
      ? { level: series(db, runId, up.id, 'water_level', asOf, (st.travelHours ?? 0) + UPSTREAM_HISTORY_EXTRA_H + 1), dangerCm: up.danger, travelHours: st.travelHours }
      : null,
  });
}

/**
 * Параллельная оценка всех станций тика; вызывается в транзакции приёма после сохранения оценок T2.
 * Ничего не бросает: ошибка расчёта сохраняется как статус ERROR и не откатывает пакет.
 */
export function persistMlAssessments(db: Db, rt: MlRuntime, runId: number, tick: number, asOf: string, evaluations: StationEvaluation[], now: string): void {
  const model = rt.model;
  if (rt.status !== 'READY' || !model) return;
  const insert = db.prepare(
    `INSERT OR REPLACE INTO ml_assessments
       (run_id, station_id, tick, as_of, model_version, status, category, p_danger, p_warning, rules_risk, agreement, result_json, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of evaluations) {
    const rules = e.assessment.risk;
    try {
      const a = assessStation(db, model, runId, e.station.id, asOf);
      insert.run(runId, e.station.id, tick, asOf, model.modelVersion, a.status, a.category, a.pDanger, a.pWarning, rules, compareWithRules(a.category, rules), JSON.stringify(a), now);
    } catch {
      insert.run(runId, e.station.id, tick, asOf, model.modelVersion, 'ERROR', null, null, null, rules, null, '{}', now);
    }
  }
}

export interface MlStationView {
  tick: number;
  asOf: string;
  modelVersion: string;
  status: 'OK' | 'INSUFFICIENT_DATA' | 'ERROR';
  category: RiskLevel | null;
  pDanger: number | null;
  pWarning: number | null;
  rulesRisk: RiskLevel;
  agreement: 'AGREE' | 'ML_HIGHER' | 'ML_LOWER' | null;
  computedAt: string;
}

function toView(r: Record<string, unknown>): MlStationView {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    tick: Number(r.tick),
    asOf: String(r.as_of),
    modelVersion: String(r.model_version),
    status: r.status as MlStationView['status'],
    category: (r.category ?? null) as RiskLevel | null,
    pDanger: n(r.p_danger),
    pWarning: n(r.p_warning),
    rulesRisk: r.rules_risk as RiskLevel,
    agreement: (r.agreement ?? null) as MlStationView['agreement'],
    computedAt: String(r.computed_at),
  };
}

/** Последняя оценка ML станции в прогоне не позже asOf (один снимок с оценкой T2 на тот же момент). */
export function latestMl(db: Db, runId: number, stationId: number, asOf: string): (MlStationView & { result: MlAssessment | null }) | null {
  const r = db
    .prepare('SELECT * FROM ml_assessments WHERE run_id = ? AND station_id = ? AND as_of <= ? ORDER BY tick DESC LIMIT 1')
    .get(runId, stationId, asOf);
  if (!r) return null;
  const parsed = JSON.parse(String(r.result_json)) as Partial<MlAssessment>;
  return { ...toView(r), result: r.status === 'ERROR' ? null : (parsed as MlAssessment) };
}

export function mlHistory(db: Db, runId: number, stationId: number, limit: number): MlStationView[] {
  return db
    .prepare('SELECT * FROM ml_assessments WHERE run_id = ? AND station_id = ? ORDER BY tick DESC LIMIT ?')
    .all(runId, stationId, limit)
    .reverse()
    .map(toView);
}
