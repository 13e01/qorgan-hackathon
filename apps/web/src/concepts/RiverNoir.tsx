// Концепция A — RIVER NOIR. Ночная сцена с высоты: Есиль (геометрия OSM) — светящаяся линия на тёмном рельефе,
// «шторки» кадра расходятся, заголовок выезжает из-под маски. Станции и их риск — из снимка сервера.
// Горизонтали рельефа — декоративные (детерминированный шум), это не топография.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '../i18n';
import { dms, riverAxis, riverChain, smoothPath, sweepRiver } from '../lib/cinema';
import river from '../map/esil-river.json';
import { CineLang, FullMenu, MaskedLines, QMark, Reveal, scrollToId, useCta, useLevelText, useRiverLive, useStill, useVisible } from './shared';

/** Детерминированный «шум» для горизонталей (без Math.random). */
const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

function contours(w: number, h: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < 16; i++) {
    const y0 = (h / 16) * (i + 0.5);
    const a1 = 18 + hash(i) * 34;
    const a2 = 8 + hash(i + 40) * 16;
    const p1 = hash(i + 9) * Math.PI * 2;
    const p2 = hash(i + 19) * Math.PI * 2;
    let d = '';
    for (let x = -40; x <= w + 40; x += 40) {
      const y = y0 + a1 * Math.sin((x / w) * Math.PI * 2.2 + p1) + a2 * Math.sin((x / w) * Math.PI * 6 + p2);
      d += `${x === -40 ? 'M' : 'L'}${x} ${y.toFixed(1)}`;
    }
    out.push(d);
  }
  return out;
}

