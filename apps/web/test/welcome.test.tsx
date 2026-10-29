// Главная страница Hydro Future: жизненный цикл сцены на Canvas (один цикл кадров, пауза, очистка), отложенная
// демонстрация после входа, разметка страницы на трёх языках, режим без движения, меню, пустые и живые данные.
// Сцена проверяется на поддельном «хосте кадров» — без браузера и реальных ожиданий.

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Snapshot, SnapshotStation, StationMeta } from '../src/api/types';
import { I18nProvider } from '../src/i18n';
import type { Lang } from '../src/lib/format';
import { riverAxis } from '../src/lib/cinema';
import { riverFlow } from '../src/lib/flow';
import river from '../src/map/esil-river.json';
import { DemoProvider } from '../src/state/demo';
import { StoreProvider } from '../src/state/store';
import { WelcomeApp } from '../src/welcome';
import { SECTIONS } from '../src/welcome/HydroFuture';
import { dprFor, FRAME_MS, MAX_PARTS, partsFor, RiverScene, type FrameHost } from '../src/welcome/RiverScene';
import { HowSection, WaveSection } from '../src/welcome/sections';
import { demoAfterLogin, FullMenu, StillProvider, type useRiverLive } from '../src/welcome/shared';

// ── Поддельные холст и хост кадров ────────────────────────────────────────────────────────────────────────

/** 2D-контекст, у которого любой метод — пустышка (градиенты и measureText возвращают нужную форму). */
function fakeContext() {
  const calls = { drawImage: 0, clearRect: 0 };
  const special: Record<string, unknown> = {
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    measureText: (s: string) => ({ width: s.length * 6 }),
    drawImage: () => void calls.drawImage++,
    clearRect: () => void calls.clearRect++,
  };
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, p) => (p in t ? t[p] : p in special ? special[p as string] : () => undefined),
    set: (t, p, v) => ((t[p] = v), true),
  });
  return { ctx, calls };
}

