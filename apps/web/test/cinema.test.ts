// Прототипы главной страницы (Eclipse Cinematic): маршруты не задевают рабочее приложение, геометрия реки строится
// из OSM и координат станций, цепочка станций и сумма добегания — из данных, тексты есть на трёх языках.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '../src/components/Shell';
import { DICTIONARIES } from '../src/i18n';
import { ru } from '../src/i18n/ru';
import { conceptHash, conceptRoute, CONCEPT_IDS, dms, riverAxis, riverChain, smoothPath, sweepRiver, totalTravelHours } from '../src/lib/cinema';
import type { RiverFlow } from '../src/lib/flow';
import river from '../src/map/esil-river.json';

// Координаты станций — как в начальных данных сервера (apps/server/src/db/seed.ts).
const STATIONS = [
  { code: 'QRG-01', lat: 53.8809, lon: 67.4335, upstreamCode: null },
  { code: 'QRG-02', lat: 54.3484, lon: 68.4465, upstreamCode: 'QRG-01' },
  { code: 'QRG-03', lat: 54.8825, lon: 69.1172, upstreamCode: 'QRG-02' },
  { code: 'QRG-04', lat: 55.1165, lon: 69.2103, upstreamCode: 'QRG-03' },
];

describe('маршруты прототипов', () => {
  it('#/concepts — выбор, #/concepts/a|b|c — прототипы', () => {
    expect(conceptRoute('#/concepts')).toEqual({ view: 'gallery' });
    expect(conceptRoute('#/concepts/')).toEqual({ view: 'gallery' });
    for (const id of CONCEPT_IDS) {
      expect(conceptRoute(conceptHash(id))).toEqual({ view: 'concept', id });
      expect(conceptRoute(`${conceptHash(id)}?still`)).toEqual({ view: 'concept', id });
    }
  });

  it('все прежние адреса остаются за рабочим приложением', () => {
    for (const h of ['', '#', '#/', '#/dashboard', '#/alerts', '#/concepts/d', '#/concepts/a/b', '#/conceptsx']) expect(conceptRoute(h), h).toBeNull();
    for (const r of ROUTES) expect(conceptRoute(`#/${r}`), r).toBeNull();
    expect(ROUTES as readonly string[]).not.toContain('concepts');
    // Главная страница по умолчанию не поменялась: пустой адрес по-прежнему открывает главную панель.
    expect(ROUTES[0]).toBe('dashboard');
  });
});

describe('геометрия реки', () => {
  it('ось течения: верхняя станция в начале (u ≈ 0), нижняя в конце (u ≈ 1), линии направлены по течению', () => {
    const axis = riverAxis(river, STATIONS);
    const u = Object.fromEntries(axis.stations.map((s) => [s.code, s.u]));
    expect(u['QRG-01']).toBeCloseTo(0, 6);
    expect(u['QRG-04']).toBeCloseTo(1, 6);
    expect(u['QRG-01']!).toBeLessThan(u['QRG-02']!);
    expect(u['QRG-02']!).toBeLessThan(u['QRG-03']!);
    expect(axis.lines.length).toBeGreaterThan(0);
    for (const l of axis.lines) expect(l[0]!.u).toBeLessThanOrEqual(l[l.length - 1]!.u);
  });

  it('без станций (ещё не загружены) река всё равно рисуется — ось по самой южной и северной точкам', () => {
    const axis = riverAxis(river, []);
    expect(axis.stations).toEqual([]);
    expect(axis.lines.flat().length).toBeGreaterThan(100);
    expect(riverAxis({ features: [] }, [])).toEqual({ lines: [], stations: [] });
  });

  it('кадр: в широком — река в правой части (слева текст), в портретном — в верхней', () => {
    const axis = riverAxis(river, STATIONS);
    const wide = sweepRiver(axis, 1600, 900, false);
    const tall = sweepRiver(axis, 900, 1600, true);
    for (const s of wide.stations) expect(s.x, s.code).toBeGreaterThan(1600 * 0.4);
    for (const s of tall.stations) expect(s.y, s.code).toBeLessThan(1600 * 0.45);
    // Исток ниже устья: река течёт «вверх» по кадру.
    expect(wide.stations[0]!.y).toBeGreaterThan(wide.stations[3]!.y);
  });

  it('плавная линия: одна кривая Безье на каждый отрезок, без NaN', () => {
    const d = smoothPath([
      { x: 0, y: 0 },
      { x: 10, y: 5 },
      { x: 20, y: 0 },
    ]);
    expect(d.startsWith('M0 0')).toBe(true);
    expect(d.match(/C/g)).toHaveLength(2);
    expect(d).not.toContain('NaN');
    expect(smoothPath([{ x: 1, y: 1 }])).toBe('');
  });

  it('подпись координат', () => {
    expect(dms(53.8809, 'N', 'S')).toBe('53°53′ N');
    expect(dms(69.2103, 'E', 'W')).toBe('69°13′ E');
    expect(dms(54.9999, 'N', 'S')).toBe('55°00′ N');
  });
});

describe('цепочка станций', () => {
  const node = (code: string) => ({ code, name: code }) as RiverFlow['nodes'][number];
  const flow: RiverFlow = {
    nodes: ['A', 'B', 'C'].map(node),
    links: [
      { from: 'A', to: 'B', travelHours: 51, state: 'calm', risk: null },
      { from: 'B', to: 'C', travelHours: 17, state: 'threat', risk: 'HIGH' },
    ],
    hasThreat: true,
  };

  it('у каждой станции — связь с нижней соседкой, у последней — нет', () => {
    const chain = riverChain(flow);
    expect(chain.map((c) => c.link?.to ?? null)).toEqual(['B', 'C', null]);
    expect(chain[1]!.link!.state).toBe('threat');
  });

  it('сумма добегания — из данных; нет времени — null, а не 0', () => {
    expect(totalTravelHours(flow)).toBe(68);
    expect(totalTravelHours({ ...flow, links: flow.links.map((l) => ({ ...l, travelHours: null })) })).toBeNull();
    expect(totalTravelHours({ ...flow, links: [] })).toBeNull();
  });
});

describe('тексты и движение', () => {
  it('все строки прототипов переведены на kk и en, слоган не скопирован с русского', () => {
    const keys = (Object.keys(ru) as Array<keyof typeof ru>).filter((k) => k.startsWith('cine.'));
    expect(keys.length).toBeGreaterThan(50);
    for (const lang of ['kk', 'en'] as const) for (const k of keys) expect(DICTIONARIES[lang][k], `${lang}:${k}`).toBeTruthy();
    expect(DICTIONARIES.kk['cine.slogan.full']).not.toBe(ru['cine.slogan.full']);
    expect(DICTIONARIES.en['cine.cta.demo']).toBe('Watch the demo');
  });

  it('общие правила «меньше движения» не ломают прототипы: внутри .cine движением управляет сама страница', () => {
    const css = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    for (const f of ['styles.css', 'eclipse.css']) {
      const block = css(f).split('@media (prefers-reduced-motion: reduce)').slice(1).join('');
      expect(block, f).toContain(':not(.cine *)');
    }
    // В режиме «без анимации» скрытое до анимации получает конечный вид.
    const c = css('concepts/concepts.css');
    expect(c).toMatch(/\.cine\[data-still\] \.mask-in/);
    expect(c).toMatch(/\.cine\[data-still\] \.noir-bar/);
  });
});
