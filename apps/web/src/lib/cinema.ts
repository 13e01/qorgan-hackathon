// Главная страница Hydro Future: маршруты, геометрия реки и раскладка «Пути волны».
// Геометрия — только проекция линии Есиля из OSM (esil-river.json) и координат станций из БД. Это схема для
// композиции, а не модель течения или затопления: здесь ничего не считается о воде.

import type { RiverFlow } from './flow';

/** Части адреса после «#/» без параметров и хвостовых «/». */
function hashPath(hash: string): string {
  return hash.replace(/^#\/?/, '').split('?')[0]!.replace(/\/+$/, '');
}

/**
 * Главная страница Hydro Future — пустой адрес, «#/» и «#/welcome». Старые адреса прототипов (#/concepts…) тоже
 * ведут на главную: выбор концепций закрыт. Все разделы рабочей системы (#/dashboard и т. д.) — без изменений.
 */
export function isWelcomeHash(hash: string): boolean {
  const p = hashPath(hash);
  return p === '' || p === 'welcome' || p === 'concepts' || p.startsWith('concepts/');
}

/** Старый адрес прототипа, который нужно заменить на «#/» (без новой записи в истории). */
export const isLegacyConceptHash = (hash: string) => hashPath(hash).startsWith('concepts');

export const WELCOME_HASH = '#/';
export const DASHBOARD_HASH = '#/dashboard';

type LonLat = [number, number];
interface RiverGeo {
  features: Array<{ geometry: { type: string; coordinates: unknown } }>;
}
interface StationPos {
  code: string;
  lat: number;
  lon: number;
  upstreamCode: string | null;
}

export interface Pt {
  x: number;
  y: number;
}

function lines(geo: RiverGeo): LonLat[][] {
  const out: LonLat[][] = [];
  for (const f of geo.features) {
    const g = f.geometry;
    if (g.type === 'LineString') out.push(g.coordinates as LonLat[]);
    else if (g.type === 'MultiLineString') out.push(...(g.coordinates as LonLat[][]));
  }
  return out.filter((l) => l.length > 1);
}

/** Равнопромежуточная проекция с поправкой cos(φ) — для схемы в пределах одной области этого достаточно. */
function planar(all: LonLat[], [lon, lat]: LonLat): Pt {
  const midLat = all.reduce((s, p) => s + p[1], 0) / all.length;
  return { x: lon * Math.cos((midLat * Math.PI) / 180), y: -lat };
}

/** Каждая n-я точка + последняя: линия остаётся узнаваемой, путь SVG — лёгким. */
function thin<T>(pts: T[], step: number): T[] {
  if (step <= 1 || pts.length <= 2) return pts;
  const out = pts.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]!);
  return out;
}

export interface AxisRiver {
  /** Линии в осях «вдоль течения» u (0 — верхняя станция, 1 — нижняя) и «поперёк» w (в тех же единицах). Направлены по течению. */
  lines: Array<Array<{ u: number; w: number }>>;
  stations: Array<{ code: string; u: number; w: number }>;
}

/**
 * Река, повёрнутая так, что ось «верхняя станция → нижняя станция» становится осью u. Нужна для перспективной
 * сцены: исток вдали, устье ближе к зрителю. Верхняя станция — без upstreamCode, нижняя — ни для кого не верхняя.
 * Без станций ось строится по самой южной и самой северной точке линии.
 */
export function riverAxis(geo: RiverGeo, stations: StationPos[], step = 2): AxisRiver {
  const src = lines(geo).map((l) => thin(l, step));
  const all: LonLat[] = [...src.flat(), ...stations.map((s) => [s.lon, s.lat] as LonLat)];
  if (all.length === 0) return { lines: [], stations: [] };
  const head = stations.find((s) => !s.upstreamCode);
  const tail = stations.find((s) => !stations.some((o) => o.upstreamCode === s.code));
  // Пока станции не загружены — ось по крайним точкам линии с юга на север (Есиль в СКО течёт на север).
  const bySouth = [...src.flat()].sort((p, q) => p[1] - q[1]);
  const from: LonLat | undefined = head && tail && head !== tail ? [head.lon, head.lat] : bySouth[0];
  const to: LonLat | undefined = head && tail && head !== tail ? [tail.lon, tail.lat] : bySouth[bySouth.length - 1];
  if (!from || !to) return { lines: [], stations: [] };
  const a = planar(all, from);
  const b = planar(all, to);
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const toAxis = (p: LonLat) => {
    const q = planar(all, p);
    const dx = q.x - a.x;
    const dy = q.y - a.y;
    return { u: (dx * ux + dy * uy) / len, w: (-dx * uy + dy * ux) / len };
  };
  return {
    lines: src.map((l) => {
      const pts = l.map(toAxis);
      return pts[0]!.u > pts[pts.length - 1]!.u ? pts.reverse() : pts;
    }),
    stations: stations.map((s) => ({ code: s.code, ...toAxis([s.lon, s.lat]) })),
  };
}

