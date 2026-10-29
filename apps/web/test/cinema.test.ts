// Главная страница Hydro Future: маршруты не задевают рабочую систему, геометрия реки строится из OSM и координат
// станций, цепочка станций и шкала «Пути волны» — только из данных, тексты есть на трёх языках.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '../src/components/Shell';
import { DICTIONARIES } from '../src/i18n';
import { ru } from '../src/i18n/ru';
import { chaikin, DASHBOARD_HASH, focusStation, isLegacyConceptHash, isWelcomeHash, riverAxis, riverChain, smoothPath, totalTravelHours, waveTimeline, WELCOME_HASH } from '../src/lib/cinema';
import type { RiverFlow } from '../src/lib/flow';
import river from '../src/map/esil-river.json';

// Координаты станций — как в начальных данных сервера (apps/server/src/db/seed.ts).
const STATIONS = [
  { code: 'QRG-01', lat: 53.8809, lon: 67.4335, upstreamCode: null },
  { code: 'QRG-02', lat: 54.3484, lon: 68.4465, upstreamCode: 'QRG-01' },
  { code: 'QRG-03', lat: 54.8825, lon: 69.1172, upstreamCode: 'QRG-02' },
  { code: 'QRG-04', lat: 55.1165, lon: 69.2103, upstreamCode: 'QRG-03' },
];

