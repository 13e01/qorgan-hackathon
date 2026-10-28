import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './auth/plugin';
import type { Db } from './db/connection';
import { registerErrorHandlers } from './errors';
import { RealtimeHub } from './realtime/hub';
import { buildSnapshot } from './realtime/snapshot';
import { adminRoutes } from './routes/admin';
import { alertRoutes } from './routes/alerts';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
import { outlookRoutes } from './routes/outlook';
import { riskRoutes } from './routes/risk';
import { simulationRoutes } from './routes/simulation';
import { stationRoutes } from './routes/stations';
import { telemetryRoutes } from './routes/telemetry';
import { realScheduler, SimulationRunner, type Scheduler } from './simulation/runner';

export interface AppOptions {
  db: Db;
  sessionSecret: string;
  sessionTtlHours: number;
  logger?: boolean;
  /** Планировщик тиков; в тестах — ручной, чтобы не ждать реального времени. */
  scheduler?: Scheduler;
  /** Источник реального времени (единственный в приложении). */
  now?: () => Date;
  /** Папка собранного интерфейса (apps/web/dist). Если в ней есть index.html — сервер раздаёт интерфейс на том же порту. */
  webRoot?: string;
  /** Папка резервных копий для кнопки администратора (POST /api/admin/backup). */
  backupDir?: string;
  /** Cookie сессии только по HTTPS (публичное размещение за прокси с TLS). */
  secureCookies?: boolean;
  /** Сервер стоит за обратным прокси: брать IP клиента из X-Forwarded-For. */
  trustProxy?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    simulation: SimulationRunner;
    realtime: RealtimeHub;
  }
}

/**
 * Доверять только ближайшему узлу (обратному прокси Caddy): IP клиента — адрес, который прокси видел сам.
 * `true` доверял бы любой цепочке X-Forwarded-For — подделав заголовок, можно было бы обойти ограничение попыток входа.
 */
const trustOneHop = (_address: string, hop: number) => hop < 1;

/** Собирает приложение без запуска сервера — так его можно проверять в тестах через `app.inject()`. */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1_048_576, trustProxy: options.trustProxy ? trustOneHop : false });
  const indexFile = options.webRoot ? join(options.webRoot, 'index.html') : null;
  const spaIndexHtml = indexFile && existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : undefined;
  registerErrorHandlers(app, { spaIndexHtml });
  await registerAuth(app, db, options.sessionSecret);
  await app.register(websocket);

  // Токен встроенного симулятора: случайный на каждый запуск, только в памяти процесса.
  const simulatorToken = randomBytes(32).toString('hex');
  let hub: RealtimeHub;

  const runner = new SimulationRunner({
    db,
    scheduler: options.scheduler ?? realScheduler,
    now,
    // Симулятор передаёт данные через тот же HTTP-маршрут, что и внешние устройства (в процессе, без сети).
    deliver: async (batch) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/telemetry',
        headers: { 'x-device-token': simulatorToken },
        payload: batch,
      });
      return { ok: res.statusCode === 200, status: res.statusCode, body: res.json() };
    },
    onChange: (event) => {
      if (event.type === 'state') hub.broadcastSnapshot({ type: 'state' });
    },
    logError: (message, details) => app.log.error({ details }, message),
  });
  runner.recover();
  hub = new RealtimeHub(() => buildSnapshot(db, runner, now().toISOString()));

  app.decorate('simulation', runner);
  app.decorate('realtime', hub);
  app.addHook('onClose', async () => {
    runner.close();
    await runner.idle();
    hub.closeAll();
  });

  await app.register(healthRoutes(db));
  await app.register(authRoutes(db, options.sessionTtlHours, { secureCookies: options.secureCookies ?? false, now }));
  await app.register(stationRoutes(db, now));
  await app.register(riskRoutes(db, now));
  await app.register(simulationRoutes(db, runner, now));
  await app.register(alertRoutes(db, now, () => hub.broadcastSnapshot({ type: 'alert' })));
  await app.register(adminRoutes(db, now, () => hub.broadcastSnapshot({ type: 'admin' }), { backupDir: options.backupDir }));
  await app.register(outlookRoutes(db, now));
  await app.register(telemetryRoutes(db, simulatorToken, now, () => hub.broadcastSnapshot({ type: 'telemetry' })));
  await app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (socket) => hub.add(socket));
  });
  if (spaIndexHtml && options.webRoot) {
    await app.register(fastifyStatic, { root: options.webRoot, index: false, wildcard: false });
    app.get('/', (_request, reply) => reply.type('text/html; charset=utf-8').send(spaIndexHtml));
  }
  return app;
}
