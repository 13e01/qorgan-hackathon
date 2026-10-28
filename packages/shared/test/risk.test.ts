// Тесты модуля оценки риска. Ожидаемые значения вычислены вручную (docs/TESTING.md §2).
// Параметры по умолчанию: W = 450, D = 550, N = 6, ε = 0.5, J_max = 50, горизонт 3 ч, ETA ≤ 72 ч.

import { describe, expect, it } from 'vitest';
import {
  assessRisk,
  DEFAULT_RISK_CONFIG,
  linearRegression,
  resolveRiskConfig,
  type MeasurementPoint,
  type ParameterCode,
  type RiskAssessment,
  type RiskInput,
} from '../src';

const AS_OF = '2026-04-02T12:00:00.000Z';
const AS_OF_MS = Date.parse(AS_OF);

/** Время через `hours` от AS_OF (отрицательное — в прошлом). */
const at = (hours: number) => new Date(AS_OF_MS + hours * 3_600_000).toISOString();

/** Почасовой ряд, последняя точка — за `endAgoH` часов до AS_OF. */
function hourly(values: number[], endAgoH = 0): MeasurementPoint[] {
  return values.map((value, i) => ({ measuredAt: at(-(values.length - 1 - i) - endAgoH), value }));
}

function input(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    asOf: AS_OF,
    thresholds: { warning: 450, danger: 550 },
    sensors: ['water_level'],
    series: {},
    upstream: null,
    config: DEFAULT_RISK_CONFIG,
    ...overrides,
  };
}

const level = (values: number[], extra: Partial<RiskInput> = {}) =>
  assessRisk(input({ series: { water_level: hourly(values) }, ...extra }));

const factor = (a: RiskAssessment, code: string) => a.factors.find((f) => f.code === code)!;

describe('линейная регрессия', () => {
  it('наклон, сдвиг и стандартная ошибка совпадают с ручным расчётом', () => {
    // t̄ = 1.5, h̄ = 2.75, Σ(t−t̄)(h−h̄) = 5.5, Σ(t−t̄)² = 5 → наклон 1.1; Σres² = 2.7 → SE = √(2.7/2/5) = 0.519615
    const r = linearRegression([{ t: 0, h: 1 }, { t: 1, h: 3 }, { t: 2, h: 2 }, { t: 3, h: 5 }])!;
    expect(r.slope).toBeCloseTo(1.1, 10);
    expect(r.intercept).toBeCloseTo(1.1, 10);
    expect(r.stdErr).toBeCloseTo(0.519615, 6);
  });

  it('точная прямая → нулевая ошибка; 2 точки → ошибка не определена', () => {
    expect(linearRegression([{ t: 0, h: 5 }, { t: 1, h: 7 }, { t: 2, h: 9 }])).toEqual({ n: 3, slope: 2, intercept: 5, stdErr: 0 });
    expect(linearRegression([{ t: 0, h: 5 }, { t: 2, h: 9 }])?.stdErr).toBeNull();
  });

  it('меньше 2 точек или одинаковое время → null (нет деления на ноль)', () => {
    expect(linearRegression([])).toBeNull();
    expect(linearRegression([{ t: 0, h: 1 }])).toBeNull();
    expect(linearRegression([{ t: 1, h: 1 }, { t: 1, h: 5 }])).toBeNull();
  });
});

describe('1. нормальный уровень и 6. отсутствие изменений (TC-R03)', () => {
  it('ровный уровень 300 см → LOW, STABLE, прогноз 300, порог не ожидается', () => {
    const a = level([300, 300, 300, 300, 300, 300]);
    expect(a.risk).toBe('LOW');
    expect(a.score).toBe(0);
    expect(a.maxScore).toBe(12);
    expect(a.trend).toMatchObject({ direction: 'STABLE', rateCmH: 0, rateStdErr: 0, rateChange: 'STEADY', pointsUsed: 6 });
    expect(a.forecast).toEqual({ status: 'OK', horizonH: 3, levelCm: 300, lowCm: 300, highCm: 300 });
    expect(a.eta).toEqual({ status: 'NOT_EXPECTED', hours: null, lowH: null, highH: null });
    expect(a.dataQuality).toEqual({ status: 'OK', confidence: 'HIGH', pointsExcluded: 0, issues: [] });
    expect(factor(a, 'TREND').reason).toEqual({ code: 'STABLE' });
    expect(a.reasons).toEqual([]);
  });

  it('рост 0.2 см/ч меньше ε = 0.5 → STABLE (TC-R12)', () => {
    const a = level([300, 300.2, 300.4, 300.6, 300.8, 301]);
    expect(a.trend.direction).toBe('STABLE');
    expect(a.trend.rateCmH).toBeCloseTo(0.2, 6);
    expect(a.risk).toBe('LOW');
  });
});

