// Локализация: свой небольшой модуль вместо i18next — три словаря, подстановка {параметров}, выбор языка
// хранится в localStorage (это настройка интерфейса, не данные). Сервер отдаёт только коды.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Reason } from '../api/shared';
import { metersFromCm, number, type Lang } from '../lib/format';
import { en } from './en';
import { kk } from './kk';
import { ru, type MessageKey } from './ru';

export const DICTIONARIES: Record<Lang, Record<MessageKey, string>> = { ru, kk, en };
export const LANGS: Lang[] = ['kk', 'ru', 'en'];
const STORAGE_KEY = 'qorgan.lang';

export type Params = Record<string, string | number | null | undefined>;

export function translate(lang: Lang, key: MessageKey, params: Params = {}): string {
  const template = DICTIONARIES[lang][key] ?? ru[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = params[name];
    return v === null || v === undefined ? '—' : String(v);
  });
}

/**
 * Текст причины оценки T2. Параметры в сантиметрах (*Cm, кроме скоростей *CmH) показываются в метрах (*M),
 * числа — в формате выбранного языка, коды параметров и уровней риска — переведёнными подписями.
 */
export function formatReason(lang: Lang, reason: Reason): string {
  const params: Params = {};
  for (const [key, value] of Object.entries(reason.params ?? {})) {
    if (typeof value === 'number' && key.endsWith('Cm') && !key.endsWith('CmH')) params[`${key.slice(0, -2)}M`] = metersFromCm(value, lang);
    else if (typeof value === 'number') params[key] = number(value, lang, 2);
    else params[key] = value;
    if (key === 'parameter') params.parameterLabel = translate(lang, `param.${value}` as MessageKey);
    if (key === 'risk') params.riskLabel = translate(lang, `risk.${value}` as MessageKey);
  }
  return translate(lang, `reason.${reason.code}` as MessageKey, params);
}

interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: MessageKey, params?: Params) => string;
  reason: (r: Reason) => string;
}

const Ctx = createContext<I18n | null>(null);

function initialLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'ru' || stored === 'kk' || stored === 'en') return stored;
  } catch {
    // недоступный localStorage — просто язык по умолчанию
  }
  return 'ru';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // настройка не сохранится — не критично
    }
  }, []);
  const value = useMemo<I18n>(
    () => ({
      lang,
      setLang,
      t: (key, params) => translate(lang, key, params),
      reason: (r) => formatReason(lang, r),
    }),
    [lang, setLang],
  );
  document.documentElement.lang = lang;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}

export type { MessageKey };
