// «Прогноз по реке»: сколько часов есть у каждого населённого пункта до прихода воды и насколько этому можно верить.
// Все числа считает сервер (GET /api/outlook, /api/outlook/verification); интерфейс только рисует.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api/client';
import type { Crossing, OutlookResult, StationOutlook, StationVerification } from '../api/shared';
import type { EvaluationContext } from '../api/types';
import { Disclosure, Icon, Val } from '../components/ui';
import { useI18n } from '../i18n';
import { dateTime, metersFromCm, number, shortDateTime } from '../lib/format';
import { useStore } from '../state/store';
import { usePalette } from '../state/theme';

const H = 3_600_000;

/** Прогноз по реке на текущее виртуальное время; перезапрашивается при новых данных, не чаще раза в секунду. */
export function useOutlook(): { outlook: OutlookResult | null; context: EvaluationContext | null; error: string | null } {
  const { user, live, describeError } = useStore();
  const vt = live.snapshot?.context.virtualTime ?? null;
  const runId = live.snapshot?.context.runId ?? null;
  const [state, setState] = useState<{ outlook: OutlookResult | null; context: EvaluationContext | null; error: string | null }>({ outlook: null, context: null, error: null });
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    const load = () => {
      last.current = Date.now();
      api
        .get<{ outlook: OutlookResult | null; context: EvaluationContext }>('/api/outlook')
        .then((r) => alive && setState({ outlook: r.outlook, context: r.context, error: null }))
        .catch((err) => alive && setState((s) => ({ ...s, error: describeError(err) })));
    };
    const wait = Math.max(0, 1000 - (Date.now() - last.current));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, wait);
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [user, vt, runId, describeError]);
  return user ? state : { outlook: null, context: null, error: null };
}

/** Короткая фраза о времени до порога: «через ≈ 94 ч (92–98)», «уже выше», «не ожидается в пределах 102 ч». */
export function useCrossingText() {
  const { t, lang } = useI18n();
  return (c: Crossing, horizonH: number): string => {
    switch (c.status) {
      case 'ALREADY_ABOVE':
        return t('outlook.cross.already');
      case 'EXPECTED': {
        const range = c.earliestH !== null && c.latestH !== null && (c.earliestH !== c.h || c.latestH !== c.h) ? t('outlook.cross.range', { a: c.earliestH, b: c.latestH }) : c.latestH === null ? t('outlook.cross.rangeOpen', { a: c.earliestH }) : '';
        return t('outlook.cross.in', { h: number(c.h, lang, 0), range });
      }
      case 'NOT_EXPECTED':
        return c.earliestH !== null ? t('outlook.cross.possible', { h: horizonH, a: c.earliestH }) : t('outlook.cross.not', { h: horizonH });
      case 'NO_THRESHOLD':
        return t('outlook.cross.noThreshold');
      default:
        return t('outlook.cross.noForecast');
    }
  };
}

/** Полоса станции на шкале «сейчас → +H ч»: где прогноз выше порога предупреждения и опасного (сплошь — по центру, штриховка — только по верхней границе). */
function Lane({ st, maxH, warningCm, dangerCm }: { st: StationOutlook; maxH: number; warningCm: number | null; dangerCm: number | null }) {
  const W = 1000;
  const x = (h: number) => (h / maxH) * W;
  const segs: Array<{ from: number; to: number; cls: string }> = [];
  const push = (h: number, cls: string) => {
    const last = segs.at(-1);
    if (last && last.cls === cls && last.to === h - 1) last.to = h;
    else segs.push({ from: h - 1, to: h, cls });
  };
  for (const p of st.points) {
    if (dangerCm !== null && p.levelCm >= dangerCm) push(p.h, 'd');
    else if (dangerCm !== null && p.highCm >= dangerCm) push(p.h, 'd-maybe');
    else if (warningCm !== null && p.levelCm >= warningCm) push(p.h, 'w');
    else if (warningCm !== null && p.highCm >= warningCm) push(p.h, 'w-maybe');
    else push(p.h, 'ok');
  }
  const nowAbove = st.danger.status === 'ALREADY_ABOVE' ? 'd' : st.warning.status === 'ALREADY_ABOVE' ? 'w' : null;
  return (
    <svg className="lane" viewBox={`0 0 ${W} 28`} preserveAspectRatio="none" aria-hidden="true">
      <rect x="0" y="9" width={W} height="10" rx="5" className="lane-bg" />
      {st.horizonH < maxH && <rect x={x(st.horizonH)} y="9" width={W - x(st.horizonH)} height="10" className="lane-unknown" />}
      {segs.map((s, i) => (
        <rect key={i} x={x(s.from)} y="6" width={Math.max(2, x(s.to) - x(s.from))} height="16" rx="3" className={`lane-${s.cls}`} />
      ))}
      {nowAbove && <rect x="0" y="4" width="6" height="20" rx="2" className={`lane-${nowAbove}`} />}
    </svg>
  );
}