describe('2. медленный подъём', () => {
  it('3 см/ч от 400 до 415: ETA (550−415)/3 = 45 ч → +1 балл, LOW', () => {
    const a = level([400, 403, 406, 409, 412, 415]);
    expect(a.trend.rateCmH).toBe(3);
    expect(a.eta).toEqual({ status: 'ESTIMATED', hours: 45, lowH: 45, highH: 45 });
    expect(a.forecast.levelCm).toBe(424);
    expect(factor(a, 'TREND')).toMatchObject({ points: 1, reason: { code: 'RISING', params: { rateCmH: 3 } } });
    expect(a.score).toBe(1);
    expect(a.risk).toBe('LOW');
  });

  it('2 см/ч от 300: ETA 120 ч > 72 ч — время не называется (BEYOND_HORIZON)', () => {
    const a = level([300, 302, 304, 306, 308, 310]);
    expect(a.eta).toEqual({ status: 'BEYOND_HORIZON', hours: null, lowH: null, highH: null });
    expect(factor(a, 'TREND')).toMatchObject({ points: 1, reason: { code: 'ETA_BEYOND_HORIZON', params: { rateCmH: 2, maxHours: 72 } } });
    expect(a.forecast.levelCm).toBe(316);
    expect(a.risk).toBe('LOW');
  });
});

