// `npm run demo:wave` — наглядная проверка T3 без браузера и без ручных HTTP-запросов.
//
// Запускает приложение в этом же процессе с ОТДЕЛЬНОЙ демо-базой data/demo-wave.db (рабочая БД не трогается),
// создаёт временного оператора со случайным паролем (живёт только в памяти), запускает сценарий через API
// и печатает, как волна проходит станции и как меняется риск. Данные учебные (симулятор).
//
// Параметры: npm run demo:wave -- [RAPID_FLOOD|GRADUAL_FLOOD|NORMAL] [мс_на_тик]

import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCENARIO_IDS, type ScenarioId } from '@qorgan/shared';
import { buildApp } from '../app';
import { ROOT_DIR } from '../config';
import { migrate, openDb } from '../db/connection';
import { seed } from '../db/seed';

const scenarioArg = (process.argv[2] ?? 'RAPID_FLOOD').toUpperCase();
if (!(SCENARIO_IDS as readonly string[]).includes(scenarioArg)) {
  console.error(`Неизвестный сценарий ${scenarioArg}. Доступны: ${SCENARIO_IDS.join(', ')}`);
  process.exit(1);
}
const scenarioId = scenarioArg as ScenarioId;
const tickMs = Math.min(1000, Math.max(50, Number(process.argv[3] ?? 60)));

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };
const RISK_COLOR: Record<string, string> = { LOW: C.green, MEDIUM: C.yellow, HIGH: C.red };
const KZ = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const kz = (iso: string) => `${KZ.format(new Date(iso))}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dbPath = resolve(ROOT_DIR, 'data/demo-wave.db');
for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
const db = openDb(dbPath);
migrate(db);
const password = randomBytes(18).toString('base64url');
seed(db, [{ username: 'demo-operator', password, role: 'operator' }]);

const app = await buildApp({ db, sessionSecret: randomBytes(32).toString('hex'), sessionTtlHours: 1 });
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'demo-operator', password } });
const cookieEntry = login.cookies.find((c) => c.name === 'qorgan_sid');
if (!cookieEntry) throw new Error('не удалось войти демо-оператором');
const cookie = `${cookieEntry.name}=${cookieEntry.value}`;
const api = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as object } : {}) });
  return res.json();
};

console.log(`${C.bold}QORGAN — демонстрация паводковой волны (T3)${C.reset}`);
console.log(`${C.dim}Учебная модель, данные симулятора. Демо-база: ${dbPath}${C.reset}`);
const started = await api('POST', '/api/simulation/start', { scenarioId, seed: 42, tickMs });
if (started.error) throw new Error(started.error.message);
const run = started.run;
console.log(`Сценарий ${C.cyan}${scenarioId}${C.reset}, прогон #${run.id}, seed 42, ${run.totalTicks} виртуальных часов.`);
console.log(`Скорость: 1 виртуальный час = ${tickMs} мс (ускорение ×${run.acceleration}). Время ниже — виртуальное, по Казахстану (UTC+5).`);
console.log('');

const header = ['Вирт. время', 'QRG-01 Сергеевка', 'QRG-02 Явленка', 'QRG-03 Петропавл', 'QRG-04 Соколовка'];
console.log(C.bold + header.map((h, i) => h.padEnd(i === 0 ? 13 : 19)).join('') + C.reset);

const firstSeen: Record<string, { MEDIUM?: string; HIGH?: string; peak: number }> = {};
let lastPrinted = -1;
let pausedShown = false;

const printRow = async () => {
  const snap = await api('GET', '/api/stations');
  void snap;
  const state = await api('GET', '/api/simulation/state');
  const t = state.run?.currentTick;
  if (t === null || t === undefined || t === lastPrinted) return state;
  lastPrinted = t;
  const cells: string[] = [];
  for (const code of ['QRG-01', 'QRG-02', 'QRG-03', 'QRG-04']) {
    const r = await api('GET', `/api/stations/${code}/risk`);
    const lvl = r.level.currentCm;
    const entry = (firstSeen[code] ??= { peak: 0 });
    entry.peak = Math.max(entry.peak, lvl ?? 0);
    if (r.risk !== 'LOW' && !entry[r.risk as 'MEDIUM' | 'HIGH']) entry[r.risk as 'MEDIUM' | 'HIGH'] = r.asOf;
    if (r.risk === 'HIGH' && !entry.MEDIUM) entry.MEDIUM = r.asOf;
    const text = `${String(lvl ?? '—').padStart(6)} см ${r.risk.padEnd(6)}`;
    cells.push(RISK_COLOR[r.risk] + text.padEnd(19) + C.reset);
  }
  if (t % 6 === 0) console.log(kz(state.run.virtualTime).padEnd(13) + cells.join(''));
  return state;
};

for (;;) {
  const state = await printRow();
  if (state.state === 'COMPLETED' || state.state === 'STOPPED') break;
  if (!pausedShown && (state.run?.currentTick ?? 0) >= 60) {
    pausedShown = true;
    const p = await api('POST', '/api/simulation/pause');
    console.log(`${C.cyan}— Пауза на 2 реальные секунды: виртуальное время ${kz(p.run.virtualTime)}${C.reset}`);
    await sleep(2000);
    const s2 = await api('GET', '/api/simulation/state');
    console.log(`${C.cyan}— После паузы виртуальное время ${kz(s2.run.virtualTime)} (не изменилось). Продолжаем.${C.reset}`);
    await api('POST', '/api/simulation/resume');
  }
  await sleep(Math.max(20, tickMs / 3));
}

const details = await api('GET', `/api/simulation/runs/${run.id}`);
console.log('');
console.log(`${C.bold}Итог${C.reset}`);
for (const code of ['QRG-01', 'QRG-02', 'QRG-03', 'QRG-04']) {
  const e = firstSeen[code];
  console.log(
    `  ${code}: максимум ${e?.peak ?? '—'} см; первый MEDIUM ${e?.MEDIUM ? kz(e.MEDIUM) : '—'}; первый HIGH ${e?.HIGH ? kz(e.HIGH) : '—'}`,
  );
}
const highs = ['QRG-01', 'QRG-02', 'QRG-03', 'QRG-04'].map((c) => firstSeen[c]?.HIGH).filter(Boolean) as string[];
const ordered = highs.every((t, i) => i === 0 || t > highs[i - 1]!);
console.log(`  Записано измерений: ${details.counts.measurements}, оценок риска: ${details.counts.assessments}`);
if (scenarioId === 'RAPID_FLOOD') {
  console.log(
    highs.length === 4 && ordered
      ? `${C.green}  ✓ Волна дошла до всех 4 станций по порядку течения реки.${C.reset}`
      : `${C.red}  ✗ Ожидалось, что все 4 станции по очереди дойдут до HIGH.${C.reset}`,
  );
}
await app.close();
db.close();
