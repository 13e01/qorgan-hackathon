// Миграции схемы БД. Применяются по порядку, каждая — один раз (таблица schema_migrations).
// Новую миграцию добавляйте в конец массива; уже применённые не изменяйте.
// Схема описана в docs/ARCHITECTURE.md §5.

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('operator', 'admin')),
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE TABLE sessions (
  id         TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE parameters (
  code      TEXT PRIMARY KEY,
  unit      TEXT NOT NULL,
  min_valid REAL NOT NULL,
  max_valid REAL NOT NULL,
  max_step  REAL,
  CHECK (min_valid < max_valid)
);

CREATE TABLE stations (
  id                  INTEGER PRIMARY KEY,
  code                TEXT    NOT NULL UNIQUE,
  name                TEXT    NOT NULL,
  hazard_type         TEXT    NOT NULL DEFAULT 'flood' CHECK (hazard_type IN ('flood')),
  station_type        TEXT    NOT NULL CHECK (station_type IN ('hydro', 'meteo', 'combined')),
  status              TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'disabled')),
  lat                 REAL    NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon                 REAL    NOT NULL CHECK (lon BETWEEN -180 AND 180),
  upstream_station_id INTEGER REFERENCES stations(id),
  travel_hours        REAL    CHECK (travel_hours IS NULL OR travel_hours >= 0),
  attenuation         REAL    NOT NULL DEFAULT 1.0 CHECK (attenuation > 0),
  base_level_cm       REAL,
  device_token_hash   TEXT,
  last_message_at     TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  CHECK (upstream_station_id IS NULL OR upstream_station_id <> id)
);

CREATE TABLE station_parameters (
  station_id     INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  parameter_code TEXT    NOT NULL REFERENCES parameters(code),
  warning        REAL,
  danger         REAL,
  PRIMARY KEY (station_id, parameter_code),
  CHECK (warning IS NULL OR danger IS NULL OR warning < danger)
);

CREATE TABLE risk_config (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  json       TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  updated_at TEXT    NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);

CREATE TABLE sim_runs (
  id          INTEGER PRIMARY KEY,
  scenario_id TEXT    NOT NULL,
  seed        INTEGER NOT NULL,
  params_json TEXT    NOT NULL,
  tick_ms     INTEGER NOT NULL,
  sim_start   TEXT    NOT NULL,
  started_at  TEXT    NOT NULL,
  finished_at TEXT
);

CREATE TABLE sim_control (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  run_id      INTEGER REFERENCES sim_runs(id),
  status      TEXT    NOT NULL CHECK (status IN ('IDLE', 'RUNNING', 'PAUSED', 'FINISHED')),
  tick_ms     INTEGER NOT NULL CHECK (tick_ms BETWEEN 250 AND 5000),
  last_tick   INTEGER,
  faults_json TEXT    NOT NULL DEFAULT '[]',
  updated_at  TEXT    NOT NULL
);

CREATE TABLE measurements (
  id             INTEGER PRIMARY KEY,
  run_id         INTEGER NOT NULL REFERENCES sim_runs(id),
  station_id     INTEGER NOT NULL REFERENCES stations(id),
  parameter_code TEXT    NOT NULL REFERENCES parameters(code),
  value          REAL    NOT NULL,
  unit           TEXT    NOT NULL,
  measured_at    TEXT    NOT NULL,
  received_at    TEXT    NOT NULL,
  tick           INTEGER,
  source         TEXT    NOT NULL CHECK (source IN ('simulator', 'manual', 'device')),
  quality        TEXT    NOT NULL DEFAULT 'ok' CHECK (quality IN ('ok', 'late', 'suspect')),
  UNIQUE (run_id, station_id, parameter_code, measured_at)
);
CREATE INDEX measurements_series ON measurements(station_id, parameter_code, measured_at);

CREATE TABLE device_log (
  id           INTEGER PRIMARY KEY,
  station_id   INTEGER REFERENCES stations(id),
  level        TEXT    NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  code         TEXT    NOT NULL,
  details_json TEXT    NOT NULL DEFAULT '{}',
  created_at   TEXT    NOT NULL
);
CREATE INDEX device_log_station ON device_log(station_id, created_at);

CREATE TABLE risk_assessments (
  id               INTEGER PRIMARY KEY,
  run_id           INTEGER NOT NULL REFERENCES sim_runs(id),
  station_id       INTEGER NOT NULL REFERENCES stations(id),
  tick             INTEGER NOT NULL,
  measured_at      TEXT    NOT NULL,
  risk             TEXT    NOT NULL CHECK (risk IN ('LOW', 'MEDIUM', 'HIGH')),
  score            REAL    NOT NULL,
  level_cm         REAL,
  rate_cm_h        REAL,
  trend            TEXT    NOT NULL CHECK (trend IN ('RISING', 'STABLE', 'FALLING', 'UNKNOWN')),
  forecast_3h_cm   REAL,
  forecast_3h_low  REAL,
  forecast_3h_high REAL,
  eta_danger_h     REAL,
  eta_low_h        REAL,
  eta_high_h       REAL,
  confidence       TEXT    NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  factors_json     TEXT    NOT NULL,
  config_version   INTEGER NOT NULL,
  thresholds_json  TEXT    NOT NULL,
  UNIQUE (run_id, station_id, tick)
);

