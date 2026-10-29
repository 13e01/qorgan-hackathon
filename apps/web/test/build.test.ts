// Production-сборка интерфейса: каждый CSS-файл кем-то подключается, а стили карты (maplibre-gl.css) загружаются
// вместе с рабочей системой. Регрессия: файл стилей карты собирался, но ни один модуль на него не ссылался —
// маркеры станций теряли position: absolute, смещались и исчезали при масштабировании.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'qorgan-build-'));
let files: Record<string, string> = {};

beforeAll(async () => {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
  const assets = readdirSync(join(out, 'assets'));
  files = Object.fromEntries([['index.html', readFileSync(join(out, 'index.html'), 'utf8')], ...assets.filter((f) => /\.(css|m?js)$/.test(f)).map((f) => [f, readFileSync(join(out, 'assets', f), 'utf8')])]);
}, 120_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('production-сборка', () => {
  it('каждый CSS-файл подключён страницей или модулем (нет «потерянных» стилей)', () => {
    const css = Object.keys(files).filter((f) => f.endsWith('.css'));
    expect(css.length).toBeGreaterThanOrEqual(3);
    for (const f of css) {
      const users = Object.entries(files).filter(([name, text]) => name !== f && text.includes(f)).map(([name]) => name);
      expect(users, f).not.toHaveLength(0);
    }
  });

  it('стили маркеров карты загружаются вместе с рабочей системой', () => {
    const mapCss = Object.keys(files).find((f) => f.endsWith('.css') && files[f]!.includes('.maplibregl-marker{'));
    expect(mapCss).toBeDefined();
    const entry = Object.keys(files).find((f) => /^index-.*\.js$/.test(f))!;
    const deps = /__vite__mapDeps=[^;]*/.exec(files[entry]!)?.[0] ?? '';
    const app = Object.keys(files).find((f) => /^App-.*\.js$/.test(f))!;
    // Список зависимостей загрузки рабочей системы содержит и её JS, и файл стилей карты.
    expect(deps).toContain(app);
    expect(deps).toContain(mapCss!);
    // Главная страница не тянет карту: в index.html нет ни JS, ни CSS MapLibre.
    expect(files['index.html']).not.toContain('maplibre');
    expect(files['index.html']).not.toContain(mapCss!);
  });
});
