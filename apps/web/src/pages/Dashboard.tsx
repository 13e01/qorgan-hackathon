import { LevelChart } from '../components/LevelChart';
import { SimulationPanel } from '../components/SimulationPanel';
import { StationCard } from '../components/StationCard';
import { StationMap } from '../components/StationMap';
import { RiskBadge, Val } from '../components/ui';
import { useStationDetails } from '../components/useStationDetails';
import { useI18n } from '../i18n';
import { metersFromCm, signed } from '../lib/format';
import { levelView } from '../lib/level';
import { useStore } from '../state/store';

export function StationStrip() {
  const { t, lang } = useI18n();
  const { stations, live, selected, select } = useStore();
  return (
    <div className="strip" role="group" aria-label={t('dash.stations')}>
      {stations.map((st) => {
        const snap = live.snapshot?.stations.find((s) => s.code === st.code);
        const r = snap?.risk;
        const lv = levelView(snap);
        const hasData = lv.measuredCm !== null;
        const level = metersFromCm(lv.measuredCm, lang);
        return (
          <button key={st.code} className="st-card" aria-pressed={selected === st.code} onClick={() => select(st.code)}>
            <div className="top">
              <span className="name">{st.name}</span>
              <RiskBadge risk={hasData ? r!.risk : 'NO_DATA'} />
            </div>
            <div className="lvl">
              <Val>{level ? `${level} ${t('unit.m')}` : null}</Val>
            </div>
            <div className="sub">
              {st.code}
              {r?.rateCmH !== null && r?.rateCmH !== undefined && ` · ${t(`trend.${r.trend}`)} ${signed(r.rateCmH, lang)} ${t('unit.cmh')}`}
            </div>
            {r?.situation.localLevel && hasData && <div className="sub">{t(`level.status.${r.situation.localLevel}`)}</div>}
            {r?.situation.upstream && (
              <div className="upstream-flag">
                ▲ {t('upstream.title')}: {r.situation.upstream.stationCode}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Dashboard() {
  const { t } = useI18n();
  const { selected, stations, stationsError } = useStore();
  const { explanation, forecast } = useStationDetails(selected);
  const meta = stations.find((s) => s.code === selected);

  return (
    <div className="dash">
      <div className="dash-left">
        {stationsError && <div className="callout danger">{stationsError}</div>}
        <StationMap />
        <StationStrip />
        <div className="panel">
          <div className="panel-head">
            <h2>
              {t('chart.title')} · {meta ? `${meta.name} (${meta.code})` : ''}
            </h2>
          </div>
          <LevelChart code={selected} forecast={forecast} />
        </div>
        <SimulationPanel compact />
      </div>
      <StationCard code={selected} explanation={explanation} forecast={forecast} />
    </div>
  );
}
