import { DEFAULT_RISK_CONFIG, type RiskConfig } from '../domain';

/**
 * Коэффициенты из БД поверх значений по умолчанию: если в сохранённом JSON нет нового поля
 * (например, БД создана до его появления), берётся значение по умолчанию.
 * Нечисловые значения игнорируются.
 */
export function resolveRiskConfig(stored: unknown): RiskConfig {
  const src = isRecord(stored) ? stored : {};
  const pick = <T extends Record<string, number>>(defaults: T, values: unknown): T => {
    const v = isRecord(values) ? values : {};
    const out = { ...defaults };
    for (const key of Object.keys(defaults) as Array<keyof T>) {
      const candidate = v[key as string];
      if (typeof candidate === 'number' && Number.isFinite(candidate)) out[key] = candidate as T[keyof T];
    }
    return out;
  };
  const { points, categories, ...scalars } = DEFAULT_RISK_CONFIG;
  return {
    ...pick(scalars, src),
    points: pick(points, src.points),
    categories: pick(categories, src.categories),
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
