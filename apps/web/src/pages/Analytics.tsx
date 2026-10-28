// Аналитика: прохождение волны по станциям (уровни на одной шкале), итоговый риск по часам, объяснение оценки.

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { LevelChart } from '../components/LevelChart';
import { RiskBadge } from '../components/ui';
import { useStationDetails } from '../components/useStationDetails';
import { useI18n } from '../i18n';
import { dateTime, metersFromCm, shortDateTime } from '../lib/format';
import { lastHours } from '../state/live';
import { useStore } from '../state/store';
import { usePalette } from '../state/theme';


function WaveChart() {
  const { t, lang } = useI18n();
  const { stations, live, user } = useStore();
  // Цвета станций — не цвета риска, чтобы не путать.
  const c = usePalette();
  const rows = new Map<number, Record<string, number>>();
  for (const st of stations) {
    const pts = live.levels[st.code]?.points ?? [];
    for (const p of user ? pts : lastHours(pts, 24)) {
      const row = rows.get(p.t) ?? { t: p.t };
      row[st.code] = p.cm / 100;
      rows.set(p.t, row);
    }
  }
  const data = [...rows.values()].sort((a, b) => a.t! - b.t!);
  if (data.length === 0) return <div className="empty">{t('chart.empty')}</div>;
  return (
    <div className="chart-box tall">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={c.grid} strokeDasharray="3 3" />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(v: number) => shortDateTime(v, lang)} stroke={c.axis} fontSize={11} minTickGap={40} />
          <YAxis domain={['auto', 'auto']} tickFormatter={(v: number) => metersFromCm(v * 100, lang, 1) ?? ''} stroke={c.axis} fontSize={11} width={48} />
          <Tooltip
            isAnimationActive={false}
            contentStyle={{ background: 'var(--surface-raised)', border: '1px solid var(--border-strong)', borderRadius: 10, fontSize: 12, color: 'var(--text)' }}
            labelFormatter={(v) => `${t('top.simTime')}: ${dateTime(new Date(Number(v)).toISOString(), lang)}`}
            formatter={(value, name) => [`${metersFromCm(Number(value) * 100, lang)} ${t('unit.m')}`, String(name)]}
          />
          {stations.map((st, i) => (
            <Line key={st.code} dataKey={st.code} name={`${st.code} ${st.name}`} stroke={c.stations[i % c.stations.length]} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function RiskTimeline() {
  const { t, lang } = useI18n();
  const { stations, live } = useStore();
  const any = stations.some((s) => (live.risks[s.code]?.points.length ?? 0) > 0);
  if (!any) return <div className="empty">{t('chart.empty')}</div>;
  const first = Math.min(...stations.map((s) => live.risks[s.code]?.points[0]?.t ?? Infinity));
  const last = Math.max(...stations.map((s) => live.risks[s.code]?.points.at(-1)?.t ?? -Infinity));
  return (
    <div className="timeline">
      {stations.map((st) => {
        const pts = live.risks[st.code]?.points ?? [];
        return (
          <div key={st.code} className="timeline-row">
            <span className="faint">{st.name}</span>
            <div className="timeline-cells" role="img" aria-label={`${st.name}: ${pts.length} ${t('unit.h')}`}>
              {pts.map((p) => (
                <span key={p.t} className={`c-${p.risk}`} title={`${dateTime(new Date(p.t).toISOString(), lang)} — ${t(`risk.${p.risk}`)}`} />
              ))}
            </div>
          </div>
        );
      })}
      <div className="timeline-row">
        <span />
        <div className="faint timeline-axis">
          <span>{Number.isFinite(first) ? dateTime(new Date(first).toISOString(), lang) : ''}</span>
          <span>{Number.isFinite(last) ? dateTime(new Date(last).toISOString(), lang) : ''}</span>
        </div>
      </div>
      <div className="chart-legend">
        {(['LOW', 'MEDIUM', 'HIGH'] as const).map((r) => (
          <RiskBadge key={r} risk={r} />
        ))}
      </div>
    </div>
  );
}

export function Analytics() {
  const { t, reason } = useI18n();
  const { selected, select, stations } = useStore();
  const { explanation, forecast } = useStationDetails(selected);

  return (
    <div className="page">
      <div className="card">
        <div className="card-head">
          <h2>{t('analytics.wave')}</h2>
        </div>
        <p className="muted">{t('analytics.waveHint')}</p>
        <WaveChart />
      </div>
      <div className="card">
        <div className="card-head">
          <h2>{t('analytics.timeline')}</h2>
        </div>
        <p className="muted">{t('analytics.timelineHint')}</p>
        <RiskTimeline />
      </div>
      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>{t('analytics.explanation')}</h2>
            <select aria-label={t('stations.col.station')} value={selected} onChange={(e) => select(e.target.value)}>
              {stations.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </div>
          {explanation ? (
            <>
              <div className="sim-status">
                <RiskBadge risk={explanation.level.currentCm === null ? 'NO_DATA' : explanation.risk} large />
                <span className="faint num">{t('risk.score', { score: explanation.score, max: explanation.maxScore })}</span>
                <span className="muted">{t(`drivers.${explanation.situation.drivers}`)}</span>
              </div>
              <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('analytics.factor')}</th>
                    <th>{t('analytics.contribution')}</th>
                    <th>{t('analytics.reason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {explanation.factors.map((f) => (
                    <tr key={f.code}>
                      <td>{t(`factor.${f.code}`)}</td>
                      <td className="num">
                        {f.status === 'OK' || f.status === 'STALE' ? t('factor.points', { points: f.points, max: f.maxPoints }) : t(`factor.status.${f.status}`)}
                      </td>
                      <td>{f.reason ? reason(f.reason) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <p className="faint note">{t('risk.model')}</p>
            </>
          ) : (
            <p className="muted">{t('common.loading')}</p>
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <h2>
              {t('chart.title')} · {stations.find((s) => s.code === selected)?.name ?? selected}
            </h2>
          </div>
          <LevelChart code={selected} forecast={forecast} />
        </div>
      </div>
    </div>
  );
}
