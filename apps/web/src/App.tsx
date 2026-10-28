import { useCallback, useEffect, useRef, useState } from 'react';
import { DemoPanel } from './components/DemoPanel';
import { ROUTES, Sidebar, TopBar, type Route } from './components/Shell';
import { LoginDialog, Notices } from './components/ui';
import { useI18n } from './i18n';
import { browserStore, readSidebarCollapsed, writeSidebarCollapsed } from './lib/prefs';
import { Admin } from './pages/Admin';
import { Alerts } from './pages/Alerts';
import { Analytics } from './pages/Analytics';
import { Dashboard } from './pages/Dashboard';
import { Outlook, OutlookProvider } from './pages/Outlook';
import { Simulator } from './pages/Simulator';
import { Stations } from './pages/Stations';
import { useStore } from './state/store';

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

export function App() {
  const { t } = useI18n();
  const { connection, live } = useStore();
  const route = useRoute();
  const [collapsed, setCollapsed] = useState(() => readSidebarCollapsed(browserStore()));
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.title = `QORGAN — ${t(`nav.${route}`)}`;
  }, [route, t]);
  useEffect(() => setMenuOpen(false), [route]);
  // Новый раздел открывается сверху (прокручивается область содержимого, а не окно).
  const contentRef = useRef<HTMLElement>(null);
  useEffect(() => contentRef.current?.scrollTo({ top: 0 }), [route]);

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      writeSidebarCollapsed(browserStore(), !c);
      return !c;
    });
  }, []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  return (
    <OutlookProvider>
    <div className={`app${collapsed ? ' is-collapsed' : ''}${menuOpen ? ' menu-open' : ''}`}>
      <a className="skip-link" href="#content" onClick={(e) => (e.preventDefault(), contentRef.current?.focus())}>
        {t('common.skip')}
      </a>
      <Sidebar route={route} collapsed={collapsed} onToggle={toggle} mobileOpen={menuOpen} onCloseMobile={closeMenu} />
      <div className="scrim" onClick={closeMenu} aria-hidden="true" />
      <div className="main">
        <TopBar route={route} onMenu={() => setMenuOpen(true)} />
        {connection !== 'open' && live.snapshot && (
          <div className="banner" role="alert">
            {t('conn.lost')}
          </div>
        )}
        <main className="content" id="content" ref={contentRef} tabIndex={-1}>
          <DemoPanel compact={route !== 'dashboard'} />
          {route === 'dashboard' && <Dashboard />}
          {route === 'stations' && <Stations />}
          {route === 'analytics' && <Analytics />}
          {route === 'simulator' && <Simulator />}
          {route === 'outlook' && <Outlook />}
          {route === 'alerts' && <Alerts />}
          {route === 'admin' && <Admin />}
        </main>
      </div>
      <LoginDialog />
      <Notices />
    </div>
    </OutlookProvider>
  );
}
