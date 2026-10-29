// Концепция C — EDITORIAL WATER. Светлая редакционная вёрстка: антиква Source Serif 4, линейки, «рисунок 1» —
// гравюра воды в разрезе русла. Уровень воды на рисунке — последнее измерение станции из снимка сервера (доля от
// опасного порога, как столбик «Живой реки»), пороги — учебные значения из БД. Профиль берегов — схема.

import { useMemo, useState, type CSSProperties } from 'react';
import { useTween } from '../components/motion';
import { useI18n } from '../i18n';
import { riverChain } from '../lib/cinema';
import type { FlowNode } from '../lib/flow';
import { CineLang, FullMenu, MaskedLines, QMark, Reveal, scrollToId, useCta, useLevelText, useRiverLive, useStill } from './shared';

const FW = 640;
const FH = 440;
const BOTTOM = 372; // дно русла на рисунке
const TOP = 172; // бровка берега = верх шкалы (опасный порог + 25 %)
const PROFILE = 'M0 168L84 176L160 214L214 300L268 352L320 372L372 352L426 300L480 214L556 176L640 168';

/** Линии гравюры: периодичны по ширине рисунка, поэтому сдвиг на FW бесшовный. */
function engraving(): Array<{ d: string; w: number }> {
  const out: Array<{ d: string; w: number }> = [];
  for (let i = 0; i < 44; i++) {
    const y0 = TOP - 10 + i * 5.2;
    const a = 2.2 + (i % 5) * 0.35;
    const ph = i * 0.55;
    let d = '';
    for (let x = 0; x <= FW * 2; x += 10) {
      const y = y0 + a * Math.sin((x / FW) * Math.PI * 2 * 3 + ph) + 1.1 * Math.sin((x / FW) * Math.PI * 2 * 7 - ph * 1.7);
      d += `${x ? 'L' : 'M'}${x} ${y.toFixed(2)}`;
    }
    out.push({ d, w: 0.45 + (i / 44) * 1.15 });
  }
  return out;
}

const yOf = (g: number) => BOTTOM - g * (BOTTOM - TOP);

function Figure({ node, base }: { node: FlowNode | null; base: number | null }) {
  const { t } = useI18n();
  const level = useLevelText();
  const { still } = useStill();
  const lines = useMemo(engraving, []);
  const gauge = useTween(node?.gauge ?? null);
  const hasLevel = gauge !== null;
  const waterY = yOf(gauge ?? base ?? 0.32);
  const marks = [
    { key: 'cine.fig.warning' as const, m: node?.warningMark ?? null, cls: 'warn' },
    { key: 'cine.fig.danger' as const, m: node?.dangerMark ?? null, cls: 'danger' },
  ];
  return (
    <figure className="ed-fig">
      <svg viewBox={`0 112 ${FW} ${FH - 140}`} role="img" aria-label={t('cine.fig.caption', { station: node?.name ?? '—' })}>
        <defs>
          <pattern id="ed-earth" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(38)">
            <path d="M0 0V7" className="ed-earth-line" />
          </pattern>
          <clipPath id="ed-channel">
            <path d={`${PROFILE}V0H0Z`} />
          </clipPath>
          <clipPath id="ed-water">
            <rect x="0" y={waterY} width={FW} height={FH - waterY} />
          </clipPath>
        </defs>
        <path d={`${PROFILE}V${FH}H0Z`} fill="url(#ed-earth)" />
        <g clipPath="url(#ed-channel)">
          <g clipPath="url(#ed-water)">
            <rect x="0" y={waterY} width={FW} height={FH - waterY} className="ed-water-bg" />
            <g className={`ed-hatch${still ? '' : ' is-moving'}${hasLevel ? '' : ' is-faint'}`}>
              {lines.map((l, i) => (
                <path key={i} d={l.d} strokeWidth={l.w} />
              ))}
            </g>
          </g>
        </g>
        <path d={PROFILE} className="ed-profile" />
        {/* Рейка без чисел — только деления шкалы рисунка (0…опасный порог + 25 %). */}
        <g className="ed-staff">
          <path d={`M300 ${BOTTOM}V${TOP}`} />
          {Array.from({ length: 11 }, (_, i) => (
            <path key={i} d={`M300 ${yOf(i / 10)}h${i % 5 === 0 ? 14 : 7}`} />
          ))}
        </g>
        {marks.map(
          (mk) =>
            mk.m !== null && (
              <g key={mk.cls} className={`ed-mark ${mk.cls}`}>
                <path d={`M24 ${yOf(mk.m)}H${FW - 24}`} />
                <text x={FW - 24} y={yOf(mk.m) - 7} textAnchor="end">
                  {t(mk.key)}
                </text>
              </g>
            ),
        )}
        {hasLevel && (
          <g className="ed-level">
            <path d={`M150 ${waterY}H490`} />
            <circle cx="320" cy={waterY} r="4" />
            <text x="320" y={waterY - 12} textAnchor="middle">
              {t('cine.fig.level')}: {level(node?.levelCm ?? null)}
            </text>
          </g>
        )}
        {!hasLevel && (
          <text x="320" y={TOP - 22} textAnchor="middle" className="ed-nodata">
            {t('common.noData')}
          </text>
        )}
      </svg>
      <figcaption>
        <span className="ed-fig-n">{t('cine.fig.caption', { station: node?.name ?? '—' })}</span>
        <span className="ed-fig-badge" title={t('risk.model')}>
          {t('top.demoShort')}
        </span>
      </figcaption>
    </figure>
  );
}