/** Плавная линия через точки (Catmull-Rom → кубические Безье): русло без «изломов молнии» на крупном плане. */
export function smoothPath(pts: Pt[]): string {
  if (pts.length < 2) return '';
  const r = (v: number) => Math.round(v * 10) / 10;
  let d = `M${r(pts[0]!.x)} ${r(pts[0]!.y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    d += `C${r(p1.x + (p2.x - p0.x) / 6)} ${r(p1.y + (p2.y - p0.y) / 6)} ${r(p2.x - (p3.x - p1.x) / 6)} ${r(p2.y - (p3.y - p1.y) / 6)} ${r(p2.x)} ${r(p2.y)}`;
  }
  return d;
}

/** Станции по течению и связь с нижней соседкой (время добегания из БД, состояние — из снимка сервера). */
export function riverChain(flow: RiverFlow) {
  return flow.nodes.map((node) => ({ node, link: flow.links.find((l) => l.from === node.code) ?? null }));
}

/** Сумма времени добегания по цепочке станций (из БД); null — данных нет. */
export function totalTravelHours(flow: RiverFlow): number | null {
  const hs = flow.links.map((l) => l.travelHours).filter((h): h is number => h !== null);
  return hs.length ? Math.round(hs.reduce((a, b) => a + b, 0)) : null;
}

/**
 * Сглаживание ломаной (Chaikin): углы срезаются, концы остаются на месте. Русло в перспективной сцене перестаёт
 * быть «молнией» из мелких зубцов OSM, а форма реки и положение станций не меняются.
 */
export function chaikin<T extends { u: number; w: number }>(pts: T[], iterations = 2): Array<{ u: number; w: number }> {
  let cur: Array<{ u: number; w: number }> = pts.map((p) => ({ u: p.u, w: p.w }));
  for (let it = 0; it < iterations && cur.length > 2; it++) {
    const next = [cur[0]!];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i]!;
      const b = cur[i + 1]!;
      next.push({ u: a.u * 0.75 + b.u * 0.25, w: a.w * 0.75 + b.w * 0.25 }, { u: a.u * 0.25 + b.u * 0.75, w: a.w * 0.25 + b.w * 0.75 });
    }
    next.push(cur[cur.length - 1]!);
    cur = next;
  }
  return cur;
}

const RANK = { NO_DATA: -1, LOW: 0, MEDIUM: 1, HIGH: 2 } as const;

/**
 * Станция для рассказа «Как работает»: самая тревожная по данным сервера; при равенстве — та, у которой уровень
 * ближе к опасному порогу. null — измерений нет ни на одной станции.
 */
export function focusStation(flow: RiverFlow): RiverFlow['nodes'][number] | null {
  let best: RiverFlow['nodes'][number] | null = null;
  for (const n of flow.nodes) {
    if (n.levelCm === null) continue;
    if (!best || RANK[n.risk] > RANK[best.risk] || (RANK[n.risk] === RANK[best.risk] && (n.gauge ?? 0) > (best.gauge ?? 0))) best = n;
  }
  return best;
}

export interface WaveStop {
  code: string;
  /** Положение на шкале 0…1 — по накопленному времени добегания из БД (если его нет — равные шаги). */
  at: number;
  /** Часов от верхней станции по схеме; null — время добегания не задано. */
  hoursFromHead: number | null;
}

export interface WaveTimeline {
  stops: WaveStop[];
  totalHours: number | null;
  /** Угроза по данным снимка: откуда (станция с риском) и к какой станции ниже она идёт. null — все связи спокойны. */
  threat: { from: string; to: string; risk: 'MEDIUM' | 'HIGH' | null; travelHours: number | null; arrived: boolean } | null;
}

/**
 * Раскладка «Пути волны»: станции по течению на шкале времени добегания (из БД) и текущая угроза из снимка.
 * Ничего не прогнозирует — только располагает уже известные значения.
 */
export function waveTimeline(flow: RiverFlow): WaveTimeline {
  const n = flow.nodes.length;
  const hours: Array<number | null> = [];
  let acc: number | null = 0;
  flow.nodes.forEach((node, i) => {
    if (i > 0) {
      const link = flow.links.find((l) => l.to === node.code);
      acc = acc === null || !link || link.travelHours === null ? null : acc + link.travelHours;
    }
    hours.push(acc);
  });
  const total = n > 1 ? hours[n - 1]! : null;
  const stops = flow.nodes.map((node, i) => ({
    code: node.code,
    at: n < 2 ? 0 : total ? hours[i]! / total : i / (n - 1),
    hoursFromHead: total ? hours[i]! : null,
  }));
  // Самая верхняя неспокойная связь: волна там, где она начинается; «дошла» — если подъём у нижней подтверждён.
  const link = flow.links.find((l) => l.state === 'threat') ?? flow.links.find((l) => l.state === 'arrived') ?? null;
  return {
    stops,
    totalHours: total,
    threat: link ? { from: link.from, to: link.to, risk: link.risk === 'LOW' ? null : link.risk, travelHours: link.travelHours, arrived: link.state === 'arrived' } : null,
  };
}
