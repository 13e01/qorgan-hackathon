// Съёмка настоящего QORGAN для ролика System Briefing.
//
//   node production/system-briefing/tools/capture.mjs [имя-дубля]
//
// Что делает:
//  1. поднимает изолированный стенд (stand.mjs): сервер :3210, брокер :1994, чистая база data/briefing-capture.db;
//  2. запускает Edge без окна (headless) 1920×1080 с плотностью 1.5 — кадры 2880×1620, чтобы крупные планы были резкими;
//  3. входит оператором через настоящий /api/auth/login (пароль случайный, в кадр не попадает);
//  4. включает приём внешних датчиков (как кнопка «Начать новый чистый прогон») — дальше данные идут только от Python-датчика;
//  5. записывает экран (CDP screencast) и выполняет сценарий настоящими событиями мыши и клавиатуры;
//  6. сохраняет кадры (frames/*.jpg), их время (frames.json) и журнал (events.json): курсор, клики, метки сцен,
//     строки вывода датчика и показания станции на экране.
// Ничего в интерфейсе не подменяется: значения на экране считает сервер QORGAN.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchEdge, sleep, waitFor } from './cdp.mjs';
import { ROOT, startStand } from './stand.mjs';

const TAKE = process.argv[2] ?? 'take1';
const DIR = resolve(ROOT, 'production/system-briefing/capture', TAKE);
const FRAMES = join(DIR, 'frames');
const DSF = 1.5;
const W = 1920;
const H = 1080;

