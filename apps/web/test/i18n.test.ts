// Переводы: одинаковые ключи и подстановки во всех языках, тексты для всех причин оценки T2.

import { describe, expect, it } from 'vitest';
import { REASON_CODES } from '@qorgan/shared';
import { DICTIONARIES, formatReason, translate } from '../src/i18n';
import { ru } from '../src/i18n/ru';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('словари', () => {
  it('kk и en содержат ровно те же ключи, что ru, без пустых значений', () => {
    const keys = Object.keys(ru).sort();
    for (const lang of ['kk', 'en'] as const) {
      expect(Object.keys(DICTIONARIES[lang]).sort(), lang).toEqual(keys);
      for (const [k, v] of Object.entries(DICTIONARIES[lang])) expect(v.trim(), `${lang}:${k}`).not.toBe('');
    }
  });

  it('подстановки {…} совпадают во всех языках', () => {
    for (const key of Object.keys(ru) as Array<keyof typeof ru>) {
      for (const lang of ['kk', 'en'] as const) {
        expect(placeholders(DICTIONARIES[lang][key]), `${lang}:${key}`).toEqual(placeholders(ru[key]));
      }
    }
  });

  it('для каждого кода причины T2 есть текст на трёх языках', () => {
    for (const code of REASON_CODES) {
      for (const lang of ['ru', 'kk', 'en'] as const) expect(DICTIONARIES[lang], `${lang}:${code}`).toHaveProperty(`reason.${code}`);
    }
  });
});

describe('formatReason', () => {
  it('сантиметры показываются в метрах, скорость — в см/ч, коды — подписями', () => {
    expect(formatReason('ru', { code: 'LEVEL_ABOVE_DANGER', params: { levelCm: 580, dangerCm: 550 } })).toBe('Уровень 5,80 м выше опасного порога 5,50 м');
    expect(formatReason('en', { code: 'RISING', params: { rateCmH: 16.674 } })).toBe('Level rising: 16.67 cm/h');
    expect(formatReason('ru', { code: 'UPSTREAM_WAVE', params: { station: 'QRG-01', risk: 'HIGH', hours: 51 } })).toBe(
      'Выше по течению (QRG-01) риск «Высокий», добегание волны ≈ 51 ч',
    );
    expect(formatReason('kk', { code: 'NO_DATA', params: { parameter: 'air_temp' } })).toBe('Деректер жоқ: Ауа температурасы');
  });

  it('отсутствующий параметр — прочерк, а не «undefined»', () => {
    expect(translate('ru', 'risk.score', { score: 3 })).toBe('Балл 3 из —');
  });
});
