import { StationCard } from '../components/StationCard';
import { RiskBadge, Val } from '../components/ui';
import { useStationDetails } from '../components/useStationDetails';
import { useI18n, type MessageKey } from '../i18n';
import { dateTime, metersFromCm, number } from '../lib/format';
import { levelView } from '../lib/level';
import { useStore } from '../state/store';

export function Stations() {
  const { t, lang } = useI18n();
  const { stations, live, selected, select } = useStore();
  const { explanation, forecast } = useStationDetails(selected);

  return (
    <div className="dash">
      <div className="panel" style={{ overflowX: 'auto' }}>
        <div className="panel-head">
          <h2>{t('stations.title')}</h2>
        </div>
        <p className="muted" style={{ marginBottom: 12 }}>
          {t('stations.hint')}
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>{t('stations.col.order')}</th>
              <th>{t('stations.col.station')}</th>
              <th>{t('stations.col.level')}</th>
              <th>{t('stations.col.risk')}</th>
              <th>{t('stations.col.thresholds')}</th>
              <th>{t('stations.col.upstream')}</th>
              <th>{t('stations.col.sensors')}</th>
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
                    <div className="faint">
                      {st.code} · {t('station.demo')}
                    </div>
                    <div className="faint">
                      {t('station.coords')}: {number(st.lat, lang, 4)}, {number(st.lon, lang, 4)}
                    </div>
                  </td>
                  <td>
                    <Val>{hasData ? `${metersFromCm(lv.measuredCm, lang)} ${t('unit.m')}` : null}</Val>
                    {lv.measuredAt && <div className="faint">{dateTime(lv.measuredAt, lang)}</div>}
                  </td>
                  <td>
                    <RiskBadge risk={hasData ? r!.risk : 'NO_DATA'} />
                  </td>
                  <td>
                    {metersFromCm(lvl?.warning, lang) ?? '—'} / {metersFromCm(lvl?.danger, lang) ?? '—'} {t('unit.m')}
                  </td>
                  <td>
                    {st.upstreamCode ? (
                      <>
                        {st.upstreamCode}
                        <div className="faint">
                          {t('station.travel')}: {st.travelHours} {t('unit.h')}
                        </div>
                      </>
                    ) : (
                      <span className="muted">{t('station.upstreamNone')}</span>
                    )}
                  </td>
                  <td>{st.parameters.map((p) => t(`param.${p.code}` as MessageKey)).join(', ')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <StationCard code={selected} explanation={explanation} forecast={forecast} />
    </div>
  );
}