describe('3. быстрый подъём и 9. время до порога', () => {
  it('10 см/ч до 450 (TC-R04): прогноз 480, ETA 10 ч, 2+2 = 4 балла → MEDIUM', () => {
    const a = level([400, 410, 420, 430, 440, 450]);
    expect(a.trend).toMatchObject({ direction: 'RISING', rateCmH: 10, rateStdErr: 0, rateChange: 'STEADY', earlyRateCmH: 10, recentRateCmH: 10 });
    expect(a.forecast).toEqual({ status: 'OK', horizonH: 3, levelCm: 480, lowCm: 480, highCm: 480 });
    expect(a.eta).toEqual({ status: 'ESTIMATED', hours: 10, lowH: 10, highH: 10 });
    expect(a.score).toBe(4);
    expect(a.risk).toBe('MEDIUM');
    expect(a.reasons).toEqual([
      { code: 'LEVEL_ABOVE_WARNING', params: { levelCm: 450, warningCm: 450 } },
      { code: 'ETA_DANGER_WITHIN', params: { hours: 10, rateCmH: 10 } },
    ]);
    expect(a.dataQuality.confidence).toBe('HIGH');
  });

  it('20 см/ч до 520 (TC-R05): ETA 1.5 ч ≤ 6 → 3 балла, итого 5 → HIGH', () => {
    const a = level([420, 440, 460, 480, 500, 520]);
    expect(a.eta.hours).toBe(1.5);
    expect(factor(a, 'TREND').points).toBe(3);
    expect(factor(a, 'LEVEL').points).toBe(2);
    expect(a.score).toBe(5);
    expect(a.risk).toBe('HIGH');
    expect(a.reasons[0]).toEqual({ code: 'ETA_DANGER_WITHIN', params: { hours: 1.5, rateCmH: 20 } });
  });

  it('ускоряющийся рост: скорость 6 см/ч, SE 0.730, ETA 20 ч [17.83; 22.77], доверие снижено до MEDIUM', () => {
    // Скорость в начале окна 3 см/ч, в конце 9 см/ч → ACCELERATING.
    const a = level([400, 402, 406, 412, 420, 430]);
    expect(a.trend).toMatchObject({ direction: 'RISING', rateCmH: 6, rateStdErr: 0.73, rateChange: 'ACCELERATING', earlyRateCmH: 3, recentRateCmH: 9 });
    expect(a.eta).toEqual({ status: 'ESTIMATED', hours: 20, lowH: 17.83, highH: 22.77 });
    expect(a.forecast).toEqual({ status: 'OK', horizonH: 3, levelCm: 448, lowCm: 445.81, highCm: 450.19 });
    expect(a.risk).toBe('MEDIUM');
    expect(a.dataQuality.confidence).toBe('MEDIUM');
    expect(a.reasons).toEqual([
      { code: 'ETA_DANGER_WITHIN', params: { hours: 20, rateCmH: 6 } },
      { code: 'ACCELERATING_RISE', params: { earlyRateCmH: 3, recentRateCmH: 9 } },
    ]);
  });

  it('замедляющийся рост → DECELERATING_RISE', () => {
    const a = level([400, 410, 418, 424, 428, 430]);
    expect(a.trend).toMatchObject({ rateChange: 'DECELERATING', earlyRateCmH: 9, recentRateCmH: 3 });
    expect(a.reasons.map((r) => r.code)).toContain('DECELERATING_RISE');
  });

  it('шум ±3 см вокруг роста 10 см/ч (TC-R14): наклон 9.657, диапазоны содержат точечную оценку', () => {
    // 400 + 10t + шум e = [+3, −3, +2, −2, +1, −1]; наклон шума: Σ(t−t̄)e / Σ(t−t̄)² = −6 / 17.5 = −0.342857
    const a = level([403, 407, 422, 428, 441, 449]);
    expect(a.trend.rateCmH).toBeCloseTo(9.657, 3);
    const { eta, forecast } = a;
    expect(eta.status).toBe('ESTIMATED');
    expect(eta.lowH!).toBeLessThanOrEqual(eta.hours!);
    expect(eta.hours!).toBeLessThanOrEqual(eta.highH!);
    expect(forecast.lowCm!).toBeLessThan(forecast.levelCm!);
    expect(forecast.levelCm!).toBeLessThan(forecast.highCm!);
  });

  it('при большой неопределённости (v − SE ≤ ε) верхняя граница ETA не называется', () => {
    // Пила ±22 см (скачки ≤ 50 см — это не выбросы) со слабым ростом: v = 80 / 17.5 = 4.571 см/ч
    const a = level([400, 445, 400, 445, 400, 450]);
    expect(a.trend.direction).toBe('RISING');
    expect(a.trend.rateCmH).toBe(4.571);
    expect(a.eta.status).toBe('ESTIMATED');
    expect(a.trend.rateStdErr!).toBeGreaterThanOrEqual(a.trend.rateCmH! - 0.5);
    expect(a.eta.highH).toBeNull();
    expect(a.dataQuality.confidence).toBe('MEDIUM');
  });
});

describe('4. превышение опасного порога', () => {
  it('рост выше D (TC-R06): ETA 0, 4+3 = 7 баллов, HIGH', () => {
    const a = level([540, 550, 560, 570, 580, 590]);
    expect(a.eta).toEqual({ status: 'ALREADY_EXCEEDED', hours: 0, lowH: 0, highH: 0 });
    expect(a.score).toBe(7);
    expect(a.risk).toBe('HIGH');
    expect(a.reasons[0]).toEqual({ code: 'LEVEL_ABOVE_DANGER', params: { levelCm: 590, dangerCm: 550 } });
    expect(a.forecast.levelCm).toBe(620);
  });

  it('уровень = D при спаде: балл 4 < 5, но правило h ≥ D даёт HIGH', () => {
    const a = level([600, 590, 580, 570, 560, 550]);
    expect(a.score).toBe(4);
    expect(a.risk).toBe('HIGH');
    expect(a.trend.direction).toBe('FALLING');
  });
});

describe('5. снижение уровня', () => {
  it('спад 10 см/ч до 450 (TC-R07): FALLING, ETA не ожидается, MEDIUM по уровню', () => {
    const a = level([500, 490, 480, 470, 460, 450]);
    expect(a.trend).toMatchObject({ direction: 'FALLING', rateCmH: -10 });
    expect(a.eta.status).toBe('NOT_EXPECTED');
    expect(a.forecast.levelCm).toBe(420);
    expect(a.risk).toBe('MEDIUM');
    expect(factor(a, 'TREND')).toMatchObject({ points: 0, reason: { code: 'FALLING', params: { rateCmH: -10 } } });
  });

  it('спад ниже W (TC-R08) → LOW', () => {
    const a = level([440, 430, 420, 410, 400, 390]);
    expect(a.risk).toBe('LOW');
    expect(a.forecast.levelCm).toBe(360);
  });
});

