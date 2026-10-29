// Главная страница QORGAN — Hydro Future (пустой адрес, «#/»). Отдельный файл сборки: рабочая система её не
// загружает, а она не загружает карту и графики. Палитра — своя постоянная тёмная (локальные токены .hf), темы
// рабочей системы не затрагиваются. Движение — по системной настройке prefers-reduced-motion (data-still).

import { useEffect, type ReactNode } from 'react';
import { LoginDialog, Notices } from '../components/ui';
import { useI18n } from '../i18n';
import { HydroFuture } from './HydroFuture';
import { StillProvider, takeScroll, useStill } from './shared';
import './welcome.css';

export function WelcomeApp({ returning = false }: { returning?: boolean }) {
  const { t } = useI18n();
  useEffect(() => {
    document.title = `QORGAN — ${t('cine.slogan.full')}`;
  }, [t]);
  useEffect(() => {
    const y = returning ? takeScroll() : 0;
    window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior });
  }, [returning]);

  return (
    <StillProvider>
      <StillRoot>
        <HydroFuture />
        <LoginDialog />
        <Notices />
      </StillRoot>
    </StillProvider>
  );
}

function StillRoot({ children }: { children: ReactNode }) {
  const { still } = useStill();
  return (
    <div className="cine" data-still={still ? 'true' : undefined}>
      {children}
    </div>
  );
}
