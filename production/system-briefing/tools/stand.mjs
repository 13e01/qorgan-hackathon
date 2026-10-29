// Изолированный стенд QORGAN для съёмки: свой порт, свой брокер, своя база.
// Рабочую базу пользователя (data/qorgan.db) и порты 3000/1883 не трогает.
// Секреты генерируются случайно при каждом запуске и живут только в памяти процессов.
//
//   node production/system-briefing/tools/stand.mjs        — запустить стенд и ждать Ctrl+C
//   import { startStand } from './stand.mjs'               — из скрипта съёмки

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const PORT = Number(process.env.BRIEFING_PORT ?? 3210);
export const MQTT_PORT = Number(process.env.BRIEFING_MQTT_PORT ?? 1994);
export const DB_REL = 'data/briefing-capture.db';

const secret = () => randomBytes(24).toString('hex');

/** Учебные учётные данные стенда: случайные, в git и в кадр не попадают. */
export function makeStandEnv() {
  return {
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DB_PATH: DB_REL,
    BACKUP_DIR: 'data/briefing-backups',
    SESSION_SECRET: randomBytes(32).toString('hex'),
    SEED_OPERATOR_USERNAME: 'operator',
    SEED_OPERATOR_PASSWORD: secret(),
    SEED_ADMIN_USERNAME: 'admin',
    SEED_ADMIN_PASSWORD: secret(),
    MQTT_PORT: String(MQTT_PORT),
    MQTT_SERVICE_USERNAME: 'qorgan-server',
    MQTT_SERVICE_PASSWORD: secret(),
    SENSOR_DEVICE_ID: 'PY-SENSOR-01',
    SENSOR_STATION: 'QRG-03',
    SENSOR_TOKEN: secret(),
  };
}

function pythonExe() {
  const venvs = [
    resolve(ROOT, 'sensors/python/.venv/Scripts/python.exe'),
    // В git-worktree своего venv нет: используем venv основной папки проекта (только запуск, без изменений).
    resolve(ROOT, '../../../sensors/python/.venv/Scripts/python.exe'),
  ];
  return venvs.find((p) => existsSync(p)) ?? 'py';
}

async function waitHealth(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`QORGAN не ответил на :${PORT}`);
}

function run(name, cmd, args, env, { onLine, stdin = 'ignore' } = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: [stdin, 'pipe', 'pipe'], windowsHide: true });
  const feed = (buf) => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      onLine?.(line);
      if (process.env.BRIEFING_VERBOSE) console.log(`[${name}] ${line}`);
    }
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  return child;
}

/**
 * Запускает сервер (с чистой базой), брокер и Python-датчик.
 * onSensorLine получает каждую строку вывода датчика — для честной вставки «окна датчика» в монтаж.
 */
export async function startStand({ onSensorLine, sensorArgs = [] } = {}) {
  const env = makeStandEnv();
  mkdirSync(resolve(ROOT, 'data'), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) rmSync(resolve(ROOT, DB_REL + suffix), { force: true });

  const tsx = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs');
  const server = run('server', process.execPath, [tsx, 'apps/server/src/server.ts'], env);
  await waitHealth();
  const broker = run('broker', process.execPath, [tsx, 'apps/server/src/mqtt/broker-cli.ts'], env);
  await new Promise((r) => setTimeout(r, 2500));
  const sensor = run(
    'sensor',
    pythonExe(),
    ['-u', 'sensors/python/sensor.py', '--host', '127.0.0.1', '--port', String(MQTT_PORT), '--env', resolve(ROOT, 'data/.no-env'),
      '--device-id', env.SENSOR_DEVICE_ID, '--station', env.SENSOR_STATION, '--token', env.SENSOR_TOKEN, ...sensorArgs],
    { PYTHONIOENCODING: 'utf-8' },
    { onLine: onSensorLine, stdin: 'pipe' },
  );

  const stop = async () => {
    try { sensor.stdin.write('Q\n'); } catch {}
    await new Promise((r) => setTimeout(r, 800));
    for (const c of [sensor, broker, server]) if (c.exitCode === null) c.kill();
  };
  /** Команда датчику, как буква + Enter в его окне. */
  const sensorKey = (key) => sensor.stdin.write(`${key}\n`);
  return { env, url: `http://127.0.0.1:${PORT}`, stop, sensorKey };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.env.BRIEFING_VERBOSE ??= '1';
  const stand = await startStand();
  console.log(`Стенд готов: ${stand.url} (оператор: ${stand.env.SEED_OPERATOR_USERNAME}; пароль сгенерирован и не печатается)`);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { const k = d.trim().toUpperCase(); if (k) stand.sensorKey(k); });
  process.on('SIGINT', async () => { await stand.stop(); process.exit(0); });
}