describe('7. недостаток данных', () => {
  it('2 точки (TC-R01): скорость не считается, прогноз и ETA недоступны, доверие LOW', () => {
    const a = level([300, 302]);
    expect(a.trend).toMatchObject({ direction: 'UNKNOWN', rateCmH: null, pointsUsed: 2 });
    expect(a.forecast).toEqual({ status: 'INSUFFICIENT_DATA', horizonH: 3, levelCm: null, lowCm: null, highCm: null });
    expect(a.eta.status).toBe('UNAVAILABLE');
    expect(a.dataQuality).toMatchObject({ status: 'INSUFFICIENT', confidence: 'LOW' });
    expect(a.dataQuality.issues).toEqual([{ code: 'INSUFFICIENT_DATA', params: { points: 2, required: 3 } }]);
    expect(a.risk).toBe('LOW');
  });

  it('1 точка выше D (TC-R02): HIGH по уровню, ETA 0', () => {
    const a = level([560]);
    expect(a.risk).toBe('HIGH');
    expect(a.eta.status).toBe('ALREADY_EXCEEDED');
    expect(a.dataQuality.confidence).toBe('LOW');
  });

  it('нет ни одного измерения → NO_DATA, без выдуманных чисел', () => {
    const a = assessRisk(input());
    expect(a.risk).toBe('LOW');
    expect(a.level.currentCm).toBeNull();
    expect(a.forecast.status).toBe('NO_DATA');
    expect(a.eta.status).toBe('UNAVAILABLE');
    expect(a.dataQuality).toMatchObject({ status: 'NO_DATA', confidence: 'LOW' });
    expect(factor(a, 'LEVEL')).toMatchObject({ status: 'NO_DATA', reason: { code: 'NO_DATA', params: { parameter: 'water_level' } } });
  });

  it('данные устарели (последнее измерение 5 ч назад > 3 ч): прогноз и ETA не выдаются', () => {
    const a = assessRisk(input({ series: { water_level: hourly([400, 410, 420, 430, 440, 450], 5) } }));
    expect(a.level.ageH).toBe(5);
    expect(a.forecast.status).toBe('STALE_DATA');
    expect(a.eta.status).toBe('UNAVAILABLE');
    expect(factor(a, 'TREND')).toMatchObject({ status: 'STALE', points: 0 });
    expect(factor(a, 'LEVEL')).toMatchObject({ status: 'STALE', points: 2 });
    expect(a.dataQuality).toMatchObject({ status: 'STALE', confidence: 'LOW' });
    expect(a.risk).toBe('MEDIUM');
  });
});

