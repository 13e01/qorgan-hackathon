// Разделы главной страницы под первым экраном. Правило честности: всё, что подписано «Данные сервера», — из снимка
// (WebSocket) и БД; движение сигнала, бегущий свет по шкале и рисунки — иллюстрации и подписаны так. Ничего не
// рассчитывается заново: риск, тренд, угроза сверху и предупреждения уже посчитаны на backend.

import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useI18n, type MessageKey } from '../i18n';
import { chaikin, focusStation, smoothPath, waveTimeline, type AxisRiver } from '../lib/cinema';
import { alertLifecycle } from '../lib/flow';
import { QMark, Reveal, useCta, useLevelText, type useRiverLive } from './shared';
import shotAlerts from './shots/alerts.jpg';
import shotMap from './shots/map.jpg';
import shotOutlook from './shots/outlook.jpg';
import shotSimulator from './shots/simulator.jpg';
import shotStations from './shots/stations.jpg';

type Live = ReturnType<typeof useRiverLive>;

function Head({ n, kicker, title, lead, id }: { n: string; kicker: string; title: string; lead: string; id: string }) {
  return (
    <Reveal className="hf-section-head">
      <p className="hf-kicker">
        <span className="hf-mono">{n}</span> {kicker}
      </p>
      <h2 id={id}>{title}</h2>
      <p>{lead}</p>
    </Reveal>
  );
}

/** Метка «Данные сервера» у живого значения или «Схема» у иллюстрации. */
function Tag({ kind }: { kind: 'live' | 'scheme' }) {
  const { t } = useI18n();
  return <span className={`hf-tag hf-tag-${kind}`}>{t(kind === 'live' ? 'cine.tag.live' : 'cine.tag.scheme')}</span>;
}

// ── 02 · Как работает ───────────────────────────────────────────────────────────────────────────────────────

export function HowSection({ live }: { live: Live }) {
  const { t } = useI18n();
  const level = useLevelText();
  const focus = focusStation(live.flow);
  const active = live.alerts?.active ?? [];
  const first = active[0] ?? null;

  return (
    <section className="hf-sec hf-how" id="hf-how" aria-labelledby="hf-how-title">
      <Head n="02" kicker={t('cine.nav.how')} title={t('cine.how.title')} lead={t('cine.how.lead')} id="hf-how-title" />
      <ol className="hf-flow">
        <Reveal as="li" className="hf-stage" delay={0}>
          <div className="hf-stage-art hf-art-sensor" aria-hidden="true">
            <svg viewBox="0 0 240 150">
              <path className="hf-bank" d="M0 92 L70 80 L110 96 L240 98 L240 150 L0 150 Z" />
              <g className="hf-water">
                <path d="M-40 104 q15 -5 30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 V150 H-40 Z" />
              </g>
              <path className="hf-mast" d="M84 104 V34" />
              <rect className="hf-box" x="72" y="26" width="24" height="16" rx="3" />
              <path className="hf-gauge-tick" d="M84 104 h8 M84 92 h6 M84 80 h8 M84 68 h6 M84 56 h8" />
              <g className="hf-ping">
                <path d="M104 26 a14 14 0 0 1 0 20" />
                <path d="M110 20 a22 22 0 0 1 0 32" />
                <path d="M116 14 a30 30 0 0 1 0 44" />
              </g>
            </svg>
          </div>
          <span className="hf-mono hf-stage-n">01</span>
          <h3>{t('cine.step1.title')}</h3>
          <p>{t('cine.step1.text')}</p>
          <p className="hf-stage-live">
            <Tag kind="live" />
            {focus ? (
              <span>
                {focus.name}: <b className="num">{level(focus.levelCm)}</b>
                {focus.fromDevice && <> · {t('cine.how.device')}</>}
              </span>
            ) : (
              <span>{t('cine.live.empty')}</span>
            )}
          </p>
        </Reveal>

        <li className="hf-wire" aria-hidden="true">
          <span className="hf-packet" />
        </li>

        <Reveal as="li" className={`hf-stage cr-${focus?.risk ?? 'NO_DATA'}`} delay={140}>
          <div className="hf-stage-art hf-art-analysis" aria-hidden="true">
            <div className="hf-meter">
              <span className="hf-meter-fill" style={{ '--g': focus?.gauge ?? 0 } as CSSProperties} />
              {focus?.warningMark != null && <i className="hf-meter-mark warn" style={{ '--m': focus.warningMark } as CSSProperties} />}
              {focus?.dangerMark != null && <i className="hf-meter-mark danger" style={{ '--m': focus.dangerMark } as CSSProperties} />}
            </div>
            <div className="hf-meter-read">
              <span className="hf-meter-val num">{focus ? level(focus.levelCm) : t('common.noData')}</span>
              <span className="hf-meter-risk">{focus ? t(`risk.${focus.risk}`) : '—'}</span>
              <span className="hf-meter-trend">{focus?.trend ? `${t('trend.title')}: ${t(`trend.${focus.trend}`)}` : ''}</span>
              <span className="hf-meter-legend">
                <i className="warn" /> {t('cine.fig.warning')}
                <br />
                <i className="danger" /> {t('cine.fig.danger')}
              </span>
            </div>
          </div>
          <span className="hf-mono hf-stage-n">02</span>
          <h3>{t('cine.step2.title')}</h3>
          <p>{t('cine.step2.text')}</p>
          <p className="hf-stage-live">
            <Tag kind="live" />
            <span>{focus ? t('cine.how.analysis', { station: focus.name, risk: t(`risk.${focus.risk}`) }) : t('cine.live.empty')}</span>
          </p>
        </Reveal>

        <li className="hf-wire" aria-hidden="true">
          <span className="hf-packet" />
        </li>

        <Reveal as="li" className="hf-stage" delay={280}>
          <div className="hf-stage-art hf-art-alert" aria-hidden="true">
            {first ? (
              <div className={`hf-alert cr-${first.severity}`}>
                <span className="hf-alert-sev">{t(`risk.${first.severity}`)}</span>
                <b>{first.stationName}</b>
                <span className="hf-alert-why">{t(`alert.trigger.${first.trigger}`)}</span>
                <ol className="hf-life">
                  {alertLifecycle(first.status).map((s) => (
                    <li key={s.status} className={`is-${s.step}`}>
                      {t(`alert.status.${s.status}`)}
                    </li>
                  ))}
                </ol>
              </div>
            ) : (
              <div className="hf-alert is-calm">
                <QMark size={34} />
                <b>{t('cine.how.noAlerts')}</b>
                <span className="hf-alert-why">{t('cine.how.watching')}</span>
              </div>
            )}
          </div>
          <span className="hf-mono hf-stage-n">03</span>
          <h3>{t('cine.step3.title')}</h3>
          <p>{t('cine.step3.text')}</p>
          <p className="hf-stage-live">
            <Tag kind="live" />
            <span>{live.alerts ? t('cine.how.alerts', { n: active.length, u: live.alerts.unhandled }) : t('common.noData')}</span>
          </p>
        </Reveal>
      </ol>
      <p className="hf-note">
        <Tag kind="scheme" /> {t('cine.how.note')}
      </p>
    </section>
  );
}

