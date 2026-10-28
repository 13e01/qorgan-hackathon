// Карточка выбранной станции. Первый уровень — главное простыми словами: уровень, оценка опасности, тенденция,
// короткое объяснение, время измерения. «Подробнее» — пороги, прогноз, факторы, качество данных, история, техника.
// Итоговый риск T2, местная обстановка и угроза сверху показываются РАЗДЕЛЬНО (describeSituation на сервере);
// угроза сверху не изображается как уже случившийся подъём.

import type { ExplanationResponse, ForecastResponse } from '../api/types';
import { useI18n } from '../i18n';
import { dateTime, metersFromCm, number, signed } from '../lib/format';
import { levelView } from '../lib/level';
import { plainStatus } from '../lib/status';
import { useStore } from '../state/store';
import { LevelChart } from './LevelChart';
import { TrendIcon } from './StationList';
import { Disclosure, Icon, RiskBadge, Val } from './ui';

function ForecastBlock({ forecast }: { forecast: ForecastResponse | null }) {
  const { t, lang } = useI18n();
  const { user, setLoginOpen } = useStore();
  if (!user) {
    return (
      <div className="callout info">
        {t('forecast.loginRequired')}{' '}
        <button className="btn sm" onClick={() => setLoginOpen(true)}>
          {t('auth.login')}
        </button>
      </div>
    );
  }
  if (!forecast) return <p className="muted">{t('common.loading')}</p>;
  const { forecast: f, eta } = forecast;
  const m = (cm: number | null) => metersFromCm(cm, lang);
  let etaText: string;
  if (eta.status === 'ESTIMATED') {
    etaText = eta.highH === null ? t('eta.ESTIMATED_OPEN', { h: number(eta.hours, lang), low: number(eta.lowH, lang) }) : t('eta.ESTIMATED', { h: number(eta.hours, lang), low: number(eta.lowH, lang), high: number(eta.highH, lang) });
  } else etaText = t(`eta.${eta.status}`);
  return (
    <>
      {f.status === 'OK' ? (
        <dl className="kv">
          <dt>{t('forecast.level')}</dt>
          <dd>
            <b>
              {m(f.levelCm)} {t('unit.m')}
            </b>{' '}
            <span className="faint">{f.lowCm !== f.highCm ? t('forecast.range', { low: m(f.lowCm), high: m(f.highCm) }) : ''}</span>
          </dd>
          <dt>{t('forecast.eta')}</dt>
          <dd>{etaText}</dd>
        </dl>
      ) : (
        <div className="callout">{t(`forecast.status.${f.status}`)}</div>
      )}
      <p className="faint note">{t('forecast.disclaimer')}</p>
    </>
  );
}

function Factors({ explanation }: { explanation: ExplanationResponse | null }) {
  const { t, reason } = useI18n();
  if (!explanation) return <p className="muted">{t('common.loading')}</p>;
  return (
    <div>
      {explanation.factors.map((f) => (
        <div key={f.code} className="factor">
          <span>{t(`factor.${f.code}`)}</span>
          <span className={`pts${f.points > 0 ? ' on' : ''}`}>
            {f.status === 'OK' || f.status === 'STALE' ? t('factor.points', { points: f.points, max: f.maxPoints }) : t(`factor.status.${f.status}`)}
          </span>
          {f.reason && <span className="why">{reason(f.reason)}</span>}
        </div>
      ))}
    </div>
  );
}

