export interface XY {
  t: number;
  h: number;
}

export interface RegressionResult {
  n: number;
  /** Наклон прямой (для уровня — см/ч). */
  slope: number;
  intercept: number;
  /** Стандартная ошибка наклона; null при n < 3 (оценить разброс не из чего). */
  stdErr: number | null;
}

/**
 * Линейная регрессия методом наименьших квадратов:
 * slope = Σ(t−t̄)(h−h̄) / Σ(t−t̄)²,  stdErr = sqrt( Σres² / (n−2) / Σ(t−t̄)² ).
 * Возвращает null, если точек меньше двух или все они в один момент времени.
 */
export function linearRegression(points: readonly XY[]): RegressionResult | null {
  const n = points.length;
  if (n < 2) return null;
  const tMean = points.reduce((s, p) => s + p.t, 0) / n;
  const hMean = points.reduce((s, p) => s + p.h, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.t - tMean) ** 2;
    sxy += (p.t - tMean) * (p.h - hMean);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = hMean - slope * tMean;
  let stdErr: number | null = null;
  if (n >= 3) {
    const ssr = points.reduce((s, p) => s + (p.h - (intercept + slope * p.t)) ** 2, 0);
    stdErr = Math.sqrt(ssr / (n - 2) / sxx);
  }
  return { n, slope, intercept, stdErr };
}
