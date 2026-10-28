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
  /** Собранный интерфейс; раздаётся, если существует (после `npm run build`). */
  webRoot: string;
  /** Публичное размещение (за HTTPS-прокси): cookie только по HTTPS, доверие заголовкам прокси, строгие проверки секретов. */
  publicDeployment: boolean;
  /** Сколько прокси-узлов стоит перед сервером (для правильного IP клиента в журнале и ограничении попыток входа). */
  trustProxy: boolean;
}

/** Пароли из .env.example — только для локального показа; в публичном размещении запрещены. */
const DEMO_PASSWORDS = new Set(['qorgan-operator-demo', 'qorgan-admin-demo']);

/** Проверка настроек публичного размещения. Возвращает список проблем (пустой — можно запускать). */
export function publicDeploymentProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  if ((env.SESSION_SECRET ?? '').length < 32 || env.SESSION_SECRET === 'replace-me') problems.push('SESSION_SECRET: задайте случайную строку не короче 32 символов');
  for (const key of ['SEED_OPERATOR_PASSWORD', 'SEED_ADMIN_PASSWORD'] as const) {
    const v = env[key];
    if (v !== undefined && (DEMO_PASSWORDS.has(v) || v.length < 12)) problems.push(`${key}: демо-пароль или короче 12 символов недопустим в публичном размещении`);
  }
  return problems;
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
    webRoot: fromRoot(env.WEB_ROOT ?? 'apps/web/dist'),
    publicDeployment: env.PUBLIC_DEPLOYMENT === 'true',
    trustProxy: env.TRUST_PROXY === 'true' || env.PUBLIC_DEPLOYMENT === 'true',
  };
}
