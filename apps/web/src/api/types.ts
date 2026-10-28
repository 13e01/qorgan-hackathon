// Формы ответов backend (сверены с apps/server/src/routes/*, realtime/snapshot.ts, simulation/runner.ts).
// Общие типы оценки риска берутся из @qorgan/shared — те же, что использует сервер.

import type {
  ConfidenceLevel,
  EtaStatus,
  ForecastStatus,
  PublicUser,
  Reason,
  RiskFactor,
  RiskLevel,
  RiskSituation,
  ScenarioId,
  TrendDirection,
} from './shared';

export type DataMode = 'LIVE' | 'PAUSED' | 'HISTORICAL' | 'NO_DATA';
export type SimState = 'IDLE' | 'CREATED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'STOPPED';

export interface EvaluationContext {
  mode: DataMode;
  runId: number | null;
  runStatus: Exclude<SimState, 'IDLE'> | null;
  scenarioId: string | null;
  virtualTime: string | null;
  realTime: string;
  lastReceivedAt: string | null;
}

export interface RunInfo {
  id: number;
  scenarioId: string;
  seed: number;
  status: Exclude<SimState, 'IDLE'>;
  tickMs: number;
  stepMinutes: number;
  simStart: string;
  currentTick: number | null;
  totalTicks: number | null;
  startedAt: string;
  finishedAt: string | null;
  stoppedAt: string | null;
  lastError: string | null;
}

export interface SimulationState {
  state: SimState;
  dataSource?: 'INTERNAL_SIMULATION' | 'EXTERNAL_SENSOR' | null;
  run: (RunInfo & { virtualTime: string | null; nextVirtualTime: string | null; progress: number | null; acceleration: number }) | null;
  realTime: string;
}

export interface Reading {
  value: number;
  unit: string;
  measuredAt: string;
  source: string;
  quality: string;
}

export interface SnapshotStation {
  id: number;
  code: string;
  name: string;
  status: string;
  lastMessageAt: string | null;
  latest: Partial<Record<'water_level' | 'precipitation' | 'air_temp', Reading>>;
  risk: {
    risk: RiskLevel;
    score: number;
    maxScore: number;
    levelCm: number | null;
    measuredAt: string | null;
    ageH: number | null;
    warningCm: number | null;
    dangerCm: number | null;
    trend: TrendDirection;
    rateCmH: number | null;
    dataStatus: string;
    confidence: ConfidenceLevel;
    topReasons: Reason[];
    situation: RiskSituation;
  };
}

export type AlertSeverity = 'MEDIUM' | 'HIGH';
export type AlertStatus = 'NEW' | 'VIEWED' | 'RESOLVED';
export type AlertEventType = 'OPENED' | 'ESCALATED' | 'DEESCALATED' | 'CLEARED' | 'VIEWED' | 'RESOLVED';

/** Предупреждение (apps/server/src/alerts/repository.ts). */
export interface AlertItem {
  id: number;
  runId: number;
  stationCode: string;
  stationName: string;
  hazardType: string;
  severity: AlertSeverity;
  trigger: 'DANGER_LEVEL' | 'FORECAST';
  status: AlertStatus;
  isActive: boolean;
  openedTick: number;
  lastTick: number;
  clearedTick: number | null;
  openedAt: string;
  createdAt: string;
  updatedAt: string;
  reasons: Reason[];
}

export interface AlertEvent {
  id: number;
  tick: number | null;
  type: AlertEventType;
  comment: string | null;
  user: string | null;
  createdAt: string;
}

export interface Snapshot {
  simulation: SimulationState;
  context: EvaluationContext;
  stations: SnapshotStation[];
  alerts?: { runId: number | null; active: AlertItem[]; unhandled: number };
  devices?: DeviceSummary[];
  mqtt?: 'disabled' | 'connecting' | 'connected' | 'offline';
}

