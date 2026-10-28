// Модуль оценки риска паводка: прозрачные правила + баллы по 5 факторам + линейный тренд уровня.
// Это учебная модель, не машинное обучение и не научно подтверждённый прогноз.
// Алгоритм описан в docs/ARCHITECTURE.md §8; каждый шаг ниже ссылается на него.

import type { ParameterCode, RiskConfig } from '../domain';
import { linearRegression, type RegressionResult } from './regression';
import type {
  Confidence,
  DataStatus,
  EtaStatus,
  ForecastStatus,
  MeasurementPoint,
  RateChange,
  Reason,
  RiskAssessment,
  RiskFactor,
  RiskInput,
  RiskLevel,
  TrendDirection,
} from './types';

const MS_PER_HOUR = 3_600_000;

interface Point {
  /** Часы относительно asOf (≤ 0). */
  t: number;
  h: number;
  at: string;
}

interface CleanSeries {
  points: Point[];
  invalid: number;
  future: number;
  duplicates: number;
}

/** Отбрасывает нечисловые значения, неверные даты и точки из будущего; сортирует; из дублей по времени оставляет последний. */
export function cleanSeries(raw: readonly MeasurementPoint[] | undefined, asOfMs: number): CleanSeries {
  const result: CleanSeries = { points: [], invalid: 0, future: 0, duplicates: 0 };
  const valid: Array<{ ms: number; h: number; order: number }> = [];
  (raw ?? []).forEach((p, order) => {
    const ms = Date.parse(p.measuredAt);
    if (!Number.isFinite(ms) || typeof p.value !== 'number' || !Number.isFinite(p.value)) result.invalid += 1;
    else if (ms > asOfMs) result.future += 1;
    else valid.push({ ms, h: p.value, order });
  });
  valid.sort((a, b) => a.ms - b.ms || a.order - b.order);
  for (const v of valid) {
    const point = { t: (v.ms - asOfMs) / MS_PER_HOUR, h: v.h, at: new Date(v.ms).toISOString() };
    const last = result.points.at(-1);
    if (last && last.at === point.at) {
      result.points[result.points.length - 1] = point;
      result.duplicates += 1;
    } else {
      result.points.push(point);
    }
  }
  return result;
}

interface LevelAnalysis {
  kept: Point[];
  regression: RegressionResult | null;
  gapH: number | null;
  spikesIgnored: number;
  unconfirmed: { valueCm: number; jumpCm: number } | null;
  suddenJumpCm: number | null;
}

/** Шаги 1–3: окно последних N точек, обрезка по разрыву, фильтр выбросов, регрессия. */
function analyzeLevel(points: Point[], cfg: RiskConfig): LevelAnalysis {
  let window = points.slice(-cfg.windowSize);
  let gapH: number | null = null;
  for (let i = window.length - 1; i > 0; i -= 1) {
    const gap = window[i]!.t - window[i - 1]!.t;
    if (gap > cfg.maxGapH) {
      gapH = gap;
      window = window.slice(i);
      break;
    }
  }

  const kept: Point[] = [];
  let spikesIgnored = 0;
  let unconfirmed: LevelAnalysis['unconfirmed'] = null;
  let suddenJumpCm: number | null = null;
  window.forEach((p, i) => {
    const prev = kept.at(-1);
    if (!prev) {
      kept.push(p);
      return;
    }
    const limit = cfg.maxJumpCm * Math.max(1, p.t - prev.t);
    const jump = p.h - prev.h;
    if (Math.abs(jump) <= limit) {
      kept.push(p);
      return;
    }
    const next = window[i + 1];
    if (!next) {
      unconfirmed = { valueCm: p.h, jumpCm: jump };
    } else if (Math.abs(next.h - prev.h) <= limit / 2) {
      spikesIgnored += 1;
    } else {
      kept.push(p);
      if (suddenJumpCm === null || Math.abs(jump) > Math.abs(suddenJumpCm)) suddenJumpCm = jump;
    }
  });

  const regression = kept.length >= cfg.minPoints ? linearRegression(kept) : null;
  return { kept, regression, gapH, spikesIgnored, unconfirmed, suddenJumpCm };
}

