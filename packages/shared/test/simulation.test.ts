// Генератор волны. Ожидаемые значения — ручной расчёт по формулам ARCHITECTURE §6.3.

import { describe, expect, it } from 'vitest';
import { createGenerator, hashUnit, pulse, resolveScenario, type Intervention, type StationModel } from '../src';

const STATIONS: StationModel[] = [
  { code: 'QRG-01', baseLevelCm: 300, upstreamCode: null, travelHours: null, attenuation: 1, responseHours: 1, sensors: ['water_level', 'precipitation', 'air_temp'] },
  { code: 'QRG-02', baseLevelCm: 280, upstreamCode: 'QRG-01', travelHours: 51, attenuation: 0.95, responseHours: 6, sensors: ['water_level', 'precipitation', 'air_temp'] },
  { code: 'QRG-03', baseLevelCm: 320, upstreamCode: 'QRG-02', travelHours: 51, attenuation: 1.05, responseHours: 6, sensors: ['water_level', 'precipitation', 'air_temp'] },
  { code: 'QRG-04', baseLevelCm: 260, upstreamCode: 'QRG-03', travelHours: 17, attenuation: 0.9, responseHours: 3, sensors: ['water_level'] },
];

const quiet = { levelNoiseCm: 0, levelDailyAmplitudeCm: 0 };

function gen(id: 'NORMAL' | 'GRADUAL_FLOOD' | 'RAPID_FLOOD', params = {}, interventions: Intervention[] = [], seed = 42) {
  return createGenerator({ scenario: resolveScenario(id, params), seed, stations: STATIONS, interventions });
}

const level = (g: ReturnType<typeof gen>, code: string, t: number) =>
  g.readingsAt(t).find((r) => r.stationCode === code && r.parameter === 'water_level')!;

describe('pulse и hashUnit', () => {
  it('трапеция: рост, максимум, спад', () => {
    expect([pulse(-1, 18, 24, 60), pulse(9, 18, 24, 60), pulse(18, 18, 24, 60), pulse(41, 18, 24, 60), pulse(72, 18, 24, 60), pulse(102, 18, 24, 60)]).toEqual([
      0, 0.5, 1, 1, 0.5, 0,
    ]);
  });

  it('hashUnit детерминирован и лежит в [0, 1)', () => {
    expect(hashUnit('42|QRG-01|water_level|7')).toBe(hashUnit('42|QRG-01|water_level|7'));
    const values = Array.from({ length: 2000 }, (_, i) => hashUnit(`k${i}`));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });
});

describe('модель волны без шума', () => {
  it('RAPID_FLOOD: начало подъёма на тиках 11 → 62 → 113 → 130 (задержки 51, 51, 17 ч)', () => {
    const g = gen('RAPID_FLOOD', quiet);
    const onset = (code: string, base: number) => {
      for (let t = 0; t < 260; t += 1) if (g.clean(code, t) > base + 1e-9) return t;
      return -1;
    };
    expect([onset('QRG-01', 300), onset('QRG-02', 280), onset('QRG-03', 320), onset('QRG-04', 260)]).toEqual([11, 62, 113, 130]);
  });

  it('RAPID_FLOOD: пики 600 / 565 / 659.25 / 565.325 см — у каждой станции свой уровень', () => {
    // 300+300; 280+0.95·300; 320+1.05·285+40 (приток); 260+0.9·339.25
    const g = gen('RAPID_FLOOD', quiet);
    const peak = (code: string) => Math.max(...Array.from({ length: 260 }, (_, t) => g.clean(code, t)));
    expect(peak('QRG-01')).toBeCloseTo(600, 9);
    expect(peak('QRG-02')).toBeCloseTo(565, 9);
    expect(peak('QRG-03')).toBeCloseTo(659.25, 9);
    expect(peak('QRG-04')).toBeCloseTo(565.325, 9);
  });

  it('GRADUAL_FLOOD: пики 470 / 441.5 / 489.575 / 412.6175 см', () => {
    const g = gen('GRADUAL_FLOOD', quiet);
    const peak = (code: string) => Math.max(...Array.from({ length: 240 }, (_, t) => g.clean(code, t)));
    expect([peak('QRG-01'), peak('QRG-02'), peak('QRG-03'), peak('QRG-04')].map((x) => Math.round(x * 1000) / 1000)).toEqual([470, 441.5, 489.575, 412.618]);
  });

  it('волна сглаживается вниз по течению: подъём у QRG-02 растянут на 6 ч дольше', () => {
    const g = gen('RAPID_FLOOD', quiet);
    const riseTicks = (code: string, base: number, peak: number) =>
      Array.from({ length: 260 }, (_, t) => g.clean(code, t)).filter((v) => v > base + 1e-9 && v < peak - 1e-9).length;
    // Исток: 17 промежуточных точек подъёма (18 ч) и 59 спада; QRG-02: каждое удлиняется на 5 из-за усреднения за 6 ч.
    expect(riseTicks('QRG-01', 300, 600)).toBe(17 + 59);
    expect(riseTicks('QRG-02', 280, 565)).toBe(17 + 59 + 10);
  });

  it('к концу сценария все станции вернулись к базовому уровню', () => {
    for (const [id, total] of [['RAPID_FLOOD', 260], ['GRADUAL_FLOOD', 240]] as const) {
      const g = gen(id, quiet);
      for (const s of STATIONS) expect(g.clean(s.code, total - 1)).toBeCloseTo(s.baseLevelCm, 9);
    }
  });
});

