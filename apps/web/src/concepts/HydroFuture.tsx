// Концепция B — HYDRO FUTURE. Приборная глубина: Есиль (OSM) уходит к горизонту, исток вдали, устье ближе.
// Поток частиц по руслу — схема движения воды; его цвет на участке между станциями — состояние связи из снимка
// сервера (riverFlow: спокойно / угроза идёт / подъём дошёл). Частицы ничего не моделируют и не считают.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '../i18n';
import { riverAxis, riverChain, totalTravelHours, type AxisRiver } from '../lib/cinema';
import type { RiverFlow } from '../lib/flow';
import river from '../map/esil-river.json';
import { CineLang, CountUp, FullMenu, QMark, Reveal, scrollToId, useCta, useLevelText, useRiverLive, useStill, useVisible, Words } from './shared';

const hash = (n: number) => {
  const s = Math.sin(n * 91.345 + 47.853) * 24634.6345;
  return s - Math.floor(s);
};

const COLORS = { calm: [94, 224, 255], MEDIUM: [255, 181, 71], HIGH: [255, 107, 107] } as const;

interface Track {
  pts: Array<{ u: number; w: number }>;
  cum: number[];
  len: number;
}

function tracks(axis: AxisRiver): Track[] {
  return axis.lines.map((pts) => {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]!.u - pts[i - 1]!.u, pts[i]!.w - pts[i - 1]!.w));
    return { pts, cum, len: cum[cum.length - 1]! };
  });
}

