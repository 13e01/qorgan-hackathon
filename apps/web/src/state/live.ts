// Состояние «живых» данных: последний снимок с сервера и истории для графиков. Чистые функции — покрыты тестами.
//
// Защита от устаревших и повторных событий: снимок того же прогона с более ранним виртуальным временем
// игнорируется; точки истории добавляются только если они новее последней (по времени измерения).
// Ничего не вычисляется «за сервер»: в истории только то, что пришло из API или из снимка.

import type { RiskLevel } from '../api/shared';
import type { MeasurementItem, Snapshot } from '../api/types';

export interface LevelPoint {
  /** Виртуальное время измерения, мс. */
  t: number;
  cm: number;
  quality: string;
  source: string;
}

export interface RiskPoint {
  t: number;
  risk: RiskLevel;
}

export interface Series<P> {
  runId: number | null;
  points: P[];
  /** История из API загружена; до этого точки из снимков копятся, а загрузка их дополнит. */
  loaded: boolean;
}

export interface LiveState {
  snapshot: Snapshot | null;
  /** Ключ последнего принятого снимка (прогон + виртуальное время). */
  key: { runId: number | null; t: number } | null;
  levels: Record<string, Series<LevelPoint>>;
  risks: Record<string, Series<RiskPoint>>;
}

export const initialLive: LiveState = { snapshot: null, key: null, levels: {}, risks: {} };

/** Ограничение длины истории в памяти (больше, чем самый длинный сценарий). */
const MAX_POINTS = 2000;

function appendIfNewer<P extends { t: number }>(series: Series<P> | undefined, runId: number | null, point: P): Series<P> {
  if (!series || series.runId !== runId) return { runId, points: [point], loaded: false };
  const last = series.points.at(-1);
  if (last && last.t >= point.t) return series;
  const points = series.points.length >= MAX_POINTS ? [...series.points.slice(1), point] : [...series.points, point];
  return { runId, points, loaded: series.loaded };
}

export function applySnapshot(state: LiveState, snap: Snapshot): LiveState {
  const runId = snap.context.runId;
  const t = snap.context.virtualTime ? Date.parse(snap.context.virtualTime) : 0;
  if (state.key && state.key.runId === runId && runId !== null && t < state.key.t) return state;

  const levels = { ...state.levels };
  const risks = { ...state.risks };
  for (const st of snap.stations) {
    const reading = st.latest.water_level;
    if (reading) {
      levels[st.code] = appendIfNewer(levels[st.code], runId, {
        t: Date.parse(reading.measuredAt),
        cm: reading.value,
        quality: reading.quality,
        source: reading.source,
      });
    }
    if (snap.context.virtualTime && st.risk.measuredAt) {
      risks[st.code] = appendIfNewer(risks[st.code], runId, { t, risk: st.risk.risk });
    }
  }
  return { snapshot: snap, key: { runId, t }, levels, risks };
}

/** Загруженная история + точки того же прогона, пришедшие по WebSocket, пока шёл запрос (новее последней загруженной). */
function merge<P extends { t: number }>(loaded: P[], existing: Series<P> | undefined, runId: number | null): P[] {
  const last = loaded.at(-1)?.t ?? Number.NEGATIVE_INFINITY;
  const extra = existing && existing.runId === runId ? existing.points.filter((p) => p.t > last) : [];
  return [...loaded, ...extra];
}

export function setLevelHistory(state: LiveState, code: string, runId: number | null, items: MeasurementItem[]): LiveState {
  const loaded = items
    .filter((i) => i.parameter === 'water_level')
    .map((i) => ({ t: Date.parse(i.measuredAt), cm: i.value, quality: i.quality, source: i.source }))
    .sort((a, b) => a.t - b.t);
  return { ...state, levels: { ...state.levels, [code]: { runId, points: merge(loaded, state.levels[code], runId), loaded: true } } };
}

export function setRiskHistory(state: LiveState, code: string, runId: number | null, items: Array<{ virtualTime: string; risk: RiskLevel }>): LiveState {
  const loaded = items.map((i) => ({ t: Date.parse(i.virtualTime), risk: i.risk })).sort((a, b) => a.t - b.t);
  return { ...state, risks: { ...state.risks, [code]: { runId, points: merge(loaded, state.risks[code], runId), loaded: true } } };
}

/** Нужно ли заново загрузить историю станции (сменился прогон или истории ещё нет). */
export function needsReload(series: Series<unknown> | undefined, runId: number | null): boolean {
  return !series || !series.loaded || series.runId !== runId;
}

/** Для гостя показываем только последние 24 виртуальных часа (так же ограничивает сервер). */
export function lastHours<P extends { t: number }>(points: P[], hours: number): P[] {
  const last = points.at(-1);
  if (!last) return points;
  const from = last.t - hours * 3_600_000;
  return points.filter((p) => p.t > from);
}
