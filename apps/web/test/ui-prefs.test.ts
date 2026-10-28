// T4.1: настройки интерфейса (тема, боковая панель, язык), защита от двойного нажатия, человеческие статусы.

import { describe, expect, it } from 'vitest';
import type { Snapshot, SnapshotStation, StationMeta } from '../src/api/types';
import { DICTIONARIES } from '../src/i18n';
import { ru } from '../src/i18n/ru';
import { CommandGate } from '../src/lib/gate';
import {
  KEYS,
  LANGS,
  memoryStore,
  readLang,
  readSidebarCollapsed,
  readThemePref,
  resolveTheme,
  writePref,
  writeSidebarCollapsed,
  type KeyValueStore,
} from '../src/lib/prefs';
import { overview, plainStatus } from '../src/lib/status';

const broken: KeyValueStore = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('тема', () => {
  it('по умолчанию — как в системе; сохранённый выбор восстанавливается', () => {
    const store = memoryStore();
    expect(readThemePref(store)).toBe('system');
    writePref(store, KEYS.theme, 'dark');
    expect(readThemePref(store)).toBe('dark');
    writePref(store, KEYS.theme, 'light');
    expect(readThemePref(store)).toBe('light');
  });

  it('неизвестное значение и недоступное хранилище не ломают интерфейс', () => {
    expect(readThemePref(memoryStore({ [KEYS.theme]: 'neon' }))).toBe('system');
    expect(readThemePref(broken)).toBe('system');
    expect(() => writePref(broken, KEYS.theme, 'dark')).not.toThrow();
    expect(readThemePref(null)).toBe('system');
  });

  it('SYSTEM следует настройке системы, LIGHT/DARK — нет', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('боковая панель', () => {
  it('по умолчанию развёрнута, состояние сохраняется', () => {
    const store = memoryStore();
    expect(readSidebarCollapsed(store)).toBe(false);
    writeSidebarCollapsed(store, true);
    expect(store.data.get(KEYS.sidebar)).toBe('collapsed');
    expect(readSidebarCollapsed(store)).toBe(true);
    writeSidebarCollapsed(store, false);
    expect(readSidebarCollapsed(store)).toBe(false);
    expect(readSidebarCollapsed(broken)).toBe(false);
  });
});

describe('переключатель языков KZ | RU | EN', () => {
  it('порядок KZ, RU, EN и короткие подписи на всех языках', () => {
    expect(LANGS).toEqual(['kk', 'ru', 'en']);
    for (const dict of Object.values(DICTIONARIES)) {
      expect(LANGS.map((l) => dict[`lang.short.${l}` as keyof typeof ru])).toEqual(['KZ', 'RU', 'EN']);
    }
  });

  it('выбор сохраняется; неизвестный язык → русский', () => {
    const store = memoryStore();
    expect(readLang(store)).toBe('ru');
    writePref(store, KEYS.lang, 'kk');
    expect(readLang(store)).toBe('kk');
    expect(readLang(memoryStore({ [KEYS.lang]: 'de' }))).toBe('ru');
    expect(readLang(broken)).toBe('ru');
  });

  it('все новые строки T4.1 переведены (тот же набор ключей проверяет i18n.test)', () => {
    for (const key of ['ctl.demo', 'demo.msg.wave', 'card.upstreamPlain', 'theme.system', 'sim.seedHint'] as const) {
      for (const lang of LANGS) expect(DICTIONARIES[lang][key].length, `${lang}:${key}`).toBeGreaterThan(1);
    }
    expect(ru['sim.seed']).toBe('Повторяемость сценария');
  });
});

describe('CommandGate — защита от двойного нажатия', () => {
  it('второй вызов во время первого не выполняется', async () => {
    const gate = new CommandGate();
    let calls = 0;
    let release!: () => void;
    const first = gate.run(() => {
      calls += 1;
      return new Promise<string>((r) => (release = () => r('ok')));
    });
    expect(gate.busy).toBe(true);
    expect(await gate.run(async () => (calls += 1))).toBeNull();
    release();
    expect(await first).toBe('ok');
    expect(calls).toBe(1);
    expect(gate.busy).toBe(false);
  });

  it('после ошибки защита снимается, подписчики видят занятость', async () => {
    const gate = new CommandGate();
    const seen: boolean[] = [];
    gate.subscribe((b) => seen.push(b));
    await expect(gate.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(gate.busy).toBe(false);
    expect(seen).toEqual([true, false]);
    expect(await gate.run(async () => 1)).toBe(1);
  });
});

type Sit = SnapshotStation['risk']['situation'];
function st(code: string, cm: number | null, risk: 'LOW' | 'MEDIUM' | 'HIGH', sit: Partial<Sit> = {}): SnapshotStation {
  return {
    id: 1,
    code,
    name: code,
    status: 'active',
    lastMessageAt: null,
    latest: cm === null ? {} : { water_level: { value: cm, unit: 'cm', measuredAt: '2026-11-01T00:00:00.000Z', source: 'simulator', quality: 'ok' } },
    risk: {
      risk,
      score: 0,
      maxScore: 12,
      levelCm: cm,
      measuredAt: '2026-11-01T00:00:00.000Z',
      ageH: 0,
      warningCm: 450,
      dangerCm: 550,
      trend: 'STABLE',
      rateCmH: 0,
      dataStatus: 'OK',
      confidence: 'HIGH',
      topReasons: [],
      situation: { localLevel: 'NORMAL', localTrend: 'STABLE', localPoints: 0, upstreamPoints: 0, drivers: 'NONE', upstream: null, ...sit },
    },
  };
}

describe('человеческие статусы станции', () => {
  it('угроза сверху при нормальном уровне — «здесь пока спокойно», а не подъём', () => {
    const s = plainStatus(st('QRG-03', 320, 'MEDIUM', { drivers: 'UPSTREAM', upstream: { stationCode: 'QRG-02', risk: 'HIGH', travelHours: 51 } }));
    expect(s).toEqual({ key: 'status.upstreamOnly', tone: 'warn', risk: 'MEDIUM' });
  });

  it('местные данные важнее угрозы сверху; нет измерений — «нет данных», а не ноль', () => {
    expect(plainStatus(st('A', 560, 'HIGH', { localLevel: 'ABOVE_DANGER' })).key).toBe('status.aboveDanger');
    expect(plainStatus(st('A', 460, 'MEDIUM', { localLevel: 'ABOVE_WARNING' })).key).toBe('status.aboveWarning');
    expect(plainStatus(st('A', 400, 'MEDIUM', { localTrend: 'RISING', upstream: { stationCode: 'B', risk: 'HIGH', travelHours: 5 } })).key).toBe('status.rising');
    expect(plainStatus(st('A', 300, 'LOW')).key).toBe('status.normal');
    expect(plainStatus(st('A', null, 'LOW'))).toEqual({ key: 'status.noData', tone: 'neutral', risk: 'NO_DATA' });
    expect(plainStatus(undefined).key).toBe('status.noData');
  });

  it('сводка: самая опасная станция, при равенстве — ниже по течению', () => {
    const metas = ['A', 'B', 'C'].map((code) => ({ code, name: `St ${code}` }) as StationMeta);
    const snap = { stations: [st('A', 300, 'HIGH'), st('B', 300, 'MEDIUM'), st('C', 300, 'HIGH')] } as Snapshot;
    const ov = overview(snap, metas);
    expect(ov.key).toBe('overview.danger');
    expect(ov.worst?.code).toBe('C');
    expect(ov.counts).toEqual({ LOW: 0, MEDIUM: 1, HIGH: 2 });
    expect(overview(null, metas).key).toBe('overview.noData');
    expect(overview({ stations: [st('A', 300, 'LOW')] } as Snapshot, metas).key).toBe('overview.allNormal');
  });
});
