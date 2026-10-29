// Тема интерфейса: светлая, тёмная или как в системе. Применяется атрибутом data-theme на <html>,
// все цвета — CSS-переменные (styles.css). Переключение без перезагрузки, выбор сохраняется в браузере.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { browserStore, KEYS, readThemePref, resolveTheme, writePref, type Theme, type ThemePref } from '../lib/prefs';

interface ThemeCtx {
  pref: ThemePref;
  theme: Theme;
  setPref: (p: ThemePref) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);
const QUERY = '(prefers-color-scheme: dark)';

function systemDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia(QUERY).matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(() => readThemePref(browserStore()));
  const [dark, setDark] = useState(systemDark);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(QUERY);
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const theme = resolveTheme(pref, dark);
  // Ставим атрибут прямо при отрисовке (до дочерних компонентов): usePalette ниже сразу читает цвета новой темы.
  const root = document.documentElement;
  if (root.dataset.theme !== theme) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  }

  const value = useMemo<ThemeCtx>(
    () => ({
      pref,
      theme,
      setPref: (p) => {
        setPrefState(p);
        writePref(browserStore(), KEYS.theme, p);
      },
    }),
    [pref, theme],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTheme outside ThemeProvider');
  return ctx;
}

/** Цвета для графиков и карты (canvas/SVG не видят CSS-классов) — читаются из CSS-переменных текущей темы. */
export interface Palette {
  grid: string;
  axis: string;
  measured: string;
  forecast: string;
  forecastBand: string;
  warning: string;
  danger: string;
  river: string;
  link: string;
  mapBg: string;
  riverGlow: string;
  riskLow: string;
  riskMedium: string;
  riskHigh: string;
  riskUnknown: string;
  stations: string[];
}

const VARS = {
  grid: '--chart-grid',
  axis: '--chart-axis',
  measured: '--chart-measured',
  forecast: '--chart-forecast',
  forecastBand: '--chart-band',
  warning: '--risk-medium',
  danger: '--risk-high',
  river: '--river',
  link: '--map-link',
  mapBg: '--map-bg',
  riverGlow: '--river-glow',
  riskLow: '--risk-low-fill',
  riskMedium: '--risk-medium-fill',
  riskHigh: '--risk-high-fill',
  riskUnknown: '--risk-unknown-fill',
} as const;

export function usePalette(): Palette {
  const { theme } = useTheme();
  return useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const read = (v: string) => cs.getPropertyValue(v).trim();
    const out = Object.fromEntries(Object.entries(VARS).map(([k, v]) => [k, read(v)])) as Omit<Palette, 'stations'>;
    return { ...out, stations: [1, 2, 3, 4].map((i) => read(`--station-${i}`)) };
    // theme в зависимостях: после смены data-theme переменные другие
  }, [theme]);
}
