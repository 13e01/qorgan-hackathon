import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './auth/plugin';
import type { Db } from './db/connection';
import { registerErrorHandlers } from './errors';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';

export interface AppOptions {
  db: Db;
  sessionSecret: string;
  sessionTtlHours: number;
  logger?: boolean;
}

/** Собирает приложение без запуска сервера — так его можно проверять в тестах через `app.inject()`. */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1_048_576 });
  registerErrorHandlers(app);
  await registerAuth(app, options.db, options.sessionSecret);
  await app.register(healthRoutes(options.db));
  await app.register(authRoutes(options.db, options.sessionTtlHours));
  return app;
}
