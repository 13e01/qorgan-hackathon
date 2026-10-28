// Разделение итоговой оценки T2 на «локальную обстановку» и «угрозу сверху по течению» — для интерфейса.
// Ничего не пересчитывает: только раскладывает уже готовую оценку (баллы факторов, уровень, пороги).
// Прибытие волны здесь НЕ утверждается: модель знает лишь, что выше по течению риск повышен
// и сколько часов в среднем добегает волна; фактическое воздействие видно по локальному уровню и тренду.

import type { RiskAssessment, RiskLevel, TrendDirection } from './types';

export type LocalLevelStatus = 'NO_DATA' | 'NO_THRESHOLD' | 'NORMAL' | 'ABOVE_WARNING' | 'ABOVE_DANGER';

/** Из чего сложился итоговый балл: только местные факторы, только угроза сверху, оба или ничего. */
export type RiskDrivers = 'NONE' | 'LOCAL' | 'UPSTREAM' | 'MIXED';

export interface RiskSituation {
  localLevel: LocalLevelStatus;
  localTrend: TrendDirection;
  /** Баллы местных факторов (уровень, тренд, осадки, потепление). */
  localPoints: number;
  /** Баллы фактора «волна сверху». */
  upstreamPoints: number;
  drivers: RiskDrivers;
  /** Есть только если фактор «волна сверху» дал баллы. */
  upstream: { stationCode: string; risk: RiskLevel; travelHours: number } | null;
}

export function describeSituation(a: RiskAssessment): RiskSituation {
  const { currentCm, warningCm, dangerCm } = a.level;
  let localLevel: LocalLevelStatus;
  if (currentCm === null) localLevel = 'NO_DATA';
  else if (dangerCm !== null && currentCm >= dangerCm) localLevel = 'ABOVE_DANGER';
  else if (warningCm !== null && currentCm >= warningCm) localLevel = 'ABOVE_WARNING';
  else if (warningCm === null && dangerCm === null) localLevel = 'NO_THRESHOLD';
  else localLevel = 'NORMAL';

  const upstreamFactor = a.factors.find((f) => f.code === 'UPSTREAM');
  const upstreamPoints = upstreamFactor?.points ?? 0;
  const localPoints = a.factors.filter((f) => f.code !== 'UPSTREAM').reduce((s, f) => s + f.points, 0);
  const drivers: RiskDrivers =
    localPoints > 0 && upstreamPoints > 0 ? 'MIXED' : localPoints > 0 ? 'LOCAL' : upstreamPoints > 0 ? 'UPSTREAM' : 'NONE';

  const params = upstreamFactor?.reason?.code === 'UPSTREAM_WAVE' ? upstreamFactor.reason.params : undefined;
  const upstream =
    upstreamPoints > 0 && params
      ? { stationCode: String(params.station), risk: params.risk as RiskLevel, travelHours: Number(params.hours) }
      : null;

  return { localLevel, localTrend: a.trend.direction, localPoints, upstreamPoints, drivers, upstream };
}
