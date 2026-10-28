// Главная панель отвечает на три вопроса: что происходит (сводка), где опасность (карта и список станций),
// что можно сделать (одна-две крупные кнопки). Подробности — в карточке станции по кнопке «Подробнее» и в «Аналитике».

import { AlertFeed } from '../components/AlertFeed';
import { ExternalSensors } from '../components/ExternalSensors';
import { LevelChart } from '../components/LevelChart';
import { OutlookStrip } from '../components/OutlookStrip';
import { SimControls, SimProgress } from '../components/SimControls';
import { StationCard } from '../components/StationCard';
import { StationList } from '../components/StationList';
import { StationMap } from '../components/StationMap';
import { Icon } from '../components/ui';
import { useStationDetails } from '../components/useStationDetails';
import { useI18n } from '../i18n';
import { overview } from '../lib/status';
import { useDemo } from '../state/demo';
import { useStore } from '../state/store';

export function Dashboard() {
  const { t } = useI18n();
  const { selected, stations, stationsError, live, simBusy } = useStore();
  const { demo, begin } = useDemo();
  const { explanation, forecast } = useStationDetails(selected);
  const meta = stations.find((s) => s.code === selected);
  const ov = overview(live.snapshot, stations);
  const demoActive = demo.phase === 'active';

  return (
    <div className="dash">
      {stationsError && <div className="callout danger">{stationsError}</div>}

      {!demoActive && (
        <section className="card hero">
          <div className="hero-text">
            <h2 className="hero-title">{t('dash.title')}</h2>
            <p className={`hero-status tone-${ov.tone}`}>
              <span className="status-dot" aria-hidden="true" />
              {t(ov.key, { station: ov.worst?.name })}
            </p>
            {ov.key !== 'overview.noData' && (
              <p className="faint">{t('overview.counts', { high: ov.counts.HIGH, medium: ov.counts.MEDIUM, low: ov.counts.LOW })}</p>
            )}
            <OutlookStrip />
          </div>
          <div className="hero-actions">
            <button className="btn lg primary" onClick={begin} disabled={simBusy}>
              <Icon name="sparkle" />
              {t('ctl.demo')}
            </button>
            <SimControls startPrimary={false} />
          </div>
          {live.snapshot?.simulation.run && (
            <div className="hero-progress">
              <SimProgress />
            </div>
          )}
        </section>
      )}

      <div className="dash-main">
        <div className="dash-map">
          <StationMap />
        </div>
        <div className="dash-side">
          <ExternalSensors compact />
          <AlertFeed />
          <StationList />
          <StationCard code={selected} explanation={explanation} forecast={forecast} />
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>
            {t('chart.title')}
            {meta ? ` · ${meta.name}` : ''}
          </h2>
          <a className="btn ghost sm" href="#/analytics">
            {t('dash.toAnalytics')}
            <Icon name="chevronRight" />
          </a>
        </div>
        <LevelChart code={selected} forecast={forecast} />
      </section>
    </div>
  );
}