/** Сравнение скорости в начале и в конце окна (по 3 точки) — ускоряется или замедляется рост. */
function rateChange(kept: Point[], cfg: RiskConfig): { change: RateChange; early: number | null; recent: number | null } {
  if (kept.length < 6) return { change: 'UNKNOWN', early: null, recent: null };
  const early = linearRegression(kept.slice(0, 3));
  const recent = linearRegression(kept.slice(-3));
  if (!early || !recent) return { change: 'UNKNOWN', early: null, recent: null };
  const diff = recent.slope - early.slope;
  const change: RateChange =
    diff > cfg.accelerationCmH ? 'ACCELERATING' : diff < -cfg.accelerationCmH ? 'DECELERATING' : 'STEADY';
  return { change, early: early.slope, recent: recent.slope };
}

/** Сумма осадков за окно: каждое измерение — средняя интенсивность (мм/ч) за интервал до него. */
function rainTotalMm(points: Point[], windowH: number): number | null {
  const start = -windowH;
  let total = 0;
  let any = false;
  points.forEach((p, i) => {
    if (p.t <= start) return;
    const prevT = i > 0 ? points[i - 1]!.t : p.t - 1;
    total += Math.max(0, p.h) * (p.t - Math.max(prevT, start));
    any = true;
  });
  return any ? total : null;
}

function meanTemp(points: Point[], windowH: number): number | null {
  const inWindow = points.filter((p) => p.t > -windowH);
  if (inWindow.length === 0) return null;
  return inWindow.reduce((s, p) => s + p.h, 0) / inWindow.length;
}

/** Округление для вывода: без -0, NaN и Infinity. */
function round(x: number, digits = 2): number {
  if (!Number.isFinite(x)) throw new Error(`risk engine produced non-finite number: ${x}`);
  const f = 10 ** digits;
  return Math.round(x * f) / f + 0;
}

function roundOrNull(x: number | null, digits = 2): number | null {
  return x === null ? null : round(x, digits);
}

const CONFIDENCE_ORDER: Confidence[] = ['LOW', 'MEDIUM', 'HIGH'];
const minConfidence = (a: Confidence, b: Confidence): Confidence =>
  CONFIDENCE_ORDER[Math.min(CONFIDENCE_ORDER.indexOf(a), CONFIDENCE_ORDER.indexOf(b))]!;

