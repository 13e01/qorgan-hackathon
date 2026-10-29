// Telegram-уведомления в журнале предупреждений (оператору): состояние бота, привязка чата по одноразовому коду,
// подписка, проверочное сообщение и журнал отправок. Тексты сообщений формирует сервер из событий QORGAN.

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { TelegramStatus } from '../api/types';
import { useI18n, type MessageKey } from '../i18n';
import { dateTime, timeWithSeconds } from '../lib/format';
import { useAlertsSignature } from '../pages/Alerts';
import { useStore } from '../state/store';
import { Disclosure } from './ui';

export function TelegramPanel() {
  const { t, lang } = useI18n();
  const { reportError, notify } = useStore();
  const signature = useAlertsSignature();
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: string; deepLink: string | null; botUsername: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<TelegramStatus>('/api/telegram/status')
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  // Обновляется при изменении предупреждений (новое событие — новая запись очереди) и после действий.
  useEffect(load, [load, signature]);
  // Пока код показан, ждём привязки (раз в 3 с, не дольше срока кода); после привязки код больше не нужен.
  const linkedCount = status?.links.length ?? 0;
  const [linkedAtCode, setLinkedAtCode] = useState(0);
  useEffect(() => {
    if (!code) return;
    if (linkedCount > linkedAtCode) {
      setCode(null);
      return;
    }
    const timer = setInterval(load, 3000);
    const stop = setTimeout(() => clearInterval(timer), Math.max(0, Date.parse(code.expiresAt) - Date.now()));
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [code, linkedCount, linkedAtCode, load]);

  const act = async (fn: () => Promise<unknown>, done?: MessageKey) => {
    setBusy(true);
    try {
      await fn();
      if (done) notify('info', t(done));
      load();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  const hint = status.enabled ? t(`tg.state.${status.state}`) : t('tg.state.DISABLED');
  return (
    <Disclosure className="card tg-panel" title={t('tg.title')} hint={hint}>
      {!status.enabled ? (
        <div className="callout info">{t('tg.disabledHelp')}</div>
      ) : (
        <>
          {status.state === 'ERROR' && <div className="callout warn">{t('tg.error', { code: status.lastError })}</div>}
          <p className="muted">{t('tg.lead', { h: status.cooldownTicks })}</p>
          <div className="tg-actions">
            <button className="btn primary sm" disabled={busy} onClick={() => void act(async () => {
                setLinkedAtCode(linkedCount);
                setCode(await api.post('/api/telegram/link-code'));
              })}>
              {t('tg.getCode')}
            </button>
            <button className="btn sm" disabled={busy || status.links.length === 0} onClick={() => void act(() => api.post('/api/telegram/test'), 'tg.testQueued')}>
              {t('tg.test')}
            </button>
          </div>
          {code && (
            <div className="callout info tg-code">
              <div>
                <p>{t('tg.codeHow', { bot: code.botUsername ? `@${code.botUsername}` : t('tg.yourBot') })}</p>
                <p className="tg-code-value num">
                  /start {code.code}
                </p>
                <p className="faint">{t('tg.codeExpires', { time: timeWithSeconds(code.expiresAt, lang) })}</p>
                {code.deepLink && (
                  <a href={code.deepLink} target="_blank" rel="noreferrer noopener">
                    {t('tg.openBot')}
                  </a>
                )}
              </div>
            </div>
          )}
          {status.allowlist && <p className="faint note">{t('tg.allowlist')}</p>}
        </>
      )}

      <h4 className="tg-sub">{t('tg.links')}</h4>
      {status.links.length === 0 ? (
        <p className="muted">{t('tg.noLinks')}</p>
      ) : (
        <ul className="tg-links">
          {status.links.map((l) => (
            <li key={l.id}>
              <span className="num">
                {t('tg.chat')} {l.chat}
                {l.tgUsername ? ` · @${l.tgUsername}` : ''} · {l.username}
              </span>
              <label className="switch-row compact">
                <input type="checkbox" role="switch" checked={l.subscribed} disabled={busy} onChange={(e) => void act(() => api.patch(`/api/telegram/links/${l.id}`, { subscribed: e.target.checked }))} />
                <span>{t('tg.subscribed')}</span>
              </label>
              <button className="btn sm ghost" disabled={busy} onClick={() => void act(() => api.del(`/api/telegram/links/${l.id}`), 'tg.unlinked')}>
                {t('tg.unlink')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <h4 className="tg-sub">{t('tg.log')}</h4>
      {status.outbox.length === 0 ? (
        <p className="muted">{t('tg.logEmpty')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th>{t('tg.col.time')}</th>
                <th>{t('tg.col.what')}</th>
                <th>{t('tg.col.chat')}</th>
                <th>{t('tg.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {status.outbox.map((o) => (
                <tr key={o.id}>
                  <td className="num">{dateTime(o.sentAt ?? o.createdAt, lang)}</td>
                  <td>{o.kind === 'ALERT' ? t('tg.kind.ALERT', { station: o.stationCode }) : t('tg.kind.TEST')}</td>
                  <td className="num">{o.chatId}</td>
                  <td>
                    <span className={`tg-status st-${o.status}`}>{t(`tg.status.${o.status}`)}</span>
                    {o.lastError && <span className="faint num"> · {o.lastError}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="faint note">{t('tg.note')}</p>
    </Disclosure>
  );
}
