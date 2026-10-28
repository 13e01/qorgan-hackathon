// `npm run setup`: создаёт .env из .env.example и подставляет случайный SESSION_SECRET.
// Существующий .env не перезаписывается.

import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, '.env');

if (existsSync(target)) {
  console.log('.env уже существует — ничего не меняю.');
} else {
  copyFileSync(resolve(root, '.env.example'), target);
  const secret = randomBytes(32).toString('hex');
  writeFileSync(target, readFileSync(target, 'utf8').replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${secret}`));
  console.log('Создан .env со случайным SESSION_SECRET. Демо-учётные записи — в .env (SEED_*).');
}
