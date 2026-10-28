// Точка входа backend: настройки → БД (миграции + начальные данные) → HTTP-сервер.

import { buildApp } from './app';
import { loadConfig } from './config';
import { migrate, openDb } from './db/connection';
import { seed } from './db/seed';

const config = loadConfig();
const db = openDb(config.dbPath);
const version = migrate(db);
const summary = seed(db, config.seedUsers);
const userCount = Number(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n ?? 0);

const app = await buildApp({
  db,
  sessionSecret: config.sessionSecret,
  sessionTtlHours: config.sessionTtlHours,
  logger: true,
  webRoot: config.webRoot,
  backupDir: config.backupDir,
});

app.log.info(`БД ${config.dbPath}: схема v${version}, добавлено станций ${summary.stations}, пользователей ${summary.users}`);
if (userCount === 0) app.log.warn('В БД нет пользователей — вход невозможен. Выполните `npm run setup`, затем `npm run db:reset`.');

const shutdown = async (signal: string) => {
  app.log.info(`${signal}: остановка сервера`);
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  db.close();
  process.exit(1);
}
