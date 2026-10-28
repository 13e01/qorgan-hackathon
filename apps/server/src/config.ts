import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SeedUser } from './db/seed';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  backupDir: string;
  sessionSecret: string;
  sessionTtlHours: number;
  seedUsers: SeedUser[];
}

/** Читает настройки из переменных окружения и файла .env в корне проекта (если он есть). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const envFile = resolve(ROOT_DIR, '.env');
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);

  const fromRoot = (p: string) => (isAbsolute(p) ? p : resolve(ROOT_DIR, p));

  let sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) {
    console.warn('[config] SESSION_SECRET не задан или короче 32 символов — сгенерирован временный; сессии сбросятся при перезапуске. Выполните `npm run setup`.');
    sessionSecret = randomBytes(32).toString('hex');
  }

  const seedUsers: SeedUser[] = [];
  if (env.SEED_OPERATOR_PASSWORD) {
    seedUsers.push({ username: env.SEED_OPERATOR_USERNAME ?? 'operator', password: env.SEED_OPERATOR_PASSWORD, role: 'operator' });
  }
  if (env.SEED_ADMIN_PASSWORD) {
    seedUsers.push({ username: env.SEED_ADMIN_USERNAME ?? 'admin', password: env.SEED_ADMIN_PASSWORD, role: 'admin' });
  }

  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '127.0.0.1',
    dbPath: fromRoot(env.DB_PATH ?? 'data/qorgan.db'),
    backupDir: fromRoot(env.BACKUP_DIR ?? 'data/backups'),
    sessionSecret,
    sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 12),
    seedUsers,
  };
}
