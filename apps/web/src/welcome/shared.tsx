// Общие детали главной страницы Hydro Future: действия кнопок, живые данные, движение и знак QORGAN.
// Кнопки ведут в настоящую систему: «Открыть систему» — на главную панель, «Смотреть демонстрацию» — тот же
// «Демо за 2 минуты» (state/demo.tsx), что и в панели; без входа оператора открывается окно входа, а после входа
// демонстрация начинается сама (без второго нажатия).

import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useReducedMotion } from '../components/motion';
import { LANGS, useI18n, type MessageKey } from '../i18n';
import { DASHBOARD_HASH } from '../lib/cinema';
import { riverFlow } from '../lib/flow';
import { metersFromCm } from '../lib/format';
import { useDemo } from '../state/demo';
import { useStore } from '../state/store';
import { preload } from '../Root';

/**
 * Что сделать с отложенной демонстрацией (нажали «Смотреть демонстрацию» без входа): после входа — начать,
 * пока открыто окно входа — ждать, окно закрыто без входа — забыть.
 */
export function demoAfterLogin(pending: boolean, canControl: boolean, loginOpen: boolean): 'start' | 'wait' | 'drop' | 'idle' {
  if (!pending) return 'idle';
  if (canControl) return 'start';
  return loginOpen ? 'wait' : 'drop';
}

const SCROLL_KEY = 'qorgan.welcome.scroll';

/** Место прокрутки главной — запоминается при уходе в систему, восстанавливается при возврате кнопкой «Назад». */
export function rememberScroll(): void {
  try {
    sessionStorage.setItem(SCROLL_KEY, String(Math.round(window.scrollY)));
  } catch {
    /* хранилище недоступно — вернёмся наверх */
  }
}

export function takeScroll(): number {
  try {
    const v = Number(sessionStorage.getItem(SCROLL_KEY));
    sessionStorage.removeItem(SCROLL_KEY);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** Действия главных кнопок. Файл рабочей системы подгружается заранее (prime), чтобы переход был без ожидания. */
export function useCta() {
  const { begin } = useDemo();
  const { canControl, loginOpen } = useStore();
  const pending = useRef(false);
  const asked = useRef(false);
  useEffect(() => {
    // Окно входа ещё не успело открыться (сессия проверяется) — не сбрасываем просьбу раньше времени.
    if (loginOpen) asked.current = true;
    const next = demoAfterLogin(pending.current, canControl, loginOpen || !asked.current);
    if (next === 'start') begin();
    if (next === 'start' || next === 'drop') pending.current = asked.current = false;
  }, [canControl, loginOpen, begin]);
  const prime = useCallback(() => void preload('app').catch(() => {}), []);
  return {
    prime,
    openSystem: () => {
      prime();
      rememberScroll();
      location.hash = DASHBOARD_HASH;
    },
    watchDemo: () => {
      prime();
      rememberScroll();
      pending.current = !canControl;
      asked.current = false;
      begin();
    },
  };
}

/** Живая сводка по реке из снимка сервера (как «Живая река» на главной панели): ничего не пересчитывается. */
export function useRiverLive() {
  const { stations, live, connection } = useStore();
  const flow = useMemo(() => riverFlow(stations, live.snapshot), [stations, live.snapshot]);
  const withData = flow.nodes.filter((n) => n.levelCm !== null);
  return {
    stations,
    flow,
    online: connection === 'open',
    hasData: withData.length > 0,
    alerts: live.snapshot?.alerts ?? null,
  };
}

/** Уровень в метрах с единицей или «Нет данных» (ноль не подставляется). */
export function useLevelText() {
  const { t, lang } = useI18n();
  return (cm: number | null) => {
    const m = metersFromCm(cm, lang);
    return m === null ? t('common.noData') : `${m} ${t('unit.m')}`;
  };
}

// ── Движение ────────────────────────────────────────────────────────────────────────────────────────────────

const StillCtx = createContext<{ still: boolean }>({ still: false });

/** «Без движения» — только системная настройка prefers-reduced-motion (переключателя в интерфейсе нет). */
export function StillProvider({ children }: { children: ReactNode }) {
  const still = useReducedMotion();
  const value = useMemo(() => ({ still }), [still]);
  return <StillCtx.Provider value={value}>{children}</StillCtx.Provider>;
}
export const useStill = () => useContext(StillCtx);

/** Элемент получает класс is-in, когда впервые попадает в кадр (один раз). Без IntersectionObserver — сразу виден. */
export function useInView<T extends Element>(margin = '0px 0px -12% 0px'): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    if (typeof IntersectionObserver !== 'function') return setInView(true);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [margin, inView]);
  return [ref, inView];
}

/** Видим ли элемент сейчас (для паузы фоновых анимаций за пределами экрана). */
export function useVisible<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, visible];
}