describe('8. некорректные показания и интервалы', () => {
  it('одиночный выброс исключается (TC-R09): наклон ровно 2 по 5 точкам', () => {
    const a = level([300, 302, 304, 420, 308, 310]);
    expect(a.trend).toMatchObject({ rateCmH: 2, pointsUsed: 5 });
    expect(a.dataQuality).toMatchObject({ status: 'DEGRADED', confidence: 'MEDIUM', pointsExcluded: 1 });
    expect(a.dataQuality.issues).toEqual([{ code: 'SPIKE_IGNORED', params: { count: 1 } }]);
    expect(a.risk).toBe('LOW');
  });

  it('неподтверждённый скачок в последней точке (TC-R10): расчёт по 308 см, доверие LOW', () => {
    const a = level([300, 302, 304, 306, 308, 600]);
    expect(a.level).toMatchObject({ currentCm: 308, ageH: 1 });
    expect(a.trend.rateCmH).toBe(2);
    expect(a.forecast.levelCm).toBe(316); // 308 + 2·(1 + 3)
    expect(a.dataQuality.issues).toEqual([{ code: 'SPIKE_UNCONFIRMED', params: { valueCm: 600, jumpCm: 292 } }]);
    expect(a.dataQuality.confidence).toBe('LOW');
    expect(a.risk).toBe('LOW');
  });

  it('подтверждённый скачок (TC-R11): точка принята, HIGH, наклон 68.714', () => {
    const a = level([302, 304, 306, 308, 600, 605]);
    expect(a.level.currentCm).toBe(605);
    expect(a.trend.rateCmH).toBe(68.714); // 1202.5 / 17.5
    expect(a.dataQuality.issues).toEqual([{ code: 'SUDDEN_JUMP', params: { jumpCm: 292 } }]);
    expect(a.risk).toBe('HIGH');
  });

  it('NaN, Infinity и неверная дата отбрасываются', () => {
    const series = [
      ...hourly([300, 300, 300, 300, 300, 300]),
      { measuredAt: at(-0.5), value: Number.NaN },
      { measuredAt: at(-0.2), value: Number.POSITIVE_INFINITY },
      { measuredAt: 'not-a-date', value: 999 },
    ];
    const a = assessRisk(input({ series: { water_level: series } }));
    expect(a.trend).toMatchObject({ rateCmH: 0, pointsUsed: 6 });
    expect(a.dataQuality.issues).toEqual([{ code: 'INVALID_POINTS', params: { parameter: 'water_level', count: 3 } }]);
    expect(a.dataQuality.pointsExcluded).toBe(3);
  });

  it('точки из будущего не используются (нет «заглядывания вперёд»)', () => {
    const past = hourly([400, 410, 420, 430, 440, 450]);
    const withFuture = [...past, { measuredAt: at(1), value: 900 }, { measuredAt: at(2), value: 950 }];
    const a = assessRisk(input({ series: { water_level: withFuture } }));
    const b = assessRisk(input({ series: { water_level: past } }));
    expect(a.dataQuality.issues).toEqual([{ code: 'FUTURE_POINTS', params: { parameter: 'water_level', count: 2 } }]);
    expect({ ...a, reasons: [], dataQuality: null }).toEqual({ ...b, reasons: [], dataQuality: null });
  });

  it('дубли по времени: остаётся последнее значение', () => {
    const series = [...hourly([400, 410, 420, 430, 440, 449]), { measuredAt: AS_OF, value: 450 }];
    const a = assessRisk(input({ series: { water_level: series } }));
    expect(a.level.currentCm).toBe(450);
    expect(a.trend.rateCmH).toBe(10);
    expect(a.dataQuality.issues).toEqual([{ code: 'DUPLICATE_TIMESTAMPS', params: { parameter: 'water_level', count: 1 } }]);
  });

  it('порядок входных точек не важен', () => {
    const sorted = hourly([400, 410, 420, 430, 440, 450]);
    const shuffled = [sorted[3]!, sorted[0]!, sorted[5]!, sorted[1]!, sorted[4]!, sorted[2]!];
    expect(assessRisk(input({ series: { water_level: shuffled } }))).toEqual(assessRisk(input({ series: { water_level: sorted } })));
  });

  it('неравномерные интервалы учитываются по времени: точки −4, −3, −1, 0 ч → ровно 10 см/ч', () => {
    const series = [
      { measuredAt: at(-4), value: 410 },
      { measuredAt: at(-3), value: 420 },
      { measuredAt: at(-1), value: 440 },
      { measuredAt: at(0), value: 450 },
    ];
    const a = assessRisk(input({ series: { water_level: series } }));
    expect(a.trend).toMatchObject({ rateCmH: 10, pointsUsed: 4 });
    expect(a.eta.hours).toBe(10);
    expect(a.dataQuality.confidence).toBe('MEDIUM');
  });

  it('разрыв 6 ч > 3 ч: старые точки не используются, тренд по последним 3', () => {
    const series = [
      { measuredAt: at(-10), value: 300 },
      { measuredAt: at(-9), value: 300 },
      { measuredAt: at(-8), value: 300 },
      { measuredAt: at(-2), value: 400 },
      { measuredAt: at(-1), value: 410 },
      { measuredAt: at(0), value: 420 },
    ];
    const a = assessRisk(input({ series: { water_level: series } }));
    expect(a.trend).toMatchObject({ rateCmH: 10, pointsUsed: 3, windowStart: at(-2) });
    expect(a.eta.hours).toBe(13);
    expect(a.risk).toBe('MEDIUM');
    expect(a.dataQuality.issues).toEqual([{ code: 'DATA_GAP', params: { hours: 6 } }]);
    expect(a.dataQuality.confidence).toBe('MEDIUM');
  });

  it('неверный asOf → исключение (защита от ошибок вызова)', () => {
    expect(() => assessRisk(input({ asOf: 'yesterday' }))).toThrow(/invalid asOf/);
  });
});

