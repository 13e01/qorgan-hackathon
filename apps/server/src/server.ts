// Точка входа backend: настройки → БД (миграции + начальные данные) → HTTP-сервер.

import { buildApp } from './app';
import { loadConfig, publicDeploymentProblems } from './config';
import { migrate, openDb } from './db/connection';
import { seed } from './db/seed';

const config = loadConfig();
if (config.publicDeployment) {
  const problems = publicDeploymentProblems(process.env);
  if (problems.length) {
    console.error(`[config] PUBLIC_DEPLOYMENT=true, но настройки небезопасны — сервер не запущен:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
}
const db = openDb(config.dbPath);
const version = migrate(db);
const summary = seed(db, config.seedUsers, config.seedDevices);
const userCount = Number(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n ?? 0);

const app = await buildApp({
  db,
  sessionSecret: config.sessionSecret,
  sessionTtlHours: config.sessionTtlHours,
  logger: true,
  webRoot: config.webRoot,
  backupDir: config.backupDir,
  secureCookies: config.publicDeployment,
  mqtt: config.mqtt.enabled ? { url: config.mqtt.url, username: config.mqtt.username, password: config.mqtt.password } : null,
  trustProxy: config.trustProxy,
});

app.log.info(`БД ${config.dbPath}: схема v${version}, добавлено станций ${summary.stations}, пользователей ${summary.users}`);
if (userCount === 0) app.log.warn('В БД нет пользователей — вход невозможен. Выполните `npm run setup`, затем `npm run db:reset`.');

app.log.info(config.publicDeployment ? 'Режим публичного размещения: cookie только по HTTPS, доверие прокси включено' : 'Локальный режим');

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