rmSync(DIR, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const now = () => Date.now() / 1000;
const events = [];
const log = (type, data = {}) => events.push({ t: now(), type, ...data });

const stand = await startStand({ onSensorLine: (line) => log('sensor', { line }) });
const { page, close } = await launchEdge({ width: W, height: H, dsf: DSF });

// ── Запись экрана ──────────────────────────────────────────────────────────────────────────────────
const frames = [];
let lastSaved = 0;
page.on('Page.screencastFrame', (p) => {
  page.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  const ts = p.metadata.timestamp;
  if (ts - lastSaved < 1 / 61) return; // не чаще 60 кадров/с — больше монтажу не нужно
  lastSaved = ts;
  const file = `${String(frames.length).padStart(5, '0')}.jpg`;
  writeFileSync(join(FRAMES, file), Buffer.from(p.data, 'base64'));
  frames.push({ ts, file });
});
const startRec = () => page.send('Page.startScreencast', { format: 'jpeg', quality: 93, everyNthFrame: 1, maxWidth: W * DSF, maxHeight: H * DSF });

// ── Мышь: плавное движение настоящими событиями (кривая Безье, ease-in-out) ─────────────────────
let cursor = { x: W / 2, y: H / 2 };
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
async function moveTo(x, y, ms = 700) {
  const from = { ...cursor };
  const dx = x - from.x;
  const dy = y - from.y;
  // Лёгкая дуга: контрольная точка смещена перпендикулярно пути — так двигается рука, а не робот.
  const c = { x: from.x + dx * 0.5 - dy * 0.12, y: from.y + dy * 0.5 + dx * 0.12 };
  const steps = Math.max(8, Math.round(ms / 16));
  const t0 = Date.now();
  for (let i = 1; i <= steps; i++) {
    const u = ease(i / steps);
    const px = (1 - u) ** 2 * from.x + 2 * (1 - u) * u * c.x + u * u * x;
    const py = (1 - u) ** 2 * from.y + 2 * (1 - u) * u * c.y + u * u * y;
    cursor = { x: px, y: py };
    log('cursor', { x: px, y: py });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
    const wait = t0 + (ms * i) / steps - Date.now();
    if (wait > 0) await sleep(wait);
  }
}
async function click(label) {
  log('click', { x: cursor.x, y: cursor.y, label });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cursor.x, y: cursor.y, button: 'left', clickCount: 1 });
  await sleep(70);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cursor.x, y: cursor.y, button: 'left', clickCount: 1 });
}
/** Центр элемента, найденного выражением в странице (CSS-пиксели). */
async function centerOf(expr) {
  await waitFor(page, `!!(${expr})`, 20_000);
  return page.eval(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
}
const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim().startsWith(${JSON.stringify(text)}) && e.getBoundingClientRect().width > 0)`;
async function typeText(text, perCharMs = 42) {
  for (const ch of text) {
    await page.send('Input.insertText', { text: ch });
    log('key', { ch });
    await sleep(perCharMs + (ch === ' ' ? 40 : 0));
  }
}
const mark = (name, extra = {}) => { log('mark', { name, ...extra }); console.log(`[${(now() - T0).toFixed(1)}s] ${name}`); };

// ── Показания на экране: что видно у Петропавловска (метка карты) ───────────────────────────────────
let watching = false;
async function watchStation() {
  watching = true;
  let last = '';
  while (watching) {
    try {
      const s = await page.eval(`(() => { const m = [...document.querySelectorAll('.marker')].find(e => e.querySelector('.m-name')?.textContent === 'Петропавловск'); return m ? m.querySelector('.m-level').textContent + '|' + m.querySelector('.m-risk').textContent + '|' + m.className : ''; })()`);
      if (s && s !== last) { last = s; log('station', { value: s }); }
    } catch {}
    await sleep(150);
  }
}

let T0 = now();
try {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }, { name: 'prefers-color-scheme', value: 'dark' }] });
  await page.navigate(stand.url + '/');
  const status = await page.eval(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({ username: stand.env.SEED_OPERATOR_USERNAME, password: stand.env.SEED_OPERATOR_PASSWORD })})}).then(r=>r.status)`);
  if (status !== 200) throw new Error(`вход оператора: ${status}`);
  // Тот же запрос, что делает кнопка «Начать новый чистый прогон» в разделе «Внешние датчики».
  const ext = await page.eval(`fetch('/api/simulation/external/start',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status)`);
  if (ext !== 200) throw new Error(`приём датчиков: ${ext}`);
  // Светлая тема рабочей системы — настоящим щелчком по кнопке «Светлая» в шапке (до начала записи).
  // Hydro Future остаётся тёмной при любой теме.
  await page.navigate(stand.url + '/');
  await page.eval(`location.hash = '#/dashboard'`);
  await waitFor(page, `!!document.querySelector('.marker .m-name')`);
  const light = await centerOf(`[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.title || '').includes('Светлая') && b.getBoundingClientRect().width > 0)`);
  await moveTo(light.x, light.y, 300);
  await click('theme-light');
  await waitFor(page, `document.documentElement.dataset.theme === 'light'`);
  log('theme', await page.eval(`({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, stored: localStorage.getItem('qorgan.theme') })`));
  // Датчик успевает передать несколько обычных показаний (≈3,2 м), чтобы у станции был уровень до подъёма.
  await sleep(9000);
  // Щелчок по теме был до записи — в журнал монтажа он не нужен.
  events.splice(0, events.length, ...events.filter((e) => e.type === 'sensor' || e.type === 'theme'));
  cursor = { x: W / 2, y: H / 2 };

  await page.navigate(stand.url + '/');
  await waitFor(page, `!!document.querySelector('.hf-ctas .hf-btn.primary')`);
  await sleep(2500);
  T0 = now();
  await startRec();
  void watchStation();
  mark('welcome');
  await sleep(8000);

  const open = await centerOf(`document.querySelector('.hf-ctas .hf-btn.primary')`);
  await moveTo(open.x, open.y, 1100);
  await sleep(350);
  await click('open-system');
  mark('open-system');
  await waitFor(page, `location.hash === '#/dashboard' && !!document.querySelector('.marker .m-name')`);
  await sleep(3500);
  mark('dashboard');

  const marker = await centerOf(`[...document.querySelectorAll('.marker')].find(e => e.querySelector('.m-name')?.textContent === 'Петропавловск').querySelector('.m-pin')`);
  await moveTo(marker.x, marker.y, 1000);
  await sleep(300);
  await click('station-petropavlovsk');
  mark('select-station', { x: marker.x, y: marker.y });
  await sleep(3500);

  const panel = await centerOf(byText('h2', 'Внешние датчики'));
  await moveTo(panel.x - 40, panel.y + 160, 1000);
  mark('sensor-panel', { x: panel.x, y: panel.y });
  await sleep(4000);

  mark('danger-command');
  stand.sensorKey('D');
  // Ждём, пока станция не станет «Высокий» и не появится предупреждение (по экрану, не по API).
  await waitFor(page, `[...document.querySelectorAll('.marker')].some(e => e.querySelector('.m-name')?.textContent === 'Петропавловск' && e.className.includes('r-HIGH'))`, 120_000, 200);
  mark('station-high');
  await sleep(5000);
  mark('rise-done');

  const nav = await centerOf(byText('nav a, aside a, .sidebar a', 'Предупреждения'));
  await moveTo(nav.x, nav.y, 1000);
  await sleep(250);
  await click('nav-alerts');
  await waitFor(page, `location.hash.startsWith('#/alerts') && !!document.querySelector('.alert-card')`);
  mark('alerts');
  await sleep(3000);

  const card = `[...document.querySelectorAll('.alert-card')].find(c => c.textContent.includes('Петропавловск'))`;
  const view = await centerOf(`[...(${card}).querySelectorAll('.alert-actions button')].find(b => b.textContent.includes('Просмотрено'))`);
  await moveTo(view.x, view.y, 1000);
  await sleep(250);
  await click('alert-view');
  mark('alert-viewed', { x: view.x, y: view.y });
  await sleep(1800);

  const resolve_ = await centerOf(`[...(${card}).querySelectorAll('.alert-actions button')].find(b => b.textContent.includes('Обработать'))`);
  await moveTo(resolve_.x, resolve_.y, 700);
  await sleep(200);
  await click('alert-resolve');
  await waitFor(page, `!!(${card}).querySelector('.alert-resolve input')`);
  mark('resolve-form');
  await sleep(500);
  await typeText('Дежурная служба оповещена');
  await sleep(500);
  const confirm = await centerOf(`(${card}).querySelector('.alert-resolve button[type=submit]')`);
  await moveTo(confirm.x, confirm.y, 700);
  await sleep(200);
  await click('alert-confirm');
  mark('resolved');
  // После обработки карточка уходит из «Требуют внимания», внизу — подтверждение «Отмечено как обработанное».
  await sleep(3500);

  const home = await centerOf(`document.querySelector('.brand-home')`);
  await moveTo(home.x, home.y, 1100);
  await sleep(250);
  await click('brand-home');
  await waitFor(page, `!!document.querySelector('.hf-ctas .hf-btn.primary')`);
  await moveTo(W - 60, H - 40, 600);
  mark('finale');
  await sleep(7000);
  mark('end');
  await page.send('Page.stopScreencast');
} finally {
  watching = false;
  await sleep(300);
  writeFileSync(join(DIR, 'frames.json'), JSON.stringify({ dsf: DSF, width: W, height: H, t0: T0, frames }, null, 0));
  writeFileSync(join(DIR, 'events.json'), JSON.stringify({ t0: T0, events }, null, 1));
  await close();
  await stand.stop();
  console.log(`кадров: ${frames.length}, событий: ${events.length} → ${DIR}`);
}
