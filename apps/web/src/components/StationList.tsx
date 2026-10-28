// Компактный список станций в порядке течения — ответ на вопрос «где опасность?».

import { useI18n } from '../i18n';
import { metersFromCm } from '../lib/format';
import { levelView } from '../lib/level';
import { plainStatus } from '../lib/status';
import { useStore } from '../state/store';
import { Icon, RiskBadge } from './ui';
import type { TrendDirection } from '../api/shared';

export function TrendIcon({ trend }: { trend: TrendDirection | undefined }) {
  if (trend === 'RISING') return <Icon name="arrowUp" />;
  if (trend === 'FALLING') return <Icon name="arrowDown" />;
  if (trend === 'STABLE') return <Icon name="arrowFlat" />;
  return null;
}

export function StationList() {
  const { t, lang } = useI18n();
  const { stations, live, selected, select } = useStore();
  return (
    <div className="card station-list">
      <div className="card-head">
        <h2>{t('dash.where')}</h2>
        <span className="faint">{t('dash.flowHint')}</span>
      </div>
      <ol className="flow" aria-label={t('dash.stations')}>
        {stations.map((st) => {
          const snap = live.snapshot?.stations.find((s) => s.code === st.code);
          const status = plainStatus(snap);
          const level = metersFromCm(levelView(snap).measuredCm, lang);
          return (
            <li key={st.code}>
              <button className={`flow-row tone-${status.tone}`} aria-pressed={selected === st.code} onClick={() => select(st.code)}>
                <span className={`flow-dot r-${status.risk}`} aria-hidden="true" />
                <span className="flow-main">
                  <span className="flow-name">{st.name}</span>
                  <span className="flow-sub">{t(status.key)}</span>
                </span>
                <span className="flow-level num">
                  {level ? `${level} ${t('unit.m')}` : '—'}
                  <span className={`trend t-${snap?.risk.trend ?? 'UNKNOWN'}`} aria-label={snap ? t(`trend.${snap.risk.trend}`) : undefined}>
                    <TrendIcon trend={snap?.risk.trend} />
                  </span>
                </span>
                <RiskBadge risk={status.risk} />
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
