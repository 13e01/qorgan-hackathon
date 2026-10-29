// Прототипы кинематографичной главной страницы (Eclipse Cinematic): маршруты и геометрия реки.
// Геометрия — только проекция линии Есиля из OSM (esil-river.json) и координат станций из БД. Это схема для
// композиции, а не модель течения или затопления: здесь ничего не считается о воде.

import type { RiverFlow } from './flow';

export const CONCEPT_IDS = ['a', 'b', 'c'] as const;
export type ConceptId = (typeof CONCEPT_IDS)[number];
export type ConceptView = { view: 'gallery' } | { view: 'concept'; id: ConceptId };

/** `#/concepts` — выбор концепции, `#/concepts/a|b|c` — прототип. Всё остальное (null) — рабочее приложение. */
export function conceptRoute(hash: string): ConceptView | null {
  const path = hash.replace(/^#\/?/, '').split('?')[0]!.replace(/\/+$/, '');
  if (path === 'concepts') return { view: 'gallery' };
  const m = /^concepts\/([abc])$/.exec(path);
  return m ? { view: 'concept', id: m[1] as ConceptId } : null;
}

export const conceptHash = (id?: ConceptId) => (id ? `#/concepts/${id}` : '#/concepts');

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

/** Координаты для подписи: 53°53′ N. */
export function dms(value: number, pos: string, neg: string): string {
  const v = Math.abs(value);
  let d = Math.floor(v);
  let m = Math.round((v - d) * 60);
  if (m === 60) (d += 1), (m = 0);
  return `${d}°${String(m).padStart(2, '0')}′ ${value >= 0 ? pos : neg}`;
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

/**
 * Река через кадр по диагонали — как кадр с высоты: ось «верхняя → нижняя станция» идёт из точки from в точку to
 * (доли кадра, концы за краями), изгибы русла откладываются по нормали в том же масштабе (пропорции сохраняются).
 * В широком кадре река занимает правую часть (слева — текст), в портретном — верхнюю.
 */
export function sweepRiver(axis: AxisRiver, width: number, height: number, portrait: boolean): { lines: Pt[][]; stations: Array<{ code: string } & Pt> } {
  const [fx, fy, tx, ty] = portrait ? [-0.1, 0.4, 1.1, -0.04] : [0.5, 1.06, 0.78, -0.1];
  const A = { x: fx * width, y: fy * height };
  const B = { x: tx * width, y: ty * height };
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  const n = { x: -(B.y - A.y) / L, y: (B.x - A.x) / L };
  const map = ({ u, w }: { u: number; w: number }): Pt => ({
    x: A.x + u * (B.x - A.x) + w * L * n.x,
    y: A.y + u * (B.y - A.y) + w * L * n.y,
  });
  return {
    lines: axis.lines.map((l) => l.map(map)),
    stations: axis.stations.map((s) => ({ code: s.code, ...map(s) })),
  };
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
