// Перспективная сцена главной страницы Hydro Future (Canvas 2D, без библиотек). Есиль (OSM) уходит к горизонту:
// верхняя станция вдали, нижняя ближе к зрителю. Поток частиц по руслу — схема движения воды; цвет участка между
// станциями — состояние связи из снимка сервера (riverFlow: спокойно / угроза идёт / подъём дошёл). Частицы ничего
// не моделируют и не считают, бегущий блик — только иллюстрация направления течения.
//
// Производительность: сетка, свечение русла и «туман» горизонта рисуются один раз в отдельный слой (при изменении
// размера); в кадре — только копия слоя, частицы (их число ограничено площадью, максимум MAX_PARTS) и подписи
// станций. Цикл requestAnimationFrame всегда один; он останавливается, когда движение выключено (reduced motion),
// сцена вне экрана, вкладка скрыта или компонент размонтирован. Плотность пикселей ограничена.

import { chaikin, type AxisRiver } from '../lib/cinema';
import type { RiverFlow } from '../lib/flow';

/** Всё, что сцена берёт у браузера, — через этот объект (в тестах подменяется). */
export interface FrameHost {
  request(cb: (now: number) => void): number;
  cancel(id: number): void;
  now(): number;
  dpr(): number;
  hidden(): boolean;
  createLayer(): HTMLCanvasElement | null;
  onVisibility(cb: () => void): () => void;
}

export const browserHost: FrameHost = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
  now: () => performance.now(),
  dpr: () => window.devicePixelRatio || 1,
  hidden: () => document.hidden,
  createLayer: () => document.createElement('canvas'),
  onVisibility: (cb) => {
    document.addEventListener('visibilitychange', cb);
    return () => document.removeEventListener('visibilitychange', cb);
  },
};

type Rgb = readonly [number, number, number];
const RGB = { calm: [94, 224, 255], MEDIUM: [255, 181, 71], HIGH: [255, 107, 107], ink: [230, 251, 255] } as const satisfies Record<string, Rgb>;
type Tone = 'calm' | 'MEDIUM' | 'HIGH';

export const MAX_PARTS = 340;
/** Минимальный промежуток между кадрами сцены, мс (≈ 60 кадров/с с запасом на неровный vsync). */
export const FRAME_MS = 15.5;
const MIN_PARTS = 120;
/** Плотность пикселей не выше 2, а на очень больших холстах — 1,5 (заметной разницы нет, а заливка дешевле). */
export const dprFor = (device: number, w: number, h: number) => Math.min(device || 1, w * h > 1_600_000 ? 1.5 : 2);
/** Число частиц — по площади сцены, в пределах [MIN_PARTS, MAX_PARTS]. */
export const partsFor = (w: number, h: number) => Math.max(MIN_PARTS, Math.min(MAX_PARTS, Math.round((w * h) / 3600)));

const hash = (n: number) => {
  const s = Math.sin(n * 91.345 + 47.853) * 24634.6345;
  return s - Math.floor(s);
};

interface Track {
  pts: Array<{ u: number; w: number }>;
  cum: number[];
  len: number;
}
interface Particle {
  ti: number;
  s: number;
  v: number;
  off: number;
  size: number;
  px: number;
  py: number;
}

function toTrack(pts: Array<{ u: number; w: number }>): Track {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]!.u - pts[i - 1]!.u, pts[i]!.w - pts[i - 1]!.w));
  return { pts, cum, len: cum[cum.length - 1]! };
}

function pointAt(tr: Track, s: number) {
  const target = s * tr.len;
  let lo = 0;
  let hi = tr.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tr.cum[mid]! < target) lo = mid;
    else hi = mid;
  }
  const a = tr.pts[lo]!;
  const b = tr.pts[hi]!;
  const k = (target - tr.cum[lo]!) / (tr.cum[hi]! - tr.cum[lo]! || 1);
  return { u: a.u + (b.u - a.u) * k, w: a.w + (b.w - a.w) * k };
}