export function Reveal({ as: Tag = 'div', className = '', delay = 0, children, ...rest }: { as?: 'div' | 'section' | 'li' | 'figure' | 'p'; className?: string; delay?: number; children: ReactNode } & Record<string, unknown>) {
  const [ref, inView] = useInView<HTMLElement>();
  const El = Tag as 'div';
  return (
    <El ref={ref as React.RefObject<HTMLDivElement>} className={`reveal${inView ? ' is-in' : ''} ${className}`} style={{ '--d': `${delay}ms` } as CSSProperties} {...rest}>
      {children}
    </El>
  );
}

/** Слова появляются по одному с лёгким размытием (blur-fade по словам). */
export function Words({ text, start = 0, step = 55, className = '' }: { text: string; start?: number; step?: number; className?: string }) {
  return (
    <span className={`words ${className}`} aria-label={text}>
      {text.split(' ').map((w, i) => (
        <Fragment key={i}>
          <span className="word" aria-hidden="true" style={{ '--d': `${start + i * step}ms` } as CSSProperties}>
            {w}
          </span>{' '}
        </Fragment>
      ))}
    </span>
  );
}

/** Число, которое один раз «досчитывает» до значения сервера при появлении. Без анимации — сразу значение. */
export function CountUp({ value, ms = 1400 }: { value: number | null; ms?: number }) {
  const { still } = useStill();
  const [ref, inView] = useInView<HTMLSpanElement>();
  const [shown, setShown] = useState<number | null>(still ? value : 0);
  useEffect(() => {
    if (value === null || still) return setShown(value);
    if (!inView) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      setShown(Math.round(value * (1 - (1 - k) ** 4)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, inView, still, ms]);
  return <span ref={ref}>{shown ?? '—'}</span>;
}

// ── Знак и мелкие элементы ──────────────────────────────────────────────────────────────────────────────────

/**
 * Знак QORGAN для главной страницы: разомкнутое кольцо «Q» (қорған — защита) и река, которая проходит сквозь
 * него и выходит хвостом буквы. Цвет — currentColor и --mark-accent концепции.
 */
export function QMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={`qmark ${className}`} width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <path d="M31.2 27.4A13.5 13.5 0 1 1 33.5 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M4.5 21.5c3.4-3.1 6.2-3.1 9.6 0s6.2 3.1 9.6 0 5.6-2.8 8.6 1.2l4.6 6.8" fill="none" className="qmark-river" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="wordmark">
      <QMark size={size} />
      <span className="wordmark-text">QORGAN</span>
    </span>
  );
}

/** Переключатель языка в стиле концепции (оформление — классом родителя). */
export function CineLang() {
  const { t, lang, setLang } = useI18n();
  return (
    <div className="cine-lang" role="group" aria-label={t('lang.label')}>
      {LANGS.map((l) => (
        <button key={l} type="button" aria-pressed={lang === l} title={t(`lang.${l}`)} onClick={() => setLang(l)}>
          {t(`lang.short.${l}`)}
        </button>
      ))}
    </div>
  );
}

/** Меню на весь экран для узких экранов: Esc и ссылка закрывают, фокус — на кнопку закрытия. */
export function FullMenu({ open, onClose, links, first = 1, children, className = '' }: { open: boolean; onClose: () => void; links: Array<{ id: string; key: MessageKey }>; first?: number; children?: ReactNode; className?: string }) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // Фокус — в меню, Tab не уходит за его пределы, страница под меню не прокручивается; после закрытия фокус
    // возвращается на кнопку, которая меню открыла.
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose();
      if (e.key !== 'Tab' || !boxRef.current) return;
      const items = [...boxRef.current.querySelectorAll<HTMLElement>('button, a[href]')];
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) (e.preventDefault(), lastEl?.focus());
      else if (!e.shiftKey && document.activeElement === lastEl) (e.preventDefault(), firstEl?.focus());
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.documentElement.style.overflow = overflow;
      opener?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={boxRef} className={`full-menu ${className}`} role="dialog" aria-modal="true" aria-label={t('cine.nav.menu')}>
      <button ref={closeRef} type="button" className="full-menu-close" onClick={onClose}>
        {t('cine.nav.close')}
      </button>
      <nav className="full-menu-links" aria-label={t('cine.nav.label')}>
        {links.map((l, i) => (
          <button type="button" key={l.id} onClick={() => (onClose(), requestAnimationFrame(() => scrollToId(l.id)))} style={{ '--d': `${80 + i * 70}ms` } as CSSProperties}>
            <span className="full-menu-n">0{i + first}</span>
            {t(l.key)}
          </button>
        ))}
      </nav>
      <div className="full-menu-foot">{children}</div>
    </div>
  );
}

/** Переход к разделу прототипа: хеш занят маршрутом, поэтому ссылки — кнопки с прокруткой. */
export function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

