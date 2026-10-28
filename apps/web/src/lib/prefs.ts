// Настройки интерфейса, которые хранятся в браузере (localStorage): язык, тема, боковая панель.
// Это не данные системы — сервер о них не знает. Недоступное хранилище (приватный режим) не ломает интерфейс.

import type { Lang } from './format';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const KEYS = {
  lang: 'qorgan.lang',
  theme: 'qorgan.theme',
  sidebar: 'qorgan.sidebar',
  demo: 'qorgan.demo',
} as const;

/** Хранилище браузера или null, если оно недоступно. */
export function browserStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readPref(store: KeyValueStore | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writePref(store: KeyValueStore | null, key: string, value: string | null): void {
  try {
    if (value === null) store?.removeItem(key);
    else store?.setItem(key, value);
  } catch {
    // настройка не сохранится — не критично
  }
}

// ---- Язык ----

export const LANGS: Lang[] = ['kk', 'ru', 'en'];

export function readLang(store: KeyValueStore | null): Lang {
  const v = readPref(store, KEYS.lang);
  return v === 'kk' || v === 'ru' || v === 'en' ? v : 'ru';
}

// ---- Тема ----

export type ThemePref = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';
export const THEME_PREFS: ThemePref[] = ['light', 'dark', 'system'];

export function readThemePref(store: KeyValueStore | null): ThemePref {
  const v = readPref(store, KEYS.theme);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

// ---- Боковая панель ----

export function readSidebarCollapsed(store: KeyValueStore | null): boolean {
  return readPref(store, KEYS.sidebar) === 'collapsed';
}

export function writeSidebarCollapsed(store: KeyValueStore | null, collapsed: boolean): void {
  writePref(store, KEYS.sidebar, collapsed ? 'collapsed' : 'expanded');
}

/** Хранилище в памяти — для тестов. */
export function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}