function RiverBoard({ outlook, selected, onSelect }: { outlook: OutlookResult; selected: string; onSelect: (c: string) => void }) {
  const { t, lang } = useI18n();
  const { stations } = useStore();
  const text = useCrossingText();
  const maxH = Math.max(24, ...outlook.stations.map((s) => s.horizonH));
  const ticks = [0, 24, 48, 72, 96, 120].filter((h) => h <= maxH);
  return (
    <div className="river-board" role="table" aria-label={t('outlook.board')}>
      <div className="rb-row rb-axis" role="row">
        <div role="columnheader" className="rb-name faint">{t('outlook.col.station')}</div>
        <div role="columnheader" className="rb-lane">
          {ticks.map((h) => (
            <span key={h} style={{ left: `${(h / maxH) * 100}%` }} className="num">
              {h === 0 ? t('chart.now') : `+${h} ${t('unit.h')}`}
            </span>
          ))}
        </div>
        <div role="columnheader" className="rb-eta faint">{t('outlook.col.danger')}</div>
      </div>
      {outlook.stations.map((st) => {
        const meta = stations.find((s) => s.code === st.code);
        const lvl = meta?.parameters.find((p) => p.code === 'water_level');
        const tone = st.danger.status === 'ALREADY_ABOVE' ? 'high' : st.danger.status === 'EXPECTED' ? 'high-soon' : st.warning.status === 'EXPECTED' || st.warning.status === 'ALREADY_ABOVE' ? 'medium' : 'calm';
        return (
          <button key={st.code} role="row" className={`rb-row${selected === st.code ? ' is-selected' : ''}`} onClick={() => onSelect(st.code)} aria-pressed={selected === st.code}>
            <div role="cell" className="rb-name">
              <b>{meta?.name ?? st.code}</b>
              <span className="faint num">
                {metersFromCm(st.currentCm, lang) ?? '—'} {t('unit.m')} · {t(`outlook.method.${st.method}`)}
              </span>
            </div>
            <div role="cell" className="rb-lane">
              <Lane st={st} maxH={maxH} warningCm={lvl?.warning ?? null} dangerCm={lvl?.danger ?? null} />
            </div>
            <div role="cell" className={`rb-eta tone-${tone}`}>
              <span className="rb-eta-main">{text(st.danger, st.horizonH)}</span>
              {st.warning.status === 'EXPECTED' && st.danger.status !== 'ALREADY_ABOVE' && <span className="faint">{t('outlook.warnIn', { h: st.warning.h })}</span>}
            </div>
          </button>
        );
      })}
      <div className="rb-legend faint">
        <span><i className="sw lane-w" />{t('outlook.legend.warning')}</span>
        <span><i className="sw lane-d" />{t('outlook.legend.danger')}</span>
        <span><i className="sw lane-d-maybe" />{t('outlook.legend.maybe')}</span>
        <span><i className="sw lane-unknown" />{t('outlook.legend.beyond')}</span>
      </div>
    </div>
  );
}

