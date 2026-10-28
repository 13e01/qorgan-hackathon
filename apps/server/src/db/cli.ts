// Команды обслуживания БД: `npm run db:reset`, `npm run db:backup`, `npm run db:fixture`.

import { existsSync, rmSync } from 'node:fs';
import { loadConfig } from '../config';
import { backupDb } from './backup';
import { migrate, openDb } from './connection';
import { insertFixture } from './fixture';
import { seed } from './seed';

const command = process.argv[2];
const config = loadConfig();

if (command === 'reset') {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = config.dbPath + suffix;
    if (existsSync(file)) rmSync(file);
  }
  const db = openDb(config.dbPath);
  const version = migrate(db);
  const summary = seed(db, config.seedUsers, config.seedDevices);
  db.close();
  console.log(`БД пересоздана: ${config.dbPath}`);
  console.log(`Схема v${version}; показателей: ${summary.parameters}, станций: ${summary.stations}, пользователей: ${summary.users}`);
  if (summary.users === 0) console.warn('Пользователи не созданы: задайте SEED_*_PASSWORD в .env (`npm run setup`).');
} else if (command === 'backup') {
  if (!existsSync(config.dbPath)) {
    console.error(`Файл БД не найден: ${config.dbPath}`);
    process.exit(1);
  }
  const db = openDb(config.dbPath);
  const file = backupDb(db, config.backupDir);
  db.close();
  console.log(`Резервная копия: ${file}`);
} else if (command === 'fixture') {
  const db = openDb(config.dbPath);
  migrate(db);
  seed(db, config.seedUsers, config.seedDevices);
  const runId = insertFixture(db);
  db.close();
  console.log(`Проверочные данные (TEST_FIXTURE, не симулятор) записаны в прогон #${runId}.`);
  console.log('Ожидается: QRG-01 HIGH, QRG-02 MEDIUM, QRG-03 LOW, QRG-04 MEDIUM.');
} else {
  console.error('Использование: tsx src/db/cli.ts reset|backup|fixture');
  process.exit(1);
}