/** Внешнее устройство (apps/server/src/mqtt/devices.ts). */
export interface DeviceSummary {
  deviceId: string;
  name: string;
  stationCode: string;
  stationName: string;
  status: string;
  link: 'ONLINE' | 'STALE' | 'OFFLINE' | 'NEVER';
  mqttStatus: string | null;
  lastValue: number | null;
  lastUnit: string | null;
  lastSensorAt: string | null;
  lastSeenAt: string | null;
  lastMode: string | null;
  lastResult: string | null;
  lastSeq: number | null;
  accepted: number;
  rejected: number;
}

// ── Администрирование (apps/server/src/routes/admin.ts) ──
export interface AdminStation extends Omit<StationMeta, 'parameters'> {
  hasDeviceToken: boolean;
  parameters: Array<{ code: string; warning: number | null; danger: number | null }>;
}

export interface AdminUser {
  id: number;
  username: string;
  role: 'operator' | 'admin';
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SourceLink = 'ONLINE' | 'STALE' | 'OFFLINE' | 'IDLE' | 'DISABLED';
export interface SourceItem {
  id: number;
  code: string;
  name: string;
  status: string;
  link: SourceLink;
  lastMessageAt: string | null;
  rejected24h: number;
  flaggedInRun: number;
  hasDeviceToken: boolean;
}

export interface DeviceLogItem {
  id: number;
  level: 'info' | 'warn' | 'error';
  code: string;
  stationCode: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface AuditItem {
  id: number;
  action: string;
  entity: string;
  entityId: string | null;
  user: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface StationMeta {
  id: number;
  code: string;
  name: string;
  hazardType: string;
  stationType: string;
  status: string;
  lat: number;
  lon: number;
  upstreamCode: string | null;
  travelHours: number | null;
  attenuation: number;
  responseHours: number;
  baseLevelCm: number | null;
  lastMessageAt: string | null;
  parameters: Array<{ code: string; warning: number | null; danger: number | null }>;
}

export interface MeasurementItem {
  parameter: string;
  value: number;
  unit: string;
  measuredAt: string;
  receivedAt: string;
  tick: number | null;
  source: string;
  quality: string;
}

export interface MeasurementsResponse {
  station: { id: number; code: string; name: string; status: string };
  context: EvaluationContext;
  parameter: string | null;
  items: MeasurementItem[];
}

export interface ExplanationResponse {
  station: { id: number; code: string; name: string; status: string };
  runId: number | null;
  context: EvaluationContext;
  asOf: string;
  computedAt: string;
  risk: RiskLevel;
  score: number;
  maxScore: number;
  level: { currentCm: number | null; measuredAt: string | null; ageH: number | null; warningCm: number | null; dangerCm: number | null };
  trend: { direction: TrendDirection; rateCmH: number | null; rateChange: string; pointsUsed: number };
  factors: RiskFactor[];
  reasons: Reason[];
  dataQuality: { status: string; confidence: ConfidenceLevel; pointsExcluded: number; issues: Reason[] };
  situation: RiskSituation;
}

export interface ForecastResponse {
  station: { id: number; code: string; name: string; status: string };
  runId: number | null;
  context: EvaluationContext;
  asOf: string;
  level: { currentCm: number | null; measuredAt: string | null; ageH: number | null; warningCm: number | null; dangerCm: number | null };
  trend: { direction: TrendDirection; rateCmH: number | null; rateStdErr: number | null };
  forecast: { status: ForecastStatus; horizonH: number; levelCm: number | null; lowCm: number | null; highCm: number | null };
  eta: { status: EtaStatus; hours: number | null; lowH: number | null; highH: number | null };
}

export interface RiskHistoryResponse {
  station: { id: number; code: string; name: string; status: string };
  context: EvaluationContext;
  items: Array<{ tick: number; virtualTime: string; risk: RiskLevel; score: number; levelCm: number | null }>;
}

export interface ScenarioInfo {
  id: ScenarioId;
  totalTicks: number;
  sourceStation: string;
  wave: { amplitudeCm: number; startTick: number; riseH: number; peakH: number; fallH: number };
}

export interface InterventionItem {
  id: number;
  type: 'LEVEL_SHIFT' | 'RISE_RATE' | 'MANUAL_READING';
  stationCode: string;
  effectiveTick: number;
  value: number;
  parameter: string | null;
  durationH: number | null;
  createdAt: string;
}

export type { PublicUser };
