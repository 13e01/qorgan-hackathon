// Типы из общего пакета, которые нужны интерфейсу. Только `import type` — в браузерную сборку код сервера не попадает.
export type {
  Confidence as ConfidenceLevel,
  Crossing,
  OutlookResult,
  StationOutlook,
  StationVerification,
  EtaStatus,
  ForecastStatus,
  PublicUser,
  Reason,
  ReasonCode,
  RiskFactor,
  RiskLevel,
  RiskConfig,
  RiskSituation,
  ScenarioId,
  TrendDirection,
} from '@qorgan/shared';
