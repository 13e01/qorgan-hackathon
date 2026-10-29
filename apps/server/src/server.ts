// Точка входа backend: настройки → БД (миграции + начальные данные) → HTTP-сервер.

import { buildApp } from './app';
import { loadConfig, publicDeploymentProblems } from './config';
import { migrate, openDb } from './db/connection';
import { seed } from './db/seed';
import { loadMlRuntime } from './ml/service';

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

const ml = loadMlRuntime(config.mlModelPath);
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
  ml,
  telegram: config.telegram,
});

app.log.info(`БД ${config.dbPath}: схема v${version}, добавлено станций ${summary.stations}, пользователей ${summary.users}`);
if (userCount === 0) app.log.warn('В БД нет пользователей — вход невозможен. Выполните `npm run setup`, затем `npm run db:reset`.');

app.log.info(
  ml.status === 'READY'
    ? `ML Sentinel: модель ${ml.model?.modelVersion} загружена (учебная, параллельная оценка)`
    : `ML Sentinel: ${ml.status}${ml.problem ? ` (${ml.problem})` : ''} — работает основная оценка риска`,
);
app.log.info(config.telegram ? `Telegram-бот: включён${config.telegram.allowedChatIds ? ' (список разрешённых чатов)' : ''}` : 'Telegram-бот: выключен (нет TELEGRAM_BOT_TOKEN)');
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
