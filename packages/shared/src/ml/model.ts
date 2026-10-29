// Модель QORGAN Sentinel: формат файла, проверка совместимости и оценка одной станции (docs/SENTINEL_ML.md).
//
// Это ПАРАЛЛЕЛЬНАЯ оценка: она не меняет категорию риска T2 (QORGAN-RULES-1) и не создаёт предупреждений.
// Модель учебная — обучена на синтетических данных симулятора QORGAN, а не на реальных измерениях реки.
// Две бинарные модели XGBoost: «уровень достигнет опасного порога D в ближайшие 6 ч» и «… порога внимания W».

import type { RiskLevel } from '../risk/types';
import { computeFeatures, FEATURE_NAMES, FEATURE_SCHEMA_VERSION, featureArray, featuresToJson, ML_HORIZON_H, ML_MAX_AGE_H, type FeatureName, type MlStationInput } from './features';
import { predictMargin, shapValues, sigmoid, type Booster } from './trees';

export const MODEL_FORMAT = 'qorgan-sentinel-model';
export const MODEL_FORMAT_VERSION = 1;

export type MlTarget = 'danger' | 'warning';

export interface TargetModel {
  booster: Booster;
  /** Порог вероятности, выбранный на валидационной выборке (docs/SENTINEL_EVALUATION.md). */
  threshold: number;
}

/** Пример для проверки паритета Python ↔ TypeScript: признаки, логит и SHAP-вклады, посчитанные XGBoost. */
export interface ParityCase {
  x: Array<number | null>;
  margin: Record<MlTarget, number>;
  contribs: Record<MlTarget, number[]>;
}

export interface SentinelModel {
  format: typeof MODEL_FORMAT;
  formatVersion: number;
  modelVersion: string;
  algorithm: string;
  trainedWith: Record<string, string>;
  featureSchemaVersion: number;
  featureNames: string[];
  horizonH: number;
  /** Учебная модель на синтетических данных. Всегда true в этой версии. */
  demo: boolean;
  dataset: Record<string, unknown>;
  /** Краткие метрики на тестовой выборке (полный отчёт — ml/reports/). */
  metrics: Record<string, unknown>;
  targets: Record<MlTarget, TargetModel>;
  parity: ParityCase[];
}

export type ModelProblem = 'FORMAT' | 'FORMAT_VERSION' | 'FEATURE_SCHEMA' | 'FEATURE_NAMES' | 'HORIZON' | 'TREES';

/** Проверка файла модели: подходит ли он этому коду. Возвращает модель или код проблемы. */
export function validateModel(raw: unknown): { ok: true; model: SentinelModel } | { ok: false; problem: ModelProblem } {
  const m = raw as Partial<SentinelModel> | null;
  if (!m || m.format !== MODEL_FORMAT) return { ok: false, problem: 'FORMAT' };
  if (m.formatVersion !== MODEL_FORMAT_VERSION) return { ok: false, problem: 'FORMAT_VERSION' };
  if (m.featureSchemaVersion !== FEATURE_SCHEMA_VERSION) return { ok: false, problem: 'FEATURE_SCHEMA' };
  if (!Array.isArray(m.featureNames) || m.featureNames.join(',') !== FEATURE_NAMES.join(',')) return { ok: false, problem: 'FEATURE_NAMES' };
  if (m.horizonH !== ML_HORIZON_H) return { ok: false, problem: 'HORIZON' };
  for (const target of ['danger', 'warning'] as const) {
    const t = m.targets?.[target];
    if (!t || !Array.isArray(t.booster?.trees) || t.booster.trees.length === 0 || !Number.isFinite(t.threshold)) return { ok: false, problem: 'TREES' };
    for (const tree of t.booster.trees) {
      const n = tree.left?.length ?? 0;
      if (n === 0 || [tree.right, tree.feature, tree.threshold, tree.defaultLeft, tree.cover].some((a) => a?.length !== n)) return { ok: false, problem: 'TREES' };
    }
  }
  return { ok: true, model: m as SentinelModel };
}

export type MlStatus = 'OK' | 'INSUFFICIENT_DATA';
/** Как оценка ML соотносится с категорией правил T2. */
export type MlAgreement = 'AGREE' | 'ML_HIGHER' | 'ML_LOWER';

export interface MlContribution {
  feature: FeatureName;
  /** Значение признака (null — нет данных). */
  value: number | null;
  /** Вклад в логит модели (SHAP): > 0 повышает вероятность, < 0 понижает. Это не причинно-следственная связь. */
  shap: number;
}

export interface MlAssessment {
  status: MlStatus;
  modelVersion: string;
  horizonH: number;
  category: RiskLevel | null;
  /** Вероятности модели (учебные, не гарантия): достичь опасного / предупредительного порога за horizonH ч. */
  pDanger: number | null;
  pWarning: number | null;
  thresholds: Record<MlTarget, number>;
  /** Какая из двух моделей объясняется: та, что определила категорию. */
  explained: MlTarget | null;
  /** Базовое значение (средний логит) объясняемой модели. */
  baseValue: number | null;
  /** Все вклады объясняемой модели, по убыванию |shap|. */
  contributions: MlContribution[];
  features: Record<FeatureName, number | null>;
}

const RANK: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export function compareWithRules(ml: RiskLevel | null, rules: RiskLevel): MlAgreement | null {
  if (ml === null) return null;
  if (RANK[ml] === RANK[rules]) return 'AGREE';
  return RANK[ml] > RANK[rules] ? 'ML_HIGHER' : 'ML_LOWER';
}

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d + 0;

/** Оценка станции моделью. Без свежего измерения уровня (старше ML_MAX_AGE_H или нет) модель не оценивает. */
export function assessWithModel(model: SentinelModel, input: MlStationInput): MlAssessment {
  const f = computeFeatures(input);
  const features = featuresToJson(f);
  const base = {
    modelVersion: model.modelVersion,
    horizonH: model.horizonH,
    thresholds: { danger: model.targets.danger.threshold, warning: model.targets.warning.threshold },
    features,
  };
  if (!Number.isFinite(f.data_age_h) || f.data_age_h > ML_MAX_AGE_H || !Number.isFinite(f.level_vs_danger_cm)) {
    return { ...base, status: 'INSUFFICIENT_DATA', category: null, pDanger: null, pWarning: null, explained: null, baseValue: null, contributions: [] };
  }
  const x = featureArray(f);
  const pDanger = sigmoid(predictMargin(model.targets.danger.booster, x));
  const pWarning = sigmoid(predictMargin(model.targets.warning.booster, x));
  const category: RiskLevel =
    pDanger >= model.targets.danger.threshold ? 'HIGH' : pWarning >= model.targets.warning.threshold ? 'MEDIUM' : 'LOW';
  const explained: MlTarget = category === 'HIGH' ? 'danger' : 'warning';
  const phi = shapValues(model.targets[explained].booster, x, FEATURE_NAMES.length);
  const contributions = FEATURE_NAMES.map((feature, i) => ({ feature, value: features[feature], shap: round(phi[i]!) }))
    .filter((c) => c.shap !== 0)
    .sort((a, b) => Math.abs(b.shap) - Math.abs(a.shap));
  return {
    ...base,
    status: 'OK',
    category,
    pDanger: round(pDanger),
    pWarning: round(pWarning),
    explained,
    baseValue: round(phi[FEATURE_NAMES.length]!),
    contributions,
  };
}