export function StationCard({
  code,
  explanation,
  forecast,
  showHistory = false,
}: {
  code: string;
  explanation: ExplanationResponse | null;
  forecast: ForecastResponse | null;
  showHistory?: boolean;
}) {
  const { t, lang, reason } = useI18n();
  const { stations, live } = useStore();
  const meta = stations.find((s) => s.code === code);
  const snap = live.snapshot?.stations.find((s) => s.code === code);
  if (!meta) return <div className="card">{t('station.select')}</div>;

  const r = snap?.risk;
  const situation = r?.situation;
  const lv = levelView(snap);
  const hasData = lv.measuredCm !== null;
  const level = metersFromCm(lv.measuredCm, lang);
  const status = plainStatus(snap);
  const upstream = hasData ? situation?.upstream : null;
  const upstreamName = upstream ? (stations.find((s) => s.code === upstream.stationCode)?.name ?? upstream.stationCode) : null;
  const upstreamHere = situation?.localTrend === 'RISING' || situation?.localLevel === 'ABOVE_WARNING' || situation?.localLevel === 'ABOVE_DANGER';
  const reasons = hasData ? (r?.topReasons ?? []).filter((x) => x.code !== 'UPSTREAM_WAVE').slice(0, 2) : [];
  const qualityIssues = explanation?.dataQuality.issues ?? [];
  const m = (cm: number | null | undefined) => {
    const v = metersFromCm(cm, lang);
    return v ? `${v} ${t('unit.m')}` : null;
  };

  return (
    <div className="card station-card" aria-live="polite">
      <div className="sc-head">
        <div>
          <div className="eyebrow">{t('dash.selected')}</div>
          <h2 className="sc-name">{meta.name}</h2>
        </div>
        <div className="sc-risk">
          <span className="faint">{t('risk.final')}</span>
          <RiskBadge risk={status.risk} large />
        </div>
      </div>

      <div className="sc-level">
        <span className="big-level num">
          <Val>{level ? `${level} ${t('unit.m')}` : null}</Val>
        </span>
        {r && hasData && (
          <span className={`trend-chip t-${r.trend}`}>
            <TrendIcon trend={r.trend} />
            {t(`trend.${r.trend}`)}
            {r.rateCmH !== null && r.trend !== 'STABLE' && (
              <span className="num">
                {' '}
                {signed(r.rateCmH, lang)} {t('unit.cmh')}
              </span>
            )}
          </span>
        )}
      </div>
      {hasData && <div className="faint num">{t('card.measured', { time: dateTime(lv.measuredAt, lang) })}</div>}

      <div className={`status-line tone-${status.tone}`}>
        <span className="status-dot" aria-hidden="true" />
        {t(status.key)}
      </div>

      {lv.differs && <div className="callout warn">{t('level.unconfirmed', { level: metersFromCm(lv.assessedCm, lang) })}</div>}

      {upstream && (
        <div className="callout upstream">
          <Icon name="info" />
          <div>
            <b>{t('upstream.title')}</b>
            <p>
              {upstreamHere
                ? t('card.upstreamArrived', { station: upstreamName, risk: t(`risk.${upstream.risk}`) })
                : t('card.upstreamPlain', { station: upstreamName, risk: t(`risk.${upstream.risk}`), hours: upstream.travelHours })}
            </p>
          </div>
        </div>
      )}

      {reasons.length > 0 && (
        <div className="sc-why">
          <div className="eyebrow">{t('card.why')}</div>
          <ul className="reasons">
            {reasons.map((x, i) => (
              <li key={i}>{reason(x)}</li>
            ))}
          </ul>
        </div>
      )}

      <Disclosure title={t('card.more')} className="sc-more">
        <section className="section">
          <h3>{t('card.thresholds')}</h3>
          <dl className="kv">
            <dt>{t('level.warning')}</dt>
            <dd>
              <Val>{m(r?.warningCm)}</Val>
            </dd>
            <dt>{t('level.danger')}</dt>
            <dd>
              <Val>{m(r?.dangerCm)}</Val>
            </dd>
            <dt>{t('level.local')}</dt>
            <dd>{situation ? t(`level.status.${situation.localLevel}`) : <Val>{null}</Val>}</dd>
          </dl>
          <p className="faint note">{t('level.thresholdsNote')}</p>
        </section>

        <section className="section">
          <h3>{t('forecast.title')}</h3>
          <ForecastBlock forecast={forecast} />
        </section>

        <section className="section">
          <h3>{t('drivers.title')}</h3>
          {situation && <p className="muted">{t(`drivers.${situation.drivers}`)}</p>}
          <Factors explanation={explanation} />
          {r && <p className="faint num note">{t('risk.score', { score: r.score, max: r.maxScore })}</p>}
          <p className="faint note">{t('risk.model')}</p>
        </section>

        <section className="section">
          <h3>{t('quality.title')}</h3>
          <dl className="kv">
            <dt>{t('quality.title')}</dt>
            <dd>{r ? t(`quality.status.${r.dataStatus}` as 'quality.status.OK') : <Val>{null}</Val>}</dd>
            <dt>{t('quality.confidence')}</dt>
            <dd>{r ? t(`confidence.${r.confidence}`) : <Val>{null}</Val>}</dd>
          </dl>
          {qualityIssues.length > 0 && (
            <ul className="reasons">
              {qualityIssues.map((q, i) => (
                <li key={i}>{reason(q)}</li>
              ))}
            </ul>
          )}
        </section>

        {showHistory && (
          <section className="section">
            <h3>{t('chart.title')}</h3>
            <LevelChart code={code} forecast={forecast} />
          </section>
        )}

        <section className="section">
          <h3>{t('card.technical')}</h3>
          <dl className="kv">
            <dt>{t('station.code')}</dt>
            <dd className="num">
              {meta.code} · {t(`station.status.${meta.status}` as 'station.status.active')}
            </dd>
            <dt>{t('station.coords')}</dt>
            <dd className="num">
              {number(meta.lat, lang, 4)}, {number(meta.lon, lang, 4)}
            </dd>
            <dt>{t('station.upstream')}</dt>
            <dd>
              {meta.upstreamCode ? `${meta.upstreamCode} · ${t('station.travel')}: ${meta.travelHours} ${t('unit.h')}` : t('station.upstreamNone')}
            </dd>
            <dt>{t('level.assessedAt')}</dt>
            <dd className="num">
              <Val>{dateTime(r?.measuredAt, lang)}</Val>
              {r?.ageH ? <span className="faint"> · {t('level.age', { h: number(r.ageH, lang) })}</span> : null}
            </dd>
            {hasData && (
              <>
                <dt>{t('level.measured')}</dt>
                <dd className="num">
                  {Math.round(lv.measuredCm!)} {t('unit.cm')}
                </dd>
              </>
            )}
          </dl>
          <p className="faint note">{t('station.demo')}</p>
        </section>
      </Disclosure>
    </div>
  );
}
