// Небольшие общие элементы интерфейса.

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { RiskLevel } from '../api/shared';
import type { DataMode } from '../api/types';
import { LANGS, useI18n } from '../i18n';
import { THEME_PREFS, type ThemePref } from '../lib/prefs';
import { useTheme } from '../state/theme';
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
          <button className="icon-btn" onClick={() => dismiss(n.id)} aria-label={t('common.close')}>
            <Icon name="close" />
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
      <form onSubmit={submit} className="stack">
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
        <div className="btn-row end">
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

const ICONS = {
  dashboard: <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h4A1.5 1.5 0 0 1 11 5.5v5A1.5 1.5 0 0 1 9.5 12h-4A1.5 1.5 0 0 1 4 10.5zM13 5.5A1.5 1.5 0 0 1 14.5 4h4A1.5 1.5 0 0 1 20 5.5v2A1.5 1.5 0 0 1 18.5 9h-4A1.5 1.5 0 0 1 13 7.5zM13 12.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5zM4 15.5A1.5 1.5 0 0 1 5.5 14h4a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 9.5 20h-4A1.5 1.5 0 0 1 4 18.5z" />,
  stations: <path d="M12 21s-6.5-5.6-6.5-10.5a6.5 6.5 0 1 1 13 0C18.5 15.4 12 21 12 21zm0-8.2a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z" />,
  analytics: <path d="M4 20h16M7 16v-5M12 16V6M17 16v-8" />,
  simulator: <path d="M3 16c2.5-2.5 4.5-2.5 7 0s4.5 2.5 7 0 3-1.6 4-1M3 10c2.5-2.5 4.5-2.5 7 0s4.5 2.5 7 0 3-1.6 4-1" />,
  sun: <path d="M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  system: <path d="M4 5h16v11H4zM9 20h6M12 16v4" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  chevronLeft: <path d="M14.5 6 8.5 12l6 6" />,
  chevronRight: <path d="M9.5 6l6 6-6 6" />,
  chevronDown: <path d="M6 9.5l6 6 6-6" />,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  pause: <path d="M8 5v14M16 5v14" />,
  stop: <path d="M6.5 6.5h11v11h-11z" />,
  restart: <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4v4h4" />,
  sparkle: <path d="M12 3.5l1.8 5 5 1.8-5 1.8-1.8 5-1.8-5-5-1.8 5-1.8zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />,
  info: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 7.5v.5" />,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
  arrowFlat: <path d="M5 12h14M13 6l6 6-6 6" />,
  user: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0" />,
  logout: <path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14M10 16l-4-4 4-4M6 12h10" />,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size }: { name: IconName; size?: number }) {
  const filled = name === 'play' || name === 'stop';
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

/**
 * Сегментированный переключатель (radiogroup): стрелки двигают выбор, Tab — уходит из группы.
 * Используется для языка и темы.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className = '',
}: {
  label: string;
  value: T;
  options: Array<{ value: T; content: ReactNode; title: string }>;
  onChange: (v: T) => void;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (i + delta + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div className={`segmented ${className}`} role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          aria-label={o.title}
          title={o.title}
          tabIndex={value === o.value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.content}
        </button>
      ))}
    </div>
  );
}

export function LangSwitch() {
  const { t, lang, setLang } = useI18n();
  return (
    <Segmented
      className="lang-switch"
      label={t('lang.label')}
      value={lang}
      onChange={setLang}
      options={LANGS.map((l) => ({ value: l, content: t(`lang.short.${l}`), title: t(`lang.${l}`) }))}
    />
  );
}

const THEME_ICONS: Record<ThemePref, IconName> = { light: 'sun', dark: 'moon', system: 'system' };

export function ThemeSwitch() {
  const { t } = useI18n();
  const { pref, setPref } = useTheme();
  return (
    <Segmented
      className="theme-switch"
      label={t('theme.label')}
      value={pref}
      onChange={setPref}
      options={THEME_PREFS.map((p) => ({ value: p, content: <Icon name={THEME_ICONS[p]} />, title: t(`theme.${p}`) }))}
    />
  );
}

/** Раскрываемый раздел (progressive disclosure) на нативном <details>: доступен с клавиатуры и экранным дикторам. */
export function Disclosure({ title, hint, children, defaultOpen = false, className = '' }: { title: ReactNode; hint?: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  return (
    <details className={`disclosure ${className}`} open={defaultOpen || undefined}>
      <summary>
        <span className="disclosure-title">
          <span>{title}</span>
          {hint && <span className="disclosure-hint">{hint}</span>}
        </span>
        <Icon name="chevronDown" />
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
