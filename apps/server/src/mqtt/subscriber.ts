// Подписчик QORGAN: MQTT-клиент, который подключается к брокеру служебной учётной записью, подписывается на
// топики датчиков (QoS 1) и передаёт сообщения адаптеру. Если брокер недоступен — сервер работает дальше,
// а клиент переподключается сам каждые 2 с; состояние связи видно в интерфейсе.

import mqtt, { type MqttClient } from 'mqtt';
import type { AdapterResult } from './adapter';
import { SERVER_STATUS_TOPIC, STATUS_SUBSCRIPTION, TELEMETRY_SUBSCRIPTION } from './protocol';

export type MqttLinkState = 'disabled' | 'connecting' | 'connected' | 'offline';

export interface SubscriberOptions {
  url: string;
  username: string;
  password: string;
  /** Постоянный идентификатор клиента (для постоянной сессии у брокера). */
  clientId?: string;
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
    // Постоянная сессия: пока QORGAN перезапускается, брокер копит для него показания (QoS 1) и отдаёт после
    // переподключения. Перезапуск самого брокера сессию теряет — этот случай закрывает статус qorgan/v1/server/status.
    clientId: options.clientId ?? `qorgan-server-${options.username}`,
    reconnectPeriod: 2000,
    connectTimeout: 5000,
    clean: false,
    // Если QORGAN пропадёт, брокер сам сообщит датчикам «offline» — они начнут копить показания.
    will: { topic: SERVER_STATUS_TOPIC, payload: Buffer.from('offline'), qos: 1, retain: true },
  });
  // Сообщения обрабатываются строго по очереди: порядок показаний устройства сохраняется.
  let chain: Promise<unknown> = Promise.resolve();

  client.on('connect', () => {
    client.subscribe([TELEMETRY_SUBSCRIPTION, STATUS_SUBSCRIPTION], { qos: 1 }, (err) => {
      if (err) {
        options.log?.('MQTT: подписка не удалась', err.message);
        return;
      }
      // «online» — только после подтверждения подписки: с этого момента ни одно показание не уйдёт «в пустоту».
      client.publish(SERVER_STATUS_TOPIC, 'online', { qos: 1, retain: true });
      setState('connected');
    });
  });
  client.on('reconnect', () => setState('connecting'));
  client.on('offline', () => setState('offline'));
  client.on('close', () => state === 'connected' && setState('offline'));
  // Пока брокер недоступен, клиент пробует каждые 2 с — в журнал пишем только первую ошибку после потери связи.
  let errorLogged = false;
  client.on('connect', () => {
    errorLogged = false;
  });
  client.on('error', (err) => {
    if (errorLogged) return;
    errorLogged = true;
    options.log?.('MQTT: брокер недоступен, переподключаюсь каждые 2 с', err.message);
  });
  client.on('message', (topic, payload, packet) => {
    chain = chain
      .then(() => options.handle(topic, payload, { retain: packet.retain }))
      .catch((err) => options.log?.('MQTT: ошибка обработки сообщения', String(err)));
  });

  return {
    state: () => state,
    close: async () => {
      // Сообщить «offline» сразу (иначе брокер сделает это по завещанию); остановка не должна зависнуть, если брокер не ответит.
      if (client.connected) {
        await Promise.race([
          new Promise<void>((resolve) => client.publish(SERVER_STATUS_TOPIC, 'offline', { qos: 1, retain: true }, () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 1000)),
        ]);
      }
      await new Promise<void>((resolve) => client.end(true, {}, () => resolve()));
      await chain.catch(() => undefined);
    },
  };
}
