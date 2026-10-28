// Типы из общего пакета, которые нужны интерфейсу. Только `import type` — в браузерную сборку код сервера не попадает.
export type {
  Confidence as ConfidenceLevel,
  EtaStatus,
  ForecastStatus,
  PublicUser,
  Reason,
  ReasonCode,
  RiskFactor,
  RiskLevel,
  RiskSituation,
  ScenarioId,
  TrendDirection,
} from '@qorgan/shared';