CREATE TABLE alerts (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES sim_runs(id),
  station_id   INTEGER NOT NULL REFERENCES stations(id),
  hazard_type  TEXT    NOT NULL CHECK (hazard_type IN ('flood')),
  severity     TEXT    NOT NULL CHECK (severity IN ('MEDIUM', 'HIGH')),
  trigger      TEXT    NOT NULL CHECK (trigger IN ('DANGER_LEVEL', 'FORECAST')),
  status       TEXT    NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'VIEWED', 'RESOLVED')),
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  opened_tick  INTEGER NOT NULL,
  last_tick    INTEGER NOT NULL,
  cleared_tick INTEGER,
  reasons_json TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);
CREATE UNIQUE INDEX one_active_alert ON alerts(run_id, station_id) WHERE is_active = 1;

CREATE TABLE alert_events (
  id         INTEGER PRIMARY KEY,
  alert_id   INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  tick       INTEGER,
  type       TEXT    NOT NULL CHECK (type IN ('OPENED', 'ESCALATED', 'DEESCALATED', 'CLEARED', 'VIEWED', 'RESOLVED')),
  user_id    INTEGER REFERENCES users(id),
  comment    TEXT,
  created_at TEXT    NOT NULL
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id),
  action      TEXT    NOT NULL,
  entity      TEXT    NOT NULL,
  entity_id   TEXT,
  before_json TEXT,
  after_json  TEXT,
  created_at  TEXT    NOT NULL
);
`,
  },
  {
    // T3: симулятор паводковой волны. Только добавление столбцов/таблиц; данные не удаляются.
    // sim_control пересоздаётся (одна служебная строка, на неё никто не ссылается): статус и скорость
    // теперь хранятся у каждого прогона в sim_runs, а sim_control только указывает активный прогон.
    version: 2,
    name: 'simulation',
    sql: `
ALTER TABLE stations ADD COLUMN response_hours INTEGER NOT NULL DEFAULT 1 CHECK (response_hours BETWEEN 1 AND 24);
UPDATE stations SET response_hours = 6 WHERE code IN ('QRG-02', 'QRG-03');
UPDATE stations SET response_hours = 3 WHERE code = 'QRG-04';

ALTER TABLE sim_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'COMPLETED'
  CHECK (status IN ('CREATED', 'RUNNING', 'PAUSED', 'COMPLETED', 'STOPPED'));
ALTER TABLE sim_runs ADD COLUMN current_tick INTEGER CHECK (current_tick IS NULL OR current_tick >= 0);
ALTER TABLE sim_runs ADD COLUMN total_ticks INTEGER CHECK (total_ticks IS NULL OR total_ticks > 0);
ALTER TABLE sim_runs ADD COLUMN step_minutes INTEGER NOT NULL DEFAULT 60 CHECK (step_minutes > 0);
ALTER TABLE sim_runs ADD COLUMN stopped_at TEXT;
ALTER TABLE sim_runs ADD COLUMN last_error TEXT;
ALTER TABLE sim_runs ADD COLUMN created_by INTEGER REFERENCES users(id);
CREATE INDEX sim_runs_status ON sim_runs(status);

CREATE TABLE sim_control_v2 (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  run_id     INTEGER REFERENCES sim_runs(id),
  updated_at TEXT    NOT NULL
);
INSERT INTO sim_control_v2 (id, run_id, updated_at) SELECT id, NULL, updated_at FROM sim_control;
DROP TABLE sim_control;
ALTER TABLE sim_control_v2 RENAME TO sim_control;

CREATE TABLE sim_interventions (
  id             INTEGER PRIMARY KEY,
  run_id         INTEGER NOT NULL REFERENCES sim_runs(id) ON DELETE CASCADE,
  effective_tick INTEGER NOT NULL CHECK (effective_tick >= 0),
  type           TEXT    NOT NULL CHECK (type IN ('LEVEL_SHIFT', 'RISE_RATE', 'MANUAL_READING')),
  station_id     INTEGER NOT NULL REFERENCES stations(id),
  parameter_code TEXT    REFERENCES parameters(code),
  value          REAL    NOT NULL,
  duration_h     REAL    CHECK (duration_h IS NULL OR duration_h > 0),
  user_id        INTEGER REFERENCES users(id),
  created_at     TEXT    NOT NULL,
  CHECK ((type = 'MANUAL_READING') = (parameter_code IS NOT NULL))
);
CREATE INDEX sim_interventions_run ON sim_interventions(run_id, effective_tick);
CREATE UNIQUE INDEX one_manual_reading ON sim_interventions(run_id, station_id, parameter_code, effective_tick)
  WHERE type = 'MANUAL_READING';

ALTER TABLE risk_assessments ADD COLUMN assessment_json TEXT;
CREATE INDEX measurements_run_tick ON measurements(run_id, tick);
`,
  },
  {
    // Внешние датчики (Python-датчик через MQTT). Только добавление: устройство привязано к станции,
    // в БД — только хеш его пароля; состояние связи и защита от повторов хранятся у устройства.
    version: 3,
    name: 'external_devices',
    sql: `
CREATE TABLE devices (
  id               INTEGER PRIMARY KEY,
  device_id        TEXT    NOT NULL UNIQUE,
  name             TEXT    NOT NULL,
  station_id       INTEGER NOT NULL REFERENCES stations(id),
  token_hash       TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  mqtt_status      TEXT    CHECK (mqtt_status IS NULL OR mqtt_status IN ('online', 'offline')),
  last_seen_at     TEXT,
  last_boot_id     TEXT,
  last_seq         INTEGER,
  last_value       REAL,
  last_unit        TEXT,
  last_sensor_at   TEXT,
  last_mode        TEXT,
  last_result      TEXT,
  accepted_count   INTEGER NOT NULL DEFAULT 0,
  rejected_count   INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);
CREATE INDEX devices_station ON devices(station_id);
`,
  },
];
