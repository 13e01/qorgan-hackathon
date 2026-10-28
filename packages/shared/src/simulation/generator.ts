// Генератор показаний виртуальных станций (docs/ARCHITECTURE.md §6.3). Учебная модель, не гидродинамика.
//
// Исток:          clean(t) = base + A·pulse(t − t0) + вмешательства(t)
// Нижняя станция: clean_k(t) = base_k + α_k · среднее_{j<w_k}( clean_{k−1}(t − τ_k − j) − base_{k−1} )
//                              + L_k·pulse(t − t0 − Στ) + вмешательства_k(t)
// Показание:      уровень = clean + суточное колебание + шум(seed, станция, параметр, тик)
//
// τ — задержка добегания (виртуальные часы), α — ослабление/усиление, w — сглаживание (часы).
// Шум не хранит состояния: любой тик вычисляется заново одинаково — это даёт воспроизводимость.

import { PARAMETERS, type ParameterCode } from '../domain';
import type { ScenarioDefinition } from './scenarios';

export interface StationModel {
  code: string;
  baseLevelCm: number;
  upstreamCode: string | null;
  travelHours: number | null;
  attenuation: number;
  responseHours: number;
  sensors: readonly ParameterCode[];
}

export type InterventionType = 'LEVEL_SHIFT' | 'RISE_RATE' | 'MANUAL_READING';

export interface Intervention {
  type: InterventionType;
  stationCode: string;
  /** Тик, с которого вмешательство действует (всегда следующий после текущего — без изменения прошлого). */
  effectiveTick: number;
  /** LEVEL_SHIFT — сдвиг, см; RISE_RATE — доп. скорость, см/ч; MANUAL_READING — значение показания. */
  value: number;
  parameter?: ParameterCode | null;
  durationH?: number | null;
}

export interface Reading {
  stationCode: string;
  parameter: ParameterCode;
  value: number;
  unit: string;
  source: 'simulator' | 'manual';
}

export interface GeneratorContext {
  scenario: ScenarioDefinition;
  seed: number;
  stations: readonly StationModel[];
  interventions: readonly Intervention[];
}

const UNIT = Object.fromEntries(PARAMETERS.map((p) => [p.code, p.unit])) as Record<ParameterCode, string>;
const RANGE = Object.fromEntries(PARAMETERS.map((p) => [p.code, p])) as Record<ParameterCode, (typeof PARAMETERS)[number]>;

/** Детерминированное число в [0, 1) по строке-ключу (FNV-1a + перемешивание mulberry32). */
export function hashUnit(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h = (h + 0x6d2b79f5) | 0;
  let t = Math.imul(h ^ (h >>> 15), 1 | h);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
}

/** Трапеция: 0 → 1 за riseH, 1 в течение peakH, 1 → 0 за fallH. */
export function pulse(x: number, riseH: number, peakH: number, fallH: number): number {
  if (x < 0) return 0;
  if (x < riseH) return x / riseH;
  if (x < riseH + peakH) return 1;
  if (x < riseH + peakH + fallH) return 1 - (x - riseH - peakH) / fallH;
  return 0;
}

const round1 = (x: number) => Math.round(x * 10) / 10 + 0;
const clamp = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x));

export function createGenerator(ctx: GeneratorContext) {
  const byCode = new Map(ctx.stations.map((s) => [s.code, s]));
  const { scenario, seed } = ctx;
  const wave = scenario.wave;

  /** Суммарная задержка от истока до станции (для момента прихода местного притока). */
  const delayFromSource = (code: string): number => {
    let total = 0;
    let current = byCode.get(code);
    const seen = new Set<string>();
    while (current?.upstreamCode && !seen.has(current.code)) {
      seen.add(current.code);
      total += Math.round(current.travelHours ?? 0);
      current = byCode.get(current.upstreamCode);
    }
    return total;
  };

  const interventionOffset = (code: string, t: number): number => {
    let offset = 0;
    for (const iv of ctx.interventions) {
      if (iv.stationCode !== code || t < iv.effectiveTick) continue;
      if (iv.type === 'LEVEL_SHIFT') offset += iv.value;
      else if (iv.type === 'RISE_RATE') offset += iv.value * Math.min(t - iv.effectiveTick + 1, iv.durationH ?? 1);
    }
    return offset;
  };

  const memo = new Map<string, number>();
  /** Уровень без шума и суточного колебания — именно он передаётся вниз по течению. */
  const clean = (code: string, t: number, depth = 0): number => {
    const st = byCode.get(code);
    if (!st) return 0;
    if (t < 0 || depth > ctx.stations.length) return st.baseLevelCm;
    const key = `${code}@${t}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let value = st.baseLevelCm;
    const up = st.upstreamCode ? byCode.get(st.upstreamCode) : undefined;
    if (code === scenario.sourceStation) {
      value += wave.amplitudeCm * pulse(t - wave.startTick, wave.riseH, wave.peakH, wave.fallH);
    } else if (up) {
      const tau = Math.round(st.travelHours ?? 0);
      const w = Math.max(1, Math.round(st.responseHours));
      let sum = 0;
      for (let j = 0; j < w; j += 1) sum += clean(up.code, t - tau - j, depth + 1) - up.baseLevelCm;
      value += st.attenuation * (sum / w);
    }
    const inflow = scenario.localInflowCm[code];
    if (inflow) value += inflow * pulse(t - wave.startTick - delayFromSource(code), wave.riseH, wave.peakH, wave.fallH);
    value += interventionOffset(code, t);

    memo.set(key, value);
    return value;
  };

  const noise = (code: string, parameter: string, t: number, amplitude: number) =>
    amplitude * (2 * hashUnit(`${seed}|${code}|${parameter}|${t}`) - 1);

  const generate = (code: string, parameter: ParameterCode, t: number): number => {
    const range = RANGE[parameter];
    if (parameter === 'water_level') {
      const daily = scenario.level.dailyAmplitudeCm * Math.sin((2 * Math.PI * t) / 24);
      return round1(clamp(clean(code, t) + daily + noise(code, parameter, t, scenario.level.noiseCm), range.minValid, range.maxValid));
    }
    if (parameter === 'precipitation') {
      let mm = 0;
      for (const r of scenario.rain) if (r.stationCode === code && t >= r.fromTick && t <= r.toTick) mm += r.mmH;
      if (hashUnit(`${seed}|${code}|drizzle|${t}`) < scenario.drizzle.probability) mm += scenario.drizzle.mmH;
      return round1(clamp(mm, range.minValid, range.maxValid));
    }
    const temp = scenario.temperature;
    const trend = temp.startC + (temp.endC - temp.startC) * Math.min(1, t / temp.rampH);
    const daily = temp.dailyAmplitudeC * Math.sin((2 * Math.PI * t) / 24);
    return round1(clamp(trend + daily + noise(code, parameter, t, temp.noiseC), range.minValid, range.maxValid));
  };

  return {
    clean,
    /** Все показания тика: по каждому датчику каждой станции; ручные показания заменяют сгенерированные. */
    readingsAt(t: number): Reading[] {
      const readings: Reading[] = [];
      for (const st of ctx.stations) {
        for (const parameter of st.sensors) {
          const manual = ctx.interventions.find(
            (iv) => iv.type === 'MANUAL_READING' && iv.stationCode === st.code && iv.parameter === parameter && iv.effectiveTick === t,
          );
          readings.push({
            stationCode: st.code,
            parameter,
            value: manual ? manual.value : generate(st.code, parameter, t),
            unit: UNIT[parameter],
            source: manual ? 'manual' : 'simulator',
          });
        }
      }
      return readings;
    },
  };
}
