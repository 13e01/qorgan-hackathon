// Локальный MQTT-брокер (Aedes, MQTT 3.1.1/5, MIT) — отдельный процесс, системная установка не нужна.
// Можно заменить на Mosquitto с теми же правилами (docs/PYTHON_SENSOR.md).
//
// Правила доступа:
//   • анонимные подключения запрещены;
//   • QORGAN (служебная учётная запись из .env) — только подписка на топики датчиков;
//   • устройство: логин = deviceId, пароль = токен устройства (сверяется с SHA-256 в БД QORGAN, БД открывается
//     только на чтение); публикует только в qorgan/v1/sensors/{свой deviceId}/telemetry|status, подписаться может
//     только на qorgan/v1/server/status (знать, принимает ли QORGAN данные);
//   • QORGAN публикует только qorgan/v1/server/status;
//   • показания с флагом retain не пропускаются (устаревшие данные не должны «всплывать» у новых подписчиков).

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { Aedes } from 'aedes';
import { parseTopic, SERVER_STATUS_TOPIC, TOPIC_PREFIX } from './protocol';

export interface BrokerOptions {
  /** Служебная учётная запись QORGAN. */
  service: { username: string; password: string };
  /** SHA-256 токена активного устройства по его deviceId; null — устройства нет или оно отключено. */
  deviceTokenHash: (deviceId: string) => string | null;
  log?: (message: string) => void;
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

type Role = { kind: 'service' } | { kind: 'device'; deviceId: string };

export async function createQorganBroker(options: BrokerOptions): Promise<Aedes> {
  const roles = new WeakMap<object, Role>();
  const broker = await Aedes.createBroker({
    authenticate: (client, username, password, done) => {
      const user = username ?? '';
      const pass = password ? password.toString('utf8') : '';
      if (user && pass && user === options.service.username && sameSecret(pass, options.service.password)) {
        roles.set(client, { kind: 'service' });
        return done(null, true);
      }
      const hash = user ? options.deviceTokenHash(user) : null;
      if (hash && pass && timingSafeEqual(sha256(pass), Buffer.from(hash, 'hex'))) {
        roles.set(client, { kind: 'device', deviceId: user });
        options.log?.(`устройство ${user} подключилось`);
        return done(null, true);
      }
      options.log?.(`отказ в подключении: ${user || '(аноним)'}`);
      const err = Object.assign(new Error('Bad username or password'), { returnCode: 4 });
      return done(err as never, false);
    },
    authorizePublish: (client, packet, callback) => {
      const role = client ? roles.get(client) : undefined;
      if (role?.kind === 'service') return callback(packet.topic === SERVER_STATUS_TOPIC ? null : new Error('publish not allowed'));
      const topic = parseTopic(packet.topic);
      if (role?.kind !== 'device' || !topic || topic.deviceId !== role.deviceId) return callback(new Error('publish not allowed'));
      if (topic.kind === 'telemetry' && packet.retain) return callback(new Error('retained telemetry not allowed'));
      return callback(null);
    },
    authorizeSubscribe: (client, subscription, callback) => {
      const role = client ? roles.get(client) : undefined;
      if (role?.kind === 'service' && subscription.topic.startsWith(`${TOPIC_PREFIX}/`)) return callback(null, subscription);
      if (role?.kind === 'device' && subscription.topic === SERVER_STATUS_TOPIC) return callback(null, subscription);
      return callback(new Error('subscribe not allowed'), null);
    },
  });
  return broker;
}

/** Запускает брокер на host:port (по умолчанию только 127.0.0.1 — наружу порт не открывается). */
export async function startBroker(options: BrokerOptions & { host: string; port: number }): Promise<{ server: Server; broker: Aedes; port: number; close: () => Promise<void> }> {
  const broker = await createQorganBroker(options);
  const server = createServer(broker.handle as (socket: unknown) => void);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    server,
    broker,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        broker.close(() => server.close(() => resolve()));
      }),
  };
}
