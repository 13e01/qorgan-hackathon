// T4: данные для интерфейса — разделение локальной обстановки и угрозы сверху, раздача собранного интерфейса.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { buildSnapshot } from '../src/realtime/snapshot';
import { testDb } from './helpers';
import { simApp } from './sim-helpers';

const START = '2026-04-10T00:00:00.000Z';

describe('локальная обстановка и угроза сверху (situation)', () => {
  it('RAPID_FLOOD, тик 30: QRG-01 — местная опасность; QRG-02 — MEDIUM из-за угрозы сверху при нормальном уровне', async () => {
    const s = await simApp();
    await s.post('/api/simulation/start', { scenarioId: 'RAPID_FLOOD', seed: 42, virtualStart: START });
    await s.run(31);
    const snap = buildSnapshot(s.db, s.app.simulation, new Date().toISOString());
    const byCode = Object.fromEntries(snap.stations.map((st) => [st.code, st.risk]));

    expect(byCode['QRG-01']).toMatchObject({ risk: 'HIGH', warningCm: 450, dangerCm: 550, situation: { localLevel: 'ABOVE_DANGER', drivers: 'LOCAL', upstream: null } });
    expect(byCode['QRG-02']).toMatchObject({
      risk: 'MEDIUM',
      situation: { localLevel: 'NORMAL', upstream: { stationCode: 'QRG-01', risk: 'HIGH', travelHours: 51 } },
    });
    expect(byCode['QRG-02']!.situation.upstreamPoints).toBe(2);

    // Тот же разбор приходит и в ответах о риске.
    const api = (await s.get('/api/stations/QRG-02/risk', '')).body;
    expect(api.situation).toEqual(byCode['QRG-02']!.situation);
    const exp = (await s.get('/api/stations/QRG-02/risk/explanation', '')).body;
    expect(exp.situation).toEqual(byCode['QRG-02']!.situation);
  });

  it('в снимке — последнее измерение уровня и уровень, по которому сделана оценка', async () => {
    const s = await simApp();
    await s.post('/api/simulation/runs', { scenarioId: 'NORMAL', virtualStart: START, params: { levelNoiseCm: 0, levelDailyAmplitudeCm: 0 } });
    for (let i = 0; i < 5; i += 1) await s.post('/api/simulation/step');
    await s.post('/api/simulation/interventions', { type: 'LEVEL_SHIFT', stationCode: 'QRG-01', value: 100 });
    await s.post('/api/simulation/step');
    const st = buildSnapshot(s.db, s.app.simulation, new Date().toISOString()).stations.find((x) => x.code === 'QRG-01')!;
    // Скачок +100 см ещё не подтверждён: датчик показал 400, оценка T2 пока по 300.
    expect(st.latest.water_level).toMatchObject({ value: 400, quality: 'suspect' });
    expect(st.risk.levelCm).toBe(300);
  });
});

describe('раздача собранного интерфейса', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('index.html на / и на путях интерфейса; API и неизвестные /api — по-прежнему JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qorgan-web-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>QORGAN</title>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    const app = await buildApp({ db: testDb(), sessionSecret: 'x'.repeat(40), sessionTtlHours: 1, webRoot: dir });

    for (const url of ['/', '/stations']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain('<title>QORGAN</title>');
    }
    const asset = await app.inject({ method: 'GET', url: '/app.js' });
    expect([asset.statusCode, asset.body]).toEqual([200, 'console.log(1)']);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().status).toBe('ok');
    const missing = await app.inject({ method: 'GET', url: '/api/nope' });
    expect([missing.statusCode, missing.json().error.code]).toEqual([404, 'NOT_FOUND']);
    await app.close();
  });

  it('пересборка при работающем сервере: новая страница и новые файлы JS сразу, удалённый файл — 404, а не HTML', async () => {
    // Регрессия «чёрного экрана»: сервер помнил index.html со старыми именами файлов, а удалённый JS отдавал как
    // страницу (200 text/html) — браузер отказывался выполнять модуль.
    const dir = mkdtempSync(join(tmpdir(), 'qorgan-web-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'assets'));
    const build = (hash: string) => {
      writeFileSync(join(dir, 'assets', `index-${hash}.js`), `console.log('${hash}')`);
      writeFileSync(join(dir, 'index.html'), `<!doctype html><script type="module" src="/assets/index-${hash}.js"></script>`);
    };
    build('OLD111');
    const app = await buildApp({ db: testDb(), sessionSecret: 'x'.repeat(40), sessionTtlHours: 1, webRoot: dir });
    expect((await app.inject({ method: 'GET', url: '/' })).body).toContain('index-OLD111.js');

    // npm run build: старый файл удалён, новый создан уже после запуска сервера.
    rmSync(join(dir, 'assets', 'index-OLD111.js'));
    build('NEW222');
    for (const url of ['/', '/simulator']) {
      const page = await app.inject({ method: 'GET', url });
      expect(page.statusCode, url).toBe(200);
      expect(page.body, url).toContain('index-NEW222.js');
      expect(page.headers['cache-control'], url).toBe('no-cache');
    }
    const js = await app.inject({ method: 'GET', url: '/assets/index-NEW222.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    const gone = await app.inject({ method: 'GET', url: '/assets/index-OLD111.js' });
    expect(gone.statusCode).toBe(404);
    expect(gone.headers['content-type']).not.toMatch(/text\/html/);
    await app.close();
  });

  it('без собранного интерфейса сервер работает как раньше (только API)', async () => {
    const app = await buildApp({ db: testDb(), sessionSecret: 'x'.repeat(40), sessionTtlHours: 1, webRoot: join(tmpdir(), 'qorgan-no-such-dir') });
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    await app.close();
  });
});