describe('маршруты', () => {
  it('главная — пустой адрес, «#/» и «#/welcome»; старые адреса прототипов тоже ведут на главную', () => {
    for (const h of ['', '#', '#/', '#/welcome', '#/?x=1', WELCOME_HASH, '#/concepts', '#/concepts/', '#/concepts/a', '#/concepts/b', '#/concepts/c']) expect(isWelcomeHash(h), h).toBe(true);
    expect(isLegacyConceptHash('#/concepts/b')).toBe(true);
    expect(isLegacyConceptHash('#/')).toBe(false);
  });

  it('все разделы рабочей системы остаются за ней', () => {
    for (const r of ROUTES) expect(isWelcomeHash(`#/${r}`), r).toBe(false);
    expect(isWelcomeHash(DASHBOARD_HASH)).toBe(false);
    expect(isWelcomeHash('#/conceptsx')).toBe(false);
    expect(ROUTES as readonly string[]).not.toContain('welcome');
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

  it('сглаживание русла: концы на месте, точек больше, зубцы ниже, без NaN', () => {
    const pts = [
      { u: 0, w: 0 },
      { u: 0.5, w: 0.2 },
      { u: 1, w: 0 },
    ];
    const s = chaikin(pts, 2);
    expect(s[0]).toEqual({ u: 0, w: 0 });
    expect(s[s.length - 1]).toEqual({ u: 1, w: 0 });
    expect(s.length).toBeGreaterThan(pts.length);
    expect(Math.max(...s.map((p) => p.w))).toBeLessThan(0.2);
    expect(s.some((p) => Number.isNaN(p.u) || Number.isNaN(p.w))).toBe(false);
    expect(chaikin(pts.slice(0, 2), 3)).toHaveLength(2);
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

describe('«Путь волны» и станция для рассказа', () => {
  type Node = RiverFlow['nodes'][number];
  const node = (code: string, risk: Node['risk'], levelCm: number | null, gauge: number | null = null) => ({ code, name: code, risk, levelCm, gauge }) as Node;
  const links = (states: Array<'calm' | 'threat' | 'arrived'>, hours: Array<number | null> = [51, 51, 17]): RiverFlow['links'] =>
    states.map((state, i) => ({ from: 'ABCD'[i]!, to: 'ABCD'[i + 1]!, travelHours: hours[i]!, state, risk: state === 'calm' ? null : 'HIGH' }));

  it('станции на шкале — по накопленному времени добегания из БД', () => {
    const tl = waveTimeline({ nodes: ['A', 'B', 'C', 'D'].map((c) => node(c, 'LOW', 300)), links: links(['calm', 'calm', 'calm']), hasThreat: false });
    expect(tl.totalHours).toBe(119);
    expect(tl.stops.map((s) => s.hoursFromHead)).toEqual([0, 51, 102, 119]);
    expect(tl.stops[0]!.at).toBe(0);
    expect(tl.stops[3]!.at).toBe(1);
    expect(tl.stops[2]!.at).toBeCloseTo(102 / 119, 6);
    expect(tl.threat).toBeNull();
  });

  it('нет времени добегания — равные шаги и «—», а не выдуманные часы', () => {
    const tl = waveTimeline({ nodes: ['A', 'B', 'C'].map((c) => node(c, 'LOW', null)), links: links(['calm', 'calm'], [51, null]), hasThreat: false });
    expect(tl.totalHours).toBeNull();
    expect(tl.stops.map((s) => s.at)).toEqual([0, 0.5, 1]);
    expect(tl.stops.every((s) => s.hoursFromHead === null)).toBe(true);
    expect(waveTimeline({ nodes: [], links: [], hasThreat: false })).toEqual({ stops: [], totalHours: null, threat: null });
  });

  it('угроза — самая верхняя неспокойная связь из снимка; «дошла» — если подъём у нижней подтверждён', () => {
    const nodes = ['A', 'B', 'C', 'D'].map((c) => node(c, 'LOW', 300));
    expect(waveTimeline({ nodes, links: links(['calm', 'threat', 'threat']), hasThreat: true }).threat).toEqual({ from: 'B', to: 'C', risk: 'HIGH', travelHours: 51, arrived: false });
    expect(waveTimeline({ nodes, links: links(['arrived', 'calm', 'calm']), hasThreat: true }).threat).toMatchObject({ from: 'A', to: 'B', arrived: true });
  });

  it('станция для «Как работает»: самая тревожная, при равенстве — ближе к порогу; без данных — null', () => {
    expect(focusStation({ nodes: [node('A', 'LOW', 300, 0.4), node('B', 'HIGH', 560, 0.9), node('C', 'MEDIUM', 320, 0.5)], links: [], hasThreat: true })!.code).toBe('B');
    expect(focusStation({ nodes: [node('A', 'LOW', 300, 0.4), node('B', 'LOW', 330, 0.6)], links: [], hasThreat: false })!.code).toBe('B');
    expect(focusStation({ nodes: [node('A', 'NO_DATA', null), node('B', 'NO_DATA', null)], links: [], hasThreat: false })).toBeNull();
  });
});

describe('тексты и стили', () => {
  const css = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

  it('все строки главной переведены на kk и en, слоган не скопирован с русского, строк прототипов нет', () => {
    const keys = (Object.keys(ru) as Array<keyof typeof ru>).filter((k) => k.startsWith('cine.'));
    expect(keys.length).toBeGreaterThan(70);
    for (const lang of ['kk', 'en'] as const) for (const k of keys) expect(DICTIONARIES[lang][k], `${lang}:${k}`).toBeTruthy();
    expect(DICTIONARIES.kk['cine.slogan.full']).not.toBe(ru['cine.slogan.full']);
    expect(DICTIONARIES.en['cine.cta.demo']).toBe('Watch the demo');
    expect(keys.some((k) => k.startsWith('cine.proto.'))).toBe(false);
  });

  it('общие правила «меньше движения» не трогают главную: внутри .cine движением управляет сама страница', () => {
    for (const f of ['styles.css', 'eclipse.css']) {
      const block = css(f).split('@media (prefers-reduced-motion: reduce)').slice(1).join('');
      expect(block, f).toContain(':not(.cine *)');
    }
    // Без движения скрытое до анимации получает конечный вид, бесконечные эффекты скрыты.
    const c = css('welcome/welcome.css');
    expect(c).toContain('.cine[data-still] .reveal');
    expect(c).toContain('.cine[data-still] .hf-track-pulse');
  });

  it('стили главной не задевают рабочую систему: общие имена классов — только внутри .cine', () => {
    // Класс .reveal есть и в eclipse.css (главная панель): без «.cine» перед ним панель становилась невидимой.
    const c = css('welcome/welcome.css');
    for (const cls of ['reveal', 'words', 'qmark', 'full-menu']) expect(c, cls).not.toMatch(new RegExp(`^\\.${cls}\\b`, 'm'));
    expect(c).toContain('.cine .reveal {');
  });
});
