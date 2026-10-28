// Карточка выбранной станции. Главное требование: итоговый риск T2, локальный уровень относительно порогов
// и угроза со станции выше по течению показываются РАЗДЕЛЬНО (данные — describeSituation на сервере).

import type { ExplanationResponse, ForecastResponse } from '../api/types';
import { useI18n } from '../i18n';
import { dateTime, metersFromCm, number, signed } from '../lib/format';
import { levelView } from '../lib/level';
import { useStore } from '../state/store';
import { RiskBadge, Val } from './ui';

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
      <p className="faint" style={{ marginTop: 6 }}>
        {t('forecast.disclaimer')}
      </p>
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

export function StationCard({ code, explanation, forecast }: { code: string; explanation: ExplanationResponse | null; forecast: ForecastResponse | null }) {
  const { t, lang, reason } = useI18n();
  const { stations, live } = useStore();
  const meta = stations.find((s) => s.code === code);
  const snap = live.snapshot?.stations.find((s) => s.code === code);
  if (!meta) return <div className="panel">{t('station.select')}</div>;

  const r = snap?.risk;
  const situation = r?.situation;
  const lv = levelView(snap);
  const hasData = lv.measuredCm !== null;
  const level = metersFromCm(lv.measuredCm, lang);
  const upstreamName = situation?.upstream ? stations.find((s) => s.code === situation.upstream!.stationCode)?.name : null;
  const localTone = situation?.localLevel === 'ABOVE_DANGER' ? 'danger' : situation?.localLevel === 'ABOVE_WARNING' ? 'warn' : 'ok';
  const qualityIssues = explanation?.dataQuality.issues ?? [];

  return (
    <div className="panel card-side" aria-live="polite">
      <div className="station-head">
        <div>
          <h2 style={{ fontSize: 18 }}>{meta.name}</h2>
          <div className="code">
            {meta.code} · {t(`station.status.${meta.status}` as 'station.status.active')}
          </div>
          <div className="faint">{t('station.demo')}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="faint">{t('risk.final')}</div>
          <RiskBadge risk={hasData ? r!.risk : 'NO_DATA'} large />
          {r && <div className="faint num">{t('risk.score', { score: r.score, max: r.maxScore })}</div>}
        </div>
      </div>

      <div className="section">
        <h3>{t('level.local')}</h3>
        <div className="big-level">
          <Val>{level ? `${level} ${t('unit.m')}` : null}</Val>
        </div>
        {hasData && (
          <div className="faint num">
            {Math.round(lv.measuredCm!)} {t('unit.cm')} · {t('level.measured')}: {dateTime(lv.measuredAt, lang)}
          </div>
        )}
        {lv.differs && (
          <div className="callout warn" style={{ marginTop: 8 }}>
            {t('level.unconfirmed', { level: metersFromCm(lv.assessedCm, lang) })}
          </div>
        )}
        {situation && (
          <div className={`callout ${localTone}`} style={{ marginTop: 8 }}>
            {t(`level.status.${situation.localLevel}`)}
          </div>
        )}
        <dl className="kv" style={{ marginTop: 10 }}>
          <dt>{t('level.warning')}</dt>
          <dd>
            <Val>{metersFromCm(r?.warningCm, lang) && `${metersFromCm(r?.warningCm, lang)} ${t('unit.m')}`}</Val>
          </dd>
          <dt>{t('level.danger')}</dt>
          <dd>
            <Val>{metersFromCm(r?.dangerCm, lang) && `${metersFromCm(r?.dangerCm, lang)} ${t('unit.m')}`}</Val>
          </dd>
          <dt>{t('trend.title')}</dt>
          <dd>
            {r ? t(`trend.${r.trend}`) : <Val>{null}</Val>}
            {r?.rateCmH !== null && r?.rateCmH !== undefined && (
              <span className="muted">
                {' '}
                · {signed(r.rateCmH, lang)} {t('unit.cmh')}
              </span>
            )}
          </dd>
          <dt>{t('level.assessedAt')}</dt>
          <dd>
            <Val>{dateTime(r?.measuredAt, lang)}</Val>
            {r?.ageH ? <div className="faint">{t('level.age', { h: number(r.ageH, lang) })}</div> : null}
          </dd>
        </dl>
        <p className="faint" style={{ marginTop: 6 }}>
          {t('level.thresholdsNote')}
        </p>
      </div>

      <div className="section">
        <h3>{t('upstream.title')}</h3>
        {situation?.upstream ? (
          <div className="callout warn">
            <p>
              {t('upstream.text', {
                station: upstreamName ? `${upstreamName}, ${situation.upstream.stationCode}` : situation.upstream.stationCode,
                risk: t(`risk.${situation.upstream.risk}`),
                hours: situation.upstream.travelHours,
              })}
            </p>
            <p className="faint" style={{ marginTop: 6 }}>
              {t('upstream.note')}
            </p>
          </div>
        ) : (
          <p className="muted">{meta.upstreamCode ? t('upstream.none') : t('station.upstreamNone')}</p>
        )}
      </div>

      <div className="section">
        <h3>{t('drivers.title')}</h3>
        {situation && <p style={{ marginBottom: 6 }}>{t(`drivers.${situation.drivers}`)}</p>}
        <Factors explanation={explanation} />
        <p className="faint" style={{ marginTop: 6 }}>
          {t('risk.model')}
        </p>
      </div>

      <div className="section">
        <h3>{t('forecast.title')}</h3>
        <ForecastBlock forecast={forecast} />
      </div>

      <div className="section">
        <h3>{t('quality.title')}</h3>
        <dl className="kv">
          <dt>{t('quality.title')}</dt>
          <dd>{r ? t(`quality.status.${r.dataStatus}` as 'quality.status.OK') : <Val>{null}</Val>}</dd>
          <dt>{t('quality.confidence')}</dt>
          <dd>{r ? t(`confidence.${r.confidence}`) : <Val>{null}</Val>}</dd>
        </dl>
        {qualityIssues.length > 0 && (
          <ul className="reasons" style={{ marginTop: 6 }}>
            {qualityIssues.map((q, i) => (
              <li key={i}>{reason(q)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
