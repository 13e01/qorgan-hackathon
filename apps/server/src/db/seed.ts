// Начальные данные: справочник показателей, 4 учебные станции на р. Есиль, коэффициенты риска,
// демо-пользователи и состояние симулятора. Повторный запуск ничего не дублирует.
// Координаты — точки на русле по OpenStreetMap (docs/ARCHITECTURE.md §4). Пороги — учебные.

import { DEFAULT_RISK_CONFIG, PARAMETERS, type ParameterCode, type Role, type StationType } from '@qorgan/shared';
import { hashPassword } from '../auth/password';
import { transaction, type Db } from './connection';

interface SeedStation {
  code: string;
  name: string;
  stationType: StationType;
  lat: number;
  lon: number;
  upstream: string | null;
  travelHours: number | null;
  attenuation: number;
  baseLevelCm: number;
  parameters: Partial<Record<ParameterCode, { warning: number | null; danger: number | null }>>;
}

// Для осадков и температуры пороги общие для всех станций и задаются в risk_config.
const METEO = {
  precipitation: { warning: null, danger: null },
  air_temp: { warning: null, danger: null },
};

export const SEED_STATIONS: readonly SeedStation[] = [
  {
    code: 'QRG-01', name: 'Сергеевка', stationType: 'combined', lat: 53.8809, lon: 67.4335,
    upstream: null, travelHours: null, attenuation: 1, baseLevelCm: 300,
    parameters: { water_level: { warning: 450, danger: 550 }, ...METEO },
  },
  {
    code: 'QRG-02', name: 'Явленка', stationType: 'combined', lat: 54.3484, lon: 68.4465,
    upstream: 'QRG-01', travelHours: 51, attenuation: 0.95, baseLevelCm: 280,
    parameters: { water_level: { warning: 420, danger: 520 }, ...METEO },
  },
  {
    code: 'QRG-03', name: 'Петропавловск', stationType: 'combined', lat: 54.8825, lon: 69.1172,
    upstream: 'QRG-02', travelHours: 51, attenuation: 1.05, baseLevelCm: 320,
    parameters: { water_level: { warning: 480, danger: 580 }, ...METEO },
  },
  {
    code: 'QRG-04', name: 'Соколовка', stationType: 'hydro', lat: 55.1165, lon: 69.2103,
    upstream: 'QRG-03', travelHours: 17, attenuation: 0.9, baseLevelCm: 260,
    parameters: { water_level: { warning: 400, danger: 500 } },
  },
];

export interface SeedUser {
  username: string;
  password: string;
  role: Role;
}

export interface SeedSummary {
  parameters: number;
  stations: number;
  users: number;
}

export function seed(db: Db, users: readonly SeedUser[]): SeedSummary {
  const now = new Date().toISOString();
  const summary: SeedSummary = { parameters: 0, stations: 0, users: 0 };

  transaction(db, () => {
    const insertParam = db.prepare(
      'INSERT OR IGNORE INTO parameters (code, unit, min_valid, max_valid, max_step) VALUES (?, ?, ?, ?, ?)',
    );
    for (const p of PARAMETERS) {
      summary.parameters += Number(insertParam.run(p.code, p.unit, p.minValid, p.maxValid, p.maxStep).changes);
    }

    const stationCount = Number(db.prepare('SELECT COUNT(*) AS n FROM stations').get()?.n ?? 0);
    if (stationCount === 0) {
      const insertStation = db.prepare(`INSERT INTO stations
        (code, name, station_type, lat, lon, upstream_station_id, travel_hours, attenuation, base_level_cm, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, (SELECT id FROM stations WHERE code = ?), ?, ?, ?, ?, ?)`);
      const insertStationParam = db.prepare(
        'INSERT INTO station_parameters (station_id, parameter_code, warning, danger) VALUES (?, ?, ?, ?)',
      );
      // Порядок важен: станция выше по течению создаётся раньше нижней.
      for (const s of SEED_STATIONS) {
        const { lastInsertRowid } = insertStation.run(
          s.code, s.name, s.stationType, s.lat, s.lon, s.upstream, s.travelHours, s.attenuation, s.baseLevelCm, now, now,
        );
        for (const [code, t] of Object.entries(s.parameters)) {
          insertStationParam.run(lastInsertRowid, code, t.warning, t.danger);
        }
        summary.stations += 1;
      }
    }

    db.prepare('INSERT OR IGNORE INTO risk_config (id, json, version, updated_at) VALUES (1, ?, 1, ?)').run(
      JSON.stringify(DEFAULT_RISK_CONFIG),
      now,
    );
    db.prepare("INSERT OR IGNORE INTO sim_control (id, status, tick_ms, updated_at) VALUES (1, 'IDLE', 1000, ?)").run(now);

    const insertUser = db.prepare(
      'INSERT OR IGNORE INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const u of users) {
      summary.users += Number(insertUser.run(u.username, hashPassword(u.password), u.role, now, now).changes);
    }
  });

  return summary;
}