function usePortrait() {
  const q = '(max-aspect-ratio: 4/5)';
  const [p, setP] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const on = () => setP(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return p;
}

export function RiverNoir() {
  const { t } = useI18n();
  const cta = useCta();
  const live = useRiverLive();
  const level = useLevelText();
  const { still } = useStill();
  const [menu, setMenu] = useState(false);
  const portrait = usePortrait();
  const [W, H] = portrait ? [900, 1600] : [1600, 900];
  const framed = useMemo(() => sweepRiver(riverAxis(river, live.stations, 9), W, H, portrait), [live.stations, W, H, portrait]);
  const d = useMemo(() => framed.lines.map(smoothPath).join(''), [framed]);
  const lines = useMemo(() => contours(W, H), [W, H]);
  const [sceneRef, visible] = useVisible<HTMLElement>();

  // Лёгкий параллакс от курсора: только переменные CSS, один кадр на событие.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || still) return;
    let raf = 0;
    const on = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.style.setProperty('--px', ((e.clientX / innerWidth - 0.5) * 2).toFixed(3));
        el.style.setProperty('--py', ((e.clientY / innerHeight - 0.5) * 2).toFixed(3));
      });
    };
    window.addEventListener('pointermove', on);
    return () => (window.removeEventListener('pointermove', on), cancelAnimationFrame(raf));
  }, [still]);

  const head = live.stations.find((s) => !s.upstreamCode);
  const tail = live.stations.find((s) => !live.stations.some((o) => o.upstreamCode === s.code));
  const chain = riverChain(live.flow);
  const links = [
    { id: 'a-how', key: 'cine.nav.how' as const },
    { id: 'a-river', key: 'cine.nav.river' as const },
  ];

  return (
    <div className={`noir${visible ? '' : ' is-paused'}`} ref={rootRef}>
      <header className="noir-nav">
        <button type="button" className="noir-brand" onClick={() => scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' })}>
          <QMark size={26} />
          <span>QORGAN</span>
        </button>
        <nav className="noir-links" aria-label={t('cine.nav.label')}>
          {links.map((l) => (
            <button key={l.id} type="button" onClick={() => scrollToId(l.id)}>
              {t(l.key)}
            </button>
          ))}
        </nav>
        <div className="noir-tools">
          <CineLang />
          <button type="button" className="noir-nav-cta" onClick={cta.openSystem}>
            {t('cine.cta.open')}
          </button>
          <button type="button" className="noir-burger" onClick={() => setMenu(true)} aria-expanded={menu}>
            <span aria-hidden="true" />
            {t('cine.nav.menu')}
          </button>
        </div>
      </header>
      <FullMenu open={menu} onClose={() => setMenu(false)} links={links} className="noir-menu">
        <CineLang />
        <button type="button" className="noir-btn primary" onClick={cta.openSystem}>
          {t('cine.cta.open')}
        </button>
      </FullMenu>

      <section className="noir-hero" ref={sceneRef}>
        <div className="noir-scene" aria-hidden="true">
          <svg className="noir-layer noir-contours" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
            {lines.map((c, i) => (
              <path key={i} d={c} pathLength={1} style={{ '--i': i } as CSSProperties} />
            ))}
          </svg>
          <svg className="noir-layer noir-river" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
            <defs>
              <filter id="noir-glow" x="-10%" y="-10%" width="120%" height="120%">
                <feGaussianBlur stdDeviation="22" />
              </filter>
              <linearGradient id="noir-ink" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0" stopColor="#6fb6ff" stopOpacity=".55" />
                <stop offset=".55" stopColor="#dbeeff" />
                <stop offset="1" stopColor="#8ec9ff" stopOpacity=".7" />
              </linearGradient>
            </defs>
            <path d={d} pathLength={1} className="noir-river-glow" filter="url(#noir-glow)" />
            <path d={d} pathLength={1} className="noir-river-body" />
            <path d={d} pathLength={1} className="noir-river-core" stroke="url(#noir-ink)" />
            <path d={d} pathLength={1} className="noir-river-pulse" />
            {framed.stations.map((s, i) => {
              const node = live.flow.nodes.find((n) => n.code === s.code);
              // Подпись — только внутри безопасной зоны кадра (не под меню и не за краем); точка видна всегда.
              const labelled = !portrait && s.x > 40 && s.x < W - (portrait ? 330 : 260) && s.y > (portrait ? 260 : 150) && s.y < H - 90;
              return (
                <g key={s.code} className={`noir-st cr-${node?.risk ?? 'NO_DATA'}${node?.next ? ' is-next' : ''}`} style={{ '--d': `${1500 + i * 260}ms` } as CSSProperties} transform={`translate(${s.x.toFixed(1)} ${s.y.toFixed(1)})`}>
                  <circle className="noir-st-ring" r={portrait ? 22 : 16} />
                  <circle className="noir-st-dot" r={portrait ? 6 : 4.5} />
                  {labelled && (
                    <text x={portrait ? 34 : 26} y={portrait ? 9 : 6} className="noir-st-name">
                      {node?.name ?? s.code}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          <div className="noir-vignette" />
          <div className="noir-grain" />
        </div>
        <div className="noir-bar top" aria-hidden="true" />
        <div className="noir-bar bottom" aria-hidden="true" />

        {head && tail && (
          <p className="noir-coords" aria-hidden="true">
            <span>{dms(head.lat, 'N', 'S')} · {dms(head.lon, 'E', 'W')}</span>
            <span className="noir-coords-arrow">{t('cine.flow')} →</span>
            <span>{dms(tail.lat, 'N', 'S')} · {dms(tail.lon, 'E', 'W')}</span>
          </p>
        )}

        <div className="noir-copy">
          <p className="noir-eyebrow">
            <span className="noir-rule" aria-hidden="true" />
            {t('app.region')}
          </p>
          <MaskedLines className="noir-title" lines={[t('cine.slogan.1'), t('cine.slogan.2')]} start={900} step={140} />
          <p className="noir-lead">{t('cine.lead')}</p>
          <div className="noir-ctas">
            <button type="button" className="noir-btn primary" onClick={cta.openSystem}>
              {t('cine.cta.open')}
              <span aria-hidden="true">→</span>
            </button>
            <button type="button" className="noir-btn ghost" onClick={cta.watchDemo}>
              <span className="noir-play" aria-hidden="true" />
              <span>
                {t('cine.cta.demo')}
                <small>{t('cine.cta.demoHint')}</small>
              </span>
            </button>
          </div>
        </div>

        <aside className="noir-live" aria-label={t('cine.live.title')}>
          <div className="noir-live-head">
            <span>{t('cine.live.title')}</span>
            <span className={`noir-live-conn${live.online ? ' on' : ''}`}>{live.online ? t('cine.live.online') : t('cine.live.offline')}</span>
          </div>
          {live.hasData ? (
            <ol>
              {live.flow.nodes.map((n) => (
                <li key={n.code} className={`cr-${n.risk}${n.next ? ' is-next' : ''}`}>
                  <span className="noir-live-dot" aria-hidden="true" />
                  <span className="noir-live-name">{n.name}</span>
                  <span className="noir-live-val num">{level(n.levelCm)}</span>
                  <span className="noir-live-risk">{n.next ? t('cine.live.next') : t(`risk.${n.risk}`)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="noir-live-empty">{t('cine.live.empty')}</p>
          )}
          <p className="noir-live-badge" title={t('risk.model')}>
            {t('top.demoShort')}
          </p>
        </aside>

        <button type="button" className="noir-scroll" onClick={() => scrollToId('a-how')}>
          <span>{t('cine.scroll')}</span>
          <span className="noir-scroll-line" aria-hidden="true" />
        </button>
      </section>

      <section className="noir-how" id="a-how" aria-labelledby="a-how-title">
        <Reveal className="noir-section-head">
          <p className="noir-kicker">01 — 03</p>
          <h2 id="a-how-title">{t('cine.how.title')}</h2>
          <p>{t('cine.how.lead')}</p>
        </Reveal>
        <ol className="noir-steps">
          {([1, 2, 3] as const).map((n, i) => (
            <Reveal as="li" key={n} delay={i * 140} className="noir-step">
              <span className="noir-step-n" aria-hidden="true">
                0{n}
              </span>
              <h3>{t(`cine.step${n}.title`)}</h3>
              <p>{t(`cine.step${n}.text`)}</p>
            </Reveal>
          ))}
        </ol>
      </section>

      <section className="noir-chain" id="a-river" aria-labelledby="a-river-title">
        <Reveal className="noir-section-head">
          <p className="noir-kicker">{t('cine.flow')}</p>
          <h2 id="a-river-title">{t('cine.river.title')}</h2>
          <p>{t('cine.river.text')}</p>
        </Reveal>
        <ol className="noir-chain-list">
          {chain.map(({ node, link }, i) => (
            <Reveal as="li" key={node.code} delay={i * 120} className={`cr-${node.risk}`}>
              <span className="noir-chain-name">{node.name}</span>
              <span className="noir-chain-meta num">
                {level(node.levelCm)} · {t(`risk.${node.risk}`)}
              </span>
              {link && (
                <span className={`noir-chain-link link-${link.state}`}>
                  <span className="noir-chain-line" aria-hidden="true" />
                  {link.travelHours !== null && t('cine.river.travel', { h: link.travelHours })} · {t(`cine.link.${link.state}`)}
                </span>
              )}
            </Reveal>
          ))}
        </ol>
        <p className="noir-note">{t('cine.river.note')}</p>
        <Reveal className="noir-final">
          <QMark size={44} />
          <h2>{t('cine.slogan.full')}</h2>
          <p>{t('cine.product.text')}</p>
          <div className="noir-ctas center">
            <button type="button" className="noir-btn primary" onClick={cta.openSystem}>
              {t('cine.cta.open')}
              <span aria-hidden="true">→</span>
            </button>
            <button type="button" className="noir-btn ghost" onClick={cta.watchDemo}>
              <span className="noir-play" aria-hidden="true" />
              <span>{t('cine.cta.demo')}</span>
            </button>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
