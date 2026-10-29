// «Живая река»: станции по течению (слева направо, на телефоне — сверху вниз) и связи между ними.
// Столбик — последнее измерение относительно учебных порогов станции; связь «угроза идёт» — когда сервер
// сообщил о волне сверху (situation.upstream), «дошла» — когда станция ниже подтвердила подъём своими измерениями.
// Это схема распространения угрозы по данным станций, а не гидродинамическая модель и не зона затопления.

import type { Crossing } from '../api/shared';
import { useI18n } from '../i18n';
import { metersFromCm, signed } from '../lib/format';
import { riverFlow, type FlowLink, type FlowNode } from '../lib/flow';
import { useCrossingText, useOutlook } from '../pages/Outlook';
import { useStore } from '../state/store';
import { useFresh, useTween } from './motion';
import { TrendIcon } from './StationList';
import { RiskBadge } from './ui';

function Gauge({ node }: { node: FlowNode }) {
  const h = useTween(node.gauge);
  return (
    <span className={`rf-gauge r-${node.risk}`} aria-hidden="true">
      <span className="rf-fill" style={{ height: `${Math.round((h ?? 0) * 100)}%` }} />
      {node.warningMark !== null && <i className="rf-mark w" style={{ bottom: `${node.warningMark * 100}%` }} />}
      {node.dangerMark !== null && <i className="rf-mark d" style={{ bottom: `${node.dangerMark * 100}%` }} />}
    </span>
  );
}

function Node({ node, selected, crossing, horizonH }: { node: FlowNode; selected: boolean; crossing: Crossing | null; horizonH: number }) {
  const { t, lang } = useI18n();
  const { select } = useStore();
  const text = useCrossingText();
  const fresh = useFresh(node.measuredAt);
  const level = useTween(node.levelCm);
  const shown = metersFromCm(level, lang);
  // Срок — только для ожидаемого превышения; «уже выше» и так сказано в статусе станции.
  const expected = crossing?.status === 'EXPECTED';
  return (
    <li className={`rf-node r-${node.risk}${selected ? ' is-selected' : ''}${node.next ? ' is-next' : ''}`}>
      <button
        type="button"
        className="rf-btn"
        aria-pressed={selected}
        onClick={() => select(node.code)}
        aria-label={t('flow.nodeLabel', { name: node.name, risk: t(`risk.${node.risk}`), status: t(node.status.key) })}
      >
        <Gauge node={node} />
        <span className="rf-info">
          <span className="rf-name">
            {node.name}
            <span className={`rf-live${fresh ? ' is-fresh' : ''}`} aria-hidden="true" />
          </span>
          <span className="rf-level num">
            {shown ? `${shown} ${t('unit.m')}` : <span className="muted">{t('common.noData')}</span>}
            {node.trend && (
              <span className={`trend t-${node.trend}`} title={t(`trend.${node.trend}`)}>
                <TrendIcon trend={node.trend} />
                {node.rateCmH !== null && node.trend !== 'STABLE' && (
                  <span className="rf-rate">
                    {signed(node.rateCmH, lang)} {t('unit.cmh')}
                  </span>
                )}
              </span>
            )}
          </span>
          <RiskBadge risk={node.risk} />
          <span className="rf-status">{t(node.status.key)}</span>
          {node.fromDevice && <span className="source-tag">{t('ext.sourceTag')}</span>}
          {node.next && <span className="rf-next">{t('flow.next')}</span>}
          {expected && crossing && <span className="rf-eta">{t('flow.eta', { when: text(crossing, horizonH) })}</span>}
        </span>
      </button>
    </li>
  );
}

function Link({ link }: { link: FlowLink }) {
  const { t } = useI18n();
  const label =
    link.state === 'threat' ? t('flow.link.threat') : link.state === 'arrived' ? t('flow.link.arrived') : t('flow.link.calm');
  return (
    <li className={`rf-link s-${link.state}${link.risk ? ` r-${link.risk}` : ''}`} aria-label={`${label}${link.travelHours ? ` · ${t('flow.travel', { h: link.travelHours })}` : ''}`}>
      <span className="rf-line" aria-hidden="true">
        <span className="rf-flow" />
      </span>
      <span className="rf-link-label">
        {link.state !== 'calm' && <b>{label}</b>}
        {link.travelHours !== null && <span className="num">{t('flow.travel', { h: link.travelHours })}</span>}
      </span>
    </li>
  );
}

export function RiverFlow({ variant = 'panel' }: { variant?: 'panel' | 'overlay' }) {
  const { t } = useI18n();
  const { stations, live, selected } = useStore();
  const { outlook } = useOutlook();
  const flow = riverFlow(stations, live.snapshot);
  if (flow.nodes.length === 0) return null;
  const items: Array<{ kind: 'node'; node: FlowNode } | { kind: 'link'; link: FlowLink }> = [];
  for (const node of flow.nodes) {
    const link = flow.links.find((l) => l.to === node.code);
    if (link && items.length > 0) items.push({ kind: 'link', link });
    items.push({ kind: 'node', node });
  }
  return (
    <section className={`river-flow v-${variant}${flow.hasThreat ? ' has-threat' : ''}`} aria-labelledby="rf-title">
      <div className="rf-head">
        <h2 id="rf-title" className="rf-title">
          {t('flow.title')}
          <span className="rf-dir" aria-hidden="true">→</span>
        </h2>
        <span className="faint">{t('flow.hint')}</span>
      </div>
      <ol className="rf-track">
        {items.map((it) =>
          it.kind === 'node' ? (
            <Node
              key={it.node.code}
              node={it.node}
              selected={selected === it.node.code}
              crossing={outlook?.stations.find((s) => s.code === it.node.code)?.danger ?? null}
              horizonH={outlook?.stations.find((s) => s.code === it.node.code)?.horizonH ?? 0}
            />
          ) : (
            <Link key={`${it.link.from}-${it.link.to}`} link={it.link} />
          ),
        )}
      </ol>
      <p className="faint rf-note">{t('flow.note')}</p>
    </section>
  );
}
