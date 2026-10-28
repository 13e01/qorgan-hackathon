// `npm run mqtt:broker` — локальный MQTT-брокер для Python-датчика. Слушает только 127.0.0.1:1883.
// Ctrl+C — остановить.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../config';
import { startBroker } from './broker';

const config = loadConfig();
const time = () => new Date().toLocaleTimeString('ru-RU');

if (!config.mqtt.password) {
  console.error('[брокер] В .env нет MQTT_SERVICE_PASSWORD. Выполните `npm run setup` и запустите снова.');
  process.exit(1);
}
if (!existsSync(config.dbPath)) {
  console.error(`[брокер] Нет базы данных ${config.dbPath}. Сначала запустите QORGAN (npm start / npm run dev) или npm run db:reset.`);
  process.exit(1);
}

// База QORGAN открывается только на чтение: брокеру нужны лишь хеши токенов устройств.
const db = new DatabaseSync(config.dbPath, { readOnly: true });

try {
  const { close, port } = await startBroker({
    host: config.mqtt.brokerHost,
    port: config.mqtt.brokerPort,
    service: { username: config.mqtt.username, password: config.mqtt.password },
    deviceTokenHash: (deviceId) => {
      const row = db.prepare("SELECT token_hash FROM devices WHERE device_id = ? AND status = 'active'").get(deviceId);
      return row ? String(row.token_hash) : null;
    },
    log: (m) => console.log(`[брокер ${time()}] ${m}`),
  });
  console.log(`[брокер ${time()}] MQTT-брокер QORGAN работает: mqtt://${config.mqtt.brokerHost}:${port} (только этот компьютер). Ctrl+C — остановить.`);
  const shutdown = async () => {
    await close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  console.error(code === 'EADDRINUSE' ? `[брокер] Порт ${config.mqtt.brokerPort} занят — брокер уже запущен в другом окне?` : `[брокер] Не удалось запустить: ${String(err)}`);
  db.close();
  process.exit(1);
}