// ── 03 · Путь волны ─────────────────────────────────────────────────────────────────────────────────────────

export function WaveSection({ live }: { live: Live }) {
  const { t } = useI18n();
  const level = useLevelText();
  const tl = useMemo(() => waveTimeline(live.flow), [live.flow]);
  const nodes = new Map(live.flow.nodes.map((n) => [n.code, n]));
  const at = new Map(tl.stops.map((s) => [s.code, s.at]));
  const threat = tl.threat;
  const head = live.flow.nodes[0];
  const tail = live.flow.nodes[live.flow.nodes.length - 1];
  const name = (code: string | undefined) => (code ? (nodes.get(code)?.name ?? code) : '—');
  // Участок угрозы на шкале (от станции-источника до станции ниже) и бегущий свет — по нему или по всей реке.
  const span = threat ? { a: at.get(threat.from) ?? 0, b: at.get(threat.to) ?? 1 } : null;
  const tone = threat?.risk === 'HIGH' ? 'HIGH' : 'MEDIUM';
  // Станции рядом на шкале (например, +102 ч и +119 ч) — подпись средней уходит над линией, чтобы не наезжать.
  const up = tl.stops.map((s, i) => i > 0 && i < tl.stops.length - 1 && tl.stops[i + 1]!.at - s.at < 0.24);

  return (
    <section className="hf-sec hf-wave" id="hf-wave" aria-labelledby="hf-wave-title">
      <Head n="03" kicker={t('cine.nav.wave')} title={t('cine.wave.title')} lead={t('cine.river.text')} id="hf-wave-title" />

      <Reveal className={`hf-track${threat ? ` has-threat cr-${tone}` : ''}${up.some(Boolean) ? ' has-up' : ''}`}>
        <div className="hf-track-rail" aria-hidden="true">
          <span className="hf-track-flow" />
          {span && <span className={`hf-track-threat${threat!.arrived ? ' is-arrived' : ''}`} style={{ '--a': span.a, '--b': span.b } as CSSProperties} />}
          <span className="hf-track-pulse" style={(span ? { '--a': span.a, '--b': span.b } : { '--a': 0, '--b': 1 }) as CSSProperties} />
        </div>
        <ol className="hf-track-stops">
          {tl.stops.map((s, i) => {
            const n = nodes.get(s.code)!;
            const out = live.flow.links.find((l) => l.from === s.code);
            return (
              <li key={s.code} className={`cr-${n.risk}${n.next ? ' is-next' : ''}${up[i] ? ' is-up' : ''}${out ? ` link-${out.state} lr-${out.risk ?? 'LOW'}` : ''}`} style={{ '--at': s.at } as CSSProperties}>
                <span className="hf-track-dot" aria-hidden="true" />
                <span className="hf-track-h hf-mono">{s.hoursFromHead === null ? '—' : i === 0 ? t('cine.wave.start') : `+${s.hoursFromHead} ${t('unit.h')}`}</span>
                <b>{n.name}</b>
                <span className="hf-mono hf-track-code">{n.code}</span>
                <span className="num hf-track-val">
                  {level(n.levelCm)} · {n.levelCm === null ? '' : t(`risk.${n.risk}`)}
                </span>
                {n.next && <span className="hf-track-next">{t('cine.live.next')}</span>}
              </li>
            );
          })}
        </ol>
      </Reveal>

      <div className="hf-wave-cards">
        <Reveal className="hf-card" delay={0}>
          <span className="hf-mono hf-card-n">A</span>
          <h3>{t('cine.wave.where')}</h3>
          <p>{threat ? t('cine.wave.whereThreat', { station: name(threat.from), risk: threat.risk ? t(`risk.${threat.risk}`) : '—' }) : t('cine.wave.whereCalm')}</p>
          <Tag kind="live" />
        </Reveal>
        <Reveal className="hf-card" delay={100}>
          <span className="hf-mono hf-card-n">B</span>
          <h3>{t('cine.wave.next')}</h3>
          <p>
            {threat
              ? threat.arrived
                ? t('cine.wave.nextArrived', { station: name(threat.to) })
                : t('cine.wave.nextThreat', { station: name(threat.to), h: threat.travelHours })
              : t('cine.wave.nextCalm', { from: name(head?.code), to: name(live.flow.nodes[1]?.code) })}
          </p>
          <Tag kind="live" />
        </Reveal>
        <Reveal className="hf-card" delay={200}>
          <span className="hf-mono hf-card-n">C</span>
          <h3>{t('cine.wave.forecast')}</h3>
          <p>{t('cine.wave.forecastText')}</p>
        </Reveal>
        <Reveal className="hf-card" delay={300}>
          <span className="hf-mono hf-card-n">D</span>
          <h3>{t('cine.wave.why')}</h3>
          <p>{tl.totalHours !== null ? t('cine.wave.whyText', { from: name(head?.code), to: name(tail?.code), h: tl.totalHours }) : t('cine.wave.whyNoData')}</p>
        </Reveal>
      </div>
      <p className="hf-note">
        <Tag kind="scheme" /> {t('cine.wave.note')}
      </p>
    </section>
  );
}

