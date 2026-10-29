// Одно предупреждение: уровень, станция, причина, время, статус обработки и действия оператора.
// Предупреждение — это запись журнала с жизненным циклом (открыто → обработано → снято), а не цвет индикатора.

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AlertEvent, AlertItem as Alert } from '../api/types';
import { useI18n } from '../i18n';
import { alertLifecycle } from '../lib/flow';
import { dateTime } from '../lib/format';
import { useStore } from '../state/store';
import { Icon, RiskBadge } from './ui';

export function AlertStatusChip({ alert }: { alert: Alert }) {
  const { t } = useI18n();
  return (
    <span className={`chip alert-status s-${alert.status}`}>
      {t(`alert.status.${alert.status}`)}
      {!alert.isActive && <span className="faint"> · {t('alert.cleared')}</span>}
    </span>
  );
}

/** Ход обработки (только отображение статуса сервера): открыто → просмотрено → обработано; «снято» — отдельно. */
export function AlertLifecycle({ alert }: { alert: Alert }) {
  const { t } = useI18n();
  return (
    <ol className="alert-life" aria-label={t('alert.lifecycle')}>
      {alertLifecycle(alert.status).map(({ status: s, step }) => (
        <li key={s} className={step === 'todo' ? '' : step} aria-current={step === 'current' ? 'step' : undefined}>
          <span className="life-dot" aria-hidden="true">
            {step !== 'todo' && <Icon name="check" />}
          </span>
          {t(`alert.status.${s}`)}
        </li>
      ))}
      {!alert.isActive && <li className="cleared">{t('alert.stage.cleared')}</li>}
    </ol>
  );
}

function Events({ alertId }: { alertId: number }) {
  const { t, lang } = useI18n();
  const [events, setEvents] = useState<AlertEvent[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .get<{ events: AlertEvent[] }>(`/api/alerts/${alertId}/events`)
      .then((r) => alive && setEvents(r.events))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [alertId]);
  if (error) return <p className="muted">{t('alert.eventsError')}</p>;
  if (!events) return <p className="muted">{t('common.loading')}</p>;
  return (
    <ol className="alert-events">
      {events.map((e) => (
        <li key={e.id}>
          <span className="num faint">{dateTime(e.createdAt, lang)}</span>
          <span>
            <b>{t(`alert.event.${e.type}`)}</b>
            {e.user && <span className="faint"> · {e.user}</span>}
            {e.comment && (
              <span>
                {' — '}
                {/* Системные причины переводятся, только если событие записала система (без автора). */}
                {e.user === null && e.comment === 'RUN_ENDED' ? t('alert.runEnded') : e.user === null && e.comment === 'STATION_DISABLED' ? t('alert.stationDisabled') : e.comment}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function AlertCard({ alert, compact = false, onChanged }: { alert: Alert; compact?: boolean; onChanged?: () => void }) {
  const { t, lang, reason } = useI18n();
  const { user, reportError, notify, select } = useStore();
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [comment, setComment] = useState('');
  const [showEvents, setShowEvents] = useState(false);

  const act = async (path: 'view' | 'resolve') => {
    setBusy(true);
    try {
      await api.post(`/api/alerts/${alert.id}/${path}`, path === 'resolve' ? { comment: comment.trim() || undefined } : {});
      notify('info', t(path === 'view' ? 'alert.done.view' : 'alert.done.resolve', { station: alert.stationName }));
      setResolving(false);
      setComment('');
      onChanged?.();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const first = alert.reasons[0];
  return (
    <article className={`alert-card sev-${alert.severity}${alert.isActive ? '' : ' is-cleared'}${compact ? ' compact' : ''}`}>
      <div className="alert-main">
        <span className="alert-sev" aria-hidden="true">
          <Icon name="warning" />
        </span>
        <RiskBadge risk={alert.severity} />
        <div className="alert-body">
          <div className="alert-title">
            <button className="link-btn" onClick={() => select(alert.stationCode)} title={t('alert.showStation')}>
              {alert.stationName}
            </button>
            <span className="faint"> · {t(`alert.trigger.${alert.trigger}`)}</span>
          </div>
          {first && <div className="alert-reason">{reason(first)}</div>}
          <div className="alert-meta faint num">
            {t('alert.openedAt', { time: dateTime(alert.openedAt, lang) })} · {t('alert.hazard.flood')}
          </div>
        </div>
        <AlertStatusChip alert={alert} />
      </div>
      {!compact && <AlertLifecycle alert={alert} />}

      {!compact && user && (
        <div className="alert-actions">
          {alert.status === 'NEW' && (
            <button className="btn sm" disabled={busy} onClick={() => void act('view')}>
              <Icon name="eye" />
              {t('alert.action.view')}
            </button>
          )}
          {alert.status !== 'RESOLVED' && !resolving && (
            <button className="btn sm primary" disabled={busy} onClick={() => setResolving(true)}>
              <Icon name="check" />
              {t('alert.action.resolve')}
            </button>
          )}
          <button className="btn sm ghost" onClick={() => setShowEvents((v) => !v)} aria-expanded={showEvents}>
            {t('alert.history')}
            <Icon name={showEvents ? 'chevronDown' : 'chevronRight'} />
          </button>
        </div>
      )}
      {resolving && (
        <form
          className="alert-resolve"
          onSubmit={(e) => {
            e.preventDefault();
            void act('resolve');
          }}
        >
          <label className="field">
            <span>{t('alert.comment')}</span>
            <input value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} placeholder={t('alert.commentHint')} autoFocus />
          </label>
          <div className="row-actions">
            <button type="button" className="btn sm ghost" onClick={() => setResolving(false)}>
              {t('auth.cancel')}
            </button>
            <button type="submit" className="btn sm primary" disabled={busy}>
              {t('alert.action.confirmResolve')}
            </button>
          </div>
        </form>
      )}
      {showEvents && <Events alertId={alert.id} />}
    </article>
  );
}
