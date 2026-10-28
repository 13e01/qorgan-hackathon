// Журнал предупреждений (ТЗ §5.6): фильтры, отметки «Просмотрено» / «Обработано» с комментарием, история событий.
// Гость видит только опубликованные (активные) предупреждения — из снимка WebSocket, без входа.

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { AlertItem, AlertStatus } from '../api/types';
import { AlertCard } from '../components/AlertItem';
import { PageHeader, Segmented } from '../components/ui';
import { useI18n } from '../i18n';
import { useStore } from '../state/store';

/** Подпись снимка, по которой журнал понимает, что предупреждения изменились (без опроса сервера). */
export function useAlertsSignature(): string {
  const { live } = useStore();
  const a = live.snapshot?.alerts;
  return a ? `${a.runId}:${a.unhandled}:${a.active.map((x) => `${x.id}${x.severity}${x.status}`).join(',')}` : 'none';
}

export function useAlertList(query: string, enabled: boolean): { items: AlertItem[] | null; reload: () => void; error: string | null } {
  const { describeError } = useStore();
  const signature = useAlertsSignature();
  const [items, setItems] = useState<AlertItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api
      .get<{ items: AlertItem[] }>(`/api/alerts?${query}`)
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setError(null);
      })
      .catch((err) => alive && setError(describeError(err)));
    return () => {
      alive = false;
    };
  }, [query, enabled, signature, nonce, describeError]);
  return { items, reload: () => setNonce((n) => n + 1), error };
}

type Scope = 'attention' | 'active' | 'all';

export function Alerts() {
  const { t } = useI18n();
  const { user, live, stations, setLoginOpen } = useStore();
  const [scope, setScope] = useState<Scope>('attention');
  const [status, setStatus] = useState<AlertStatus | ''>('');
  const [station, setStation] = useState('');
  const query = useMemo(() => {
    const p = new URLSearchParams({ limit: '200' });
    if (scope === 'active') p.set('active', 'true');
    if (scope === 'attention') p.set('unhandled', 'true');
    if (status) p.set('status', status);
    if (station) p.set('station', station);
    return p.toString();
  }, [scope, status, station]);
  const { items: fetched, reload, error } = useAlertList(query, user !== null);
  const items = user ? fetched : (live.snapshot?.alerts?.active ?? null);
  const summary = live.snapshot?.alerts;
  const highActive = summary?.active.filter((a) => a.severity === 'HIGH').length ?? 0;

  return (
    <div className="page-stack">
      <PageHeader title={t('alerts.title')} lead={t('alerts.hint')} />
      {summary && (
        <ul className="stat-row" aria-label={t('alerts.summary')}>
          <li className={`stat${highActive > 0 ? ' tone-danger' : ''}`}>
            <b className="stat-value num">{highActive}</b>
            <span className="stat-label">{t('alerts.activeCount')} · {t('alerts.highCount')}</span>
          </li>
          <li className={`stat${summary.active.length > 0 ? ' tone-warn' : ''}`}>
            <b className="stat-value num">{summary.active.length}</b>
            <span className="stat-label">{t('alerts.activeCount')}</span>
          </li>
          <li className={`stat${summary.unhandled > 0 ? ' tone-accent' : ''}`}>
            <b className="stat-value num">{summary.unhandled}</b>
            <span className="stat-label">{t('alerts.unhandledCount')}</span>
          </li>
        </ul>
      )}
      <section className="card">

        {user ? (
          <div className="filters">
            <Segmented
              label={t('alerts.scope')}
              value={scope}
              onChange={setScope}
              options={[
                { value: 'attention', content: t('alerts.scope.attention'), title: t('alerts.scope.attentionHint') },
                { value: 'active', content: t('alerts.scope.active'), title: t('alerts.scope.active') },
                { value: 'all', content: t('alerts.scope.all'), title: t('alerts.scope.all') },
              ]}
            />
            <label className="field inline">
              <span>{t('alerts.filter.status')}</span>
              <select value={status} onChange={(e) => setStatus(e.target.value as AlertStatus | '')}>
                <option value="">{t('alerts.filter.any')}</option>
                {(['NEW', 'VIEWED', 'RESOLVED'] as const).map((s) => (
                  <option key={s} value={s}>
                    {t(`alert.status.${s}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field inline">
              <span>{t('alerts.filter.station')}</span>
              <select value={station} onChange={(e) => setStation(e.target.value)}>
                <option value="">{t('alerts.filter.any')}</option>
                {stations.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <div className="callout info">
            {t('alerts.guest')}{' '}
            <button className="btn sm" onClick={() => setLoginOpen(true)}>
              {t('auth.login')}
            </button>
          </div>
        )}

        {error && <div className="callout danger">{error}</div>}
        {items === null ? (
          <p className="muted">{t('common.loading')}</p>
        ) : items.length === 0 ? (
          <div className="empty">
            <p>
              <b>{!user || scope === 'active' ? t('alerts.emptyActive') : scope === 'attention' ? t('alerts.emptyAttention') : t('alerts.empty')}</b>
            </p>
            <p className="muted">{t('alerts.emptyHint')}</p>
          </div>
        ) : (
          <div className="alert-list">
            {items.map((a) => (
              <AlertCard key={a.id} alert={a} onChanged={reload} />
            ))}
          </div>
        )}
      </section>
      <p className="faint note">{t('alerts.rules')}</p>
    </div>
  );
}
