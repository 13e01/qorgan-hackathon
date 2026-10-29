import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessWithModel,
  compareWithRules,
  computeFeatures,
  FEATURE_NAMES,
  predictMargin,
  shapValues,
  validateModel,
  type MeasurementPoint,
  type MlStationInput,
  type SentinelModel,
} from '../src';

const MODEL_PATH = resolve(import.meta.dirname, '../../../ml/models/sentinel-model.json');
const raw = JSON.parse(readFileSync(MODEL_PATH, 'utf8'));
const validated = validateModel(raw);
if (!validated.ok) throw new Error(`model invalid: ${validated.problem}`);
const model: SentinelModel = validated.model;

const H = 3_600_000;
const T0 = Date.parse('2026-04-01T12:00:00.000Z');
const at = (h: number) => new Date(T0 + h * H).toISOString();
/** Часовой ряд: значения для часов from…0 (0 = asOf). */
const series = (values: number[]): MeasurementPoint[] => values.map((v, i) => ({ measuredAt: at(i - values.length + 1), value: v }));

function input(level: MeasurementPoint[], extra: Partial<MlStationInput> = {}): MlStationInput {
  return { asOf: at(0), thresholds: { warning: 450, danger: 550 }, level, precipitation: null, airTemp: null, upstream: null, ...extra };
}

describe('ML: паритет с XGBoost (Python)', () => {
  it('модель проходит проверку совместимости и содержит примеры паритета', () => {
    expect(model.featureNames).toEqual([...FEATURE_NAMES]);
    expect(model.demo).toBe(true);
    expect(model.parity.length).toBeGreaterThanOrEqual(20);
    expect(model.parity.some((c) => c.x.some((v) => v === null))).toBe(true);
  });

  it('логит и SHAP-вклады совпадают с XGBoost predict(output_margin) и pred_contribs', () => {
    for (const c of model.parity) {
      const x = c.x.map((v) => (v === null ? Number.NaN : v));
      for (const target of ['danger', 'warning'] as const) {
        const booster = model.targets[target].booster;
        expect(predictMargin(booster, x)).toBeCloseTo(c.margin[target], 4);
        const phi = shapValues(booster, x, FEATURE_NAMES.length);
        phi.forEach((v, i) => expect(v).toBeCloseTo(c.contribs[target][i]!, 4));
        // Свойство SHAP: сумма вкладов + базовое значение = логит.
        expect(phi.reduce((a, b) => a + b, 0)).toBeCloseTo(predictMargin(booster, x), 5);
      }
    }
  });

  it('несовместимый файл модели отклоняется с кодом причины', () => {
    expect(validateModel(null)).toEqual({ ok: false, problem: 'FORMAT' });
    expect(validateModel({ ...raw, formatVersion: 99 })).toEqual({ ok: false, problem: 'FORMAT_VERSION' });
    expect(validateModel({ ...raw, featureSchemaVersion: 0 })).toEqual({ ok: false, problem: 'FEATURE_SCHEMA' });
    expect(validateModel({ ...raw, featureNames: [...raw.featureNames].reverse() })).toEqual({ ok: false, problem: 'FEATURE_NAMES' });
    expect(validateModel({ ...raw, horizonH: 3 })).toEqual({ ok: false, problem: 'HORIZON' });
    const broken = structuredClone(raw);
    broken.targets.danger.booster.trees[0].cover.pop();
    expect(validateModel(broken)).toEqual({ ok: false, problem: 'TREES' });
  });
});