describe('показания', () => {
  it('один seed → одинаковые показания; другой seed → другой шум той же формы (разница ≤ 2σ = 2 см)', () => {
    const a = gen('RAPID_FLOOD', {}, [], 42);
    const b = gen('RAPID_FLOOD', {}, [], 42);
    const c = gen('RAPID_FLOOD', {}, [], 7);
    for (const t of [0, 20, 90, 150]) {
      expect(a.readingsAt(t)).toEqual(b.readingsAt(t));
      expect(Math.abs(level(a, 'QRG-03', t).value - level(c, 'QRG-03', t).value)).toBeLessThanOrEqual(2.05);
    }
    expect(a.readingsAt(20)).not.toEqual(c.readingsAt(20));
  });

  it('каждый тик вычисляется независимо от предыдущих (можно продолжить после перезапуска)', () => {
    const fresh = gen('RAPID_FLOOD').readingsAt(150);
    const warmed = gen('RAPID_FLOOD');
    for (let t = 0; t < 150; t += 1) warmed.readingsAt(t);
    expect(warmed.readingsAt(150)).toEqual(fresh);
  });

  it('по каждому датчику ровно одно показание с единицей; у QRG-04 только уровень', () => {
    const r = gen('NORMAL').readingsAt(5);
    expect(r).toHaveLength(10);
    expect(r.filter((x) => x.stationCode === 'QRG-04').map((x) => x.parameter)).toEqual(['water_level']);
    expect(new Set(r.map((x) => `${x.parameter}:${x.unit}`))).toEqual(new Set(['water_level:cm', 'precipitation:mm/h', 'air_temp:°C']));
  });

  it('NORMAL: уровень в пределах базового ± 2 см (суточные 1 + шум 1), температура около −3 °C', () => {
    const g = gen('NORMAL');
    for (let t = 0; t < 72; t += 1) {
      for (const s of STATIONS) expect(Math.abs(level(g, s.code, t).value - s.baseLevelCm)).toBeLessThanOrEqual(2.05);
      const temp = g.readingsAt(t).find((r) => r.stationCode === 'QRG-01' && r.parameter === 'air_temp')!.value;
      expect(temp).toBeGreaterThanOrEqual(-5.4);
      expect(temp).toBeLessThanOrEqual(-0.6);
    }
  });

  it('RAPID_FLOOD: дождь 4 мм/ч на тиках 4–9 только у QRG-01; потепление от −4 до +8 °C', () => {
    const g = gen('RAPID_FLOOD');
    const rain = (code: string, t: number) => g.readingsAt(t).find((r) => r.stationCode === code && r.parameter === 'precipitation')!.value;
    expect([3, 4, 9, 10].map((t) => rain('QRG-01', t))).toEqual([0, 4, 4, 0]);
    expect(rain('QRG-02', 5)).toBe(0);
    const temp48 = g.readingsAt(48).find((r) => r.stationCode === 'QRG-01' && r.parameter === 'air_temp')!.value;
    expect(temp48).toBeCloseTo(8, 0);
  });
});

describe('ручные вмешательства', () => {
  it('LEVEL_SHIFT +100 у QRG-02 с тика 50 сдвигает её уровень и через 51 ч — уровень QRG-03 (×1.05)', () => {
    const iv: Intervention[] = [{ type: 'LEVEL_SHIFT', stationCode: 'QRG-02', effectiveTick: 50, value: 100 }];
    const g = gen('NORMAL', quiet, iv);
    expect(g.clean('QRG-02', 49)).toBe(280);
    expect(g.clean('QRG-02', 50)).toBe(380);
    expect(g.clean('QRG-03', 100)).toBe(320);
    // Через τ = 51 ч сглаживание за 6 ч: на тике 101 учтён 1 час из 6, на тике 106 — все 6.
    expect(g.clean('QRG-03', 101)).toBeCloseTo(320 + 1.05 * 100 / 6, 9);
    expect(g.clean('QRG-03', 106)).toBeCloseTo(425, 9);
  });

  it('RISE_RATE 10 см/ч на 5 ч: +10, +20 … +50 и дальше держится', () => {
    const g = gen('NORMAL', quiet, [{ type: 'RISE_RATE', stationCode: 'QRG-01', effectiveTick: 3, value: 10, durationH: 5 }]);
    expect([2, 3, 4, 7, 8, 20].map((t) => g.clean('QRG-01', t) - 300)).toEqual([0, 10, 20, 50, 50, 50]);
  });

  it('MANUAL_READING заменяет показание только в своём тике, источник — manual, в волну не передаётся', () => {
    const g = gen('NORMAL', quiet, [{ type: 'MANUAL_READING', stationCode: 'QRG-01', parameter: 'water_level', effectiveTick: 10, value: 333 }]);
    expect(level(g, 'QRG-01', 10)).toMatchObject({ value: 333, source: 'manual' });
    expect(level(g, 'QRG-01', 11)).toMatchObject({ value: 300, source: 'simulator' });
    expect(g.clean('QRG-01', 10)).toBe(300);
  });
});
