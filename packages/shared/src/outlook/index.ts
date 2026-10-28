// «Прогноз по реке» (River Outlook) — учебная маршрутизация паводковой волны по цепочке станций (docs/INNOVATION.md).
//
// Идея: уровень у нижней станции через τ часов определяется тем, что УЖЕ измерено выше по течению. Поэтому прогноз
// нижней станции строится не экстраполяцией её собственного тренда (как в модуле риска, горизонт 3 ч), а по
// измерениям верхней станции — «задержка и ослабление» (lag-and-attenuate, простейший вид гидрологической маршрутизации):
//
//   маршрут_k(t) = база_k + α_k · среднее_{j<w_k}( h_u(t − τ_k − j) − база_u )
//   прогноз_k(t) = маршрут_k(t) + e₀ · exp(−(t − t₀)/T_e),   e₀ = h_k(t₀) − маршрут_k(t₀)   (коррекция по текущей ошибке)
//
// h_u — измерение верхней станции, а если его ещё нет (момент в будущем) — её собственный прогноз: так прогноз идёт каскадом
// (Сергеевка → Явленка → Петропавловск → Соколовка) с горизонтом τ₁ + τ₂ + … Для истока (нет станции выше) — только
// короткая линейная экстраполяция тренда.
//
// Полоса неопределённости — ЭМПИРИЧЕСКАЯ эвристика (разброс расхождений «измерение − маршрут» за последние 48 ч плюс
// расширение с горизонтом и глубиной каскада), а не статистический доверительный интервал. Насколько ей можно верить,
// показывает проверка на истории (verifyOutlook): доля фактических значений внутри полосы.
//
// Ограничения (показываются в интерфейсе): τ, α, w — учебные параметры станций из БД, не откалиброванные по реальным
// гидропостам; модель не учитывает местный приток, осадки между постами, лёд и поймы. В демо-данных симулятор устроен
// похоже, поэтому точность на них НЕ доказывает точность на реальной реке.

import type { MeasurementPoint } from '../risk/types';

const H = 3_600_000;

export interface OutlookStation {
  code: string;
  upstreamCode: string | null;
  travelHours: number | null;
  attenuation: number;
  responseHours: number;
  baseLevelCm: number | null;
  warningCm: number | null;
  dangerCm: number | null;
}

export interface OutlookConfig {
  /** Максимальный горизонт прогноза, ч. */
  horizonH: number;
  /** Горизонт экстраполяции тренда у истока, ч. */
  trendHorizonH: number;
  /** Сколько последних измерений берётся для тренда у истока. */
  trendWindow: number;
  /** Время затухания поправки по текущей ошибке, ч. */
  errorDecayH: number;
  /** За сколько часов назад оценивается разброс расхождений «измерение − маршрут». */
  residualWindowH: number;
  /** Минимальная полуширина полосы, см. */
  minBandCm: number;
  /** Расширение полосы, см на каждый час горизонта. */
  bandGrowthCmH: number;
}

export const DEFAULT_OUTLOOK_CONFIG: OutlookConfig = {
  horizonH: 120,
  trendHorizonH: 3,
  trendWindow: 6,
  errorDecayH: 48,
  residualWindowH: 48,
  minBandCm: 5,
  bandGrowthCmH: 0.15,
};

export type OutlookMethod = 'ROUTED' | 'TREND' | 'NONE';
export type OutlookIssue = 'NO_DATA' | 'NO_BASE_LEVEL' | 'UPSTREAM_NO_DATA' | 'INSUFFICIENT_DATA';

export interface OutlookPoint {
  /** Часы от момента прогноза (1, 2, …). */
  h: number;
  time: string;
  levelCm: number;
  lowCm: number;
  highCm: number;
}

export type CrossingStatus = 'ALREADY_ABOVE' | 'EXPECTED' | 'NOT_EXPECTED' | 'NO_THRESHOLD' | 'NO_FORECAST';

