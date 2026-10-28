import { useEffect, useState } from 'react';
import { Icon, LoginDialog, ModePill, Notices } from './components/ui';
import { LANGS, useI18n, type MessageKey } from './i18n';
import { dateTime, type Lang } from './lib/format';
import { Analytics } from './pages/Analytics';
import { Dashboard } from './pages/Dashboard';
import { Simulator } from './pages/Simulator';
import { Stations } from './pages/Stations';
import { useStore } from './state/store';

const ROUTES = ['dashboard', 'stations', 'analytics', 'simulator'] as const;
type Route = (typeof ROUTES)[number];

function useRoute(): Route {
  const read = (): Route => {
    const r = location.hash.replace(/^#\/?/, '');
    return (ROUTES as readonly string[]).includes(r) ? (r as Route) : 'dashboard';
  };
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function TopBar() {
  const { t, lang, setLang } = useI18n();
  const { live, connection, user, setLoginOpen, logout } = useStore();
  const ctx = live.snapshot?.context;
  // Без связи последние данные не выдаются за актуальные: режим «данные не обновляются».
  const mode = connection !== 'open' && live.snapshot ? 'STALE' : (ctx?.mode ?? 'NO_DATA');
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Часы в шапке — только отображение, к серверу не обращаются.
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="topbar">
      <div className="topbar-title">
        <strong>{t('app.subtitle')}</strong>
        <span className="faint">{t('app.region')}</span>
      </div>
      <div className="topbar-group">
        <ModePill mode={mode} />
        <span className="pill demo">{t('top.demo')}</span>
        <div className="clock">
          <span className="label">
            {t('top.simTime')} ({t('top.tz')})
          </span>
          <span className="value">{ctx?.virtualTime ? dateTime(ctx.virtualTime, lang, true) : t('top.simTimeNone')}</span>
        </div>
        <div className="clock">
          <span className="label">{t('top.systemTime')}</span>
          <span className="value">{dateTime(now.toISOString(), lang)}</span>
        </div>
        <span className={`pill conn-${connection}`} role="status">
          <span className="dot" aria-hidden="true" />
          {t(`conn.${connection}`)}
        </span>
      </div>
      <div className="topbar-group">
        <label className="visually-hidden" htmlFor="lang">
          {t('lang.label')}
        </label>
        <select id="lang" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
          {LANGS.map((l) => (
            <option key={l} value={l}>
              {t(`lang.${l}`)}
            </option>
          ))}
        </select>
        {user ? (
          <>
            <span className="muted">
              {user.username} · {t(`auth.role.${user.role}`)}
            </span>
            <button className="btn sm" onClick={() => void logout()}>
              {t('auth.logout')}
            </button>
          </>
        ) : (
          <>
            <span className="muted">{t('auth.guest')}</span>
            <button className="btn sm primary" onClick={() => setLoginOpen(true)}>
              {t('auth.login')}
            </button>
          </>
        )}
      </div>
    </header>
  );
}

const NAV: Array<{ route: Route; key: MessageKey; icon: 'dashboard' | 'stations' | 'analytics' | 'simulator' }> = [
  { route: 'dashboard', key: 'nav.dashboard', icon: 'dashboard' },
  { route: 'stations', key: 'nav.stations', icon: 'stations' },
  { route: 'analytics', key: 'nav.analytics', icon: 'analytics' },
  { route: 'simulator', key: 'nav.simulator', icon: 'simulator' },
];

export function App() {
  const { t } = useI18n();
  const { connection, live } = useStore();
  const route = useRoute();
  useEffect(() => {
    document.title = `QORGAN — ${t(`nav.${route}`)}`;
  }, [route, t]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-name">{t('app.title')}</div>
          <div className="brand-sub">{t('app.subtitle')}</div>
        </div>
        <nav className="nav" aria-label={t('nav.label')}>
          {NAV.map((n) => (
            <a key={n.route} href={`#/${n.route}`} aria-current={route === n.route ? 'page' : undefined}>
              <Icon name={n.icon} />
              <span>{t(n.key)}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">{t('station.demo')} · {t('top.demo')}</div>
      </aside>
      <div className="main">
        <TopBar />
        {connection !== 'open' && live.snapshot && (
          <div className="banner" role="alert">
            {t('conn.lost')}
          </div>
        )}
        <main className="content">
          {route === 'dashboard' && <Dashboard />}
          {route === 'stations' && <Stations />}
          {route === 'analytics' && <Analytics />}
          {route === 'simulator' && <Simulator />}
        </main>
      </div>
      <LoginDialog />
      <Notices />
    </div>
  );
}