export function EditorialWater() {
  const { t } = useI18n();
  const cta = useCta();
  const live = useRiverLive();
  const level = useLevelText();
  const [menu, setMenu] = useState(false);
  const chain = riverChain(live.flow);
  const nodes = live.flow.nodes;
  // Рисунок показывает самую тревожную станцию; если всё спокойно — следующую под угрозой; иначе — середину реки.
  const focus = (live.worst && live.worst.risk !== 'LOW' ? live.worst : null) ?? nodes.find((n) => n.next) ?? nodes[Math.floor(nodes.length / 2)] ?? null;
  const meta = live.stations.find((s) => s.code === focus?.code);
  const base = meta?.baseLevelCm != null && focus?.dangerCm ? Math.min(1, meta.baseLevelCm / (focus.dangerCm * 1.25)) : null;
  const links = [
    { id: 'c-how', key: 'cine.nav.how' as const },
    { id: 'c-river', key: 'cine.nav.river' as const },
  ];

  return (
    <div className="ed">
      <header className="ed-mast">
        <div className="ed-mast-top">
          <span>{t('cine.c.issue')} · 01</span>
          <span className="ed-mast-region">{t('app.region')}</span>
          <CineLang />
        </div>
        <div className="ed-mast-main">
          <button type="button" className="ed-brand" onClick={() => scrollTo({ top: 0 })}>
            <QMark size={30} />
            <span>QORGAN</span>
          </button>
          <nav className="ed-links" aria-label={t('cine.nav.label')}>
            {links.map((l) => (
              <button key={l.id} type="button" onClick={() => scrollToId(l.id)}>
                {t(l.key)}
              </button>
            ))}
          </nav>
          <button type="button" className="ed-btn dark sm" onClick={cta.openSystem}>
            {t('cine.cta.open')}
          </button>
          <button type="button" className="ed-burger" onClick={() => setMenu(true)} aria-expanded={menu}>
            {t('cine.nav.menu')}
          </button>
        </div>
      </header>
      <FullMenu open={menu} onClose={() => setMenu(false)} links={links} className="ed-menu">
        <CineLang />
        <button type="button" className="ed-btn dark" onClick={cta.openSystem}>
          {t('cine.cta.open')}
        </button>
      </FullMenu>

      <section className="ed-hero">
        <p className="ed-kicker">
          <span>{t('cine.c.kicker')}</span>
        </p>
        <MaskedLines className="ed-title" label={t('cine.slogan.full')} lines={[t('cine.slogan.1'), <em key="em">{t('cine.slogan.2')}</em>]} start={250} step={150} />
        <div className="ed-grid">
          <div className="ed-col">
            <p className="ed-lead">{t('cine.lead')}</p>
            <div className="ed-ctas">
              <button type="button" className="ed-btn dark" onClick={cta.openSystem}>
                {t('cine.cta.open')}
                <span aria-hidden="true">→</span>
              </button>
              <button type="button" className="ed-link" onClick={cta.watchDemo}>
                {t('cine.cta.demo')}
                <span aria-hidden="true">↘</span>
              </button>
            </div>
            <p className="ed-hint">{t('cine.cta.demoHint')}</p>
          </div>
          <Figure node={focus} base={base} />
        </div>
        <table className="ed-table">
          <caption>
            {t('cine.live.title')} · {live.online ? t('cine.live.online') : t('cine.live.offline')}
          </caption>
          <tbody>
            <tr>
              {nodes.map((n, i) => (
                <td key={n.code} className={`cr-${n.risk}`} style={{ '--d': `${700 + i * 90}ms` } as CSSProperties}>
                  <span className="ed-t-name">{n.name}</span>
                  <span className="ed-t-val num">{level(n.levelCm)}</span>
                  <span className="ed-t-risk">{n.next ? t('cine.live.next') : t(`risk.${n.risk}`)}</span>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </section>

      <section className="ed-how" id="c-how" aria-labelledby="c-how-title">
        <Reveal className="ed-section-head">
          <h2 id="c-how-title">{t('cine.how.title')}</h2>
          <p>{t('cine.how.lead')}</p>
        </Reveal>
        <ol className="ed-steps">
          {([1, 2, 3] as const).map((n, i) => (
            <Reveal as="li" key={n} delay={i * 140}>
              <span className="ed-step-n" aria-hidden="true">
                {n}
              </span>
              <h3>{t(`cine.step${n}.title`)}</h3>
              <p>{t(`cine.step${n}.text`)}</p>
            </Reveal>
          ))}
        </ol>
      </section>

      <section className="ed-river" id="c-river" aria-labelledby="c-river-title">
        <Reveal className="ed-section-head">
          <h2 id="c-river-title">{t('cine.river.title')}</h2>
          <p>{t('cine.river.text')}</p>
        </Reveal>
        <ol className="ed-chain">
          {chain.map(({ node, link }, i) => (
            <Reveal as="li" key={node.code} delay={i * 110} className={`cr-${node.risk}`}>
              <span className="ed-chain-name">{node.name}</span>
              <span className="ed-chain-meta num">
                {level(node.levelCm)} · {t(`risk.${node.risk}`)}
              </span>
              {link && (
                <span className={`ed-chain-link link-${link.state}`}>
                  {link.travelHours !== null ? t('cine.river.travel', { h: link.travelHours }) : '—'} · {t(`cine.link.${link.state}`)}
                </span>
              )}
            </Reveal>
          ))}
        </ol>
        <p className="ed-note">{t('cine.river.note')}</p>
        <Reveal className="ed-final">
          <h2>
            {t('cine.slogan.1')} <em>{t('cine.slogan.2')}</em>
          </h2>
          <div className="ed-ctas center">
            <button type="button" className="ed-btn dark" onClick={cta.openSystem}>
              {t('cine.cta.open')}
              <span aria-hidden="true">→</span>
            </button>
            <button type="button" className="ed-link" onClick={cta.watchDemo}>
              {t('cine.cta.demo')}
              <span aria-hidden="true">↘</span>
            </button>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
