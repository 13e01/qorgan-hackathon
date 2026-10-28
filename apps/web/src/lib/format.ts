// Форматирование для интерфейса. Уровень воды хранится в сантиметрах; пользователю показываем метры,
// сантиметры — в подробностях. «Нет данных» — это null, а не ноль.

export type Lang = 'ru' | 'kk' | 'en';

const LOCALE: Record<Lang, string> = { ru: 'ru-RU', kk: 'kk-KZ', en: 'en-GB' };

/** Часовой пояс Казахстана (единый UTC+5 с 2024 г.). */
export const KZ_TZ = 'Asia/Almaty';

export function metersFromCm(cm: number | null | undefined, lang: Lang, digits = 2): string | null {
  if (cm === null || cm === undefined || !Number.isFinite(cm)) return null;
  return new Intl.NumberFormat(LOCALE[lang], { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cm / 100);
}

export function number(value: number | null | undefined, lang: Lang, digits = 1): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: digits }).format(value);
}

/** Знак «+» у положительных значений (скорость роста). */
export function signed(value: number | null | undefined, lang: Lang, digits = 1): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits + 0;
  const s = number(rounded, lang, digits)!;
  return rounded > 0 ? `+${s}` : s;
}

export function dateTime(iso: string | null | undefined, lang: Lang, withYear = false): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(LOCALE[lang], {
    timeZone: KZ_TZ,
    day: '2-digit',
    month: '2-digit',
    ...(withYear ? { year: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function timeOnly(iso: string | number | null | undefined, lang: Lang): string | null {
  if (iso === null || iso === undefined) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(LOCALE[lang], { timeZone: KZ_TZ, hour: '2-digit', minute: '2-digit' }).format(d);
}

export function shortDateTime(ms: number, lang: Lang): string {
  return new Intl.DateTimeFormat(LOCALE[lang], { timeZone: KZ_TZ, day: '2-digit', month: '2-digit', hour: '2-digit' }).format(new Date(ms));
}
