// График уровня воды станции: измерения из backend (сплошная линия) и прогноз модели на 3 ч
// (отдельный пунктир с диапазоном — не продолжение измерений). Значения в метрах.

import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ForecastResponse } from '../api/types';
import { useI18n } from '../i18n';
import { metersFromCm, shortDateTime, dateTime } from '../lib/format';
import { lastHours } from '../state/live';
import { useStore } from '../state/store';
import { usePalette } from '../state/theme';

interface Row {
  t: number;
  m?: number;
  fc?: number;
  band?: [number, number];
}

export function LevelChart({ code, forecast, tall = false }: { code: string; forecast?: ForecastResponse | null; tall?: boolean }) {
  const { t, lang } = useI18n();
  const { live, stations, user } = useStore();
  const c = usePalette();
  const meta = stations.find((s) => s.code === code);
  const level = meta?.parameters.find((p) => p.code === 'water_level');
  const all = live.levels[code]?.points ?? [];
  const points = user ? all : lastHours(all, 24);

  const rows: Row[] = points.map((p) => ({ t: p.t, m: p.cm / 100 }));
  const fc = forecast?.forecast;
  const lastPoint = points.at(-1);
  const hasForecast =
    fc?.status === 'OK' && fc.levelCm !== null && fc.lowCm !== null && fc.highCm !== null && lastPoint && forecast?.level.measuredAt === new Date(lastPoint.t).toISOString();
  if (hasForecast && lastPoint) {
    const asOf = Date.parse(forecast!.asOf);
    const end = asOf + fc!.horizonH * 3_600_000;
    rows.push({ t: lastPoint.t, fc: lastPoint.cm / 100, band: [lastPoint.cm / 100, lastPoint.cm / 100] });
    rows.push({ t: end, fc: fc!.levelCm! / 100, band: [fc!.lowCm! / 100, fc!.highCm! / 100] });
  }
  const nowT = live.snapshot?.context.virtualTime ? Date.parse(live.snapshot.context.virtualTime) : null;
  const warning = level?.warning ?? null;
  const danger = level?.danger ?? null;
  const values = rows.flatMap((r) => [r.m, r.fc, ...(r.band ?? [])]).filter((v): v is number => v !== undefined);
  const lo = Math.min(...values, warning !== null ? warning / 100 : Infinity);
  const hi = Math.max(...values, danger !== null ? danger / 100 : -Infinity);
  const pad = Number.isFinite(lo) && Number.isFinite(hi) ? Math.max(0.2, (hi - lo) * 0.08) : 0.5;

  if (rows.length === 0) {
    return <div className="empty">{t('chart.empty')}</div>;
  }

  const fmt = (v: number) => metersFromCm(v * 100, lang);

  return (
    <div>
      <div className="chart-legend">
        <span>
          <span className="swatch" style={{ borderColor: c.measured }} />
          {t('chart.measured')}
        </span>
        {hasForecast && (
          <span>
            <span className="swatch dashed" style={{ borderColor: c.forecast }} />
            {t('chart.forecast')}
          </span>
        )}
        {warning !== null && (
          <span>
            <span className="swatch dashed" style={{ borderColor: 'var(--risk-medium)' }} />
            {t('chart.warning')} {fmt(warning / 100)} {t('unit.m')}
          </span>
        )}
        {danger !== null && (
          <span>
            <span className="swatch dashed" style={{ borderColor: 'var(--risk-high)' }} />
            {t('chart.danger')} {fmt(danger / 100)} {t('unit.m')}
          </span>
        )}
        {!user && <span className="faint">{t('chart.guestLimit')}</span>}
      </div>
      <div className={`chart-box${tall ? ' tall' : ''}`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid stroke={c.grid} strokeDasharray="3 3" />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v: number) => shortDateTime(v, lang)}
              stroke={c.axis}
              fontSize={11}
              minTickGap={40}
            />
            <YAxis
              domain={[Number.isFinite(lo) ? lo - pad : 'auto', Number.isFinite(hi) ? hi + pad : 'auto']}
              tickFormatter={(v: number) => fmt(v) ?? ''}
              stroke={c.axis}
              fontSize={11}
              width={52}
              label={{ value: t('chart.axisLevel'), angle: -90, position: 'insideLeft', fill: c.axis, fontSize: 11 }}
            />
            <Tooltip
              isAnimationActive={false}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0]!.payload as Row;
                return (
                  <div className="tooltip">
                    <div className="faint">
                      {t('top.simTime')}: {dateTime(new Date(Number(label)).toISOString(), lang)}
                    </div>
                    {row.m !== undefined && (
                      <div>
                        {t('chart.measured')}: <b>{fmt(row.m)} {t('unit.m')}</b> ({Math.round(row.m * 100)} {t('unit.cm')})
                      </div>
                    )}
                    {row.fc !== undefined && row.m === undefined && (
                      <div>
                        {t('chart.forecast')}: <b>{fmt(row.fc)} {t('unit.m')}</b>
                        {row.band && row.band[0] !== row.band[1] && (
                          <div className="faint">{t('forecast.range', { low: fmt(row.band[0]), high: fmt(row.band[1]) })}</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              }}
            />
            {warning !== null && <ReferenceLine y={warning / 100} stroke={c.warning} strokeDasharray="6 4" ifOverflow="extendDomain" />}
            {danger !== null && <ReferenceLine y={danger / 100} stroke={c.danger} strokeDasharray="6 4" ifOverflow="extendDomain" />}
            {nowT !== null && <ReferenceLine x={nowT} stroke={c.axis} strokeDasharray="2 3" label={{ value: t('chart.now'), fill: c.axis, fontSize: 10, position: 'top' }} />}
            <Area dataKey="band" stroke="none" fill={c.forecastBand} fillOpacity={0.18} isAnimationActive={false} connectNulls={false} />
            <Line dataKey="m" stroke={c.measured} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} name={t('chart.measured')} />
            <Line dataKey="fc" stroke={c.forecast} strokeWidth={2} strokeDasharray="6 4" dot={{ r: 3 }} isAnimationActive={false} connectNulls name={t('chart.forecast')} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="faint note">{t('chart.axisTime')}</p>
    </div>
  );
}
