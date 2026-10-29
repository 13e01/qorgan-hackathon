// Главная страница HYDRO FUTURE (выбранная концепция B). Приборная глубина: Есиль (OSM) уходит к горизонту, по
// руслу течёт поток частиц (RiverScene), внизу — приборная полоса станций. Все значения — из снимка сервера и БД;
// разделы ниже: 02 «Как работает», 03 «Путь волны», 04 «Настоящая система», 05 — финал.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useI18n, type MessageKey } from '../i18n';
import { riverAxis, riverChain, totalTravelHours, type AxisRiver } from '../lib/cinema';
import type { RiverFlow } from '../lib/flow';
import river from '../map/esil-river.json';
import { RiverScene } from './RiverScene';
import { FinalSection, HowSection, ProductSection, WaveSection } from './sections';
import { CineLang, CountUp, FullMenu, QMark, scrollToId, useCta, useLevelText, useRiverLive, useStill, useVisible, Words } from './shared';

/** Разделы страницы: номер в навигации совпадает с номером раздела (01 — первый экран). */
export const SECTIONS: Array<{ id: string; key: MessageKey }> = [
  { id: 'hf-how', key: 'cine.nav.how' },
  { id: 'hf-wave', key: 'cine.nav.wave' },
  { id: 'hf-product', key: 'cine.nav.product' },
];

/** React-обёртка сцены: один RiverScene на холст, данные и условия движения передаются ему, без пересоздания. */
function RiverDepth({ axis, flow, still }: { axis: AxisRiver; flow: RiverFlow; still: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [wrapRef, visible] = useVisible<HTMLDivElement>();
  const sceneRef = useRef<RiverScene | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = new RiverScene(canvas, axis);
    sceneRef.current = scene;
    const ro = new ResizeObserver(() => scene.resize());
    ro.observe(canvas);
    scene.resize();
    return () => {
      ro.disconnect();
      scene.destroy();
      sceneRef.current = null;
    };
  }, [axis]);

  useEffect(() => sceneRef.current?.setFlow(flow), [flow, axis]);
  useEffect(() => sceneRef.current?.setMotion(!still), [still, axis]);
  useEffect(() => sceneRef.current?.setVisible(visible), [visible, axis]);

  return (
    <div className="hf-depth" ref={wrapRef} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}

/** Какой раздел сейчас в кадре — для подсветки пункта навигации. */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        setActive(ids.find((id) => seen.get(id)) ?? null);
      },
      { rootMargin: '-45% 0px -50% 0px' },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [ids]);
  return active;
}