export class RiverScene {
  /** Нарисовано кадров (для диагностики и тестов). */
  frames = 0;
  private ctx: CanvasRenderingContext2D | null;
  private layer: HTMLCanvasElement | null = null;
  private sprites: Partial<Record<Tone, HTMLCanvasElement>> = {};
  private w = 0;
  private h = 0;
  private dpr = 1;
  private raf = 0;
  private last = 0;
  private time = 0;
  private motion = false;
  private visible = true;
  private destroyed = false;
  private readonly tracks: Track[];
  private readonly parts: Particle[];
  private active = MIN_PARTS;
  private readonly wMid: number;
  private flow: RiverFlow = { nodes: [], links: [], hasThreat: false };
  /** Участки русла с цветом связи: [u от, u до, тон]. */
  private spans: Array<[number, number, Tone]> = [];
  private readonly offVisibility: () => void;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly axis: AxisRiver,
    private readonly host: FrameHost = browserHost,
  ) {
    this.ctx = canvas.getContext('2d');
    this.tracks = axis.lines.map((l) => toTrack(chaikin(l, 2))).filter((t) => t.len > 0);
    this.wMid = axis.stations.length ? axis.stations.reduce((a, s) => a + s.w, 0) / axis.stations.length : 0;
    // Частицы: дорожка (длинные — чаще), положение, скорость, смещение поперёк — из хеш-шума (детерминированно).
    const weights = this.tracks.map((t) => t.len);
    const total = weights.reduce((a, b) => a + b, 0);
    this.parts = this.tracks.length
      ? Array.from({ length: MAX_PARTS }, (_, i) => {
          let r = hash(i) * total;
          let ti = 0;
          while (ti < this.tracks.length - 1 && r > weights[ti]!) r -= weights[ti++]!;
          return { ti, s: hash(i + 500), v: 0.02 + hash(i + 900) * 0.032, off: (hash(i + 1300) - 0.5) * 0.011, size: 0.55 + hash(i + 1700) * 1.3, px: NaN, py: NaN };
        })
      : [];
    this.offVisibility = host.onVisibility(() => this.sync());
  }

  get running(): boolean {
    return this.raf !== 0;
  }

  setFlow(flow: RiverFlow): void {
    this.flow = flow;
    const u = new Map(this.axis.stations.map((s) => [s.code, s.u]));
    this.spans = [];
    for (const link of flow.links) {
      const a = u.get(link.from);
      const b = u.get(link.to);
      if (a === undefined || b === undefined || link.state === 'calm') continue;
      this.spans.push([a, b, link.risk === 'HIGH' ? 'HIGH' : 'MEDIUM']);
    }
    if (!this.running) this.draw(0);
  }

  /** Движение разрешено (нет prefers-reduced-motion). Без движения — один законченный статичный кадр. */
  setMotion(on: boolean): void {
    this.motion = on;
    this.sync();
    if (!on) this.draw(0);
  }

  /** Сцена в кадре (IntersectionObserver). Вне кадра цикл останавливается. */
  setVisible(on: boolean): void {
    this.visible = on;
    this.sync();
  }

  resize(): void {
    if (this.destroyed) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.w = w;
    this.h = h;
    this.dpr = dprFor(this.host.dpr(), w, h);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.active = Math.min(this.parts.length, partsFor(w, h));
    for (const p of this.parts) p.px = NaN;
    this.renderLayer();
    if (!this.running) this.draw(0);
    this.sync();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf) this.host.cancel(this.raf);
    this.raf = 0;
    this.offVisibility();
    this.layer = null;
    this.sprites = {};
  }

  /** Запустить или остановить цикл по текущим условиям. Цикл никогда не бывает двойным. */
  private shouldRun(): boolean {
    return this.motion && this.visible && !this.destroyed && !this.host.hidden() && this.w > 0 && this.tracks.length > 0;
  }

  private sync(): void {
    const run = this.shouldRun();
    if (run && !this.raf) {
      this.last = this.host.now();
      this.raf = this.host.request(this.loop);
    } else if (!run && this.raf) {
      this.host.cancel(this.raf);
      this.raf = 0;
    }
  }

  /**
   * Кадр не чаще ≈ 60 раз в секунду: на мониторах 120–240 Гц сцена не рисуется лишний раз (ноутбук не греется),
   * а движение по-прежнему плавное (шаг считается по прошедшему времени).
   */
  private readonly loop = (now: number) => {
    this.raf = 0;
    if (this.destroyed) return;
    if (now - this.last >= FRAME_MS) {
      const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.time += dt;
      this.draw(dt);
    }
    if (this.shouldRun()) this.raf = this.host.request(this.loop);
  };

  // ── Проекция ─────────────────────────────────────────────────────────────────────────────────────────────

  private get wide() {
    return this.w > 820;
  }

  /** Камера над рекой: исток (u = 0) на глубине 9, нижняя станция (u = 1) — на 2; ближе 0,6 не подходим. */
  private project(u: number, wv: number) {
    const { w, h } = this;
    const wide = this.wide;
    const cx = wide ? w * 0.68 : w * 0.5;
    const horizon = h * (wide ? 0.12 : 0.1);
    const f = Math.min(w, h * 1.4) * (wide ? 0.62 : 0.9);
    const z = Math.max(0.6, 2 + (1 - u) * 7);
    // Схема: изгибы русла усилены ×2,2, а ось слегка развёрнута (из глубины слева — к зрителю справа).
    const lateral = (wv - this.wMid) * 2.2 + (u - 0.5) * 0.14;
    return { x: cx + (lateral * 6.4 * f) / z, y: horizon + (1.6 * f) / z, k: 2 / z };
  }

  private tone(u: number): Tone {
    for (const [a, b, t] of this.spans) if (u >= a && u <= b) return t;
    return 'calm';
  }

  // ── Статичный слой: горизонт, сетка, свечение русла ─────────────────────────────────────────────────────

  private renderLayer(): void {
    const layer = this.layer ?? this.host.createLayer();
    const ctx = layer?.getContext('2d');
    if (!layer || !ctx) return;
    this.layer = layer;
    layer.width = this.canvas.width;
    layer.height = this.canvas.height;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);

    // Свечение над горизонтом.
    const hz = this.project(-0.6, 0).y;
    const glow = ctx.createLinearGradient(0, hz - 110, 0, hz + 60);
    glow.addColorStop(0, 'rgba(60,140,220,0)');
    glow.addColorStop(0.68, 'rgba(60,150,230,0.16)');
    glow.addColorStop(1, 'rgba(60,140,220,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, hz - 110, w, 170);
    ctx.fillStyle = 'rgba(150,220,255,0.35)';
    ctx.fillRect(0, hz, w, 1);

    // Сетка плоскости: поперечные линии по глубине (ярче ближе) и продольные лучи к точке схода.
    ctx.lineWidth = 1;
    for (let i = 0; i <= 34; i++) {
      const u = -0.6 + (i / 34) * 1.9;
      const a = this.project(u, -1.4);
      const b = this.project(u, 1.4);
      ctx.strokeStyle = `rgba(120,200,255,${Math.max(0.015, 0.02 + u * 0.15)})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (let i = -14; i <= 14; i++) {
      const a = this.project(-0.6, i * 0.06);
      const b = this.project(1.5, i * 0.06);
      ctx.strokeStyle = `rgba(120,200,255,${i % 4 === 0 ? 0.13 : 0.07})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Отражение реки на плоскости — мягкое пятно у ближней части русла.
    const near = this.project(0.85, this.wMid);
    const pool = ctx.createRadialGradient(near.x, near.y, 0, near.x, near.y, Math.max(w, h) * 0.45);
    pool.addColorStop(0, 'rgba(40,150,230,0.14)');
    pool.addColorStop(1, 'rgba(40,150,230,0)');
    ctx.fillStyle = pool;
    ctx.fillRect(0, 0, w, h);

    // Русло: широкое размытое свечение, тело реки (шире у зрителя), яркая сердцевина.
    const paths = this.tracks.map((tr) => tr.pts.map((p) => this.project(p.u, p.w)));
    const stroke = (width: number, color: string, blur = 0) => {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      if (blur) {
        ctx.shadowColor = 'rgba(94,224,255,0.9)';
        ctx.shadowBlur = blur;
      }
      for (const pts of paths) {
        ctx.beginPath();
        pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.stroke();
      }
      ctx.restore();
    };
    stroke(18, 'rgba(94,224,255,0.05)');
    stroke(6, 'rgba(120,215,255,0.12)', 22);
    // Тело реки по отрезкам: толщина и яркость растут к зрителю — ощущение глубины.
    ctx.lineCap = 'round';
    for (const pts of paths) {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        ctx.strokeStyle = `rgba(170,232,255,${0.35 + Math.min(1, b.k) * 0.5})`;
        ctx.lineWidth = 0.7 + b.k * 1.5;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // Туман у горизонта: дальняя часть сетки и реки растворяется — глубина без лишних кадров.
    const fog = ctx.createLinearGradient(0, hz, 0, hz + h * 0.22);
    fog.addColorStop(0, 'rgba(5,10,18,0.75)');
    fog.addColorStop(1, 'rgba(5,10,18,0)');
    ctx.fillStyle = fog;
    ctx.fillRect(0, hz, w, h * 0.22);

    // Спрайты частиц: мягкое пятно с ярким центром (дешевле, чем shadowBlur в каждом кадре).
    for (const tone of ['calm', 'MEDIUM', 'HIGH'] as const) {
      const s = this.sprites[tone] ?? this.host.createLayer();
      const sc = s?.getContext('2d');
      if (!s || !sc) continue;
      s.width = s.height = 32;
      const [r, g, b] = RGB[tone];
      const grad = sc.createRadialGradient(16, 16, 0, 16, 16, 16);
      grad.addColorStop(0, `rgba(255,255,255,1)`);
      grad.addColorStop(0.18, `rgba(${r},${g},${b},0.95)`);
      grad.addColorStop(0.45, `rgba(${r},${g},${b},0.28)`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      sc.clearRect(0, 0, 32, 32);
      sc.fillStyle = grad;
      sc.fillRect(0, 0, 32, 32);
      this.sprites[tone] = s;
    }
  }

  // ── Кадр ─────────────────────────────────────────────────────────────────────────────────────────────────

  private draw(dt: number): void {
    const ctx = this.ctx;
    if (!ctx || this.w === 0 || this.destroyed) return;
    this.frames++;
    const { w, h } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.layer) ctx.drawImage(this.layer, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Бегущий блик: раз в 9 с проходит по руслу от истока к устью (иллюстрация направления течения).
    const pulse = this.motion ? ((this.time / 9) % 1) * 1.4 - 0.2 : -9;

    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.active; i++) {
      const p = this.parts[i]!;
      const tr = this.tracks[p.ti]!;
      p.s = (p.s + (p.v * dt) / Math.max(0.2, tr.len)) % 1;
      const a = pointAt(tr, p.s);
      const q = this.project(a.u, a.w + p.off);
      const tone = this.tone(a.u);
      const fade = Math.min(1, p.s * 8, (1 - p.s) * 8);
      const boost = Math.max(0, 1 - Math.abs(a.u - pulse) / 0.06);
      const alpha = Math.min(1, (0.3 + q.k * 0.75 + boost * 0.6) * fade);
      const size = Math.max(1.2, p.size * (0.9 + Math.min(q.k, 1.1) * 2.6)) * (1 + boost * 0.5);
      // Короткий след от прошлого положения — поток читается как движение, а не как россыпь точек.
      if (dt > 0 && Number.isFinite(p.px) && Math.hypot(q.x - p.px, q.y - p.py) < 40) {
        const [r, g, b] = RGB[tone];
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha * 0.45})`;
        ctx.lineWidth = Math.max(0.6, size * 0.35);
        ctx.beginPath();
        ctx.moveTo(p.px, p.py);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }
      p.px = q.x;
      p.py = q.y;
      const sprite = this.sprites[tone];
      if (sprite) {
        ctx.globalAlpha = alpha;
        ctx.drawImage(sprite, q.x - size * 2, q.y - size * 2, size * 4, size * 4);
        ctx.globalAlpha = 1;
      } else {
        const [r, g, b] = RGB[tone];
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.fillRect(q.x - size / 2, q.y - size / 2, size, size);
      }
    }
    ctx.globalCompositeOperation = 'source-over';

    this.drawStations(w);
    void h;
  }

  /** Мачты станций с подписью на подложке: название из БД, код; цвет — риск из снимка; «угроза идёт сюда» — кольцо. */
  private drawStations(w: number): void {
    const ctx = this.ctx!;
    const small = w < 520;
    ctx.textBaseline = 'middle';
    this.axis.stations.forEach((s, i) => {
      const node = this.flow.nodes.find((n) => n.code === s.code);
      const q = this.project(s.u, s.w);
      const top = q.y - (small ? 30 : 40) - q.k * (small ? 46 : 70);
      const c: Rgb = node && (node.risk === 'MEDIUM' || node.risk === 'HIGH') ? RGB[node.risk] : RGB.ink;
      const rgb = `${c[0]},${c[1]},${c[2]}`;

      // Мачта: градиент от русла вверх.
      const mast = ctx.createLinearGradient(0, q.y, 0, top);
      mast.addColorStop(0, `rgba(${rgb},0.9)`);
      mast.addColorStop(1, `rgba(${rgb},0.25)`);
      ctx.strokeStyle = mast;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
      ctx.lineTo(q.x, top);
      ctx.stroke();
      ctx.fillStyle = `rgb(${rgb})`;
      ctx.beginPath();
      ctx.arc(q.x, q.y, 2.6, 0, Math.PI * 2);
      ctx.fill();

      // Кольцо: пульсирует при движении, без движения — неподвижное.
      if (node?.next) {
        const k = this.motion ? (this.time % 1.8) / 1.8 : 0.4;
        ctx.strokeStyle = `rgba(${RGB.MEDIUM.join(',')},${0.9 * (1 - k)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(q.x, q.y, 6 + k * 18, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Подпись на тёмной подложке — читается поверх русла и сетки.
      const name = node?.name ?? s.code;
      const code = `${s.code}${i === 0 ? ' ↓' : ''}`;
      const nameSize = Math.round((small ? 11 : 12) + Math.min(q.k, 1.2) * (small ? 2 : 4));
      ctx.font = `600 ${nameSize}px "Inter Variable", Inter, system-ui, sans-serif`;
      const nw = ctx.measureText(name).width;
      ctx.font = `500 10.5px "Cascadia Mono", Consolas, ui-monospace, monospace`;
      const cw = ctx.measureText(code).width;
      const bw = Math.max(nw, cw) + 18;
      const bh = nameSize + 22;
      const left = q.x + 10 + bw > w - 8;
      const bx = left ? q.x - 10 - bw : q.x + 10;
      const by = top - bh / 2;
      ctx.fillStyle = 'rgba(5,12,22,0.78)';
      ctx.strokeStyle = `rgba(${rgb},0.32)`;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(bx, by, bw, bh, 5);
      else ctx.rect(bx, by, bw, bh);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = `rgb(${rgb})`;
      ctx.beginPath();
      ctx.arc(q.x, top, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.font = `600 ${nameSize}px "Inter Variable", Inter, system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(234,246,255,0.96)';
      ctx.fillText(name, bx + 9, by + 7 + nameSize / 2);
      ctx.font = `500 10.5px "Cascadia Mono", Consolas, ui-monospace, monospace`;
      ctx.fillStyle = 'rgba(160,215,245,0.7)';
      ctx.fillText(code, bx + 9, by + bh - 9);
    });
  }
}
