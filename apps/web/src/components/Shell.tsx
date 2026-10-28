// Оболочка: боковая панель (свёрнута/развёрнута, на телефоне — выдвижное меню) и верхняя строка.

import { useEffect, useRef, useState } from 'react';
import { useI18n, type MessageKey } from '../i18n';
import { dateTime } from '../lib/format';
import { useStore } from '../state/store';
import { Icon, LangSwitch, ModePill, ThemeSwitch, type IconName } from './ui';

export const ROUTES = ['dashboard', 'outlook', 'alerts', 'stations', 'analytics', 'simulator', 'admin'] as const;
export type Route = (typeof ROUTES)[number];

type NavGroup = 'monitor' | 'data' | 'control';

/** Пункты меню по группам (Eclipse): мониторинг → данные → управление. Маршруты и права — прежние. */
export const NAV: Array<{ route: Route; key: MessageKey; icon: IconName; group: NavGroup; adminOnly?: boolean }> = [
  { route: 'dashboard', key: 'nav.dashboard', icon: 'dashboard', group: 'monitor' },
  { route: 'outlook', key: 'nav.outlook', icon: 'timeline', group: 'monitor' },
  { route: 'alerts', key: 'nav.alerts', icon: 'bell', group: 'monitor' },
  { route: 'stations', key: 'nav.stations', icon: 'stations', group: 'data' },
  { route: 'analytics', key: 'nav.analytics', icon: 'analytics', group: 'data' },
  { route: 'simulator', key: 'nav.simulator', icon: 'simulator', group: 'control' },
  { route: 'admin', key: 'nav.admin', icon: 'shield', group: 'control', adminOnly: true },
];

const GROUPS: NavGroup[] = ['monitor', 'data', 'control'];

/** Видимые пункты для роли: администрирование — только администратору. */
export function navItems(role: string | null | undefined) {
  return NAV.filter((n) => !n.adminOnly || role === 'admin');
}

export function Logo() {
  return (
    // Знак QORGAN: кольцо «Q» (защита, «қорған») и река, проходящая сквозь него.
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="10" className="logo-bg" />
      <circle cx="16" cy="15.5" r="8.6" fill="none" className="logo-ring" strokeWidth="2.2" />
      <path d="M20.6 21.6l3.6 3.6" className="logo-ring" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M5.5 17c2.3-2.1 4.1-2.1 6.3 0s4.1 2.1 6.3 0 4-2 7.4-.4" fill="none" className="logo-river" strokeWidth="2.3" strokeLinecap="round" />
    </svg>
  );
}

export function Sidebar({
  route,
  collapsed,
  onToggle,
  mobileOpen,
  onCloseMobile,
}: {
  route: Route;
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const { t } = useI18n();
  const { user, live } = useStore();
  const firstLink = useRef<HTMLAnchorElement>(null);
  const unhandled = live.snapshot?.alerts?.unhandled ?? 0;
  const items = navItems(user?.role);

  // В выдвижном меню фокус — на первый пункт; Esc закрывает.
  useEffect(() => {
    if (!mobileOpen) return;
    firstLink.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseMobile();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, onCloseMobile]);

  return (
    <aside className="sidebar" id="sidebar" aria-label={t('nav.label')}>
      <div className="brand">
        <a className="brand-home" href="#/dashboard" aria-label={t('nav.home')} onClick={onCloseMobile}>
          <Logo />
        </a>
        <div className="brand-text">
          <div className="brand-name">{t('app.title')}</div>
          <div className="brand-sub">{t('app.region')}</div>
        </div>
        <button className="icon-btn drawer-close" onClick={onCloseMobile} aria-label={t('nav.closeMenu')}>
          <Icon name="close" />
        </button>
      </div>
      <nav className="nav">
        {GROUPS.map((g) => {
          const group = items.filter((n) => n.group === g);
          if (group.length === 0) return null;
          return (
            <div key={g} className="nav-group" role="group" aria-labelledby={`nav-g-${g}`}>
              <div id={`nav-g-${g}`} className="nav-group-label">
                {t(`nav.group.${g}`)}
              </div>
              {group.map((n) => (
                <a
                  key={n.route}
                  ref={n === items[0] ? firstLink : undefined}
                  href={`#/${n.route}`}
                  aria-current={route === n.route ? 'page' : undefined}
                  data-tip={t(n.key)}
                  onClick={onCloseMobile}
                >
                  <Icon name={n.icon} />
                  <span className="nav-label">{t(n.key)}</span>
                  {n.route === 'alerts' && unhandled > 0 && (
                    <span className="nav-badge num" aria-label={t('alerts.unhandledAria', { n: unhandled })}>
                      {unhandled > 99 ? '99+' : unhandled}
                    </span>
                  )}
                </a>
              ))}
            </div>
          );
        })}
      </nav>
      <div className="drawer-prefs">
        <LangSwitch />
        <ThemeSwitch />
      </div>
      <div className="sidebar-foot">
        <span className="sidebar-note">{t('top.demoShort')}</span>
        <button
          className="icon-btn collapse-btn"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls="sidebar"
          aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
          data-tip={collapsed ? t('nav.expand') : t('nav.collapse')}
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} />
        </button>
      </div>
    </aside>
  );
}

export function TopBar({ route, onMenu }: { route: Route; onMenu: () => void }) {
  const { t, lang } = useI18n();
  const { live, connection, user, setLoginOpen, logout } = useStore();
  const ctx = live.snapshot?.context;
  // Без связи последние данные не выдаются за актуальные: режим «данные не обновляются».
  const mode = connection !== 'open' && live.snapshot ? 'STALE' : (ctx?.mode ?? 'NO_DATA');
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Часы — только отображение, к серверу не обращаются.
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const simTime = ctx?.virtualTime ? dateTime(ctx.virtualTime, lang) : null;

  return (
    <header className="topbar">
      <button className="icon-btn menu-btn" onClick={onMenu} aria-label={t('nav.menu')} aria-controls="sidebar">
        <Icon name="menu" />
      </button>
      {/* Заголовок экрана (h1) — в самой странице; здесь — короткий «где я». */}
      <div className="topbar-title">
        <span className="topbar-crumb">QORGAN</span>
        <span className="topbar-sep" aria-hidden="true">/</span>
        <span>{t(`nav.${route}`)}</span>
      </div>
      <div className="topbar-status">
        <ModePill mode={mode} />
        <span className="sim-clock num" title={t('top.techTime', { time: dateTime(now.toISOString(), lang) })}>
          <span className="faint">{t('top.simTime')}</span> <b>{simTime ?? t('top.simTimeNone')}</b>
        </span>
        {connection !== 'open' && (
          <span className={`pill conn-${connection}`} role="status">
            <span className="dot" aria-hidden="true" />
            {t(`conn.${connection}`)}
          </span>
        )}
        <span className="pill demo" title={t('risk.model')}>
          {t('top.demoShort')}
        </span>
      </div>
      <div className="topbar-tools">
        <LangSwitch />
        <ThemeSwitch />
        {user ? (
          <div className="user-chip">
            <Icon name="user" />
            <span className="user-name">
              {user.username}
              <span className="faint"> · {t(`auth.role.${user.role}`)}</span>
            </span>
            <button className="icon-btn" onClick={() => void logout()} aria-label={t('auth.logout')} title={t('auth.logout')}>
              <Icon name="logout" />
            </button>
          </div>
        ) : (
          <button className="btn primary sm" onClick={() => setLoginOpen(true)}>
            {t('auth.login')}
          </button>
        )}
      </div>
    </header>
  );
}
