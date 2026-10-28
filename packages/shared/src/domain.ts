// Справочники предметной области QORGAN. Значения учебные (см. docs/ARCHITECTURE.md §3, §8).

export const ROLES = ['operator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Гость — пользователь без входа; у него нет записи в users. */
export type AccessLevel = 'guest' | Role;

const ACCESS_RANK: Record<AccessLevel, number> = { guest: 0, operator: 1, admin: 2 };

/** true, если уровень `actual` не ниже `required` (admin может всё, что operator). */
export function hasAccess(actual: AccessLevel, required: AccessLevel): boolean {
  return ACCESS_RANK[actual] >= ACCESS_RANK[required];
}

export const HAZARD_TYPES = ['flood'] as const;
export type HazardType = (typeof HAZARD_TYPES)[number];

export const STATION_TYPES = ['hydro', 'meteo', 'combined'] as const;
export type StationType = (typeof STATION_TYPES)[number];

export const STATION_STATUSES = ['active', 'maintenance', 'disabled'] as const;
export type StationStatus = (typeof STATION_STATUSES)[number];

export const PARAMETER_CODES = ['water_level', 'precipitation', 'air_temp'] as const;
export type ParameterCode = (typeof PARAMETER_CODES)[number];

export interface ParameterDefinition {
  code: ParameterCode;
  unit: string;
  minValid: number;
  maxValid: number;
  /** Максимальный правдоподобный скачок за один тик; null — не проверяется. */
  maxStep: number | null;
}

/** Справочник измеряемых показателей с допустимыми диапазонами (учебные значения). */
export const PARAMETERS: readonly ParameterDefinition[] = [
  { code: 'water_level', unit: 'cm', minValid: 0, maxValid: 1500, maxStep: 50 },
  { code: 'precipitation', unit: 'mm/h', minValid: 0, maxValid: 100, maxStep: null },
  { code: 'air_temp', unit: '°C', minValid: -50, maxValid: 45, maxStep: 10 },
];

/** Коэффициенты модели риска (ARCHITECTURE §8). Хранятся в risk_config, меняет администратор. */
export interface RiskConfig {
  windowSize: number;
  minPoints: number;
  epsilonCmH: number;
  maxJumpCm: number;
  forecastHorizonH: number;
  highEtaH: number;
  mediumEtaH: number;
  upstreamHorizonH: number;
  rainWindowH: number;
  rainModerateMm: number;
  rainHeavyMm: number;
  meltWindowH: number;
  meltTempC: number;
  clearAfterLowCount: number;
  points: {
    levelDanger: number;
    levelWarning: number;
    etaHigh: number;
    etaMedium: number;
    rising: number;
    rainHeavy: number;
    rainModerate: number;
    melt: number;
    upstreamHigh: number;
    upstreamMedium: number;
  };
  categories: {
    highScore: number;
    mediumScore: number;
  };
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  windowSize: 6,
  minPoints: 3,
  epsilonCmH: 0.5,
  maxJumpCm: 50,
  forecastHorizonH: 3,
  highEtaH: 6,
  mediumEtaH: 24,
  upstreamHorizonH: 72,
  rainWindowH: 6,
  rainModerateMm: 10,
  rainHeavyMm: 20,
  meltWindowH: 24,
  meltTempC: 2,
  clearAfterLowCount: 3,
  points: {
    levelDanger: 4,
    levelWarning: 2,
    etaHigh: 3,
    etaMedium: 2,
    rising: 1,
    rainHeavy: 2,
    rainModerate: 1,
    melt: 1,
    upstreamHigh: 2,
    upstreamMedium: 1,
  },
  categories: {
    highScore: 5,
    mediumScore: 2,
  },
};
