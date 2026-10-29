// Разведка экранов в СВЕТЛОЙ теме: тема включается настоящим щелчком по кнопке «Светлая» в шапке,
// затем проверяются data-theme и цвет фона, снимаются все разделы и учебный подъём воды от Python-датчика.
//   node production/system-briefing/tools/explore-light.mjs <папка-для-снимков>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchEdge, sleep, waitFor } from './cdp.mjs';
import { startStand } from './stand.mjs';

const out = process.argv[2] ?? 'explore-light';
mkdirSync(out, { recursive: true });
const stand = await startStand();
const { page, close } = await launchEdge({ port: 9361 });
const shot = async (name, wait = 1500) => { await sleep(wait); writeFileSync(join(out, name + '.png'), await page.screenshot()); console.log('shot', name); };
const report = {};
try {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }, { name: 'prefers-color-scheme', value: 'dark' }] });
  await page.navigate(stand.url + '/');
  await page.eval(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({ username: stand.env.SEED_OPERATOR_USERNAME, password: stand.env.SEED_OPERATOR_PASSWORD })})}).then(r=>r.status)`);
  await page.eval("location.hash = '#/dashboard'");
  await waitFor(page, `!!document.querySelector('.marker .m-name')`);
  report.before = await page.eval(`({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor })`);
  await shot('00-dashboard-before');
  // Настоящий щелчок мышью по кнопке «Светлая».
  const btn = await page.eval(`(() => { const b = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.title || '').includes('Светлая') && b.getBoundingClientRect().width > 0); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: b.getAttribute('aria-label') || b.title }; })()`);
  report.button = btn;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
  await sleep(800);
  report.after = await page.eval(`({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, stored: Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])) })`);
  await shot('01-dashboard-light');
  for (const [hash, name] of [['#/stations', '02-stations'], ['#/outlook', '03-outlook'], ['#/simulator', '04-simulator'], ['#/alerts', '05-alerts']]) {
    await page.eval(`location.hash='${hash}'`);
    await shot(name);
  }
  await page.eval(`location.hash='#/'`);
  await shot('06-welcome-after-light', 2500);
  report.welcome = await page.eval(`({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.querySelector('.hf') || document.body).backgroundColor })`);
  // Учебный подъём воды
  await page.eval(`fetch('/api/simulation/external/start',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status)`);
  await page.eval(`location.hash='#/dashboard'`);
  await sleep(7000);
  await shot('07-dashboard-normal', 0);
  stand.sensorKey('D');
  for (const s of [10, 20, 30]) { await sleep(10000); await shot(`08-rise-${s}s`, 0); }
  await page.eval(`location.hash='#/stations'`);
  await shot('09-stations-rise');
  await page.eval(`location.hash='#/alerts'`);
  await shot('10-alerts-rise');
  await page.eval(`location.hash='#/outlook'`);
  await shot('11-outlook-rise');
  await page.eval(`location.hash='#/'`);
  await shot('12-welcome-rise', 2500);
} finally {
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
  await close();
  await stand.stop();
}
