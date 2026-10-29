// «Почему такой риск?» — объяснение оценки QORGAN Sentinel простыми словами (docs/SENTINEL_ML.md §6).
// Ничего не пересчитывает: берёт готовые вклады SHAP и значения признаков из ответа сервера и выбирает
// фразу по знаку значения признака. Фразы — ключи i18n; заготовленных случайных текстов нет.
// Вклад SHAP — это вклад признака в оценку модели, а не доказанная причина и не гарантия.

import type { MlContribution, MlResult } from '../api/types';
import type { MessageKey, Params } from '../i18n';
import { metersFromCm, number, signed, type Lang } from './format';

export interface Phrase {
  key: MessageKey;
  params: Params;
}

export interface FactorView {
  feature: string;
  /** Подпись признака. */
  label: MessageKey;
  /** Значение признака в понятных единицах (или null — нет данных). */
  value: ValueView | null;
  /** Что значение говорит о ситуации. */
  phrase: Phrase;
  /** up — повышает оценку риска, down — понижает. */
  direction: 'up' | 'down';
  /** Доля от самого сильного вклада в списке, 0…1 (для полоски). */
  weight: number;
}

const STEADY_CM = 0.5;

function hoursOf(feature: string): number | null {
  const m = /_(\d+)h_/.exec(feature);
  return m ? Number(m[1]) : null;
}

/**
 * Фраза по признаку и его значению (единицы — как в признаке: см, ч, мм, °C).
 * hasUpstream = false — у станции нет станции выше по течению (исток): признаки «сверху» не «нет данных», а неприменимы.
 */
export function describeFeature(feature: string, value: number | null, lang: Lang, hasUpstream = true): Phrase {
  const label = `ml.f.${feature}` as MessageKey;
  if (value === null && feature.startsWith('up_') && !hasUpstream) return { key: 'ml.say.noUpstream', params: {} };
  if (value === null) return { key: 'ml.say.noData', params: { feature: label } };
  const m = (cm: number) => metersFromCm(Math.abs(cm), lang);
  const cm = (x: number) => number(Math.abs(x), lang, 1);
  const h = hoursOf(feature);
  switch (feature) {
    case 'level_vs_danger_cm':
      return value >= 0 ? { key: 'ml.say.aboveDanger', params: { m: m(value) } } : { key: 'ml.say.belowDanger', params: { m: m(value) } };
    case 'level_vs_warning_cm':
      return value >= 0 ? { key: 'ml.say.aboveWarning', params: { m: m(value) } } : { key: 'ml.say.belowWarning', params: { m: m(value) } };
    case 'delta_1h_cm':
    case 'delta_3h_cm':
    case 'delta_6h_cm':
    case 'delta_12h_cm':
      if (Math.abs(value) < STEADY_CM) return { key: 'ml.say.steady', params: { h } };
      return { key: value > 0 ? 'ml.say.rose' : 'ml.say.fell', params: { h, cm: cm(value) } };
    case 'slope_6h_cm_h':
      return Math.abs(value) < STEADY_CM ? { key: 'ml.say.slopeFlat', params: {} } : { key: 'ml.say.slope', params: { cmh: signed(value, lang, 1) } };
    case 'accel_3h_cm':
      if (Math.abs(value) < 1) return { key: 'ml.say.accelNone', params: {} };
      return { key: value > 0 ? 'ml.say.accel' : 'ml.say.decel', params: { cm: cm(value) } };
    case 'ma6_dev_cm':
      return { key: value >= 0 ? 'ml.say.aboveAvg' : 'ml.say.belowAvg', params: { cm: cm(value) } };
    case 'data_age_h':
      return { key: 'ml.say.age', params: { h: number(value, lang, 1) } };
    case 'rain_6h_mm':
      return value > 0 ? { key: 'ml.say.rain', params: { mm: number(value, lang, 1) } } : { key: 'ml.say.noRain', params: {} };
    case 'temp_mean_24h_c':
      return { key: 'ml.say.temp', params: { c: signed(value, lang, 1) } };
    case 'up_level_vs_danger_cm':
      return value >= 0 ? { key: 'ml.say.upAboveDanger', params: { m: m(value) } } : { key: 'ml.say.upBelowDanger', params: { m: m(value) } };
    case 'up_delta_3h_cm':
    case 'up_delta_6h_cm':
      if (Math.abs(value) < STEADY_CM) return { key: 'ml.say.upSteady', params: { h } };
      return { key: value > 0 ? 'ml.say.upRose' : 'ml.say.upFell', params: { h, cm: cm(value) } };
    case 'up_arriving_6h_cm':
      if (Math.abs(value) < STEADY_CM) return { key: 'ml.say.upNothing', params: {} };
      return { key: value > 0 ? 'ml.say.upArriving' : 'ml.say.upReceding', params: { cm: cm(value) } };
    case 'up_travel_h':
      return { key: 'ml.say.travel', params: { h: number(value, lang, 0) } };
    default:
      return { key: 'ml.say.noData', params: { feature: label } };
  }
}

