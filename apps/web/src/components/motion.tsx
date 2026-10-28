// Примитивы движения Eclipse. Анимация объясняет изменение (новое значение, смена этапа), а не украшает.
// При prefers-reduced-motion значения меняются сразу, без промежуточных кадров.

import { useEffect, useRef, useState, type ReactNode } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia(QUERY).matches;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(QUERY);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * Плавный переход числа к новому значению сервера (≈ 0,4 с, без «перелёта»). Показывает только значения между старым
 * и новым измерением — ничего не прогнозирует. null (нет данных) — сразу null, без анимации к нулю.
 */
export function useTween(value: number | null, ms = 420): number | null {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (value === null || from.current === null || reduced) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = from.current;
    if (start === value) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const eased = 1 - (1 - k) ** 3;
      const v = start + (value - start) * eased;
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms, reduced]);
  return shown;
}

/** Число с плавной сменой; format получает промежуточное значение. */
export function AnimatedValue({ value, format }: { value: number | null; format: (v: number) => ReactNode }) {
  const v = useTween(value);
  return <>{v === null ? null : format(v)}</>;
}

/** Короткая подсветка при смене ключа (новое измерение): класс .is-fresh на ~0,7 с. */
export function useFresh(key: unknown): boolean {
  const [fresh, setFresh] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setFresh(true);
    const id = setTimeout(() => setFresh(false), 700);
    return () => clearTimeout(id);
  }, [key]);
  return fresh;
}