export function HydroFuture() {
  const { t } = useI18n();
  const cta = useCta();
  const live = useRiverLive();
  const level = useLevelText();
  const { still } = useStill();
  const [menu, setMenu] = useState(false);
  const closeMenu = useCallback(() => setMenu(false), []);
  const [scrolled, setScrolled] = useState(false);
  const axis = useMemo(() => riverAxis(river, live.stations), [live.stations]);
  const chain = riverChain(live.flow);
  const hours = totalTravelHours(live.flow);
  const ids = useMemo(() => SECTIONS.map((s) => s.id), []);
  const active = useActiveSection(ids);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  // Бесконечные CSS-анимации раздела (сигнал, волны, бегущий свет) идут только пока раздел рядом с экраном.
  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) (e.target as HTMLElement).toggleAttribute('data-on', e.isIntersecting);
      },
      { rootMargin: '120px 0px' },
    );
    document.querySelectorAll('.hf-sec').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  // Файл рабочей системы — заранее, когда браузер свободен: «Открыть систему» откроется без ожидания.
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(cta.prime);
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(cta.prime, 2500);
    return () => window.clearTimeout(id);
  }, [cta.prime]);

  return (
    <div className="hf">
      <a className="hf-skip" href="#hf-main" onClick={(e) => (e.preventDefault(), scrollToId('hf-main'))}>
        {t('common.skip')}
      </a>
      <header className={`hf-nav${scrolled ? ' is-scrolled' : ''}`}>
        <button type="button" className="hf-brand" onClick={() => scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' })} aria-label={t('cine.nav.top')}>
          <QMark size={24} />
          <span>QORGAN</span>
        </button>
        <nav className="hf-links" aria-label={t('cine.nav.label')}>
          {SECTIONS.map((l, i) => (
            <button key={l.id} type="button" onClick={() => scrollToId(l.id)} aria-current={active === l.id ? 'true' : undefined}>
              <span className="hf-mono" aria-hidden="true">
                0{i + 2}
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
          <button type="button" className="hf-btn primary sm" onClick={cta.openSystem} onPointerEnter={cta.prime} onFocus={cta.prime}>
            {t('cine.cta.open')}
          </button>
          <button type="button" className="hf-burger" onClick={() => setMenu(true)} aria-expanded={menu} aria-haspopup="dialog">
            <span className="hf-burger-lines" aria-hidden="true" />
            {t('cine.nav.menu')}
          </button>
        </div>
      </header>
      <FullMenu open={menu} onClose={closeMenu} links={SECTIONS} first={2} className="hf-menu">
        <CineLang />
        <button type="button" className="hf-btn primary" onClick={() => (setMenu(false), cta.openSystem())}>
          {t('cine.cta.open')}
        </button>
      </FullMenu>

      <main id="hf-main" tabIndex={-1}>
        <section className="hf-hero" aria-labelledby="hf-title">
          <div className="hf-grid-bg" aria-hidden="true" />
          <RiverDepth axis={axis} flow={live.flow} still={still} />
          <div className="hf-copy">
            <p className="hf-kicker">
              <span className="hf-mono">01</span>
              {chain.length > 1 && (
                <span className="hf-mono">
                  {chain[0]!.node.code} → {chain[chain.length - 1]!.node.code}
                </span>
              )}
              {t('cine.c.kicker')}
            </p>
            <h1 className="hf-title" id="hf-title" aria-label={t('cine.slogan.full')}>
              <span aria-hidden="true">
                <Words text={t('cine.slogan.1')} start={250} />
                <br />
                <span className="hf-title-accent">
                  <Words text={t('cine.slogan.2')} start={520} />
                </span>
              </span>
            </h1>
            <p className="hf-lead">{t('cine.lead')}</p>
            <div className="hf-ctas">
              <button type="button" className="hf-btn primary" onClick={cta.openSystem} onPointerEnter={cta.prime} onFocus={cta.prime}>
                {t('cine.cta.open')}
                <span aria-hidden="true">↗</span>
              </button>
              <button type="button" className="hf-btn line" onClick={cta.watchDemo} onPointerEnter={cta.prime}>
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
            {live.flow.nodes.length === 0 && <li className="hf-cell-empty">{live.online ? t('common.loading') : t('cine.live.offline')}</li>}
            {live.flow.nodes.map((n, i) => (
              <li key={n.code} className={`cr-${n.risk}${n.next ? ' is-next' : ''}`} style={{ '--d': `${900 + i * 90}ms` } as CSSProperties}>
                <span className="hf-cell-code hf-mono">{n.code}</span>
                <span className="hf-cell-name">{n.name}</span>
                <span className="hf-cell-val num">{level(n.levelCm)}</span>
                <span className="hf-cell-gauge" aria-hidden="true">
                  <span style={{ '--g': n.gauge ?? 0 } as CSSProperties} />
                  {n.dangerMark !== null && <i style={{ '--m': n.dangerMark } as CSSProperties} />}
                </span>
                <span className="hf-cell-risk">{n.levelCm === null ? t('common.noData') : n.next ? t('cine.live.next') : t(`risk.${n.risk}`)}</span>
              </li>
            ))}
            <li className="hf-cell-badge" title={t('risk.model')}>
              {t('top.demoShort')}
            </li>
          </ul>
        </section>

        <HowSection live={live} />
        <WaveSection live={live} />
        <ProductSection />
        <FinalSection axis={axis} />
      </main>
    </div>
  );
}