export interface Crossing {
  status: CrossingStatus;
  thresholdCm: number | null;
  /** Через сколько часов порог будет достигнут по центральному прогнозу. */
  h: number | null;
  /** Самый ранний срок (по верхней границе полосы) и самый поздний (по нижней; null — не в пределах горизонта). */
  earliestH: number | null;
  latestH: number | null;
  time: string | null;
}

export interface StationOutlook {
  code: string;
  method: OutlookMethod;
  issue: OutlookIssue | null;
  upstreamCode: string | null;
  travelHours: number | null;
  /** Цепочка станций, по измерениям которых построен прогноз (сверху вниз). */
  sourceChain: string[];
  currentCm: number | null;
  horizonH: number;
  /** Использовано допущение «до начала наблюдений уровень верхней станции был равен первому измерению». */
  assumedHistory: boolean;
  /** Поправка по текущей ошибке маршрута e₀, см. */
  correctionCm: number | null;
  /** Разброс расхождений «измерение − маршрут» за окно, см (основа полосы). */
  residualSdCm: number | null;
  points: OutlookPoint[];
  peak: { levelCm: number; h: number; time: string; atHorizonEnd: boolean } | null;
  warning: Crossing;
  danger: Crossing;
}

export interface OutlookResult {
  model: 'QORGAN-ROUTE-1';
  demo: true;
  asOf: string;
  horizonH: number;
  stations: StationOutlook[];
}