export function assessRisk(input: RiskInput): RiskAssessment {
  const cfg = input.config;
  const asOfMs = Date.parse(input.asOf);
  if (!Number.isFinite(asOfMs)) throw new Error(`invalid asOf: ${input.asOf}`);
  const has = (p: ParameterCode) => input.sensors.includes(p);
  const { warning, danger } = input.thresholds;
  const issues: Reason[] = [];

  const cleaned = {} as Record<ParameterCode, CleanSeries>;
  for (const parameter of ['water_level', 'precipitation', 'air_temp'] as const) {
    const c = cleanSeries(input.series[parameter], asOfMs);
    cleaned[parameter] = c;
    if (c.invalid) issues.push({ code: 'INVALID_POINTS', params: { parameter, count: c.invalid } });
    if (c.future) issues.push({ code: 'FUTURE_POINTS', params: { parameter, count: c.future } });
    if (c.duplicates) issues.push({ code: 'DUPLICATE_TIMESTAMPS', params: { parameter, count: c.duplicates } });
  }

  // --- Уровень и тренд (шаги 1–4) ---
  const levelPoints = cleaned.water_level.points;
  const analysis = levelPoints.length > 0 ? analyzeLevel(levelPoints, cfg) : null;
  const current = analysis?.kept.at(-1) ?? null;
  const h = current?.h ?? null;
  const ageH = current ? -current.t : null;
  const stale = ageH !== null && ageH > cfg.staleAfterH;
  const reg = analysis?.regression ?? null;
  const v = reg?.slope ?? null;
  const se = reg?.stdErr ?? 0;
  const direction: TrendDirection =
    v === null ? 'UNKNOWN' : v > cfg.epsilonCmH ? 'RISING' : v < -cfg.epsilonCmH ? 'FALLING' : 'STABLE';
  const change = analysis ? rateChange(analysis.kept, cfg) : { change: 'UNKNOWN' as const, early: null, recent: null };

  if (analysis) {
    if (analysis.gapH !== null) issues.push({ code: 'DATA_GAP', params: { hours: round(analysis.gapH) } });
    if (analysis.spikesIgnored) issues.push({ code: 'SPIKE_IGNORED', params: { count: analysis.spikesIgnored } });
    if (analysis.unconfirmed) {
      issues.push({
        code: 'SPIKE_UNCONFIRMED',
        params: { valueCm: round(analysis.unconfirmed.valueCm), jumpCm: round(analysis.unconfirmed.jumpCm) },
      });
    }
    if (analysis.suddenJumpCm !== null) issues.push({ code: 'SUDDEN_JUMP', params: { jumpCm: round(analysis.suddenJumpCm) } });
    if (!reg) issues.push({ code: 'INSUFFICIENT_DATA', params: { points: analysis.kept.length, required: cfg.minPoints } });
  } else if (has('water_level')) {
    issues.push({ code: 'NO_DATA', params: { parameter: 'water_level' } });
  }
  if (stale && ageH !== null) issues.push({ code: 'STALE_DATA', params: { ageH: round(ageH) } });

  // --- Прогноз на горизонт H_f (шаг 5) ---
  const horizonH = cfg.forecastHorizonH;
  let forecastStatus: ForecastStatus;
  let forecast: { level: number; low: number; high: number } | null = null;
  if (h === null || ageH === null) forecastStatus = 'NO_DATA';
  else if (stale) forecastStatus = 'STALE_DATA';
  else if (v === null) forecastStatus = 'INSUFFICIENT_DATA';
  else {
    forecastStatus = 'OK';
    const span = ageH + horizonH;
    forecast = { level: h + v * span, low: h + (v - se) * span, high: h + (v + se) * span };
  }

  // --- Время до опасного порога (шаг 6) ---
  let etaStatus: EtaStatus;
  let eta: { hours: number | null; low: number | null; high: number | null } = { hours: null, low: null, high: null };
  if (h === null || ageH === null) etaStatus = 'UNAVAILABLE';
  else if (danger === null) etaStatus = 'NO_THRESHOLD';
  else if (h >= danger) {
    etaStatus = 'ALREADY_EXCEEDED';
    eta = { hours: 0, low: 0, high: 0 };
  } else if (stale || v === null) etaStatus = 'UNAVAILABLE';
  else if (direction !== 'RISING') etaStatus = 'NOT_EXPECTED';
  else {
    const remaining = danger - h;
    const hours = Math.max(0, remaining / v - ageH);
    if (hours > cfg.etaMaxH) etaStatus = 'BEYOND_HORIZON';
    else {
      etaStatus = 'ESTIMATED';
      const low = Math.max(0, remaining / (v + se) - ageH);
      const highRaw = v - se > cfg.epsilonCmH ? Math.max(0, remaining / (v - se) - ageH) : null;
      eta = { hours, low, high: highRaw !== null && highRaw <= cfg.etaMaxH ? highRaw : null };
    }
  }

  // --- Факторы и баллы (шаг 8) ---
  const pts = cfg.points;
  const factors: RiskFactor[] = [];

  {
    const f: RiskFactor = { code: 'LEVEL', points: 0, maxPoints: pts.levelDanger, status: 'OK', value: roundOrNull(h), unit: 'cm', reason: null };
    if (!has('water_level')) f.status = 'NO_SENSOR';
    else if (h === null) {
      f.status = 'NO_DATA';
      f.reason = { code: 'NO_DATA', params: { parameter: 'water_level' } };
    } else {
      if (stale) f.status = 'STALE';
      if (danger !== null && h >= danger) {
        f.points = pts.levelDanger;
        f.reason = { code: 'LEVEL_ABOVE_DANGER', params: { levelCm: round(h), dangerCm: danger } };
      } else if (warning !== null && h >= warning) {
        f.points = pts.levelWarning;
        f.reason = { code: 'LEVEL_ABOVE_WARNING', params: { levelCm: round(h), warningCm: warning } };
      }
    }
    factors.push(f);
  }

  {
    const f: RiskFactor = { code: 'TREND', points: 0, maxPoints: pts.etaHigh, status: 'OK', value: roundOrNull(v), unit: 'cm/h', reason: null };
    if (!has('water_level')) f.status = 'NO_SENSOR';
    else if (h === null) f.status = 'NO_DATA';
    else if (stale) {
      f.status = 'STALE';
      f.reason = { code: 'STALE_DATA', params: { ageH: round(ageH ?? 0) } };
    } else if (v === null) {
      f.status = 'NO_DATA';
      f.reason = { code: 'INSUFFICIENT_DATA', params: { points: analysis?.kept.length ?? 0, required: cfg.minPoints } };
    } else if (direction === 'RISING') {
      const rising: Reason = { code: 'RISING', params: { rateCmH: round(v) } };
      if (etaStatus === 'ALREADY_EXCEEDED') {
        f.points = pts.etaHigh;
        f.reason = rising;
      } else if (etaStatus === 'ESTIMATED' && eta.hours !== null && eta.hours <= cfg.mediumEtaH) {
        f.points = eta.hours <= cfg.highEtaH ? pts.etaHigh : pts.etaMedium;
        f.reason = { code: 'ETA_DANGER_WITHIN', params: { hours: round(eta.hours), rateCmH: round(v) } };
      } else {
        f.points = pts.rising;
        f.reason =
          etaStatus === 'BEYOND_HORIZON'
            ? { code: 'ETA_BEYOND_HORIZON', params: { rateCmH: round(v), maxHours: cfg.etaMaxH } }
            : rising;
      }
    } else {
      f.reason = direction === 'FALLING' ? { code: 'FALLING', params: { rateCmH: round(v) } } : { code: 'STABLE' };
    }
    factors.push(f);
  }

  {
    const f: RiskFactor = { code: 'RAIN', points: 0, maxPoints: pts.rainHeavy, status: 'OK', value: null, unit: 'mm', reason: null };
    const mm = has('precipitation') ? rainTotalMm(cleaned.precipitation.points, cfg.rainWindowH) : null;
    if (!has('precipitation')) f.status = 'NO_SENSOR';
    else if (mm === null) {
      f.status = 'NO_DATA';
      f.reason = { code: 'NO_DATA', params: { parameter: 'precipitation' } };
    } else {
      f.value = round(mm);
      const params = { mm: round(mm), hours: cfg.rainWindowH };
      if (mm >= cfg.rainHeavyMm) {
        f.points = pts.rainHeavy;
        f.reason = { code: 'HEAVY_RAIN', params };
      } else if (mm >= cfg.rainModerateMm) {
        f.points = pts.rainModerate;
        f.reason = { code: 'MODERATE_RAIN', params };
      }
    }
    factors.push(f);
  }

  {
    const f: RiskFactor = { code: 'MELT', points: 0, maxPoints: pts.melt, status: 'OK', value: null, unit: '°C', reason: null };
    const temp = has('air_temp') ? meanTemp(cleaned.air_temp.points, cfg.meltWindowH) : null;
    if (!has('air_temp')) f.status = 'NO_SENSOR';
    else if (temp === null) {
      f.status = 'NO_DATA';
      f.reason = { code: 'NO_DATA', params: { parameter: 'air_temp' } };
    } else {
      f.value = round(temp);
      if (temp >= cfg.meltTempC) {
        f.points = pts.melt;
        f.reason = { code: 'SNOWMELT', params: { tempC: round(temp), hours: cfg.meltWindowH } };
      }
    }
    factors.push(f);
  }

  {
    const up = input.upstream;
    const f: RiskFactor = { code: 'UPSTREAM', points: 0, maxPoints: pts.upstreamHigh, status: 'OK', value: up?.travelHours ?? null, unit: 'h', reason: null };
    if (!up) f.status = 'NOT_APPLICABLE';
    else if (up.travelHours === null) f.status = 'NO_DATA';
    else if (up.travelHours <= cfg.upstreamHorizonH && up.risk !== 'LOW') {
      f.points = up.risk === 'HIGH' ? pts.upstreamHigh : pts.upstreamMedium;
      f.reason = { code: 'UPSTREAM_WAVE', params: { station: up.stationCode, risk: up.risk, hours: up.travelHours } };
    }
    factors.push(f);
  }

  // --- Категория (шаг 9) ---
  const score = factors.reduce((s, f) => s + f.points, 0);
  const maxScore = factors.reduce((s, f) => s + f.maxPoints, 0);
  const aboveDanger = h !== null && danger !== null && h >= danger;
  const risk: RiskLevel =
    aboveDanger || score >= cfg.categories.highScore ? 'HIGH' : score >= cfg.categories.mediumScore ? 'MEDIUM' : 'LOW';

  // --- Достоверность (шаг 7) ---
  let confidence: Confidence;
  if (h === null || v === null || stale || analysis?.unconfirmed) confidence = 'LOW';
  else {
    const n = analysis?.kept.length ?? 0;
    confidence = n >= cfg.windowSize && se <= 0.25 * Math.abs(v) ? 'HIGH' : 'MEDIUM';
    const irregular =
      change.change === 'ACCELERATING' ||
      change.change === 'DECELERATING' ||
      (analysis !== null && (analysis.gapH !== null || analysis.spikesIgnored > 0 || analysis.suddenJumpCm !== null));
    if (irregular) confidence = minConfidence(confidence, 'MEDIUM');
  }
  const dataStatus: DataStatus =
    has('water_level') && h === null ? 'NO_DATA' : stale ? 'STALE' : has('water_level') && v === null ? 'INSUFFICIENT' : issues.length > 0 ? 'DEGRADED' : 'OK';

  // --- Причины: сначала факторы с наибольшим вкладом ---
  const reasons: Reason[] = factors
    .filter((f) => f.points > 0 && f.reason)
    .sort((a, b) => b.points - a.points)
    .map((f) => f.reason!);
  if (direction === 'RISING' && change.change === 'ACCELERATING' && change.early !== null && change.recent !== null) {
    reasons.push({ code: 'ACCELERATING_RISE', params: { earlyRateCmH: round(change.early), recentRateCmH: round(change.recent) } });
  } else if (direction === 'RISING' && change.change === 'DECELERATING' && change.early !== null && change.recent !== null) {
    reasons.push({ code: 'DECELERATING_RISE', params: { earlyRateCmH: round(change.early), recentRateCmH: round(change.recent) } });
  }
  reasons.push(...issues);

  const kept = analysis?.kept ?? [];
  return {
    model: { id: 'QORGAN-RULES-1', method: 'RULES_AND_LINEAR_TREND', demo: true, configVersion: input.configVersion ?? null },
    asOf: new Date(asOfMs).toISOString(),
    computedAt: input.computedAt ?? new Date(asOfMs).toISOString(),
    risk,
    score,
    maxScore,
    level: {
      currentCm: roundOrNull(h),
      measuredAt: current?.at ?? null,
      ageH: roundOrNull(ageH),
      warningCm: warning,
      dangerCm: danger,
    },
    trend: {
      direction,
      rateCmH: roundOrNull(v, 3),
      rateStdErr: reg && reg.stdErr !== null ? round(reg.stdErr, 3) : null,
      rateChange: change.change,
      earlyRateCmH: roundOrNull(change.early, 3),
      recentRateCmH: roundOrNull(change.recent, 3),
      pointsUsed: kept.length,
      windowStart: kept[0]?.at ?? null,
      windowEnd: kept.at(-1)?.at ?? null,
    },
    forecast: {
      status: forecastStatus,
      horizonH,
      levelCm: forecast ? round(forecast.level) : null,
      lowCm: forecast ? round(forecast.low) : null,
      highCm: forecast ? round(forecast.high) : null,
    },
    eta: { status: etaStatus, hours: roundOrNull(eta.hours), lowH: roundOrNull(eta.low), highH: roundOrNull(eta.high) },
    factors,
    reasons,
    dataQuality: {
      status: dataStatus,
      confidence,
      pointsExcluded:
        cleaned.water_level.invalid +
        cleaned.water_level.future +
        cleaned.water_level.duplicates +
        (analysis ? analysis.spikesIgnored + (analysis.unconfirmed ? 1 : 0) : 0),
      issues,
    },
  };
}
