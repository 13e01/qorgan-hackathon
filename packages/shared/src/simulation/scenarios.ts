// Сценарии симулятора паводка (docs/ARCHITECTURE.md §6.4). Все значения учебные.
// Время — в тиках; 1 тик = 1 виртуальный час.

export const SCENARIO_IDS = ['NORMAL', 'GRADUAL_FLOOD', 'RAPID_FLOOD'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/** Трапеция паводковой волны у станции-истока: рост → максимум → спад. */
export interface WaveShape {
  amplitudeCm: number;
  startTick: number;
  riseH: number;
  peakH: number;
  fallH: number;
}

export interface RainEvent {
  stationCode: string;
  fromTick: number;
  toTick: number;
  mmH: number;
}

export interface ScenarioDefinition {
  id: ScenarioId;
  totalTicks: number;
  /** Станция, у которой начинается волна; остальные получают её по цепочке upstream. */
  sourceStation: string;
  wave: WaveShape;
  /** Дополнительный приток у станции (см), приходит одновременно с волной. */
  localInflowCm: Record<string, number>;
  rain: RainEvent[];
  /** Редкая морось в обычном режиме: вероятность за час и интенсивность. */
  drizzle: { probability: number; mmH: number };
  temperature: { startC: number; endC: number; rampH: number; dailyAmplitudeC: number; noiseC: number };
  level: { dailyAmplitudeCm: number; noiseCm: number };
}

/** Параметры, которые оператор может изменить при создании прогона (проверяются схемой API). */
export interface ScenarioParams {
  amplitudeCm?: number;
  startTick?: number;
  riseH?: number;
  peakH?: number;
  fallH?: number;
  totalTicks?: number;
  levelNoiseCm?: number;
  levelDailyAmplitudeCm?: number;
}

const COMMON = {
  sourceStation: 'QRG-01',
  drizzle: { probability: 0, mmH: 0 },
  // Суточное колебание и шум уровня держим ниже порога «незначимого изменения» модели риска (ε = 0,5 см/ч):
  // при 3 см и ±2 см наклон доходил до 0,8 см/ч и риск «мигал» LOW ↔ MEDIUM на спокойной воде (проверено, T3).
  level: { dailyAmplitudeCm: 1, noiseCm: 1 },
};

export const SCENARIOS: Readonly<Record<ScenarioId, ScenarioDefinition>> = {
  NORMAL: {
    ...COMMON,
    id: 'NORMAL',
    totalTicks: 72,
    wave: { amplitudeCm: 0, startTick: 0, riseH: 1, peakH: 0, fallH: 1 },
    localInflowCm: {},
    rain: [],
    drizzle: { probability: 0.05, mmH: 0.5 },
    temperature: { startC: -3, endC: -3, rampH: 1, dailyAmplitudeC: 2, noiseC: 0.3 },
  },
  GRADUAL_FLOOD: {
    ...COMMON,
    id: 'GRADUAL_FLOOD',
    totalTicks: 240,
    // 170 см: все станции переходят порог «внимание», но остаются MEDIUM. При 180 см у QRG-04 (короткая задержка 17 ч)
    // на один тик складываются уровень ≥ W, рост с ETA ≤ 24 ч и MEDIUM сверху = 5 баллов → HIGH (проверено на 4 seed).
    wave: { amplitudeCm: 170, startTick: 10, riseH: 24, peakH: 12, fallH: 48 },
    localInflowCm: {},
    rain: [{ stationCode: 'QRG-01', fromTick: 4, toTick: 9, mmH: 2 }],
    temperature: { startC: -2, endC: 1, rampH: 24, dailyAmplitudeC: 1.5, noiseC: 0.3 },
  },
  RAPID_FLOOD: {
    ...COMMON,
    id: 'RAPID_FLOOD',
    totalTicks: 260,
    wave: { amplitudeCm: 300, startTick: 10, riseH: 18, peakH: 24, fallH: 60 },
    localInflowCm: { 'QRG-03': 40 },
    rain: [{ stationCode: 'QRG-01', fromTick: 4, toTick: 9, mmH: 4 }],
    temperature: { startC: -4, endC: 8, rampH: 24, dailyAmplitudeC: 2, noiseC: 0.3 },
  },
};

/** Сценарий с учётом параметров оператора. */
export function resolveScenario(id: ScenarioId, params: ScenarioParams = {}): ScenarioDefinition {
  const base = SCENARIOS[id];
  return {
    ...base,
    totalTicks: params.totalTicks ?? base.totalTicks,
    wave: {
      amplitudeCm: params.amplitudeCm ?? base.wave.amplitudeCm,
      startTick: params.startTick ?? base.wave.startTick,
      riseH: params.riseH ?? base.wave.riseH,
      peakH: params.peakH ?? base.wave.peakH,
      fallH: params.fallH ?? base.wave.fallH,
    },
    level: {
      dailyAmplitudeCm: params.levelDailyAmplitudeCm ?? base.level.dailyAmplitudeCm,
      noiseCm: params.levelNoiseCm ?? base.level.noiseCm,
    },
  };
}