function at(tr: Track, s: number) {
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

/** Перспективная сцена на canvas. Без анимации (reduced motion) — один статичный кадр. */
function RiverDepth({ axis, flow, still }: { axis: AxisRiver; flow: RiverFlow; still: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [wrapRef, visible] = useVisible<HTMLDivElement>();
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const trs = useMemo(() => tracks(axis), [axis]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || trs.length === 0) return;
    let w = 0;
    let h = 0;
    const resize = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(() => (resize(), still && draw(0)));
    ro.observe(canvas);

    // Частицы: дорожка (длинные чаще), положение, скорость, смещение поперёк — из хеш-шума.
    const weights = trs.map((t) => t.len);
    const total = weights.reduce((a, b) => a + b, 0);
    const N = 320;
    const parts = Array.from({ length: N }, (_, i) => {
      let r = hash(i) * total;
      let ti = 0;
      while (ti < trs.length - 1 && r > weights[ti]!) r -= weights[ti++]!;
      return { ti, s: hash(i + 500), v: 0.018 + hash(i + 900) * 0.03, off: (hash(i + 1300) - 0.5) * 0.012, size: 0.6 + hash(i + 1700) * 1.4 };
    });

    // Середина русла поперёк оси — по станциям, чтобы река стояла в своей половине кадра.
    const wMid = axis.stations.length ? axis.stations.reduce((a, s) => a + s.w, 0) / axis.stations.length : 0;
    const project = (u: number, wv: number) => {
      const wide = w > 820;
      const cx = wide ? w * 0.68 : w * 0.5;
      const horizon = h * (wide ? 0.12 : 0.1);
      const f = Math.min(w, h * 1.4) * (wide ? 0.62 : 0.9);
      // Камера над рекой: исток (u = 0) на глубине 9, нижняя станция (u = 1) — на 2; ближе 0,6 не подходим.
      const z = Math.max(0.6, 2 + (1 - u) * 7);
      // Схема: изгибы русла усилены ×2,2, а ось слегка развёрнута (из глубины слева — к зрителю справа).
      const lateral = (wv - wMid) * 2.2 + (u - 0.5) * 0.14;
      return { x: cx + (lateral * 6.4 * f) / z, y: horizon + (1.6 * f) / z, k: 2 / z };
    };

    const colorAt = (u: number) => {
      const fl = flowRef.current;
      for (let i = 0; i < fl.links.length; i++) {
        const link = fl.links[i]!;
        const a = axis.stations.find((s) => s.code === link.from)?.u;
        const b = axis.stations.find((s) => s.code === link.to)?.u;
        if (a === undefined || b === undefined || u < a || u > b) continue;
        if (link.state === 'calm') return COLORS.calm;
        return link.risk === 'HIGH' ? COLORS.HIGH : COLORS.MEDIUM;
      }
      return COLORS.calm;
    };

    const draw = (dt: number) => {
      ctx.clearRect(0, 0, w, h);
      // Сетка плоскости: поперечные линии по глубине и продольные лучи.
      ctx.lineWidth = 1;
      // Линия горизонта и свечение над ним.
      const hz = project(-0.6, 0).y;
      const glow = ctx.createLinearGradient(0, hz - 80, 0, hz + 40);
      glow.addColorStop(0, "rgba(60,140,220,0)");
      glow.addColorStop(0.7, "rgba(60,140,220,0.12)");
      glow.addColorStop(1, "rgba(60,140,220,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, hz - 80, w, 120);
      for (let i = 0; i <= 30; i++) {
        const u = -0.6 + (i / 30) * 1.8;
        const a = project(u, -1.2);
        const b = project(u, 1.2);
        ctx.strokeStyle = `rgba(120,200,255,${0.02 + u * 0.16})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      for (let i = -12; i <= 12; i++) {
        const a = project(-0.6, i * 0.06);
        const b = project(1.4, i * 0.06);
        ctx.strokeStyle = 'rgba(120,200,255,0.1)';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      // Русло: широкое свечение и тонкая линия.
      for (const [width, alpha] of [
        [14, 0.06],
        [5, 0.16],
        [1.4, 0.75],
      ] as const) {
        for (const tr of trs) {
          ctx.beginPath();
          tr.pts.forEach((p, i) => {
            const q = project(p.u, p.w);
            if (i) ctx.lineTo(q.x, q.y);
            else ctx.moveTo(q.x, q.y);
          });
          ctx.strokeStyle = `rgba(150,225,255,${alpha})`;
          ctx.lineWidth = width;
          ctx.lineJoin = 'round';
          ctx.stroke();
        }
      }
      // Частицы.
      for (const p of parts) {
        const tr = trs[p.ti]!;
        p.s = (p.s + (p.v * dt) / Math.max(0.2, tr.len)) % 1;
        const a = at(tr, p.s);
        const q = project(a.u, a.w + p.off);
        const c = colorAt(a.u);
        const fade = Math.min(1, p.s * 8, (1 - p.s) * 8);
        ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${(0.35 + q.k * 0.9) * fade})`;
        ctx.beginPath();
        ctx.arc(q.x, q.y, Math.max(0.2, p.size * (0.5 + Math.min(q.k, 1.1) * 1.6)), 0, Math.PI * 2);
        ctx.fill();
      }
      // Станции: мачта, метка, подпись (название из БД, уровень — из снимка).
      ctx.textBaseline = 'middle';
      axis.stations.forEach((s, i) => {
        const node = flowRef.current.nodes.find((n) => n.code === s.code);
        const q = project(s.u, s.w);
        const top = q.y - 40 - q.k * 70;
        const c = node && node.risk !== 'LOW' && node.risk !== 'NO_DATA' ? COLORS[node.risk] : [230, 251, 255];
        ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},0.7)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(q.x, top);
        ctx.stroke();
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        ctx.beginPath();
        ctx.arc(q.x, top, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(q.x, q.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = `600 ${Math.round(11 + q.k * 5)}px "Inter Variable", system-ui, sans-serif`;
        // У правого края подпись — слева от мачты, чтобы не обрезалась.
        const left = q.x > w - 150;
        ctx.textAlign = left ? 'right' : 'left';
        const tx = left ? q.x - 9 : q.x + 9;
        ctx.fillText(node?.name ?? s.code, tx, top - 2);
        ctx.font = `500 ${Math.round(10 + q.k * 3)}px "Cascadia Mono", Consolas, monospace`;
        ctx.fillStyle = 'rgba(200,235,255,0.6)';
        ctx.fillText(`${s.code}${i === 0 ? ' ↓' : ''}`, tx, top + 13);
      });
    };

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!document.hidden) draw(dt);
      raf = requestAnimationFrame(loop);
    };
    if (still || !visible) draw(0);
    else raf = requestAnimationFrame(loop);
    return () => (cancelAnimationFrame(raf), ro.disconnect());
  }, [trs, axis, still, visible]);

  return (
    <div className="hf-depth" ref={wrapRef} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}

