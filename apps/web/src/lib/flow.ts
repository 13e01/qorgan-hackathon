// Схема реки для визуализации (Eclipse): станции в порядке течения и связи между ними.
// Только выбор представления по данным сервера — риск, тренд и «угроза сверху» (situation.upstream) уже посчитаны
// на backend (describeSituation T2). Здесь ничего не пересчитывается и не моделируется: состояние связи — это
// схематическое отображение того, что сервер уже сообщил о станции ниже по течению, а не гидродинамика.

import type { RiskLevel, TrendDirection } from '../api/shared';
import type { Snapshot, SnapshotStation, StationMeta } from '../api/types';
import { levelView } from './level';
import { plainStatus, type PlainStatus } from './status';

/** calm — угрозы нет; threat — сервер видит волну сверху, у станции ниже местного подъёма ещё нет; arrived — подъём у станции ниже подтверждён её измерениями. */
export type LinkState = 'calm' | 'threat' | 'arrived';

export interface FlowNode {
  code: string;
  name: string;
  risk: RiskLevel | 'NO_DATA';
  status: PlainStatus;
  levelCm: number | null;
  measuredAt: string | null;
  warningCm: number | null;
  dangerCm: number | null;
  trend: TrendDirection | null;
  rateCmH: number | null;
  /** Высота столбика «уровень относительно опасного порога», 0…1; null — нет измерений. */
  gauge: number | null;
  warningMark: number | null;
  dangerMark: number | null;
  /** Ближайшая станция, к которой по данным сервера идёт угроза сверху (сама ещё без местного подъёма). */
  next: boolean;
  /** Измерение — с внешнего датчика (MQTT), а не со встроенного симулятора. */
  fromDevice: boolean;
}

export interface FlowLink {
  from: string;
  to: string;
  travelHours: number | null;
  state: LinkState;
  /** Риск станции-источника угрозы (для цвета), если связь не спокойная. */
  risk: RiskLevel | null;
}

export interface RiverFlow {
  nodes: FlowNode[];
  links: FlowLink[];
  hasThreat: boolean;
}

/** Местный подъём подтверждён самой станцией: выше порога или рост по её измерениям. */
function locallyAffected(st: SnapshotStation | undefined): boolean {
  if (!st || levelView(st).measuredCm === null) return false;
  const s = st.risk.situation;
  return s.localLevel === 'ABOVE_WARNING' || s.localLevel === 'ABOVE_DANGER' || s.localTrend === 'RISING';
}

/** Верх шкалы столбика: опасный порог + 25 % (чтобы превышение было видно), иначе — от самого уровня. */
function gaugeTop(levelCm: number | null, dangerCm: number | null): number | null {
  if (dangerCm !== null && dangerCm > 0) return Math.max(dangerCm * 1.25, levelCm ?? 0);
  if (levelCm !== null && levelCm > 0) return levelCm * 1.25;
  return null;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function riverFlow(stations: StationMeta[], snapshot: Snapshot | null): RiverFlow {
  const byCode = new Map((snapshot?.stations ?? []).map((s) => [s.code, s]));
  const codes = new Set(stations.map((s) => s.code));

  const links: FlowLink[] = [];
  for (const meta of stations) {
    if (!meta.upstreamCode || !codes.has(meta.upstreamCode)) continue;
    const down = byCode.get(meta.code);
    const hasData = down !== undefined && levelView(down).measuredCm !== null;
    const up = hasData ? down.risk.situation.upstream : null;
    let state: LinkState = 'calm';
    let risk: RiskLevel | null = null;
    if (up && up.stationCode === meta.upstreamCode) {
      state = locallyAffected(down) ? 'arrived' : 'threat';
      risk = up.risk;
    }
    links.push({ from: meta.upstreamCode, to: meta.code, travelHours: meta.travelHours, state, risk });
  }

  // «Следующая» — самая верхняя по течению станция, к которой угроза идёт, но ещё не пришла.
  const nextCode = stations.find((m) => links.some((l) => l.to === m.code && l.state === 'threat'))?.code ?? null;

  const nodes: FlowNode[] = stations.map((meta) => {
    const snap = byCode.get(meta.code);
    const lv = levelView(snap);
    const status = plainStatus(snap);
    const param = meta.parameters.find((p) => p.code === 'water_level');
    const warningCm = snap?.risk.warningCm ?? param?.warning ?? null;
    const dangerCm = snap?.risk.dangerCm ?? param?.danger ?? null;
    const top = gaugeTop(lv.measuredCm, dangerCm);
    const hasData = lv.measuredCm !== null;
    return {
      code: meta.code,
      name: meta.name,
      risk: status.risk,
      status,
      levelCm: lv.measuredCm,
      measuredAt: lv.measuredAt,
      warningCm,
      dangerCm,
      trend: hasData ? (snap?.risk.trend ?? null) : null,
      rateCmH: hasData ? (snap?.risk.rateCmH ?? null) : null,
      gauge: hasData && top ? clamp01(lv.measuredCm! / top) : null,
      warningMark: top && warningCm !== null ? clamp01(warningCm / top) : null,
      dangerMark: top && dangerCm !== null ? clamp01(dangerCm / top) : null,
      next: meta.code === nextCode,
      fromDevice: snap?.latest.water_level?.source === 'device',
    };
  });

  return { nodes, links, hasThreat: links.some((l) => l.state !== 'calm') };
}