export interface OutlookInput {
  asOf: string;
  stations: readonly OutlookStation[];
  /** Измерения уровня по станциям (любые, будущие относительно asOf отбрасываются). */
  levels: Readonly<Record<string, readonly MeasurementPoint[]>>;
  config?: Partial<OutlookConfig>;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Часовая сетка измерений станции относительно asOf: ключ — час (0 = asOf, −1 = час назад …). */
function hourlyGrid(points: readonly MeasurementPoint[], asOfMs: number): Map<number, number> {
  const grid = new Map<number, number>();
  const sorted = [...points]
    .map((p) => ({ t: Date.parse(p.measuredAt), v: p.value }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.t <= asOfMs)
    .sort((a, b) => a.t - b.t);
  for (const p of sorted) grid.set(Math.round((p.t - asOfMs) / H), p.v);
  return grid;
}

/** Значение на часе h: точное, иначе линейная интерполяция между соседями не дальше 2 ч. */
function valueAt(grid: Map<number, number>, h: number): number | null {
  const exact = grid.get(h);
  if (exact !== undefined) return exact;
  let before: [number, number] | null = null;
  let after: [number, number] | null = null;
  for (let d = 1; d <= 2; d += 1) {
    if (!before && grid.has(h - d)) before = [h - d, grid.get(h - d)!];
    if (!after && grid.has(h + d)) after = [h + d, grid.get(h + d)!];
  }
  if (!before || !after) return null;
  return before[1] + ((after[1] - before[1]) * (h - before[0])) / (after[0] - before[0]);
}

function sd(xs: number[]): number | null {
  if (xs.length < 3) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function crossing(points: OutlookPoint[], currentCm: number | null, threshold: number | null, method: OutlookMethod): Crossing {
  const base = { thresholdCm: threshold, h: null, earliestH: null, latestH: null, time: null };
  if (threshold === null) return { status: 'NO_THRESHOLD', ...base };
  if (currentCm !== null && currentCm >= threshold) return { status: 'ALREADY_ABOVE', ...base, h: 0, earliestH: 0, latestH: 0 };
  if (method === 'NONE' || points.length === 0) return { status: 'NO_FORECAST', ...base };
  const central = points.find((p) => p.levelCm >= threshold);
  const early = points.find((p) => p.highCm >= threshold);
  const late = points.find((p) => p.lowCm >= threshold);
  if (!central) return { status: 'NOT_EXPECTED', ...base, earliestH: early?.h ?? null };
  return { status: 'EXPECTED', thresholdCm: threshold, h: central.h, earliestH: early?.h ?? central.h, latestH: late?.h ?? null, time: central.time };
}

/** Прогноз по реке для всех станций на момент asOf. Чистая функция: без БД, сети и текущего времени. */
export function computeOutlook(input: OutlookInput): OutlookResult {
  const cfg: OutlookConfig = { ...DEFAULT_OUTLOOK_CONFIG, ...input.config };
  const asOfMs = Date.parse(input.asOf);
  const byCode = new Map(input.stations.map((s) => [s.code, s]));
  const grids = new Map(input.stations.map((s) => [s.code, hourlyGrid(input.levels[s.code] ?? [], asOfMs)]));
  const forecasts = new Map<string, Map<number, OutlookPoint>>();
  const results = new Map<string, StationOutlook>();
  const timeAt = (h: number) => new Date(asOfMs + h * H).toISOString();

  /**
   * Уровень станции на часе h: измерение (h ≤ 0) или её прогноз по маршруту (h > 0). Короткая экстраполяция тренда
   * истока вниз по течению НЕ передаётся: каскад строится только на измерениях и маршрутизации.
   */
  const firstHour = new Map([...grids].map(([code, g]) => [code, g.size ? Math.min(...g.keys()) : null]));
  let backfilled = false;
  const levelOf = (code: string, h: number): number | null => {
    if (h > 0) return results.get(code)?.method === 'ROUTED' ? (forecasts.get(code)?.get(h)?.levelCm ?? null) : null;
    const g = grids.get(code)!;
    const v = valueAt(g, h);
    if (v !== null) return v;
    // Допущение: до начала наблюдений река стояла на первом измеренном уровне (иначе первые τ часов прогона
    // нижние станции оставались бы без прогноза). Использование допущения отмечается в результате.
    const first = firstHour.get(code);
    if (first !== null && first !== undefined && h < first) {
      backfilled = true;
      return g.get(first)!;
    }
    return null;
  };

  const solve = (s: OutlookStation, visiting: Set<string>): StationOutlook => {
    const done = results.get(s.code);
    if (done) return done;
    visiting.add(s.code);
    const grid = grids.get(s.code)!;
    const currentCm = valueAt(grid, 0);
    const empty = (method: OutlookMethod, issue: OutlookIssue | null, extra: Partial<StationOutlook> = {}): StationOutlook => ({
      code: s.code, method, issue, upstreamCode: s.upstreamCode, travelHours: s.travelHours, sourceChain: [s.code], currentCm,
      horizonH: 0, assumedHistory: false, correctionCm: null, residualSdCm: null, points: [], peak: null,
      warning: crossing([], currentCm, s.warningCm, method), danger: crossing([], currentCm, s.dangerCm, method), ...extra,
    });
    let result: StationOutlook;
    const up = s.upstreamCode ? byCode.get(s.upstreamCode) : undefined;

    if (currentCm === null) result = empty('NONE', 'NO_DATA');
    else if (up && s.travelHours !== null && !visiting.has(up.code)) {
      const upResult = solve(up, visiting);
      const tau = Math.max(0, Math.round(s.travelHours));
      const w = Math.max(1, Math.round(s.responseHours));
      if (s.baseLevelCm === null || up.baseLevelCm === null) result = empty('NONE', 'NO_BASE_LEVEL');
      else {
        const route = (h: number): number | null => {
          let sum = 0;
          for (let j = 0; j < w; j += 1) {
            const v = levelOf(up.code, h - tau - j);
            if (v === null) return null;
            sum += v - up.baseLevelCm!;
          }
          return s.baseLevelCm! + s.attenuation * (sum / w);
        };
        backfilled = false;
        const route0 = route(0);
        if (route0 === null) result = empty('NONE', 'UPSTREAM_NO_DATA');
        else {
          const e0 = currentCm - route0;
          const residuals: number[] = [];
          // Оценка разброса по прошлому не должна выставлять пометку о допущении — она касается только прогноза.
          const flagBefore = backfilled;
          for (let h = -cfg.residualWindowH; h <= 0; h += 1) {
            const m = valueAt(grid, h);
            const r = route(h);
            if (m !== null && r !== null) residuals.push(m - r);
          }
          backfilled = flagBefore;
          const resSd = sd(residuals);
          const depth = upResult.method === 'ROUTED' ? upResult.sourceChain.length : 1;
          const points: OutlookPoint[] = [];
          const map = new Map<number, OutlookPoint>();
          for (let h = 1; h <= cfg.horizonH; h += 1) {
            const r = route(h);
            if (r === null) break;
            const level = r + e0 * Math.exp(-h / cfg.errorDecayH);
            const upstreamBand = h - tau > 0 ? (forecasts.get(up.code)?.get(h - tau)?.highCm ?? 0) - (forecasts.get(up.code)?.get(h - tau)?.levelCm ?? 0) : 0;
            const half = Math.max(cfg.minBandCm, 1.5 * (resSd ?? 0)) + cfg.bandGrowthCmH * h * Math.sqrt(depth) + s.attenuation * Math.max(0, upstreamBand) * 0.5;
            const p = { h, time: timeAt(h), levelCm: round1(level), lowCm: round1(Math.max(0, level - half)), highCm: round1(level + half) };
            points.push(p);
            map.set(h, p);
          }
          forecasts.set(s.code, map);
          result = {
            code: s.code, method: 'ROUTED', issue: null, upstreamCode: up.code, travelHours: s.travelHours,
            sourceChain: [...(upResult.method === 'ROUTED' ? upResult.sourceChain : [up.code]), s.code],
            currentCm, horizonH: points.length, assumedHistory: backfilled || upResult.assumedHistory, correctionCm: round1(e0), residualSdCm: resSd === null ? null : round1(resSd), points,
            peak: null, warning: crossing(points, currentCm, s.warningCm, 'ROUTED'), danger: crossing(points, currentCm, s.dangerCm, 'ROUTED'),
          };
        }
      }
    } else {
      // Исток: станции выше нет — короткая линейная экстраполяция последних измерений (МНК).
      const pts: Array<{ h: number; v: number }> = [];
      for (let h = 0; h > -cfg.trendWindow * 2 && pts.length < cfg.trendWindow; h -= 1) {
        const v = grid.get(h);
        if (v !== undefined) pts.push({ h, v });
      }
      if (pts.length < 3) result = empty('NONE', 'INSUFFICIENT_DATA');
      else {
        const mh = pts.reduce((a, p) => a + p.h, 0) / pts.length;
        const mv = pts.reduce((a, p) => a + p.v, 0) / pts.length;
        const sxx = pts.reduce((a, p) => a + (p.h - mh) ** 2, 0);
        const slope = pts.reduce((a, p) => a + (p.h - mh) * (p.v - mv), 0) / sxx;
        const resid = pts.map((p) => p.v - (mv + slope * (p.h - mh)));
        const se = Math.sqrt(resid.reduce((a, r) => a + r * r, 0) / Math.max(1, pts.length - 2) / sxx);
        const points: OutlookPoint[] = [];
        const map = new Map<number, OutlookPoint>();
        for (let h = 1; h <= cfg.trendHorizonH; h += 1) {
          const level = currentCm + slope * h;
          const half = cfg.minBandCm + se * h;
          const p = { h, time: timeAt(h), levelCm: round1(level), lowCm: round1(Math.max(0, level - half)), highCm: round1(level + half) };
          points.push(p);
          map.set(h, p);
        }
        forecasts.set(s.code, map);
        result = {
          ...empty('TREND', null),
          horizonH: points.length,
          points,
          warning: crossing(points, currentCm, s.warningCm, 'TREND'),
          danger: crossing(points, currentCm, s.dangerCm, 'TREND'),
        };
      }
    }

    if (result.points.length > 0) {
      const top = result.points.reduce((a, b) => (b.levelCm > a.levelCm ? b : a));
      result.peak = { levelCm: top.levelCm, h: top.h, time: top.time, atHorizonEnd: top.h === result.points.at(-1)!.h };
    }
    visiting.delete(s.code);
    results.set(s.code, result);
    return result;
  };

  for (const s of input.stations) solve(s, new Set());
  return { model: 'QORGAN-ROUTE-1', demo: true, asOf: new Date(asOfMs).toISOString(), horizonH: cfg.horizonH, stations: input.stations.map((s) => results.get(s.code)!) };
}

// ── Проверка на истории (hindcast) ─────────────────────────────────────────────────────────────────────────────

export interface VerificationInput {
  stations: readonly OutlookStation[];
  /** Все измерения прогона (прогноз на каждый прошлый час строится только по данным до этого часа). */
  levels: Readonly<Record<string, readonly MeasurementPoint[]>>;
  /** Моменты выпуска прогноза (обычно — каждый час прогона до текущего). */
  issueTimes: readonly string[];
  /** Заблаговременность, на которой сравниваются ошибки, ч. */
  leadH: number;
  config?: Partial<OutlookConfig>;
}

export interface StationVerification {
  code: string;
  method: OutlookMethod;
  leadH: number;
  /** Сколько пар «прогноз — факт» удалось сопоставить. */
  samples: number;
  maeCm: number | null;
  /** Ошибка «наивного» прогноза: уровень не изменится (persistence) — эталон для сравнения. */
  persistenceMaeCm: number | null;
  /** 1 − MAE_модели / MAE_persistence: > 0 — лучше наивного прогноза. */
  skill: number | null;
  /** Доля фактических значений внутри полосы. */
  bandCoverage: number | null;
  /** Первое фактическое превышение опасного уровня и за сколько часов до него прогноз по реке непрерывно его ожидал. */
  danger: { actualTime: string | null; outlookLeadH: number | null };
}

export function verifyOutlook(input: VerificationInput): StationVerification[] {
  const all = input.issueTimes.map((t) => computeOutlook({ asOf: t, stations: input.stations, levels: input.levels, config: input.config }));
  const grids = new Map(input.stations.map((s) => [s.code, new Map((input.levels[s.code] ?? []).map((p) => [Date.parse(p.measuredAt), p.value]))]));
  return input.stations.map((s) => {
    const grid = grids.get(s.code)!;
    const actual = (ms: number) => grid.get(ms) ?? null;
    let n = 0;
    let errM = 0;
    let errP = 0;
    let inside = 0;
    let method: OutlookMethod = 'NONE';
    for (const o of all) {
      const so = o.stations.find((x) => x.code === s.code)!;
      if (so.method !== 'NONE') method = so.method;
      const p = so.points.find((x) => x.h === input.leadH);
      if (!p || so.currentCm === null) continue;
      const a = actual(Date.parse(p.time));
      if (a === null) continue;
      n += 1;
      errM += Math.abs(p.levelCm - a);
      errP += Math.abs(so.currentCm - a);
      if (a >= p.lowCm && a <= p.highCm) inside += 1;
    }
    // Первое фактическое превышение опасного порога.
    let actualMs: number | null = null;
    if (s.dangerCm !== null) {
      const sorted = [...grid.entries()].sort((a, b) => a[0] - b[0]);
      const hit = sorted.find(([, v]) => v >= s.dangerCm!);
      actualMs = hit ? hit[0] : null;
    }
    let outlookLeadH: number | null = null;
    if (actualMs !== null) {
      const before = all.filter((o) => Date.parse(o.asOf) < actualMs!).reverse();
      let earliest: number | null = null;
      for (const o of before) {
        const d = o.stations.find((x) => x.code === s.code)!.danger;
        if (d.status !== 'EXPECTED') break;
        earliest = Date.parse(o.asOf);
      }
      outlookLeadH = earliest === null ? 0 : Math.round((actualMs - earliest) / H);
    }
    const mae = n ? errM / n : null;
    const pmae = n ? errP / n : null;
    return {
      code: s.code,
      method,
      leadH: input.leadH,
      samples: n,
      maeCm: mae === null ? null : round1(mae),
      persistenceMaeCm: pmae === null ? null : round1(pmae),
      skill: mae !== null && pmae !== null && pmae > 0 ? Math.round((1 - mae / pmae) * 100) / 100 : null,
      bandCoverage: n ? Math.round((inside / n) * 100) / 100 : null,
      danger: { actualTime: actualMs === null ? null : new Date(actualMs).toISOString(), outlookLeadH },
    };
  });
}