export function HydroFuture() {
  const { t } = useI18n();
  const cta = useCta();
  const live = useRiverLive();
  const level = useLevelText();
  const { still } = useStill();
  const [menu, setMenu] = useState(false);
  const axis = useMemo(() => riverAxis(river, live.stations), [live.stations]);
  const chain = riverChain(live.flow);
  const hours = totalTravelHours(live.flow);
  const links = [
    { id: 'b-river', key: 'cine.nav.river' as const },
    { id: 'b-how', key: 'cine.nav.how' as const },
  ];

  return (
    <div className="hf">
      <header className="hf-nav">
        <button type="button" className="hf-brand" onClick={() => scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' })}>
          <QMark size={24} />
          <span>QORGAN</span>
        </button>
        <nav className="hf-links" aria-label={t('cine.nav.label')}>
          {links.map((l, i) => (
            <button key={l.id} type="button" onClick={() => scrollToId(l.id)}>
              <span className="hf-mono" aria-hidden="true">
                0{i + 1}
              </span>
              {t(l.key)}
            </button>
          ))}
        </nav>
        <div className="hf-tools">
          <span className={`hf-status${live.online ? ' on' : ''}`} role="status">
            <span className="hf-status-dot" aria-hidden="true" />
            {live.online ? t('cine.live.online') : t('cine.live.offline')}
          </span>
          <CineLang />
          <button type="button" className="hf-btn primary sm" onClick={cta.openSystem}>
            {t('cine.cta.open')}
          </button>
          <button type="button" className="hf-burger" onClick={() => setMenu(true)} aria-expanded={menu}>
            {t('cine.nav.menu')}
          </button>
        </div>
      </header>
      <FullMenu open={menu} onClose={() => setMenu(false)} links={links} className="hf-menu">
        <CineLang />
        <button type="button" className="hf-btn primary" onClick={cta.openSystem}>
          {t('cine.cta.open')}
        </button>
      </FullMenu>

      <section className="hf-hero">
        <div className="hf-grid-bg" aria-hidden="true" />
        <RiverDepth axis={axis} flow={live.flow} still={still} />
        <div className="hf-copy">
          <p className="hf-kicker">
            {chain.length > 1 && <span className="hf-mono">{chain[0]!.node.code} → {chain[chain.length - 1]!.node.code}</span>} {t('cine.c.kicker')}
          </p>
          <h1 className="hf-title">
            <Words text={t('cine.slogan.1')} start={250} />
            <br />
            <span className="hf-title-accent">
              <Words text={t('cine.slogan.2')} start={520} />
            </span>
          </h1>
          <p className="hf-lead">{t('cine.lead')}</p>
          <div className="hf-ctas">
            <button type="button" className="hf-btn primary" onClick={cta.openSystem}>
              {t('cine.cta.open')}
              <span aria-hidden="true">↗</span>
            </button>
            <button type="button" className="hf-btn line" onClick={cta.watchDemo}>
              <span className="hf-play" aria-hidden="true" />
              {t('cine.cta.demo')}
            </button>
          </div>
          <p className="hf-hint">{t('cine.cta.demoHint')}</p>
          <dl className="hf-metrics">
            <div>
              <dt>{t('cine.metric.stations')}</dt>
              <dd className="num">
                <CountUp value={live.stations.length || null} />
              </dd>
            </div>
            <div>
              <dt>{t('cine.metric.hours')}</dt>
              <dd className="num">
                <CountUp value={hours} />
              </dd>
            </div>
            <div>
              <dt>{t('cine.metric.factors')}</dt>
              <dd className="num">
                <CountUp value={5} />
              </dd>
            </div>
          </dl>
        </div>
        <ul className="hf-cells" aria-label={t('cine.live.title')}>
          {live.flow.nodes.map((n, i) => (
            <li key={n.code} className={`cr-${n.risk}${n.next ? ' is-next' : ''}`} style={{ '--d': `${900 + i * 90}ms` } as CSSProperties}>
              <span className="hf-cell-code hf-mono">{n.code}</span>
              <span className="hf-cell-name">{n.name}</span>
              <span className="hf-cell-val num">{level(n.levelCm)}</span>
              <span className="hf-cell-gauge" aria-hidden="true">
                <span style={{ '--g': n.gauge ?? 0 } as CSSProperties} />
                {n.dangerMark !== null && <i style={{ '--m': n.dangerMark } as CSSProperties} />}
              </span>
              <span className="hf-cell-risk">{n.next ? t('cine.live.next') : t(`risk.${n.risk}`)}</span>
            </li>
          ))}
          <li className="hf-cell-badge" title={t('risk.model')}>
            {t('top.demoShort')}
          </li>
        </ul>
      </section>

      <section className="hf-river" id="b-river" aria-labelledby="b-river-title">
        <Reveal className="hf-section-head">
          <p className="hf-kicker">
            <span className="hf-mono">01</span> {t('cine.nav.river')}
          </p>
          <h2 id="b-river-title">{t('cine.river.title')}</h2>
          <p>{t('cine.river.text')}</p>
        </Reveal>
        <ol className="hf-chain">
          {chain.map(({ node, link }, i) => (
            <Reveal as="li" key={node.code} delay={i * 110} className={`cr-${node.risk}`}>
              <span className="hf-chain-node">
                <span className="hf-mono">{node.code}</span>
                <b>{node.name}</b>
                <span className="num">
                  {level(node.levelCm)} · {t(`risk.${node.risk}`)}
                </span>
              </span>
              {link && (
                <span className={`hf-chain-link link-${link.state}`}>
                  <svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
                    <path d="M0 4H96" />
                    <path d="M92 1L97 4L92 7" />
                  </svg>
                  <span className="hf-mono">{link.travelHours !== null ? t('cine.river.travel', { h: link.travelHours }) : '—'}</span>
                  <span>{t(`cine.link.${link.state}`)}</span>
                </span>
              )}
            </Reveal>
          ))}
        </ol>
        <p className="hf-note">{t('cine.river.note')}</p>
      </section>

      <section className="hf-how" id="b-how" aria-labelledby="b-how-title">
        <Reveal className="hf-section-head">
          <p className="hf-kicker">
            <span className="hf-mono">02</span> {t('cine.nav.how')}
          </p>
          <h2 id="b-how-title">{t('cine.how.title')}</h2>
          <p>{t('cine.how.lead')}</p>
        </Reveal>
        <ol className="hf-pipeline">
          {([1, 2, 3] as const).map((n, i) => (
            <Reveal as="li" key={n} delay={i * 150}>
              <span className="hf-mono hf-pipe-n">0{n}</span>
              <h3>{t(`cine.step${n}.title`)}</h3>
              <p>{t(`cine.step${n}.text`)}</p>
            </Reveal>
          ))}
        </ol>
        <Reveal className="hf-final">
          <h2>{t('cine.slogan.full')}</h2>
          <div className="hf-ctas">
            <button type="button" className="hf-btn primary" onClick={cta.openSystem}>
              {t('cine.cta.open')}
              <span aria-hidden="true">↗</span>
            </button>
            <button type="button" className="hf-btn line" onClick={cta.watchDemo}>
              <span className="hf-play" aria-hidden="true" />
              {t('cine.cta.demo')}
            </button>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
