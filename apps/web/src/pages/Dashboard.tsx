// Главная панель (Eclipse) — карта и река в центре. Порядок чтения:
// 1) состояние реки одной фразой и главное действие; 2) крупная карта со станциями и линиями угрозы;
// 3) «Живая река» — станции по течению и куда движется угроза; 4) рядом — предупреждения и выбранная станция;
// 5) ниже — график уровня. Все значения — из снимка сервера; интерфейс ничего не пересчитывает.

import { AlertFeed } from '../components/AlertFeed';
import { ExternalSensors } from '../components/ExternalSensors';
import { LevelChart } from '../components/LevelChart';
import { OutlookStrip } from '../components/OutlookStrip';
import { RiverFlow } from '../components/RiverFlow';
import { SimControls, SimProgress } from '../components/SimControls';
import { StationCard } from '../components/StationCard';
import { StationMap } from '../components/StationMap';
import { Icon } from '../components/ui';
import { useStationDetails } from '../components/useStationDetails';
import { useI18n } from '../i18n';
import { overview } from '../lib/status';
import { useDemo } from '../state/demo';
import { useStore } from '../state/store';

function DashHero() {
  const { t } = useI18n();
  const { stations, live, simBusy } = useStore();
  const { begin } = useDemo();
  const ov = overview(live.snapshot, stations);
  const intro = ov.key === 'overview.noData';
  return (
    <section className={`dash-hero${intro ? ' is-intro' : ''}`} data-tone={ov.tone} aria-labelledby="dash-title">
      <div className="dh-text">
        <p className="eyebrow dh-eyebrow reveal" style={{ ['--i' as string]: 0 }}>
          <span className="dh-pulse" aria-hidden="true" />
          {intro ? t('app.region') : `${t('dash.eyebrow')} · ${t('app.region')}`}
        </p>
        <h1 id="dash-title" className="dh-title reveal" style={{ ['--i' as string]: 1 }}>
          {intro ? t('dash.intro.title') : t(ov.key, { station: ov.worst?.name })}
        </h1>
        {intro ? (
          <p className="dh-lead reveal" style={{ ['--i' as string]: 2 }}>
            {t('dash.intro.lead')}
          </p>
        ) : (
          <ul className="dh-counts reveal" style={{ ['--i' as string]: 2 }} aria-label={t('overview.counts', { high: ov.counts.HIGH, medium: ov.counts.MEDIUM, low: ov.counts.LOW })}>
            {(['HIGH', 'MEDIUM', 'LOW'] as const).map((r) => (
              <li key={r} className={`dh-count r-${r}${ov.counts[r] > 0 ? ' on' : ''}`}>
                <span className="dh-count-n num">{ov.counts[r]}</span>
                <span className="dh-count-l">{t(`risk.${r}`)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="reveal" style={{ ['--i' as string]: 3 }}>
          <OutlookStrip />
        </div>
      </div>
      <div className="dh-actions reveal" style={{ ['--i' as string]: 2 }}>
        <div className="dh-buttons">
          <button className="btn lg primary glow" onClick={begin} disabled={simBusy}>
            <Icon name="sparkle" />
            {t('ctl.demo')}
          </button>
          <SimControls startPrimary={false} />
        </div>
        {intro && <p className="faint dh-hint">{t('dash.intro.cta')}</p>}
      </div>
      {live.snapshot?.simulation.run && (
        <div className="dh-progress">
          <SimProgress />
        </div>
      )}
    </section>
  );
}

export function Dashboard() {
  const { t } = useI18n();
  const { selected, stations, stationsError } = useStore();
  const { demo } = useDemo();
  const { explanation, forecast } = useStationDetails(selected);
  const meta = stations.find((s) => s.code === selected);
  const demoActive = demo.phase === 'active';

  return (
    <div className="dash">
      {stationsError && <div className="callout danger">{stationsError}</div>}
      {!demoActive && <DashHero />}

      <div className="stage">
        <div className="stage-main">
          <div className="stage-map reveal" style={{ ['--i' as string]: 1 }}>
            <StationMap />
          </div>
        </div>
        <aside className="stage-side" aria-label={t('dash.selected')}>
          <ExternalSensors compact />
          <AlertFeed />
          <StationCard code={selected} explanation={explanation} forecast={forecast} />
        </aside>
      </div>

      <RiverFlow />

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
