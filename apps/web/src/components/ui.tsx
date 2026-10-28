// Небольшие общие элементы интерфейса.

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { RiskLevel } from '../api/shared';
import type { DataMode } from '../api/types';
import { useI18n } from '../i18n';
import { useStore } from '../state/store';

export function RiskBadge({ risk, large = false }: { risk: RiskLevel | 'NO_DATA' | null | undefined; large?: boolean }) {
  const { t } = useI18n();
  const r = risk ?? 'NO_DATA';
  return <span className={`risk risk-${r}${large ? ' lg' : ''}`}>{t(`risk.${r}`)}</span>;
}

export function ModePill({ mode }: { mode: DataMode | 'STALE' }) {
  const { t } = useI18n();
  return (
    <span className={`pill mode-${mode}`} title={t(`mode.hint.${mode}`)}>
      <span className="dot" aria-hidden="true" />
      {t(`mode.${mode}`)}
    </span>
  );
}

/** Значение или «Нет данных» — никогда не подставляем ноль вместо отсутствующих данных. */
export function Val({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return <>{children === null || children === undefined || children === '' ? <span className="muted">{t('common.noData')}</span> : children}</>;
}

export function Notices() {
  const { notices, dismiss } = useStore();
  const { t } = useI18n();
  return (
    <div className="notices" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`notice ${n.kind}`} role={n.kind === 'error' ? 'alert' : 'status'}>
          <span>{n.text}</span>
          <button className="btn ghost sm" onClick={() => dismiss(n.id)} aria-label={t('common.close')}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function LoginDialog() {
  const { loginOpen, setLoginOpen, login, describeError } = useStore();
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (loginOpen && !d.open) d.showModal();
    if (!loginOpen && d.open) d.close();
  }, [loginOpen]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      setPassword('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} onClose={() => setLoginOpen(false)} aria-labelledby="login-title">
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 id="login-title">{t('auth.title')}</h2>
        <div className="field">
          <label htmlFor="login-user">{t('auth.username')}</label>
          <input id="login-user" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="login-pass">{t('auth.password')}</label>
          <input id="login-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && (
          <div className="callout danger" role="alert">
            {error}
          </div>
        )}
        <p className="faint">{t('auth.hint')}</p>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={() => setLoginOpen(false)}>
            {t('auth.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {t('auth.submit')}
          </button>
        </div>
      </form>
    </dialog>
  );
}

const ICONS: Record<string, ReactNode> = {
  dashboard: <path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z" />,
  stations: <path d="M12 21s-6-5.5-6-10a6 6 0 1 1 12 0c0 4.5-6 10-6 10zm0-8a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />,
  analytics: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  simulator: <path d="M3 17c3-3 5-3 8 0s5 3 8 0M3 11c3-3 5-3 8 0s5 3 8 0M3 5c3-3 5-3 8 0s5 3 8 0" />,
};

export function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}
