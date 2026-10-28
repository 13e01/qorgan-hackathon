// Проверочный набор данных для T2 (`npm run db:fixture`): фиксированные 12 часов измерений по 4 станциям,
// чтобы вручную проверить API риска до появления симулятора (T3).
// Это НЕ симулятор и не реальные данные: прогон помечен scenario_id = 'TEST_FIXTURE', источник — 'manual'.
// Ожидаемые результаты (проверяются в apps/server/test/risk-api.test.ts):
//   QRG-01 Сергеевка     — рост 20 см/ч до 580 см (выше D = 550), ливень 24 мм, +6 °C → HIGH, 10 баллов
//   QRG-02 Явленка       — ровно 300 см, +6 °C, волна сверху (HIGH, 51 ч) → MEDIUM, 3 балла
//   QRG-03 Петропавловск — ровно 340 см, −2 °C, волна сверху (MEDIUM, 51 ч) → LOW, 1 балл
//   QRG-04 Соколовка     — спад 5 см/ч до 415 см (выше W = 400), один выброс 545 см отброшен → MEDIUM, 2 балла

import type { ParameterCode } from '@qorgan/shared';
import { transaction, type Db } from './connection';

export const FIXTURE_SCENARIO = 'TEST_FIXTURE';
export const FIXTURE_AS_OF = '2026-04-02T12:00:00.000Z';
const HOURS = 12;

type Series = Partial<Record<ParameterCode, number[]>>;

const range = (f: (k: number) => number) => Array.from({ length: HOURS }, (_, k) => f(k));

export const FIXTURE_SERIES: Record<string, Series> = {
  'QRG-01': {
    water_level: range((k) => 360 + 20 * k),
    precipitation: range((k) => (k < 6 ? 0 : 4)),
    air_temp: range(() => 6),
  },
  'QRG-02': {
    water_level: range(() => 300),
    precipitation: range(() => 0),
    air_temp: range(() => 6),
  },
  'QRG-03': {
    water_level: range(() => 340),
    precipitation: range(() => 0),
    air_temp: range(() => -2),
  },
  'QRG-04': {
    water_level: range((k) => (k === 9 ? 545 : 470 - 5 * k)),
  },
};

const UNITS: Record<ParameterCode, string> = { water_level: 'cm', precipitation: 'mm/h', air_temp: '°C' };

/** Заменяет прежний проверочный прогон новым. Возвращает id прогона. */
export function insertFixture(db: Db): number {
  const now = new Date().toISOString();
  const asOfMs = Date.parse(FIXTURE_AS_OF);
  const simStart = new Date(asOfMs - (HOURS - 1) * 3_600_000).toISOString();

  return transaction(db, () => {
    const old = db.prepare('SELECT id FROM sim_runs WHERE scenario_id = ?').all(FIXTURE_SCENARIO).map((r) => Number(r.id));
    for (const id of old) {
      db.prepare('DELETE FROM measurements WHERE run_id = ?').run(id);
      db.prepare('DELETE FROM sim_runs WHERE id = ?').run(id);
    }

    const runId = Number(
      db
        .prepare(
          `INSERT INTO sim_runs (scenario_id, seed, params_json, tick_ms, sim_start, started_at, finished_at)
           VALUES (?, 0, '{}', 1000, ?, ?, ?)`,
        )
        .run(FIXTURE_SCENARIO, simStart, now, now).lastInsertRowid,
    );

    const insert = db.prepare(
      `INSERT INTO measurements (run_id, station_id, parameter_code, value, unit, measured_at, received_at, tick, source)
       VALUES (?, (SELECT id FROM stations WHERE code = ?), ?, ?, ?, ?, ?, ?, 'manual')`,
    );
    for (const [code, series] of Object.entries(FIXTURE_SERIES)) {
      for (const [parameter, values] of Object.entries(series) as Array<[ParameterCode, number[]]>) {
        values.forEach((value, k) => {
          const measuredAt = new Date(asOfMs - (HOURS - 1 - k) * 3_600_000).toISOString();
          insert.run(runId, code, parameter, value, UNITS[parameter], measuredAt, now, k);
        });
      }
    }
    return runId;
  });
}
