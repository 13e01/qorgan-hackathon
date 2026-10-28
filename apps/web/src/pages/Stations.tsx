import { ExternalSensors } from '../components/ExternalSensors';
import { StationCard } from '../components/StationCard';
import { RiskBadge, Val } from '../components/ui';
import { useStationDetails } from '../components/useStationDetails';
import { useI18n } from '../i18n';
import { dateTime, metersFromCm } from '../lib/format';
import { levelView } from '../lib/level';
import { plainStatus } from '../lib/status';
import { useStore } from '../state/store';

export function Stations() {
  const { t, lang } = useI18n();
  const { stations, live, selected, select } = useStore();
  const { explanation, forecast } = useStationDetails(selected);

  return (
    <div className="split">
      <div className="page-stack">
      <ExternalSensors />
      <div className="card">
        <div className="card-head">
          <h2>{t('stations.title')}</h2>
        </div>
        <p className="muted">{t('stations.hint')}</p>
        <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('stations.col.order')}</th>
              <th>{t('stations.col.station')}</th>
              <th>{t('stations.col.level')}</th>
              <th>{t('risk.final')}</th>
              <th>{t('stations.col.thresholds')}</th>
            </tr>
          </thead>
          <tbody>
            {stations.map((st, i) => {
              const snap = live.snapshot?.stations.find((s) => s.code === st.code);
              const r = snap?.risk;
              const lvl = st.parameters.find((p) => p.code === 'water_level');
              const lv = levelView(snap);
              const hasData = lv.measuredCm !== null;
              return (
                <tr
                  key={st.code}
                  className="clickable"
                  aria-selected={selected === st.code}
                  tabIndex={0}
                  onClick={() => select(st.code)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), select(st.code))}
                >
                  <td>{i + 1}</td>
                  <td>
                    <b>{st.name}</b>
                    <div className="faint">{st.code}</div>
                  </td>
                  <td>
                    <Val>{hasData ? `${metersFromCm(lv.measuredCm, lang)} ${t('unit.m')}` : null}</Val>
                    {lv.measuredAt && <div className="faint">{dateTime(lv.measuredAt, lang)}</div>}
                  </td>
                  <td>
                    <RiskBadge risk={hasData ? r!.risk : 'NO_DATA'} />
                    <div className="faint">{t(plainStatus(snap).key)}</div>
                  </td>
                  <td>
                    {metersFromCm(lvl?.warning, lang) ?? '—'} / {metersFromCm(lvl?.danger, lang) ?? '—'} {t('unit.m')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>
      </div>
      <StationCard code={selected} explanation={explanation} forecast={forecast} showHistory />
    </div>
  );
}
