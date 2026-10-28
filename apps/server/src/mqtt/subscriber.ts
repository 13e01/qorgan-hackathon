// Подписчик QORGAN: MQTT-клиент, который подключается к брокеру служебной учётной записью, подписывается на
// топики датчиков (QoS 1) и передаёт сообщения адаптеру. Если брокер недоступен — сервер работает дальше,
// а клиент переподключается сам каждые 2 с; состояние связи видно в интерфейсе.

import mqtt, { type MqttClient } from 'mqtt';
import type { AdapterResult } from './adapter';
import { STATUS_SUBSCRIPTION, TELEMETRY_SUBSCRIPTION } from './protocol';

export type MqttLinkState = 'disabled' | 'connecting' | 'connected' | 'offline';

export interface SubscriberOptions {
  url: string;
  username: string;
  password: string;
  handle: (topic: string, payload: Buffer, packet: { retain?: boolean }) => Promise<AdapterResult>;
  onStateChange?: (state: MqttLinkState) => void;
  log?: (message: string, details?: unknown) => void;
}

export function startMqttSubscriber(options: SubscriberOptions): { state: () => MqttLinkState; close: () => Promise<void> } {
  let state: MqttLinkState = 'connecting';
  const setState = (next: MqttLinkState) => {
    if (next === state) return;
    state = next;
    options.onStateChange?.(next);
  };
  const client: MqttClient = mqtt.connect(options.url, {
    username: options.username,
    password: options.password,
    clientId: `qorgan-server-${process.pid}`,
    reconnectPeriod: 2000,
    connectTimeout: 5000,
    clean: true,
  });
  // Сообщения обрабатываются строго по очереди: порядок показаний устройства сохраняется.
  let chain: Promise<unknown> = Promise.resolve();

  client.on('connect', () => {
    client.subscribe([TELEMETRY_SUBSCRIPTION, STATUS_SUBSCRIPTION], { qos: 1 }, (err) => {
      if (err) options.log?.('MQTT: подписка не удалась', err.message);
      else setState('connected');
    });
  });
  client.on('reconnect', () => setState('connecting'));
  client.on('offline', () => setState('offline'));
  client.on('close', () => state === 'connected' && setState('offline'));
  client.on('error', (err) => options.log?.('MQTT: ошибка соединения', err.message));
  client.on('message', (topic, payload, packet) => {
    chain = chain
      .then(() => options.handle(topic, payload, { retain: packet.retain }))
      .catch((err) => options.log?.('MQTT: ошибка обработки сообщения', String(err)));
  });

  return {
    state: () => state,
    close: async () => {
      await new Promise<void>((resolve) => client.end(true, {}, () => resolve()));
      await chain.catch(() => undefined);
    },
  };
}