function OutlookChart({ st }: { st: StationOutlook }) {
  const { t, lang } = useI18n();
  const { live, stations } = useStore();
  const c = usePalette();
  const meta = stations.find((s) => s.code === st.code);
  const lvl = meta?.parameters.find((p) => p.code === 'water_level');
  const measured = (live.levels[st.code]?.points ?? []).slice(-96);
  type Row = { t: number; m?: number; fc?: number; band?: [number, number] };
  const rows: Row[] = measured.map((p) => ({ t: p.t, m: p.cm / 100 }));
  const last = measured.at(-1);
  if (last && st.points.length) rows.push({ t: last.t, fc: last.cm / 100, band: [last.cm / 100, last.cm / 100] });
  for (const p of st.points) rows.push({ t: Date.parse(p.time), fc: p.levelCm / 100, band: [p.lowCm / 100, p.highCm / 100] });
  if (rows.length === 0) return <div className="empty">{t('chart.empty')}</div>;
  const fmt = (v: number) => metersFromCm(v * 100, lang);
  const nowT = last?.t ?? null;
  return (
    <div className="chart-box tall">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={c.grid} strokeDasharray="3 3" />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(v: number) => shortDateTime(v, lang)} stroke={c.axis} fontSize={11} minTickGap={48} />
          <YAxis domain={['auto', 'auto']} tickFormatter={(v: number) => fmt(v) ?? ''} stroke={c.axis} fontSize={11} width={52} />
          <Tooltip
            isAnimationActive={false}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]!.payload as Row;
              return (
                <div className="tooltip">
                  <div className="faint">{dateTime(new Date(Number(label)).toISOString(), lang)}</div>
                  {row.m !== undefined && <div>{t('chart.measured')}: <b>{fmt(row.m)} {t('unit.m')}</b></div>}
                  {row.fc !== undefined && row.m === undefined && (
                    <div>
                      {t('outlook.chart.routed')}: <b>{fmt(row.fc)} {t('unit.m')}</b>
                      {row.band && <div className="faint">{t('forecast.range', { low: fmt(row.band[0]), high: fmt(row.band[1]) })}</div>}
                    </div>
                  )}
                </div>
              );
            }}
          />
          {lvl?.warning != null && <ReferenceLine y={lvl.warning / 100} stroke={c.warning} strokeDasharray="6 4" ifOverflow="extendDomain" />}
          {lvl?.danger != null && <ReferenceLine y={lvl.danger / 100} stroke={c.danger} strokeDasharray="6 4" ifOverflow="extendDomain" />}
          {nowT !== null && <ReferenceLine x={nowT} stroke={c.axis} strokeDasharray="2 3" label={{ value: t('chart.now'), fill: c.axis, fontSize: 10, position: 'top' }} />}
          <Area dataKey="band" stroke="none" fill={c.forecastBand} fillOpacity={0.22} isAnimationActive={false} />
          <Line dataKey="m" stroke={c.measured} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line dataKey="fc" stroke={c.forecast} strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function Verification() {
  const { t, lang } = useI18n();
  const { stations, live, describeError } = useStore();
  const [data, setData] = useState<{ leadH: number; items: Array<StationVerification & { danger: StationVerification['danger'] & { localTrendLeadH: number | null } }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runId = live.snapshot?.context.runId;
  useEffect(() => setData(null), [runId]);
  const run = async () => {
    setBusy(true);
    try {
      setData(await api.get('/api/outlook/verification?leadH=24'));
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const name = (code: string) => stations.find((s) => s.code === code)?.name ?? code;
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{t('outlook.verify.title')}</h2>
          <p className="muted">{t('outlook.verify.hint')}</p>
        </div>
        <button className="btn" onClick={() => void run()} disabled={busy}>
          <Icon name="check" />
          {data ? t('outlook.verify.again') : t('outlook.verify.run')}
        </button>
      </div>
      {error && <div className="callout danger">{error}</div>}
      {data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('outlook.col.station')}</th>
                <th>{t('outlook.verify.leadDanger')}</th>
                <th>{t('outlook.verify.mae', { h: data.leadH })}</th>
                <th>{t('outlook.verify.skill')}</th>
                <th>{t('outlook.verify.coverage')}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((v) => (
                <tr key={v.code}>
                  <td>
                    <b>{name(v.code)}</b>
                    <div className="faint">{t(`outlook.method.${v.method}`)}</div>
                  </td>
                  <td>
                    {v.danger.actualTime ? (
                      <div className="lead-compare">
                        <div>
                          <span className="lead-bar outlook" style={{ width: `${Math.min(100, (v.danger.outlookLeadH ?? 0) / 1.2)}%` }} />
                          <b className="num">{v.danger.outlookLeadH} {t('unit.h')}</b> <span className="faint">{t('outlook.verify.byOutlook')}</span>
                        </div>
                        <div>
                          <span className="lead-bar trend" style={{ width: `${Math.min(100, (v.danger.localTrendLeadH ?? 0) / 1.2)}%` }} />
                          <span className="num">{v.danger.localTrendLeadH} {t('unit.h')}</span> <span className="faint">{t('outlook.verify.byTrend')}</span>
                        </div>
                      </div>
                    ) : (
                      <span className="muted">{t('outlook.verify.noCrossing')}</span>
                    )}
                  </td>
                  <td className="num">
                    {v.maeCm !== null ? (
                      <>
                        <b>{number(v.maeCm, lang)} {t('unit.cm')}</b>
                        <div className="faint">{t('outlook.verify.persistence', { v: number(v.persistenceMaeCm, lang) })}</div>
                      </>
                    ) : (
                      <Val>{null}</Val>
                    )}
                  </td>
                  <td className="num">{v.skill !== null ? number(v.skill, lang, 2) : <Val>{null}</Val>}</td>
                  <td className="num">{v.bandCoverage !== null ? `${Math.round(v.bandCoverage * 100)} %` : <Val>{null}</Val>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="faint note">{t('outlook.verify.note')}</p>
    </section>
  );
}

export function Outlook() {
  const { t, lang } = useI18n();
  const { user, setLoginOpen, selected, select } = useStore();
  const { outlook, error } = useOutlook();
  const text = useCrossingText();
  const st = useMemo(() => outlook?.stations.find((s) => s.code === selected) ?? outlook?.stations[0] ?? null, [outlook, selected]);
  const { stations } = useStore();

  if (!user) {
    return (
      <section className="card">
        <h2>{t('nav.outlook')}</h2>
        <p className="muted">{t('outlook.lead')}</p>
        <div className="callout info">
          {t('outlook.loginRequired')}{' '}
          <button className="btn sm" onClick={() => setLoginOpen(true)}>
            {t('auth.login')}
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="page-stack">
      <section className="card">
        <div className="card-head">
          <div>
            <h2>{t('outlook.title')}</h2>
            <p className="muted">{t('outlook.lead')}</p>
          </div>
          {outlook && <span className="pill demo num">{t('outlook.asOf', { time: dateTime(outlook.asOf, lang) })}</span>}
        </div>
        {error && <div className="callout danger">{error}</div>}
        {!outlook ? (
          <div className="empty">
            <p>
              <b>{t('outlook.empty')}</b>
            </p>
            <p className="muted">{t('alerts.emptyHint')}</p>
          </div>
        ) : (
          <RiverBoard outlook={outlook} selected={st?.code ?? ''} onSelect={select} />
        )}
        {outlook?.stations.some((s) => s.assumedHistory) && <p className="faint note">{t('outlook.assumedHistory')}</p>}
      </section>

      {st && (
        <section className="card">
          <div className="card-head">
            <h2>
              {t('outlook.chart.title')} · {stations.find((s) => s.code === st.code)?.name ?? st.code}
            </h2>
          </div>
          <div className="outlook-facts">
            <div>
              <span className="eyebrow">{t('outlook.fact.danger')}</span>
              <b>{text(st.danger, st.horizonH)}</b>
            </div>
            <div>
              <span className="eyebrow">{t('outlook.fact.peak')}</span>
              <b className="num">
                {st.peak ? `${metersFromCm(st.peak.levelCm, lang)} ${t('unit.m')} · +${st.peak.h} ${t('unit.h')}` : '—'}
              </b>
              {st.peak?.atHorizonEnd && <span className="faint">{t('outlook.fact.peakBeyond')}</span>}
            </div>
            <div>
              <span className="eyebrow">{t('outlook.fact.basis')}</span>
              <b>{st.method === 'ROUTED' ? st.sourceChain.slice(0, -1).map((c) => stations.find((s) => s.code === c)?.name ?? c).join(' → ') : t(`outlook.method.${st.method}`)}</b>
              <span className="faint">{t('outlook.fact.horizon', { h: st.horizonH })}</span>
            </div>
          </div>
          <OutlookChart st={st} />
          {st.issue && <div className="callout">{t(`outlook.issue.${st.issue}`)}</div>}
        </section>
      )}

      <Verification />

      <Disclosure title={t('outlook.how.title')}>
        <div className="prose">
          <p>{t('outlook.how.p1')}</p>
          <p className="mono-sm">{t('outlook.how.formula')}</p>
          <p>{t('outlook.how.p2')}</p>
          <p>{t('outlook.how.p3')}</p>
          <p className="faint">{t('outlook.how.limits')}</p>
        </div>
      </Disclosure>
    </div>
  );
}
