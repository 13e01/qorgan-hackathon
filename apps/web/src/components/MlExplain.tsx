// «Почему такой риск?» — параллельная оценка QORGAN Sentinel (XGBoost) с объяснением SHAP на карточке станции.
// Официальное состояние QORGAN — оценка правил T2 (бейдж выше); ML — дополнительная учебная оценка, расхождение
// показывается явно. Данные — только из ответа сервера /api/stations/:id/ml; браузер ничего не считает.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { MlResponse } from '../api/types';
import { useI18n, type MessageKey } from '../i18n';
import { dateTime } from '../lib/format';
import { hasUpstreamOf, percent, summarize, topFactors, type Phrase } from '../lib/explain';
import { useStore } from '../state/store';
import { Icon, RiskBadge } from './ui';

const MIN_INTERVAL_MS = 800;

/** Ответ ML для станции: при выборе и при новой оценке ML в снимке, не чаще раза в 800 мс. */
function useMl(code: string) {
  const { live } = useStore();
  const [data, setData] = useState<MlResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const last = useRef(0);
  const snapMl = live.snapshot?.stations.find((s) => s.code === code)?.ml;
  const key = `${live.snapshot?.context.runId}:${snapMl?.tick ?? 'none'}:${live.snapshot?.mlModel?.status ?? ''}`;
  useEffect(() => {
    setData(null);
    last.current = 0;
  }, [code]);
  useEffect(() => {
    let alive = true;
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - last.current));
    const timer = setTimeout(() => {
      last.current = Date.now();
      api
        .get<MlResponse>(`/api/stations/${code}/ml`)
        .then((r) => {
          if (!alive) return;
          setData(r);
          setFailed(false);
        })
        .catch(() => alive && setFailed(true));
    }, wait);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [code, key]);
  return { data, failed };
}

export function MlExplain({ code }: { code: string }) {
  const { t, lang } = useI18n();
  const { data, failed } = useMl(code);
  const say = (p: Phrase) => t(p.key, { ...p.params, feature: typeof p.params.feature === 'string' ? t(p.params.feature as MessageKey) : undefined });

  const head = (
    <div className="ml-head">
      <div>
        <div className="eyebrow">{t('ml.eyebrow')}</div>
        <h3 className="ml-title">{t('ml.title')}</h3>
      </div>
      <span className="source-tag">{t('ml.badge')}</span>
    </div>
  );

  let body: ReactNode;
  const status = data?.model.status;
  if (failed && !data) body = <p className="callout warn">{t('ml.unavailable.NETWORK')}</p>;
  else if (!data) body = <p className="muted">{t('common.loading')}</p>;
  else if (status !== 'READY') body = <p className="callout warn">{t(`ml.unavailable.${status}` as MessageKey)}</p>;
  else if (!data.assessment) body = <p className="muted">{t('ml.noAssessment')}</p>;
  else if (data.assessment.status === 'ERROR' || !data.assessment.result) body = <p className="callout warn">{t('ml.unavailable.ERROR')}</p>;
  else if (data.assessment.status === 'INSUFFICIENT_DATA') body = <p className="callout">{t('ml.summary.insufficient')}</p>;
  else {
    const a = data.assessment;
    const r = a.result!;
    const factors = topFactors(r.contributions, lang, 5, hasUpstreamOf(r));
    const [first, ...rest] = summarize(r, lang);
    const p = r.category === 'HIGH' ? r.pDanger : r.pWarning;
    body = (
      <>
        <div className="ml-score">
          <RiskBadge risk={r.category} />
          <span className="ml-prob num">
            {t(r.category === 'HIGH' ? 'ml.pDanger' : 'ml.pWarning', { p: percent(p, lang), h: r.horizonH })}
          </span>
          {a.agreement && (
            <span className={`ml-agree agree-${a.agreement}`}>
              <Icon name={a.agreement === 'AGREE' ? 'check' : 'warning'} />
              {t(`ml.agreement.${a.agreement}`, { rules: t(`risk.${a.rulesRisk}`) })}
            </span>
          )}
        </div>
        <p className="ml-summary">
          <b>{say(first!)}</b> {rest.map((x) => say(x)).join(' ')}
        </p>
        <ul className="ml-factors" aria-label={t('ml.factors')}>
          {factors.map((f) => (
            <li key={f.feature} className={`ml-factor dir-${f.direction}`}>
              <span className="ml-dir" aria-hidden="true">
                <Icon name={f.direction === 'up' ? 'arrowUp' : 'arrowDown'} />
              </span>
              <span className="ml-factor-text">
                <span className="ml-factor-label">{t(f.label)}</span>
                <span className="ml-factor-say">{say(f.phrase)}</span>
              </span>
              <span className="ml-factor-value num">{f.value ? `${f.value.text}${f.value.unit ? ` ${t(f.value.unit)}` : ''}` : f.phrase.key === 'ml.say.noUpstream' ? '—' : t('common.noData')}</span>
              <span className="ml-bar" aria-hidden="true">
                <span style={{ width: `${Math.max(6, Math.round(f.weight * 100))}%` }} />
              </span>
              <span className="sr-only">{t(f.direction === 'up' ? 'ml.raises' : 'ml.lowers')}</span>
            </li>
          ))}
        </ul>
        <p className="faint note num">
          {t('ml.source', { version: a.modelVersion, time: dateTime(a.asOf, lang) })}
        </p>
      </>
    );
  }

  return (
    <section className="ml-explain" aria-live="polite">
      {head}
      {body}
      <p className="faint note">{t('ml.disclaimer')}</p>
    </section>
  );
}