export interface ValueView {
  text: string;
  unit: MessageKey | null;
}

/** Значение признака для списка факторов: число в формате языка и ключ единицы (уровни относительно порогов — в метрах). */
export function featureValue(feature: string, value: number | null, lang: Lang): ValueView | null {
  if (value === null) return null;
  if (feature.endsWith('_vs_danger_cm') || feature.endsWith('_vs_warning_cm')) {
    const s = metersFromCm(value, lang);
    return s === null ? null : { text: `${value > 0 ? '+' : ''}${s}`, unit: 'unit.m' };
  }
  if (feature === 'slope_6h_cm_h') return { text: signed(value, lang, 1)!, unit: 'unit.cmh' };
  if (feature.endsWith('_cm')) return { text: signed(value, lang, 1)!, unit: 'unit.cm' };
  if (feature.endsWith('_h')) return { text: number(value, lang, 1)!, unit: 'unit.h' };
  if (feature.endsWith('_mm')) return { text: number(value, lang, 1)!, unit: 'unit.mm' };
  if (feature.endsWith('_c')) return { text: signed(value, lang, 1)!, unit: 'unit.c' };
  return { text: number(value, lang, 2)!, unit: null };
}

/** Вероятность в процентах; крайние значения — «< 1 %» / «> 99 %», чтобы оценка не читалась как уверенность. */
export function percent(p: number | null, lang: Lang): string | null {
  if (p === null || !Number.isFinite(p)) return null;
  if (p < 0.005) return `< ${number(1, lang, 0)} %`;
  if (p > 0.995) return `> ${number(99, lang, 0)} %`;
  return `${number(p * 100, lang, 0)} %`;
}

/** Самые значимые факторы (по |SHAP|), не больше `limit`. */
export function topFactors(contributions: readonly MlContribution[], lang: Lang, limit = 5, hasUpstream = true): FactorView[] {
  const list = contributions.filter((c) => c.shap !== 0).slice(0, limit);
  const max = Math.max(...list.map((c) => Math.abs(c.shap)), 1e-9);
  return list.map((c) => ({
    feature: c.feature,
    label: `ml.f.${c.feature}` as MessageKey,
    value: featureValue(c.feature, c.value, lang),
    phrase: describeFeature(c.feature, c.value, lang, hasUpstream),
    direction: c.shap > 0 ? 'up' : 'down',
    weight: Math.abs(c.shap) / max,
  }));
}

/**
 * Краткое объяснение: категория и вероятность + две главные фразы в сторону итоговой оценки
 * (для HIGH/MEDIUM — то, что повышает риск; для LOW — то, что его понижает).
 */
export function summarize(result: MlResult, lang: Lang): Phrase[] {
  if (result.status !== 'OK' || !result.category) return [{ key: 'ml.summary.insufficient', params: {} }];
  const p = result.category === 'HIGH' ? result.pDanger : result.pWarning;
  const head: Phrase = { key: `ml.summary.${result.category}` as MessageKey, params: { p: percent(p, lang), h: result.horizonH } };
  const towards = result.contributions.filter((c) => (result.category === 'LOW' ? c.shap < 0 : c.shap > 0)).slice(0, 2);
  return [head, ...towards.map((c) => describeFeature(c.feature, c.value, lang, hasUpstreamOf(result)))];
}

/** Есть ли у станции станция выше по течению: время добегания известно (признак up_travel_h). */
export function hasUpstreamOf(result: MlResult): boolean {
  return result.features.up_travel_h !== null && result.features.up_travel_h !== undefined;
}
