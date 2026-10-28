import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './connection';

/** Сколько последних копий хранить (старые удаляются, чтобы копии не заполнили диск). */
export const BACKUP_KEEP = 20;

/** Сохраняет согласованную копию БД в `dir` (можно делать на работающем сервере). Возвращает путь к файлу. */
export function backupDb(db: Db, dir: string, now: Date = new Date(), keep = BACKUP_KEEP): string {
  mkdirSync(dir, { recursive: true });
  // ГГГГММДД-ЧЧММСС-ммм (UTC): две копии в одну секунду не конфликтуют.
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').slice(0, 19);
  let file = join(dir, `qorgan-${stamp}.db`);
  for (let n = 1; existsSync(file); n += 1) file = join(dir, `qorgan-${stamp}-${n}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  const copies = readdirSync(dir).filter((f) => /^qorgan-\d{8}-.*\.db$/.test(f)).sort();
  for (const old of copies.slice(0, Math.max(0, copies.length - keep))) rmSync(join(dir, old), { force: true });
  return file;
}

