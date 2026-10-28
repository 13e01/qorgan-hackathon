// `npm run setup`: создаёт .env из .env.example и подставляет случайные секреты.
// Если .env уже есть — ничего не перезаписывает, только добавляет недостающие ключи (например, после обновления проекта).

import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, '.env');
const example = readFileSync(resolve(root, '.env.example'), 'utf8');
const secret = () => randomBytes(24).toString('hex');
// Ключи, значения которых генерируются случайно (вместо replace-me).
const RANDOM = new Set(['SESSION_SECRET', 'MQTT_SERVICE_PASSWORD', 'SENSOR_TOKEN']);

const fill = (line) => {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!m || !RANDOM.has(m[1])) return line;
  return `${m[1]}=${m[1] === 'SESSION_SECRET' ? randomBytes(32).toString('hex') : secret()}`;
};

if (!existsSync(target)) {
  copyFileSync(resolve(root, '.env.example'), target);
  writeFileSync(target, readFileSync(target, 'utf8').split(/\r?\n/).map(fill).join('\n'));
  console.log('Создан .env со случайными секретами. Демо-учётные записи — в .env (SEED_*).');
} else {
  const current = readFileSync(target, 'utf8');
  const have = new Set(current.split(/\r?\n/).map((l) => /^([A-Z0-9_]+)=/.exec(l)?.[1]).filter(Boolean));
  const missing = example.split(/\r?\n/).filter((l) => {
    const key = /^([A-Z0-9_]+)=/.exec(l)?.[1];
    return key && !have.has(key);
  });
  if (missing.length === 0) console.log('.env уже существует и содержит все ключи — ничего не меняю.');
  else {
    writeFileSync(target, `${current.replace(/\s*$/, '')}\n\n# Добавлено npm run setup\n${missing.map(fill).join('\n')}\n`);
    console.log(`.env дополнен ключами: ${missing.map((l) => l.split('=')[0]).join(', ')}`);
  }
}