describe('11. факторы, вклад и объяснения', () => {
  const meteo: ParameterCode[] = ['water_level', 'precipitation', 'air_temp'];

  it('ливень 24 мм за 6 ч при ровном уровне (TC-R15) → ранний MEDIUM', () => {
    const a = level([300, 300, 300, 300, 300, 300], {
      sensors: meteo,
      series: { water_level: hourly([300, 300, 300, 300, 300, 300]), precipitation: hourly([10, 10, 10, 10, 10, 10, 4, 4, 4, 4, 4, 4]) },
    });
    expect(factor(a, 'RAIN')).toMatchObject({ points: 2, value: 24, reason: { code: 'HEAVY_RAIN', params: { mm: 24, hours: 6 } } });
    expect(a.risk).toBe('MEDIUM');
    expect(a.reasons[0]?.code).toBe('HEAVY_RAIN');
  });

  it('осадки с неравными интервалами: 2 мм/ч × (1 + 2 + 3) ч = 12 мм → MODERATE_RAIN', () => {
    const precipitation = [
      { measuredAt: at(-5), value: 2 },
      { measuredAt: at(-3), value: 2 },
      { measuredAt: at(0), value: 2 },
    ];
    const a = assessRisk(input({ sensors: meteo, series: { water_level: hourly([300, 300, 300]), precipitation } }));
    expect(factor(a, 'RAIN')).toMatchObject({ points: 1, value: 12, reason: { code: 'MODERATE_RAIN' } });
  });

  it('потепление +5 °C за сутки (TC-R16) → +1 балл, одной температуры недостаточно для MEDIUM', () => {
    const a = assessRisk(input({ sensors: meteo, series: { water_level: hourly([300, 300, 300]), air_temp: hourly(Array(24).fill(5)) } }));
    expect(factor(a, 'MELT')).toMatchObject({ points: 1, value: 5, reason: { code: 'SNOWMELT', params: { tempC: 5, hours: 24 } } });
    expect(a.risk).toBe('LOW');
  });

  it('все факторы вместе (TC-R17): 2 + 2 + 1 + 1 = 6 → HIGH; сумма вкладов = итоговый балл', () => {
    const a = assessRisk(
      input({
        sensors: meteo,
        series: { water_level: hourly([400, 410, 420, 430, 440, 450]), precipitation: hourly([2, 2, 2, 2, 2, 2]), air_temp: hourly([5, 5, 5, 5, 5, 5]) },
      }),
    );
    expect(a.factors.map((f) => [f.code, f.points, f.maxPoints])).toEqual([
      ['LEVEL', 2, 4], ['TREND', 2, 3], ['RAIN', 1, 2], ['MELT', 1, 1], ['UPSTREAM', 0, 2],
    ]);
    expect(a.score).toBe(6);
    expect(a.factors.reduce((s, f) => s + f.points, 0)).toBe(a.score);
    expect(a.risk).toBe('HIGH');
    expect(a.reasons.map((r) => r.code)).toEqual(['LEVEL_ABOVE_WARNING', 'ETA_DANGER_WITHIN', 'MODERATE_RAIN', 'SNOWMELT']);
  });

  it('нет датчиков осадков и температуры (TC-R18) → NO_SENSOR, результат как TC-R04', () => {
    const a = level([400, 410, 420, 430, 440, 450]);
    expect(factor(a, 'RAIN').status).toBe('NO_SENSOR');
    expect(factor(a, 'MELT').status).toBe('NO_SENSOR');
    expect(a.score).toBe(4);
  });

  it('датчик есть, данных нет → NO_DATA с причиной', () => {
    const a = assessRisk(input({ sensors: meteo, series: { water_level: hourly([300, 300, 300]), air_temp: hourly([5], 30) } }));
    expect(factor(a, 'RAIN')).toMatchObject({ status: 'NO_DATA', reason: { code: 'NO_DATA', params: { parameter: 'precipitation' } } });
    expect(factor(a, 'MELT')).toMatchObject({ status: 'NO_DATA' }); // единственное значение старше 24 ч
  });

  it('волна сверху (TC-R13): HIGH и 51 ч → +2 → MEDIUM; 80 ч или MEDIUM сверху → LOW', () => {
    const flat = [300, 300, 300, 300, 300, 300];
    const high = level(flat, { upstream: { stationCode: 'QRG-01', risk: 'HIGH', travelHours: 51 } });
    expect(high.risk).toBe('MEDIUM');
    expect(high.reasons).toEqual([{ code: 'UPSTREAM_WAVE', params: { station: 'QRG-01', risk: 'HIGH', hours: 51 } }]);
    expect(level(flat, { upstream: { stationCode: 'QRG-01', risk: 'HIGH', travelHours: 80 } }).risk).toBe('LOW');
    const medium = level(flat, { upstream: { stationCode: 'QRG-01', risk: 'MEDIUM', travelHours: 51 } });
    expect([medium.score, medium.risk]).toEqual([1, 'LOW']);
    expect(factor(level(flat), 'UPSTREAM').status).toBe('NOT_APPLICABLE');
  });

  it('порог D не задан → NO_THRESHOLD, время не выдумывается', () => {
    const a = level([400, 410, 420, 430, 440, 450], { thresholds: { warning: 450, danger: null } });
    expect(a.eta.status).toBe('NO_THRESHOLD');
    expect(a.eta.hours).toBeNull();
  });

  it('коэффициенты из БД применяются: удвоенный вес ливня → 4 балла', () => {
    const config = resolveRiskConfig({ points: { rainHeavy: 4 } });
    const a = assessRisk(
      input({ config, sensors: meteo, series: { water_level: hourly([300, 300, 300]), precipitation: hourly([4, 4, 4, 4, 4, 4]) } }),
    );
    expect(factor(a, 'RAIN')).toMatchObject({ points: 4, maxPoints: 4 });
    expect(a.maxScore).toBe(14);
  });

  it('модель помечена как учебная; время расчёта и версия коэффициентов в ответе', () => {
    const a = level([300, 300, 300], { computedAt: '2026-10-28T10:00:00.000Z', configVersion: 3 });
    expect(a.model).toEqual({ id: 'QORGAN-RULES-1', method: 'RULES_AND_LINEAR_TREND', demo: true, configVersion: 3 });
    expect(a.asOf).toBe(AS_OF);
    expect(a.computedAt).toBe('2026-10-28T10:00:00.000Z');
  });
});

