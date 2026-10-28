import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations';

export type Db = DatabaseSync;

/** Открывает файл БД (или ':memory:' для тестов) с нужными настройками. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  return db;
}

/**
 * Выполняет `fn` в одной транзакции: либо все изменения сохраняются, либо ни одного.
 * Вложенные вызовы выполняются внутри внешней транзакции.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Применяет недостающие миграции. Возвращает текущую версию схемы. */
export function migrate(db: Db): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version)),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    transaction(db, () => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });
  }
  return schemaVersion(db);
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return Number(row?.v ?? 0);
}
