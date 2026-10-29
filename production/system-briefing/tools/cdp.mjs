// Минимальный клиент Chrome DevTools Protocol для Microsoft Edge (уже установлен в Windows).
// Без зависимостей: WebSocket и fetch встроены в Node 24.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

export async function launchEdge({ width = 1920, height = 1080, dsf = 1, port = 9333, headless = true } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'qorgan-briefing-edge-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-features=Translate,msEdgeSidebarV2,msHubApps',
    '--hide-scrollbars', `--force-device-scale-factor=${dsf}`, '--lang=ru-RU',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling',
    '--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files',
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];
  const proc = spawn(EDGE, args, { stdio: 'ignore', windowsHide: true });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) throw new Error('Edge не запустился с CDP');
  const page = await connect(target.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile: false });
  const close = async () => {
    try { await page.send('Browser.close'); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    if (proc.exitCode === null) proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };
  return { page, close };
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`)) : resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    }
  };
  const page = {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    }),
    on: (method, fn) => {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(fn);
      return () => listeners.get(method).delete(fn);
    },
    /** Выполнить выражение в странице и вернуть значение. */
    eval: async (expression) => {
      const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    },
    navigate: async (url) => {
      const loaded = new Promise((res) => { const off = page.on('Page.loadEventFired', () => { off(); res(); }); });
      await page.send('Page.navigate', { url });
      await loaded;
    },
    screenshot: async (opts = {}) => Buffer.from((await page.send('Page.captureScreenshot', { format: 'png', ...opts })).data, 'base64'),
    close: () => ws.close(),
  };
  return page;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ждать, пока выражение в странице не станет истинным. */
export async function waitFor(page, expression, timeoutMs = 20_000, stepMs = 100) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if (await page.eval(expression)) return true; } catch {}
    await sleep(stepMs);
  }
  throw new Error(`waitFor timeout: ${expression}`);
}