describe('resolveRiskConfig', () => {
  it('недостающие и нечисловые поля берутся из значений по умолчанию', () => {
    const c = resolveRiskConfig({ windowSize: 8, maxGapH: 'x', points: { melt: 3 }, extra: 1 });
    expect(c).toEqual({ ...DEFAULT_RISK_CONFIG, windowSize: 8, points: { ...DEFAULT_RISK_CONFIG.points, melt: 3 } });
    expect(resolveRiskConfig(null)).toEqual(DEFAULT_RISK_CONFIG);
  });
});

describe('надёжность: воспроизводимость и отсутствие NaN/Infinity', () => {
  function* numbers(obj: unknown): Generator<number> {
    if (typeof obj === 'number') yield obj;
    else if (obj && typeof obj === 'object') for (const v of Object.values(obj)) yield* numbers(v);
  }

  it('200 детерминированно сгенерированных рядов: все числа конечные, результат повторяется', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    for (let k = 0; k < 200; k += 1) {
      const n = Math.floor(rand() * 10);
      const values = Array.from({ length: n }, () => Math.round(200 + rand() * 500));
      const times = values.map(() => at(-Math.round(rand() * 12 * 4) / 4));
      const series = values.map((value, i) => ({ measuredAt: times[i]!, value }));
      const inp = input({
        sensors: ['water_level', 'precipitation', 'air_temp'],
        series: { water_level: series, precipitation: series.map((p) => ({ ...p, value: p.value / 100 })), air_temp: series.map((p) => ({ ...p, value: p.value / 50 - 5 })) },
        upstream: rand() > 0.5 ? { stationCode: 'UP', risk: rand() > 0.5 ? 'HIGH' : 'MEDIUM', travelHours: 20 } : null,
      });
      const a = assessRisk(inp);
      for (const x of numbers(a)) expect(Number.isFinite(x)).toBe(true);
      expect(assessRisk(inp)).toEqual(a);
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(a.risk);
      if (a.eta.hours !== null) expect(a.eta.hours).toBeGreaterThanOrEqual(0);
    }
  });
});
