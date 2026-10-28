import { randomBytes } from 'node:crypto';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './auth/plugin';
import type { Db } from './db/connection';
import { registerErrorHandlers } from './errors';
import { RealtimeHub } from './realtime/hub';
import { buildSnapshot } from './realtime/snapshot';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
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
}

declare module 'fastify' {
  interface FastifyInstance {
    simulation: SimulationRunner;
    realtime: RealtimeHub;
  }
}

/** Собирает приложение без запуска сервера — так его можно проверять в тестах через `app.inject()`. */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1_048_576 });
  registerErrorHandlers(app);
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
  await app.register(authRoutes(db, options.sessionTtlHours));
  await app.register(stationRoutes(db, now));
  await app.register(riskRoutes(db, now));
  await app.register(simulationRoutes(db, runner, now));
  await app.register(telemetryRoutes(db, simulatorToken, now, () => hub.broadcastSnapshot({ type: 'telemetry' })));
  await app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (socket) => hub.add(socket));
  });
  return app;
}
