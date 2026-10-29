// Разведка экранов перед раскадровкой: снимки настоящих страниц на изолированном стенде.
//   node production/system-briefing/tools/explore.mjs <папка-для-снимков>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchEdge, sleep, waitFor } from './cdp.mjs';
import { startStand } from './stand.mjs';

const out = process.argv[2] ?? 'explore-shots';
mkdirSync(out, { recursive: true });
const sensorLog = [];
const stand = await startStand({ onSensorLine: (l) => sensorLog.push(l) });
const { page, close } = await launchEdge();
try {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await page.navigate(stand.url + '/');
  const login = await page.eval(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({ username: stand.env.SEED_OPERATOR_USERNAME, password: stand.env.SEED_OPERATOR_PASSWORD })})}).then(r=>r.status)`);
  console.log('login', login);
  const shot = async (name) => { await sleep(1500); writeFileSync(join(out, name + '.png'), await page.screenshot()); console.log('shot', name); };
  await page.navigate(stand.url + '/');
  await sleep(2500);
  await shot('01-welcome');
  for (const [hash, name] of [['#/dashboard', '02-dashboard'], ['#/stations', '03-stations'], ['#/outlook', '04-outlook'], ['#/simulator', '05-simulator'], ['#/alerts', '06-alerts']]) {
    await page.eval(`location.hash='${hash}'`);
    await shot(name);
  }
  // Режим внешних датчиков: как кнопка «Начать новый чистый прогон».
  const ext = await page.eval(`fetch('/api/simulation/external/start',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(async r=>r.status+' '+(await r.text()).slice(0,300))`);
  console.log('external', ext);
  await page.eval(`location.hash='#/dashboard'`);
  await sleep(6000);
  stand.sensorKey('D');
  for (let i = 0; i < 6; i++) { await sleep(8000); await shot(`07-danger-${i}`); }
  await page.eval(`location.hash='#/alerts'`);
  await shot('08-alerts-after');
  await page.eval(`location.hash='#/stations'`);
  await shot('09-stations-after');
  await page.eval(`location.hash='#/simulator'`);
  await shot('10-sim-after');
  writeFileSync(join(out, 'sensor.log'), sensorLog.join('\n'));
} finally {
  await close();
  await stand.stop();
}