describe('ML: признаки', () => {
  const rising = series([400, 402, 404, 406, 408, 410, 412, 414, 416, 418, 420, 422, 424]);

  it('изменения за 1/3/6/12 ч, наклон, ускорение, отклонение от среднего, относительно порогов', () => {
    const f = computeFeatures(input(rising));
    expect(f.level_vs_danger_cm).toBe(424 - 550);
    expect(f.level_vs_warning_cm).toBe(424 - 450);
    expect(f.delta_1h_cm).toBe(2);
    expect(f.delta_3h_cm).toBe(6);
    expect(f.delta_6h_cm).toBe(12);
    expect(f.delta_12h_cm).toBe(24);
    expect(f.slope_6h_cm_h).toBeCloseTo(2, 6);
    expect(f.accel_3h_cm).toBe(0);
    expect(f.ma6_dev_cm).toBeCloseTo(5, 6);
    expect(f.data_age_h).toBe(0);
  });

  it('нет утечки будущего: точки позже asOf не меняют признаки', () => {
    const future = [...rising, { measuredAt: at(1), value: 900 }, { measuredAt: at(2), value: 950 }];
    expect(computeFeatures(input(future))).toEqual(computeFeatures(input(rising)));
    const up = { level: series(new Array(80).fill(300)), dangerCm: 520, travelHours: 4 };
    const upFuture = { ...up, level: [...up.level, { measuredAt: at(3), value: 999 }] };
    expect(computeFeatures(input(rising, { upstream: upFuture }))).toEqual(computeFeatures(input(rising, { upstream: up })));
  });

  it('пропуски дают NaN, а не ноль; дубли и неверные точки отбрасываются', () => {
    const gap = rising.filter((_, i) => i !== 9); // нет точки 3 ч назад
    expect(Number.isNaN(computeFeatures(input(gap)).delta_3h_cm)).toBe(true);
    const noData = computeFeatures(input([]));
    expect(Number.isNaN(noData.level_vs_danger_cm)).toBe(true);
    expect(Number.isNaN(noData.rain_6h_mm)).toBe(true); // нет датчика осадков
    const dirty = [...rising, { measuredAt: 'not-a-date', value: 1 }, { measuredAt: at(-1), value: Number.NaN }, { measuredAt: at(0), value: 430 }];
    const f = computeFeatures(input(dirty));
    expect(f.level_vs_danger_cm).toBe(430 - 550); // из двух точек с одним временем — последняя
  });

  it('осадки за 6 ч и средняя температура за 24 ч; «приходящая волна» сверху с учётом времени добегания', () => {
    const rain = series([9, 9, 1, 1, 1, 1, 1, 1]); // последние 6 ч — по 1 мм
    const temp = series(new Array(24).fill(3));
    // Выше по течению уровень растёт на 5 см/ч последние 20 ч; добегание 10 ч → к станции «едет» рост за 6 ч.
    const upLevel = series([...new Array(60).fill(300), ...Array.from({ length: 20 }, (_, i) => 305 + i * 5)]);
    const f = computeFeatures(input(rising, { precipitation: rain, airTemp: temp, upstream: { level: upLevel, dangerCm: 500, travelHours: 10 } }));
    expect(f.rain_6h_mm).toBe(6);
    expect(f.temp_mean_24h_c).toBe(3);
    expect(f.up_level_vs_danger_cm).toBe(400 - 500);
    expect(f.up_delta_3h_cm).toBe(15);
    expect(f.up_arriving_6h_cm).toBe(30); // h_u(asOf − 4) − h_u(asOf − 10)
    expect(f.up_travel_h).toBe(10);
  });
});

describe('ML: оценка станции', () => {
  it('без свежего измерения уровня модель не оценивает (INSUFFICIENT_DATA)', () => {
    const stale = series([400, 401, 402]).map((p) => ({ ...p, measuredAt: new Date(Date.parse(p.measuredAt) - 5 * H).toISOString() }));
    const a = assessWithModel(model, input(stale));
    expect(a.status).toBe('INSUFFICIENT_DATA');
    expect(a.category).toBeNull();
    expect(assessWithModel(model, input([])).status).toBe('INSUFFICIENT_DATA');
  });

  it('спокойная вода — LOW; уровень выше опасного и растёт — HIGH; объяснение — вклады той модели, что решила', () => {
    const calm = assessWithModel(model, input(series(new Array(25).fill(300))));
    expect(calm.status).toBe('OK');
    expect(calm.category).toBe('LOW');
    expect(calm.explained).toBe('warning');
    const flood = assessWithModel(model, input(series(Array.from({ length: 25 }, (_, i) => 500 + i * 3))));
    expect(flood.category).toBe('HIGH');
    expect(flood.explained).toBe('danger');
    expect(flood.pDanger!).toBeGreaterThan(model.targets.danger.threshold);
    expect(flood.contributions[0]!.shap).toBeGreaterThan(0);
    // Вклады отсортированы по |shap| и в сумме с базой дают логит.
    const abs = flood.contributions.map((c) => Math.abs(c.shap));
    expect([...abs].sort((a, b) => b - a)).toEqual(abs);
  });

  it('расхождение с правилами T2', () => {
    expect(compareWithRules('HIGH', 'MEDIUM')).toBe('ML_HIGHER');
    expect(compareWithRules('LOW', 'MEDIUM')).toBe('ML_LOWER');
    expect(compareWithRules('MEDIUM', 'MEDIUM')).toBe('AGREE');
    expect(compareWithRules(null, 'LOW')).toBeNull();
  });
});
