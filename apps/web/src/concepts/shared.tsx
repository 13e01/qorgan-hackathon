// Общие детали прототипов главной страницы: действия кнопок, живые данные, движение и знак QORGAN.
// Кнопки ведут в настоящую систему: «Открыть систему» — на главную панель, «Смотреть демонстрацию» — тот же
// «Демо за 2 минуты» (state/demo.tsx), что и в панели; без входа оператора он открывает окно входа.

import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useReducedMotion } from '../components/motion';
import { LANGS, useI18n, type MessageKey } from '../i18n';
import { riverFlow, type FlowNode } from '../lib/flow';
import { metersFromCm } from '../lib/format';
import { useDemo } from '../state/demo';
import { useStore } from '../state/store';

/** Действия главных кнопок — общие для всех концепций. */
export function useCta() {
  const { begin } = useDemo();
  return {
    openSystem: () => {
      location.hash = '#/dashboard';
    },
    watchDemo: begin,
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
    worst: worstNode(flow.nodes),
  };
}

const RANK = { NO_DATA: -1, LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
function worstNode(nodes: FlowNode[]): FlowNode | null {
  let best: FlowNode | null = null;
  for (const n of nodes) if (n.levelCm !== null && (!best || RANK[n.risk] > RANK[best.risk])) best = n;
  return best;
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

type MotionChoice = 'auto' | 'still' | 'motion';
const StillCtx = createContext<{ still: boolean; setChoice: (v: MotionChoice) => void }>({ still: false, setChoice: () => {} });

/**
 * «Без анимации»: по умолчанию — системная настройка prefers-reduced-motion. Переключатель на панели прототипа
 * нужен для сравнения концепций: можно выключить движение или посмотреть его, даже если в системе оно уменьшено.
 */
export function StillProvider({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  const [choice, setChoice] = useState<MotionChoice>('auto');
  const still = choice === 'still' || (choice === 'auto' && reduced);
  const value = useMemo(() => ({ still, setChoice }), [still]);
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

/**
 * Заголовок со строками, выезжающими из-под маски. Для диктора — одна цельная фраза (aria-label),
 * разбивка на строки только визуальная.
 */
export function MaskedLines({ lines, label: given, className = '', as: Tag = 'h1', start = 0, step = 110 }: { lines: ReactNode[]; label?: string; className?: string; as?: 'h1' | 'h2'; start?: number; step?: number }) {
  const label = given ?? lines.map((l) => (typeof l === 'string' ? l : '')).join(' ');
  return (
    <Tag className={`masked ${className}`} aria-label={label || undefined}>
      {lines.map((l, i) => (
        <span className="mask" key={i} aria-hidden={label ? true : undefined}>
          <span className="mask-in" style={{ '--d': `${start + i * step}ms` } as CSSProperties}>
            {l}
          </span>
        </span>
      ))}
    </Tag>
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
export function FullMenu({ open, onClose, links, children, className = '' }: { open: boolean; onClose: () => void; links: Array<{ id: string; key: MessageKey }>; children?: ReactNode; className?: string }) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className={`full-menu ${className}`} role="dialog" aria-modal="true" aria-label={t('cine.nav.menu')}>
      <button ref={closeRef} type="button" className="full-menu-close" onClick={onClose}>
        {t('cine.nav.close')}
      </button>
      <nav className="full-menu-links" aria-label={t('cine.nav.label')}>
        {links.map((l, i) => (
          <button type="button" key={l.id} onClick={() => (onClose(), requestAnimationFrame(() => scrollToId(l.id)))} style={{ '--d': `${80 + i * 70}ms` } as CSSProperties}>
            <span className="full-menu-n">0{i + 1}</span>
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