// ── 04 · Настоящая система ──────────────────────────────────────────────────────────────────────────────────

const SHOTS: Array<{ id: string; src: string; route: string; tab: MessageKey; title: MessageKey; text: MessageKey }> = [
  { id: 'map', src: shotMap, route: '#/dashboard', tab: 'cine.product.map', title: 'cine.product.mapTitle', text: 'cine.product.mapText' },
  { id: 'alerts', src: shotAlerts, route: '#/alerts', tab: 'cine.product.alerts', title: 'cine.product.alertsTitle', text: 'cine.product.alertsText' },
  { id: 'outlook', src: shotOutlook, route: '#/outlook', tab: 'cine.product.outlook', title: 'cine.product.outlookTitle', text: 'cine.product.outlookText' },
  { id: 'stations', src: shotStations, route: '#/stations', tab: 'cine.product.stations', title: 'cine.product.stationsTitle', text: 'cine.product.stationsText' },
  { id: 'simulator', src: shotSimulator, route: '#/simulator', tab: 'cine.product.simulator', title: 'cine.product.simulatorTitle', text: 'cine.product.simulatorText' },
];

export function ProductSection() {
  const { t } = useI18n();
  const cta = useCta();
  const [cur, setCur] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const shot = SHOTS[cur]!;

  // Вкладки по правилам WAI-ARIA: стрелки, Home, End.
  const onKey = (e: KeyboardEvent) => {
    const last = SHOTS.length - 1;
    const next = e.key === 'ArrowRight' ? (cur === last ? 0 : cur + 1) : e.key === 'ArrowLeft' ? (cur === 0 ? last : cur - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
    if (next === null) return;
    e.preventDefault();
    setCur(next);
    tabs.current[next]?.focus();
  };

  return (
    <section className="hf-sec hf-product" id="hf-product" aria-labelledby="hf-product-title">
      <Head n="04" kicker={t('cine.nav.product')} title={t('cine.product.title')} lead={t('cine.product.text')} id="hf-product-title" />
      <Reveal className="hf-shot-wrap">
        <div className="hf-tabs" role="tablist" aria-label={t('cine.product.tabs')} onKeyDown={onKey}>
          {SHOTS.map((s, i) => (
            <button
              key={s.id}
              ref={(el) => void (tabs.current[i] = el)}
              type="button"
              role="tab"
              id={`hf-tab-${s.id}`}
              aria-selected={i === cur}
              aria-controls="hf-shot-panel"
              tabIndex={i === cur ? 0 : -1}
              onClick={() => setCur(i)}
            >
              <span className="hf-mono" aria-hidden="true">
                0{i + 1}
              </span>
              {t(s.tab)}
            </button>
          ))}
        </div>
        <div className="hf-shot-grid" role="tabpanel" id="hf-shot-panel" aria-labelledby={`hf-tab-${shot.id}`}>
          <figure className="hf-shot">
            <div className="hf-shot-bar" aria-hidden="true">
              <i />
              <i />
              <i />
              <span className="hf-mono">localhost:3000/{shot.route}</span>
            </div>
            <img key={shot.id} src={shot.src} alt={t(shot.title)} width={1440} height={900} loading="lazy" decoding="async" />
          </figure>
          <div className="hf-shot-text">
            <h3>{t(shot.title)}</h3>
            <p>{t(shot.text)}</p>
            <button
              type="button"
              className="hf-btn line"
              onPointerEnter={cta.prime}
              onClick={() => {
                cta.prime();
                location.hash = shot.route;
              }}
            >
              {t('cine.product.open')}
              <span aria-hidden="true">→</span>
            </button>
            <p className="hf-shot-note">{t('cine.product.note')}</p>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

// ── 05 · Финал ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Есиль через весь кадр (все фрагменты линии OSM, сглажено): только рисунок для финала, данных не несёт.
 * Ось «верхняя → нижняя станция» идёт слева направо, изгибы — по вертикали в том же масштабе.
 */
function riverLine(axis: AxisRiver, width: number, height: number): string {
  const wMid = axis.stations.length ? axis.stations.reduce((a, s) => a + s.w, 0) / axis.stations.length : 0;
  const x = (u: number) => ((u + 0.06) / 1.12) * width;
  return axis.lines
    .map((l) => chaikin(l, 2).filter((p) => p.u > -0.08 && p.u < 1.08))
    .filter((l) => l.length > 1)
    .map((l) => smoothPath(l.map((p) => ({ x: x(p.u), y: height / 2 + (p.w - wMid) * width * 0.55 }))))
    .join('');
}

export function FinalSection({ axis }: { axis: AxisRiver }) {
  const { t } = useI18n();
  const cta = useCta();
  const d = useMemo(() => riverLine(axis, 1200, 220), [axis]);
  return (
    <section className="hf-sec hf-end" id="hf-end" aria-labelledby="hf-end-title">
      <Reveal className="hf-end-card">
        <svg className="hf-end-river" viewBox="0 0 1200 220" preserveAspectRatio="none" aria-hidden="true">
          <path className="glow" d={d} />
          <path className="core" d={d} />
          <path className="flow" d={d} />
        </svg>
        <p className="hf-kicker">
          <span className="hf-mono">05</span> QORGAN
        </p>
        <h2 id="hf-end-title">{t('cine.slogan.full')}</h2>
        <p className="hf-end-lead">{t('cine.end.lead')}</p>
        <div className="hf-ctas">
          <button type="button" className="hf-btn primary" onClick={cta.openSystem} onPointerEnter={cta.prime} onFocus={cta.prime}>
            {t('cine.cta.open')}
            <span aria-hidden="true">↗</span>
          </button>
          <button type="button" className="hf-btn line" onClick={cta.watchDemo}>
            <span className="hf-play" aria-hidden="true" />
            {t('cine.cta.demo')}
          </button>
        </div>
        <p className="hf-hint">{t('cine.cta.demoHint')}</p>
      </Reveal>
      <footer className="hf-foot">
        <span className="hf-foot-brand">
          <QMark size={20} /> QORGAN
        </span>
        <span>{t('cine.end.foot')}</span>
        <span className="hf-mono" title={t('risk.model')}>
          {t('top.demoShort')}
        </span>
      </footer>
    </section>
  );
}