function fakeCanvas(w = 1280, h = 720) {
  const { ctx, calls } = fakeContext();
  const canvas = { clientWidth: w, clientHeight: h, width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { canvas, calls };
}

function fakeHost() {
  let seq = 0;
  let t = 0;
  const queue = new Map<number, (now: number) => void>();
  const state = { hidden: false, visibilityCb: null as null | (() => void), removed: false };
  const host: FrameHost = {
    request: (cb) => (queue.set(++seq, cb), seq),
    cancel: (id) => void queue.delete(id),
    now: () => t,
    dpr: () => 3,
    hidden: () => state.hidden,
    createLayer: () => fakeCanvas().canvas,
    onVisibility: (cb) => {
      state.visibilityCb = cb;
      return () => void (state.removed = true);
    },
  };
  /** Прокрутить «экран» с частотой hz в течение ms: вызываются только запрошенные кадры. */
  const run = (ms: number, hz = 60) => {
    const step = 1000 / hz;
    for (let k = 0; k < ms / step; k++) {
      t += step;
      const cbs = [...queue.values()];
      queue.clear();
      for (const cb of cbs) cb(t);
    }
  };
  return { host, queue, state, run };
}

const STATIONS = [
  { code: 'QRG-01', lat: 53.8809, lon: 67.4335, upstreamCode: null },
  { code: 'QRG-02', lat: 54.3484, lon: 68.4465, upstreamCode: 'QRG-01' },
  { code: 'QRG-03', lat: 54.8825, lon: 69.1172, upstreamCode: 'QRG-02' },
  { code: 'QRG-04', lat: 55.1165, lon: 69.2103, upstreamCode: 'QRG-03' },
];
const AXIS = riverAxis(river, STATIONS);

describe('сцена реки (RiverScene): цикл кадров', () => {
  it('движение разрешено и сцена в кадре — ровно один запрошенный кадр, повторные вызовы его не удваивают', () => {
    const { host, queue, run } = fakeHost();
    const scene = new RiverScene(fakeCanvas().canvas, AXIS, host);
    scene.resize();
    expect(queue.size).toBe(0); // без разрешения движения цикла нет
    scene.setMotion(true);
    scene.setMotion(true);
    scene.setVisible(true);
    scene.resize();
    expect(queue.size).toBe(1);
    run(1000);
    expect(queue.size).toBe(1);
    expect(scene.running).toBe(true);
  });

  it('на мониторе 240 Гц сцена рисует не больше ≈ 60 кадров в секунду', () => {
    const { host, run } = fakeHost();
    const scene = new RiverScene(fakeCanvas().canvas, AXIS, host);
    scene.resize();
    scene.setMotion(true);
    const before = scene.frames;
    run(1000, 240);
    const drawn = scene.frames - before;
    expect(drawn).toBeGreaterThan(50);
    expect(drawn).toBeLessThanOrEqual(Math.ceil(1000 / FRAME_MS) + 1);
  });

  it('без движения (prefers-reduced-motion) — цикл остановлен, нарисован один статичный кадр', () => {
    const { host, queue, run } = fakeHost();
    const scene = new RiverScene(fakeCanvas().canvas, AXIS, host);
    scene.resize();
    scene.setMotion(true);
    run(200);
    const before = scene.frames;
    scene.setMotion(false);
    expect(queue.size).toBe(0);
    expect(scene.running).toBe(false);
    expect(scene.frames).toBe(before + 1);
    run(1000);
    expect(scene.frames).toBe(before + 1);
  });

  it('сцена вне экрана или вкладка скрыта — цикл стоит; вернулись — идёт снова', () => {
    const { host, queue, state } = fakeHost();
    const scene = new RiverScene(fakeCanvas().canvas, AXIS, host);
    scene.resize();
    scene.setMotion(true);
    scene.setVisible(false);
    expect(queue.size).toBe(0);
    scene.setVisible(true);
    expect(queue.size).toBe(1);
    state.hidden = true;
    state.visibilityCb!();
    expect(queue.size).toBe(0);
    state.hidden = false;
    state.visibilityCb!();
    expect(queue.size).toBe(1);
  });

  it('размонтирование: кадр отменён, подписка на видимость снята, дальше ничего не запускается', () => {
    const { host, queue, state, run } = fakeHost();
    const scene = new RiverScene(fakeCanvas().canvas, AXIS, host);
    scene.resize();
    scene.setMotion(true);
    scene.destroy();
    expect(queue.size).toBe(0);
    expect(state.removed).toBe(true);
    scene.setMotion(true);
    scene.resize();
    run(500);
    expect(queue.size).toBe(0);
    expect(scene.running).toBe(false);
  });

  it('без линии реки цикл не запускается; размер холста учитывает ограничение плотности пикселей', () => {
    const { host, queue } = fakeHost();
    const empty = new RiverScene(fakeCanvas().canvas, { lines: [], stations: [] }, host);
    empty.resize();
    empty.setMotion(true);
    expect(queue.size).toBe(0);
    const { canvas } = fakeCanvas(1000, 500);
    new RiverScene(canvas, AXIS, fakeHost().host).resize();
    expect(canvas.width).toBe(2000); // устройство даёт 3×, сцена берёт не больше 2×
  });

  it('число частиц ограничено, плотность пикселей — не выше 2 (на огромном холсте 1,5)', () => {
    expect(partsFor(10, 10)).toBe(120);
    expect(partsFor(10_000, 10_000)).toBe(MAX_PARTS);
    expect(dprFor(3, 1000, 600)).toBe(2);
    expect(dprFor(3, 2560, 1440)).toBe(1.5);
    expect(dprFor(1, 1000, 600)).toBe(1);
  });
});

describe('«Смотреть демонстрацию» без входа', () => {
  it('после входа демонстрация начинается сама; окно закрыли без входа — просьба забывается', () => {
    expect(demoAfterLogin(false, true, false)).toBe('idle');
    expect(demoAfterLogin(true, false, true)).toBe('wait');
    expect(demoAfterLogin(true, true, false)).toBe('start');
    expect(demoAfterLogin(true, false, false)).toBe('drop');
  });
});

// ── Разметка страницы (серверный рендер, без браузера) ─────────────────────────────────────────────────────

const g = globalThis as Record<string, unknown>;
function setEnv({ lang = 'ru', reduce = false }: { lang?: Lang; reduce?: boolean }) {
  const data = new Map<string, string>([['qorgan.lang', lang]]);
  g.localStorage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  g.document = { documentElement: {} };
  g.matchMedia = (q: string) => ({ matches: reduce && q.includes('reduce'), addEventListener() {}, removeEventListener() {} });
}

const shell = (node: ReactNode) =>
  renderToStaticMarkup(
    <I18nProvider>
      <StoreProvider>
        <DemoProvider>{node}</DemoProvider>
      </StoreProvider>
    </I18nProvider>,
  );

describe('главная страница: разметка', () => {
  beforeEach(() => setEnv({}));
  afterEach(() => {
    delete g.localStorage;
    delete g.matchMedia;
    delete g.document;
  });

  it.each([
    ['ru', 'Увидеть угрозу раньше, чем придёт вода', 'Открыть систему', 'Смотреть демонстрацию'],
    ['kk', 'Су жетпей тұрып, қауіпті ерте көру', 'Жүйені ашу', 'Демонстрацияны көру'],
    ['en', 'See the threat before the water arrives', 'Open the system', 'Watch the demo'],
  ] as const)('%s: заголовок, обе кнопки, все разделы и бейдж демо-данных', (lang, slogan, open, demo) => {
    setEnv({ lang });
    const html = shell(<WelcomeApp />);
    expect(html).toContain(`aria-label="${slogan}"`);
    expect(html.split(`>${open}`).length - 1).toBeGreaterThanOrEqual(3); // меню, первый экран, финал
    expect(html).toContain(demo);
    for (const id of ['hf-how', 'hf-wave', 'hf-product', 'hf-end']) expect(html).toContain(`id="${id}"`);
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html.match(/<h2[ >]/g)!.length).toBeGreaterThanOrEqual(4);
    expect(html).toMatch(/class="hf-cell-badge"/);
  });

  it('выбора концепций и переключателя анимации больше нет', () => {
    const html = shell(<WelcomeApp />);
    for (const s of ['proto-bar', 'Все концепции', 'С анимацией', 'Без анимации', '#/concepts', 'River Noir', 'Editorial Water']) expect(html).not.toContain(s);
  });

  it('навигация ведёт к настоящим разделам страницы (номера 02–04)', () => {
    for (const s of SECTIONS) expect(shell(<WelcomeApp />)).toContain(`id="${s.id}"`);
    const menu = shell(<FullMenu open onClose={() => {}} links={SECTIONS} first={2} />);
    expect(menu).toContain('role="dialog"');
    expect(menu).toContain('aria-modal="true"');
    expect(menu).toMatch(/02<\/span>Как работает/);
    expect(menu).toMatch(/04<\/span>Система/);
    expect(shell(<FullMenu open={false} onClose={() => {}} links={SECTIONS} />)).toBe('');
  });

  it('prefers-reduced-motion — страница статичная (data-still), без него — с движением', () => {
    setEnv({ reduce: true });
    expect(shell(<WelcomeApp />)).toContain('data-still="true"');
    setEnv({ reduce: false });
    expect(shell(<WelcomeApp />)).not.toContain('data-still');
  });

  it('декоративная сцена скрыта от читалок экрана и не перехватывает нажатия; снимки экрана подписаны', () => {
    const html = shell(<WelcomeApp />);
    expect(html).toMatch(/class="hf-depth" aria-hidden="true"><canvas>/);
    expect(html).toMatch(/<img [^>]*alt="Главная панель: карта и «Живая река»"/);
    expect(html).toMatch(/role="tablist"/);
  });

  it('без данных сервера — «Нет данных», а не нули', () => {
    const html = shell(<WelcomeApp />);
    expect(html).toContain('Нет данных — запустите демонстрацию');
    expect(html).not.toMatch(/>0,00 м</);
  });
});

