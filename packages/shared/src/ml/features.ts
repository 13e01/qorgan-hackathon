// Признаки ML-модели QORGAN Sentinel (docs/SENTINEL_ML.md §3). Чистые функции, без БД и сети.
//
// Один и тот же код используется при подготовке обучающих данных (ml/dataset/export.ts) и при оценке на сервере —
// так признаки при обучении и при работе не расходятся. Берутся только точки с временем ≤ asOf: будущее модель не видит.
// Признаки выражены относительно порогов станции (уровень − порог), поэтому модель не зависит от конкретной станции
// и продолжает работать, если администратор меняет пороги. Нет данных → NaN (XGBoost обрабатывает пропуски сам).

import type { MeasurementPoint } from '../risk/types';

const MS_PER_HOUR = 3_600_000;

/** Порядок признаков — часть контракта модели: модель обучена именно в таком порядке (FEATURE_SCHEMA_VERSION). */
export const FEATURE_NAMES = [
  'level_vs_danger_cm',
  'level_vs_warning_cm',
  'delta_1h_cm',
  'delta_3h_cm',
  'delta_6h_cm',
  'delta_12h_cm',
  'slope_6h_cm_h',
  'accel_3h_cm',
  'ma6_dev_cm',
  'data_age_h',
  'rain_6h_mm',
  'temp_mean_24h_c',
  'up_level_vs_danger_cm',
  'up_delta_3h_cm',
  'up_delta_6h_cm',
  'up_arriving_6h_cm',
  'up_travel_h',
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

/** Версия набора признаков. Меняется при любом изменении состава, порядка или способа расчёта признаков. */
export const FEATURE_SCHEMA_VERSION = 1;

/** Горизонт прогноза модели: «достигнет ли уровень порога в ближайшие 6 ч». */
export const ML_HORIZON_H = 6;

/** Сколько часов истории уровня нужно станции и станции выше по течению (с запасом на время добегания). */
export const LEVEL_HISTORY_H = 24;
export const UPSTREAM_HISTORY_EXTRA_H = 24;

/** Максимальный возраст последнего измерения уровня, при котором модель ещё оценивает (как staleAfterH у T2). */
export const ML_MAX_AGE_H = 3;

export interface MlUpstreamInput {
  level: readonly MeasurementPoint[];
  dangerCm: number | null;
  /** Время добегания волны от верхней станции, ч. */
  travelHours: number | null;
}

export interface MlStationInput {
  asOf: string;
  thresholds: { warning: number | null; danger: number | null };
  level: readonly MeasurementPoint[];
  /** null — у станции нет датчика (признак NaN). */
  precipitation: readonly MeasurementPoint[] | null;
  airTemp: readonly MeasurementPoint[] | null;
  upstream: MlUpstreamInput | null;
}

export type FeatureVector = Record<FeatureName, number>;

interface Pt {
  t: number;
  v: number;
}

/** Числовые точки не позже asOf, по времени; из точек с одинаковым временем остаётся последняя. */
function clean(points: readonly MeasurementPoint[] | null, asOfMs: number): Pt[] {
  if (!points) return [];
  const byTime = new Map<number, number>();
  for (const p of points) {
    const t = Date.parse(p.measuredAt);
    if (!Number.isFinite(t) || !Number.isFinite(p.value) || t > asOfMs) continue;
    byTime.set(t, p.value);
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}

/** Значение на момент `t`: последняя точка не позже t и не раньше t − tolerance; иначе NaN. */
function valueAt(points: Pt[], t: number, toleranceH = 0.5): number {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const p = points[i]!;
    if (p.t > t) continue;
    return t - p.t <= toleranceH * MS_PER_HOUR ? p.v : Number.NaN;
  }
  return Number.NaN;
}

function slope(points: Pt[]): number {
  if (points.length < 3) return Number.NaN;
  const xs = points.map((p) => p.t / MS_PER_HOUR);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = points.reduce((a, p) => a + p.v, 0) / points.length;
  let num = 0;
  let den = 0;
  points.forEach((p, i) => {
    num += (xs[i]! - mx) * (p.v - my);
    den += (xs[i]! - mx) ** 2;
  });
  return den === 0 ? Number.NaN : num / den;
}

const sub = (a: number, b: number) => a - b; // NaN распространяется сам

/**
 * Признаки станции на момент asOf. Опорная точка h0 — последнее измерение (не старше ML_MAX_AGE_H);
 * изменения за 1/3/6/12 ч считаются от h0 к значениям в моменты t0 − k ч (если там нет точки — NaN).
 */
export function computeFeatures(input: MlStationInput): FeatureVector {
  const asOfMs = Date.parse(input.asOf);
  const level = clean(input.level, asOfMs);
  const last = level.at(-1);
  const t0 = last?.t ?? Number.NaN;
  const h0 = last?.v ?? Number.NaN;
  const ageH = last ? (asOfMs - last.t) / MS_PER_HOUR : Number.NaN;
  const at = (k: number) => (last ? valueAt(level, t0 - k * MS_PER_HOUR) : Number.NaN);
  const h1 = at(1);
  const h3 = at(3);
  const h6 = at(6);
  const recent6 = last ? level.filter((p) => p.t > t0 - 6 * MS_PER_HOUR) : [];
  const { warning, danger } = input.thresholds;

  let rain = Number.NaN;
  if (input.precipitation) {
    const pts = clean(input.precipitation, asOfMs).filter((p) => p.t > asOfMs - 6 * MS_PER_HOUR);
    // Интенсивность мм/ч × 1 ч на точку (часовые показания); нет ни одной точки — NaN, а не 0.
    if (pts.length > 0) rain = pts.reduce((a, p) => a + p.v, 0);
  }
  let temp = Number.NaN;
  if (input.airTemp) {
    const pts = clean(input.airTemp, asOfMs).filter((p) => p.t > asOfMs - 24 * MS_PER_HOUR);
    if (pts.length > 0) temp = pts.reduce((a, p) => a + p.v, 0) / pts.length;
  }

  let upVsDanger = Number.NaN;
  let upD3 = Number.NaN;
  let upD6 = Number.NaN;
  let upArriving = Number.NaN;
  let upTravel = Number.NaN;
  const up = input.upstream;
  if (up) {
    const ul = clean(up.level, asOfMs);
    const uLast = ul.at(-1);
    if (uLast && (asOfMs - uLast.t) / MS_PER_HOUR <= ML_MAX_AGE_H) {
      const u0 = uLast.v;
      upVsDanger = up.dangerCm === null ? Number.NaN : u0 - up.dangerCm;
      upD3 = sub(u0, valueAt(ul, uLast.t - 3 * MS_PER_HOUR));
      upD6 = sub(u0, valueAt(ul, uLast.t - 6 * MS_PER_HOUR));
    }
    if (up.travelHours !== null && up.travelHours >= 0) {
      upTravel = up.travelHours;
      // Что «едет» к станции в ближайшие 6 ч: изменение уровня выше по течению между моментами, которые дойдут
      // сюда через 6 ч и сейчас (asOf − τ + 6 и asOf − τ). Если τ < 6, часть этого окна ещё в будущем — берём
      // последнее известное значение, но не позже asOf: будущие точки не используются.
      const lead = Math.min(asOfMs, asOfMs - (up.travelHours - ML_HORIZON_H) * MS_PER_HOUR);
      const now = asOfMs - up.travelHours * MS_PER_HOUR;
      upArriving = sub(valueAt(ul, lead, 1), valueAt(ul, now, 1));
    }
  }

  return {
    level_vs_danger_cm: danger === null ? Number.NaN : h0 - danger,
    level_vs_warning_cm: warning === null ? Number.NaN : h0 - warning,
    delta_1h_cm: sub(h0, h1),
    delta_3h_cm: sub(h0, h3),
    delta_6h_cm: sub(h0, h6),
    delta_12h_cm: sub(h0, at(12)),
    slope_6h_cm_h: slope(recent6),
    accel_3h_cm: sub(sub(h0, h3), sub(h3, h6)),
    ma6_dev_cm: recent6.length >= 3 ? h0 - recent6.reduce((a, p) => a + p.v, 0) / recent6.length : Number.NaN,
    data_age_h: ageH,
    rain_6h_mm: rain,
    temp_mean_24h_c: temp,
    up_level_vs_danger_cm: upVsDanger,
    up_delta_3h_cm: upD3,
    up_delta_6h_cm: upD6,
    up_arriving_6h_cm: upArriving,
    up_travel_h: upTravel,
  };
}

/** Признаки в порядке FEATURE_NAMES (для модели). */
export function featureArray(f: FeatureVector): number[] {
  return FEATURE_NAMES.map((n) => f[n]);
}

/** Признаки для JSON (NaN → null, округление до 0,01). */
export function featuresToJson(f: FeatureVector): Record<FeatureName, number | null> {
  const out = {} as Record<FeatureName, number | null>;
  for (const n of FEATURE_NAMES) out[n] = Number.isFinite(f[n]) ? Math.round(f[n] * 100) / 100 + 0 : null;
  return out;
}
