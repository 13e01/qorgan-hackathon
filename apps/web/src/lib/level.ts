// Какой уровень показывать пользователю.
// Главное число — последнее фактическое измерение датчика. Модуль риска T2 может оценивать по другому значению
// (например, не принять ещё не подтверждённый резкий скачок) — тогда это показывается отдельно, а не подменяет измерение.

import type { SnapshotStation } from '../api/types';

export interface LevelView {
  /** Последнее измерение уровня, см; null — измерений нет. */
  measuredCm: number | null;
  measuredAt: string | null;
  quality: string | null;
  /** Уровень, по которому модуль риска сделал оценку, см. */
  assessedCm: number | null;
  /** Оценка сделана не по последнему измерению. */
  differs: boolean;
}

export function levelView(st: SnapshotStation | undefined): LevelView {
  const reading = st?.latest.water_level;
  const measuredCm = reading?.value ?? null;
  const assessedCm = st?.risk.levelCm ?? null;
  return {
    measuredCm,
    measuredAt: reading?.measuredAt ?? null,
    quality: reading?.quality ?? null,
    assessedCm,
    differs: measuredCm !== null && assessedCm !== null && Math.abs(measuredCm - assessedCm) >= 0.05,
  };
}