// ── Живые данные: разделы получают снимок сервера ─────────────────────────────────────────────────────────

const CODES = ['QRG-01', 'QRG-02', 'QRG-03', 'QRG-04'];
const metas = CODES.map(
  (code, i) =>
    ({ code, name: `Станция ${i + 1}`, upstreamCode: i === 0 ? null : CODES[i - 1]!, travelHours: i === 0 ? null : [0, 51, 51, 17][i], lat: 54, lon: 68, parameters: [{ code: 'water_level', warning: 450, danger: 550 }] }) as StationMeta,
);
function snap(levels: number[], risk: Array<'LOW' | 'MEDIUM' | 'HIGH'>, upstreamFor: Record<string, string> = {}): Snapshot {
  return {
    simulation: { state: 'RUNNING', run: null, realTime: '' },
    context: { mode: 'LIVE', runId: 1, runStatus: null, scenarioId: 'RAPID_FLOOD', virtualTime: '', realTime: '', lastReceivedAt: null },
    alerts: { runId: 1, active: [], unhandled: 0 },
    stations: CODES.map((code, i) => ({
      id: i + 1,
      code,
      name: code,
      status: 'active',
      lastMessageAt: null,
      latest: { water_level: { value: levels[i]!, unit: 'cm', measuredAt: '2026-11-01T00:00:00.000Z', source: 'simulator', quality: 'ok' } },
      risk: {
        risk: risk[i]!,
        score: 0,
        maxScore: 12,
        levelCm: levels[i]!,
        measuredAt: '2026-11-01T00:00:00.000Z',
        ageH: 0,
        warningCm: 450,
        dangerCm: 550,
        trend: 'STABLE',
        rateCmH: 0,
        dataStatus: 'OK',
        confidence: 'HIGH',
        topReasons: [],
        situation: {
          localLevel: 'NORMAL',
          localTrend: 'STABLE',
          localPoints: 0,
          upstreamPoints: 0,
          drivers: 'NONE',
          upstream: upstreamFor[code] ? { stationCode: upstreamFor[code]!, risk: 'HIGH', travelHours: 51 } : null,
        },
      } as SnapshotStation['risk'],
    })),
  } as Snapshot;
}
const liveOf = (s: Snapshot | null): ReturnType<typeof useRiverLive> => {
  const flow = riverFlow(metas, s);
  return { stations: metas, flow, online: true, hasData: s !== null, alerts: s?.alerts ?? null };
};

