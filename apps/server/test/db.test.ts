import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RISK_CONFIG, PARAMETERS } from '@qorgan/shared';
import { backupDb } from '../src/db/backup';
import { migrate, openDb, schemaVersion, transaction } from '../src/db/connection';
import { MIGRATIONS } from '../src/db/migrations';
import { seed, SEED_STATIONS } from '../src/db/seed';
import { TEST_USERS, testDb } from './helpers';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('TC-D01 миграции', () => {
  it('применяются к пустой БД и повторный запуск ничего не меняет', () => {
    const db = openDb(':memory:');
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    const applied = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get();
    expect(Number(applied?.n)).toBe(MIGRATIONS.length);
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)?.version);
  });

  it('ограничения схемы отклоняют некорректные данные', () => {
    const db = testDb();
    const now = new Date().toISOString();
    // порог «внимание» должен быть меньше «опасно»
    expect(() =>
      db.prepare("INSERT INTO station_parameters (station_id, parameter_code, warning, danger) VALUES (1, 'air_temp', 10, 5)").run(),
    ).toThrow(/CHECK/);
    // недопустимая роль
    expect(() =>
      db.prepare("INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES ('x', 'h', 'root', ?, ?)").run(now, now),
    ).toThrow(/CHECK/);
    // ссылка на несуществующую станцию (внешние ключи включены)
    expect(() =>
      db.prepare("INSERT INTO station_parameters (station_id, parameter_code) VALUES (999, 'water_level')").run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('транзакция откатывается целиком при ошибке', () => {
    const db = testDb();
    const before = Number(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()?.n);
    expect(() =>
      transaction(db, () => {
        db.prepare("INSERT INTO audit_log (action, entity, created_at) VALUES ('test', 'x', 'now')").run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()?.n)).toBe(before);
  });
});

describe('TC-D02 начальные данные', () => {
  it('создают 4 станции вдоль реки в правильном порядке, с W < D', () => {
    const db = testDb();
    const stations = db
      .prepare(
        `SELECT s.code, s.name, u.code AS upstream, s.travel_hours, sp.warning, sp.danger
         FROM stations s
         LEFT JOIN stations u ON u.id = s.upstream_station_id
         JOIN station_parameters sp ON sp.station_id = s.id AND sp.parameter_code = 'water_level'
         ORDER BY s.id`,
      )
      .all();
    expect(stations.map((s) => s.code)).toEqual(['QRG-01', 'QRG-02', 'QRG-03', 'QRG-04']);
    expect(stations.map((s) => s.upstream)).toEqual([null, 'QRG-01', 'QRG-02', 'QRG-03']);
    expect(stations.map((s) => s.travel_hours)).toEqual([null, 51, 51, 17]);
    for (const s of stations) expect(Number(s.warning)).toBeLessThan(Number(s.danger));
  });

  it('у Соколовки только датчик уровня, у остальных — уровень, осадки, температура', () => {
    const db = testDb();
    const counts = db
      .prepare('SELECT s.code, COUNT(*) AS n FROM station_parameters sp JOIN stations s ON s.id = sp.station_id GROUP BY s.code ORDER BY s.code')
      .all();
    expect(counts.map((c) => [c.code, Number(c.n)])).toEqual([
      ['QRG-01', 3], ['QRG-02', 3], ['QRG-03', 3], ['QRG-04', 1],
    ]);
  });

  it('создают справочник показателей, коэффициенты риска, состояние симулятора и пользователей с хешами', () => {
    const db = testDb();
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM parameters').get()?.n)).toBe(PARAMETERS.length);
    const config = db.prepare('SELECT json, version FROM risk_config WHERE id = 1').get();
    expect(JSON.parse(String(config?.json))).toEqual(DEFAULT_RISK_CONFIG);
    expect(db.prepare('SELECT status FROM sim_control WHERE id = 1').get()?.status).toBe('IDLE');
    const users = db.prepare('SELECT username, role, password_hash FROM users ORDER BY id').all();
    expect(users.map((u) => [u.username, u.role])).toEqual([['operator', 'operator'], ['admin', 'admin']]);
    for (const u of users) {
      expect(String(u.password_hash)).toMatch(/^scrypt\$/);
      expect(String(u.password_hash)).not.toContain('test-pass');
    }
  });

  it('повторный запуск ничего не дублирует', () => {
    const db = testDb();
    const summary = seed(db, TEST_USERS);
    expect(summary).toEqual({ parameters: 0, stations: 0, users: 0 });
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM stations').get()?.n)).toBe(SEED_STATIONS.length);
  });
});

describe('TC-D03 резервная копия', () => {
  it('создаёт файл БД с теми же данными', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qorgan-backup-'));
    tempDirs.push(dir);
    const source = openDb(join(dir, 'source.db'));
    migrate(source);
    seed(source, TEST_USERS);

    const file = backupDb(source, join(dir, 'backups'), new Date('2026-10-28T12:34:56Z'));
    expect(file).toMatch(/qorgan-20261028-123456\.db$/);
    source.close();

    const copy = openDb(file);
    expect(Number(copy.prepare('SELECT COUNT(*) AS n FROM stations').get()?.n)).toBe(4);
    expect(Number(copy.prepare('SELECT COUNT(*) AS n FROM users').get()?.n)).toBe(2);
    copy.close();
  });
});
