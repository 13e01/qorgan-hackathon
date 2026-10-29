// Корень интерфейса: главная страница Hydro Future (пустой адрес, «#/») или рабочая система (#/dashboard и другие
// разделы). Обе части — отдельные файлы сборки: главная не тянет карту и графики, рабочая система — сцену главной.
// Переход между ними — перекрёстное затухание View Transitions API; без поддержки или при prefers-reduced-motion —
// мгновенная смена. Состояние входа, языка и темы живёт выше (провайдеры в main.tsx) и при переходе не теряется.

import { useEffect, useState, type ComponentType } from 'react';
import { flushSync } from 'react-dom';
import { prefersReducedMotion } from './components/motion';
import { isLegacyConceptHash, isWelcomeHash, WELCOME_HASH } from './lib/cinema';

type Part = 'welcome' | 'app';
type Loaded = { welcome?: ComponentType<{ returning: boolean }>; app?: ComponentType };

const loaded: Loaded = {};
const pending: Partial<Record<Part, Promise<void>>> = {};

/** Загрузить часть интерфейса один раз (повторные вызовы возвращают тот же промис). */
export function preload(part: Part): Promise<void> {
  pending[part] ??=
    part === 'app'
      ? import('./App').then((m) => void (loaded.app = m.App))
      : import('./welcome').then((m) => void (loaded.welcome = m.WelcomeApp));
  // Файл не загрузился (например, сервер перезапускается) — следующая попытка начнётся заново.
  pending[part].catch(() => delete pending[part]);
  return pending[part]!;
}

const partOf = (hash: string): Part => (isWelcomeHash(hash) ? 'welcome' : 'app');

export function Root() {
  const [part, setPart] = useState<Part>(() => partOf(location.hash));
  const [returning, setReturning] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    // Возврат кнопкой «Назад»: popstate приходит раньше hashchange — главная восстановит место прокрутки.
    let byHistory = false;
    const onPop = () => (byHistory = true);
    const onHash = () => {
      if (isLegacyConceptHash(location.hash)) history.replaceState(null, '', WELCOME_HASH);
      const next = partOf(location.hash);
      const viaHistory = byHistory;
      byHistory = false;
      const apply = () => {
        setReturning(viaHistory && next === 'welcome');
        setPart(next);
      };
      const vt = (document as Document & { startViewTransition?: (cb: () => void) => unknown }).startViewTransition;
      // Перекрёстное затухание — только если нужная часть уже загружена (иначе кадр перехода был бы пустым).
      if (vt && next !== part && loaded[next] && !prefersReducedMotion()) vt.call(document, () => flushSync(apply));
      else apply();
    };
    if (isLegacyConceptHash(location.hash)) history.replaceState(null, '', WELCOME_HASH);
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onHash);
    };
  }, [part]);

  useEffect(() => {
    if (!loaded[part]) preload(part).then(() => setTick((n) => n + 1));
  }, [part]);

  const Welcome = loaded.welcome;
  const App = loaded.app;
  if (part === 'welcome') return Welcome ? <Welcome returning={returning} /> : <div className="boot boot-welcome" aria-busy="true" />;
  return App ? <App /> : <div className="boot" aria-busy="true" />;
}