describe('разделы на живых данных', () => {
  beforeEach(() => setEnv({}));
  afterEach(() => {
    delete g.localStorage;
    delete g.matchMedia;
    delete g.document;
  });
  const section = (node: ReactNode) => shell(<StillProvider>{node}</StillProvider>);

  it('«Путь волны»: угроза идёт от станции с риском к следующей, время — из БД', () => {
    const html = section(<WaveSection live={liveOf(snap([320, 560, 300, 260], ['LOW', 'HIGH', 'MEDIUM', 'LOW'], { 'QRG-03': 'QRG-02', 'QRG-04': 'QRG-02' }))} />);
    expect(html).toContain('has-threat');
    expect(html).toContain('У станции «Станция 2» риск «Высокий»');
    expect(html).toContain('Следующая — «Станция 3». По схеме волна идёт ≈ 51 ч');
    expect(html).toContain('угроза идёт сюда');
    expect(html).toContain('+119 ч');
  });

  it('«Путь волны»: всё спокойно — угрозы нет, бегущий свет только иллюстрирует течение', () => {
    const html = section(<WaveSection live={liveOf(snap([320, 330, 300, 260], ['LOW', 'LOW', 'LOW', 'LOW']))} />);
    expect(html).not.toContain('has-threat');
    expect(html).toContain('Угрозы нет');
    expect(html).toContain('не является расчётом');
  });

  it('«Как работает»: уровень и риск самой тревожной станции, число предупреждений — из снимка', () => {
    const html = section(<HowSection live={liveOf(snap([320, 560, 300, 260], ['LOW', 'HIGH', 'MEDIUM', 'LOW']))} />);
    expect(html).toContain('Станция 2: <b class="num">5,60 м</b>');
    expect(html).toContain('Станция 2: риск «Высокий» — посчитан сервером');
    expect(html).toContain('Активных предупреждений: 0');
    expect(html).toContain('Данные сервера');
    expect(html).toContain('Схема');
  });

  it('«Как работает» без снимка — «Нет данных», шкала пустая', () => {
    const html = section(<HowSection live={liveOf(null)} />);
    expect(html).toContain('Нет данных — запустите демонстрацию');
    expect(html).toContain('--g:0');
  });
});
