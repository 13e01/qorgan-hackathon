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
import { createSensorAdapter } from './mqtt/adapter';
import { startMqttSubscriber, type MqttLinkState } from './mqtt/subscriber';
import { buildSnapshot } from './realtime/snapshot';
import { alertSummary } from './alerts/repository';
import { latestMl, ML_DISABLED, type MlRuntime } from './ml/service';
import { createEvaluator } from './risk/service';
import { mlRoutes } from './routes/ml';
import { telegramRoutes } from './routes/telegram';
import { enqueueAlertNotifications } from './telegram/outbox';
import { TelegramService, type BotStatusData, type TelegramOptions } from './telegram/service';
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
  /** Подписчик MQTT для внешних датчиков; не задан — MQTT выключен (тесты, сервер без брокера). */
  mqtt?: { url: string; username: string; password: string } | null;
  /** QORGAN Sentinel: загруженная модель (loadMlRuntime). Не задано — ML выключена, всё остальное работает. */
  ml?: MlRuntime;
  /** Telegram-бот; null / не задано — выключен (нет токена). */
  telegram?: TelegramOptions | null;
  /** Планировщик циклов бота; в тестах — ручной. */
  telegramScheduler?: Scheduler;
}

declare module 'fastify' {
  interface FastifyInstance {
    simulation: SimulationRunner;
    realtime: RealtimeHub;
    sensorAdapter: ReturnType<typeof createSensorAdapter>;
    telegram: TelegramService;
    ml: MlRuntime;
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
  // index.html читается при каждом запросе (файл маленький): после новой сборки (`npm run build`) уже работающий
  // сервер сразу отдаёт страницу с новыми именами файлов JS. Раньше он запоминал её при старте и ссылался на
  // удалённые файлы — в браузере был чёрный экран.
  const indexFile = options.webRoot ? join(options.webRoot, 'index.html') : null;
  const spaIndexHtml = () => {
    if (!indexFile) return undefined;
    try {
      return readFileSync(indexFile, 'utf8');
    } catch {
      return undefined;
    }
  };
  registerErrorHandlers(app, { spaIndexHtml });
  await registerAuth(app, db, options.sessionSecret);
  await app.register(websocket);

  // Токены встроенного симулятора и MQTT-адаптера: случайные на каждый запуск, только в памяти процесса.
  const simulatorToken = randomBytes(32).toString('hex');
  const mqttAdapterToken = randomBytes(32).toString('hex');
  let mqttState: MqttLinkState = 'disabled';
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
  const ml = options.ml ?? ML_DISABLED;
  hub = new RealtimeHub(() => buildSnapshot(db, runner, now().toISOString(), mqttState, ml));

  // Данные для команд бота: те же публичные данные, что видит гость (текущий прогон, один момент asOf).
  const botStatus = (): BotStatusData => {
    const evaluator = createEvaluator(db, { computedAt: now().toISOString() });
    const ctx = evaluator.context();
    const alerts = alertSummary(db).active;
    return {
      mode: ctx.mode,
      virtualTime: ctx.virtualTime,
      ml: { status: ml.status, version: ml.model?.modelVersion ?? null },
      stations: evaluator.evaluateAll().map(({ station, assessment: a }) => ({
        code: station.code,
        name: station.name,
        levelCm: a.level.currentCm,
        risk: a.risk,
        mlCategory: evaluator.runId === null ? null : (latestMl(db, evaluator.runId, station.id, evaluator.asOf)?.category ?? null),
      })),
      alerts: alerts.map((x) => ({ stationName: x.stationName, severity: x.severity, openedAt: x.openedAt })),
    };
  };
  const telegram = new TelegramService(
    { db, scheduler: options.telegramScheduler ?? realScheduler, now, statusData: botStatus, log: (message, details) => app.log.warn({ details }, message) },
    options.telegram ?? null,
  );
  app.decorate('telegram', telegram);
  app.decorate('ml', ml);

  // Изменения состояния устройств (отклонённые сообщения, online/offline) — не чаще двух снимков в секунду.
  let deviceTimer: ReturnType<typeof setTimeout> | null = null;
  const deviceChanged = () => {
    if (deviceTimer) return;
    deviceTimer = setTimeout(() => {
      deviceTimer = null;
      hub.broadcastSnapshot({ type: 'device' });
    }, 500);
  };
  // MQTT-адаптер передаёт показания датчиков через тот же POST /api/telemetry (в процессе, без сети).
  const sensorAdapter = createSensorAdapter({
    db,
    now,
    deliver: async (body) => {
      const res = await app.inject({ method: 'POST', url: '/api/telemetry', headers: { 'x-device-token': mqttAdapterToken }, payload: body as object });
      return { status: res.statusCode, body: res.json() };
    },
    onDeviceChange: deviceChanged,
  });
  app.decorate('sensorAdapter', sensorAdapter);

  app.decorate('simulation', runner);
  app.decorate('realtime', hub);
  const subscriber = options.mqtt
    ? startMqttSubscriber({
        ...options.mqtt,
        handle: (topic, payload, packet) => sensorAdapter.handle(topic, payload, packet),
        onStateChange: (state) => {
          mqttState = state;
          app.log.info(`MQTT: ${state}`);
          hub.broadcastSnapshot({ type: 'mqtt' });
        },
        log: (message, details) => app.log.warn({ details }, message),
      })
    : null;
  if (subscriber) mqttState = subscriber.state();

  app.addHook('onClose', async () => {
    telegram.close();
    await subscriber?.close();
    if (deviceTimer) clearTimeout(deviceTimer);
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
  await app.register(mlRoutes(db, now, () => ml));
  await app.register(telegramRoutes(db, now, telegram));
  await app.register(
    telemetryRoutes(
      db,
      simulatorToken,
      now,
      () => {
        hub.broadcastSnapshot({ type: 'telemetry' });
        telegram.kick();
      },
      mqttAdapterToken,
      {
        ml,
        afterAlerts: telegram.enabled
          ? ({ runId, tick, changes, evaluations, now: at }) =>
              void enqueueAlertNotifications(db, runId, tick, changes, evaluations, at, { allowedChatIds: telegram.allowedChatIds, cooldownTicks: telegram.cooldownTicks })
          : undefined,
        onExtensionError: (where, err) => app.log.error({ err }, `Sentinel: ошибка ${where === 'ml' ? 'оценки ML' : 'очереди уведомлений'} (пакет принят)`),
      },
    ),
  );
  await app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (socket) => hub.add(socket));
  });
  if (options.webRoot && existsSync(options.webRoot)) {
    // wildcard: файл ищется на диске при каждом запросе, а не по списку, составленному при старте (новые файлы
    // сборки тоже отдаются). Нет файла — обработчик «не найдено» выше: страница для путей интерфейса, 404 для файлов.
    await app.register(fastifyStatic, { root: options.webRoot, index: false, wildcard: true });
    app.get('/', (_request, reply) => {
      const html = spaIndexHtml();
      if (!html) return reply.callNotFound();
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(html);
    });
  }
  telegram.start();
  return app;
}
