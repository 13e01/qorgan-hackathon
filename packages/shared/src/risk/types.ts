// Типы модуля оценки риска (docs/ARCHITECTURE.md §8).

import type { ParameterCode, RiskConfig } from '../domain';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type TrendDirection = 'RISING' | 'STABLE' | 'FALLING' | 'UNKNOWN';
/** Как изменилась скорость между началом и концом окна: ACCELERATING — стала больше (рост ускоряется). */
export type RateChange = 'ACCELERATING' | 'DECELERATING' | 'STEADY' | 'UNKNOWN';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type DataStatus = 'OK' | 'DEGRADED' | 'INSUFFICIENT' | 'STALE' | 'NO_DATA';
export type ForecastStatus = 'OK' | 'INSUFFICIENT_DATA' | 'STALE_DATA' | 'NO_DATA';
export type EtaStatus =
  | 'ESTIMATED'
  | 'ALREADY_EXCEEDED'
  | 'NOT_EXPECTED'
  | 'BEYOND_HORIZON'
  | 'UNAVAILABLE'
  | 'NO_THRESHOLD';
export type FactorCode = 'LEVEL' | 'TREND' | 'RAIN' | 'MELT' | 'UPSTREAM';
export type FactorStatus = 'OK' | 'NO_DATA' | 'NO_SENSOR' | 'NOT_APPLICABLE' | 'STALE';

/** Коды причин переводит фронтенд; params подставляются в текст. */
export type ReasonCode =
  | 'LEVEL_ABOVE_DANGER'
  | 'LEVEL_ABOVE_WARNING'
  | 'ETA_DANGER_WITHIN'
  | 'ETA_BEYOND_HORIZON'
  | 'RISING'
  | 'FALLING'
  | 'STABLE'
  | 'ACCELERATING_RISE'
  | 'DECELERATING_RISE'
  | 'HEAVY_RAIN'
  | 'MODERATE_RAIN'
  | 'SNOWMELT'
  | 'UPSTREAM_WAVE'
  | 'NO_DATA'
  | 'NO_SENSOR'
  | 'NO_THRESHOLD'
  | 'INSUFFICIENT_DATA'
  | 'STALE_DATA'
  | 'SPIKE_IGNORED'
  | 'SPIKE_UNCONFIRMED'
  | 'SUDDEN_JUMP'
  | 'DATA_GAP'
  | 'INVALID_POINTS'
  | 'FUTURE_POINTS'
  | 'DUPLICATE_TIMESTAMPS';

export interface Reason {
  code: ReasonCode;
  params?: Record<string, number | string>;
}

export interface MeasurementPoint {
  /** Время измерения, ISO 8601. */
  measuredAt: string;
  value: number;
}

export interface UpstreamInfo {
  stationCode: string;
  risk: RiskLevel;
  /** Время добегания волны от верхней станции, ч; null — не задано. */
  travelHours: number | null;
}

export interface RiskInput {
  /** Момент, на который выполняется оценка (модельное время). Точки позже него не используются. */
  asOf: string;
  thresholds: { warning: number | null; danger: number | null };
  /** Какие датчики есть у станции — чтобы отличить «нет датчика» от «нет данных». */
  sensors: readonly ParameterCode[];
  series: Partial<Record<ParameterCode, readonly MeasurementPoint[]>>;
  upstream: UpstreamInfo | null;
  config: RiskConfig;
  configVersion?: number | null;
  /** Реальное время расчёта (ISO); по умолчанию совпадает с asOf — так результат полностью детерминирован. */
  computedAt?: string;
}

export interface RiskFactor {
  code: FactorCode;
  /** Вклад в итоговый балл. */
  points: number;
  maxPoints: number;
  status: FactorStatus;
  /** Значение, по которому оценивался фактор (уровень, ETA, мм осадков, °C, …). */
  value: number | null;
  unit: string | null;
  reason: Reason | null;
}

export interface RiskAssessment {
  model: { id: 'QORGAN-RULES-1'; method: 'RULES_AND_LINEAR_TREND'; demo: true; configVersion: number | null };
  /** Момент (модельное время), на который оценены данные. */
  asOf: string;
  /** Когда выполнен расчёт. */
  computedAt: string;
  risk: RiskLevel;
  score: number;
  maxScore: number;
  level: {
    currentCm: number | null;
    measuredAt: string | null;
    ageH: number | null;
    warningCm: number | null;
    dangerCm: number | null;
  };
  trend: {
    direction: TrendDirection;
    rateCmH: number | null;
    rateStdErr: number | null;
    rateChange: RateChange;
    earlyRateCmH: number | null;
    recentRateCmH: number | null;
    pointsUsed: number;
    windowStart: string | null;
    windowEnd: string | null;
  };
  forecast: {
    status: ForecastStatus;
    horizonH: number;
    levelCm: number | null;
    lowCm: number | null;
    highCm: number | null;
  };
  eta: {
    status: EtaStatus;
    hours: number | null;
    lowH: number | null;
    /** null при status ESTIMATED — верхняя граница не ограничена (рост может остановиться). */
    highH: number | null;
  };
  factors: RiskFactor[];
  /** Причины итоговой оценки: сначала факторы с наибольшим вкладом, затем замечания о данных. */
  reasons: Reason[];
  dataQuality: {
    status: DataStatus;
    confidence: Confidence;
    pointsExcluded: number;
    issues: Reason[];
  };
}
