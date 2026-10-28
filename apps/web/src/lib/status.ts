// Человеческие формулировки обстановки — только выбор текста по данным сервера (describeSituation T2),
// без пересчёта риска. Главное правило: приближение волны сверху НЕ показывается как уже случившийся подъём.

import type { RiskLevel } from '../api/shared';
import type { Snapshot, SnapshotStation, StationMeta } from '../api/types';
import { levelView } from './level';

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export type StatusKey =
  | 'status.noData'
  | 'status.aboveDanger'
  | 'status.aboveWarning'
  | 'status.upstreamOnly'
  | 'status.rising'
  | 'status.normal';

export interface PlainStatus {
  key: StatusKey;
  tone: Tone;
  /** Итоговый риск или NO_DATA, если измерений нет. */
  risk: RiskLevel | 'NO_DATA';
}

export function plainStatus(st: SnapshotStation | undefined): PlainStatus {
  const lv = levelView(st);
  if (!st || lv.measuredCm === null) return { key: 'status.noData', tone: 'neutral', risk: 'NO_DATA' };
  const s = st.risk.situation;
  const risk = st.risk.risk;
  const tone: Tone = risk === 'HIGH' ? 'danger' : risk === 'MEDIUM' ? 'warn' : 'ok';
  if (s.localLevel === 'ABOVE_DANGER') return { key: 'status.aboveDanger', tone: 'danger', risk };
  if (s.localLevel === 'ABOVE_WARNING') return { key: 'status.aboveWarning', tone: 'warn', risk };
  if (s.localTrend === 'RISING') return { key: 'status.rising', tone, risk };
  if (s.upstream) return { key: 'status.upstreamOnly', tone, risk };
  return { key: 'status.normal', tone, risk };
}

export type OverviewKey = 'overview.noData' | 'overview.allNormal' | 'overview.attention' | 'overview.danger';

export interface Overview {
  key: OverviewKey;
  tone: Tone;
  /** Самая опасная станция (для «Где опасность?»), если риск выше низкого. */
  worst: StationMeta | null;
  counts: Record<RiskLevel, number>;
}

const RANK: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/** Сводка по всем станциям для шапки главной панели. При равном риске важнее станция ниже по течению (позже в списке). */
export function overview(snapshot: Snapshot | null, stations: StationMeta[]): Overview {
  const counts: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  let worst: StationMeta | null = null;
  let worstRank = -1;
  let any = false;
  for (const meta of stations) {
    const st = snapshot?.stations.find((s) => s.code === meta.code);
    if (!st || levelView(st).measuredCm === null) continue;
    any = true;
    counts[st.risk.risk] += 1;
    const rank = RANK[st.risk.risk];
    if (rank >= worstRank) {
      worstRank = rank;
      worst = meta;
    }
  }
  if (!any) return { key: 'overview.noData', tone: 'neutral', worst: null, counts };
  if (counts.HIGH > 0) return { key: 'overview.danger', tone: 'danger', worst, counts };
  if (counts.MEDIUM > 0) return { key: 'overview.attention', tone: 'warn', worst, counts };
  return { key: 'overview.allNormal', tone: 'ok', worst: null, counts };
}
