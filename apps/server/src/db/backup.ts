import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './connection';

/** Сохраняет согласованную копию БД в `dir` (можно делать на работающем сервере). Возвращает путь к файлу. */
export function backupDb(db: Db, dir: string, now: Date = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = join(dir, `qorgan-${stamp}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  return file;
}
