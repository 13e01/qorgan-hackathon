// Чистая логика интерфейса: форматирование, доступность команд, живые данные, отображение уровня.

import { describe, expect, it } from 'vitest';
import type { Snapshot, SnapshotStation } from '../src/api/types';
import { dateTime, metersFromCm, signed } from '../src/lib/format';
import { levelView } from '../src/lib/level';
import { commandAvailable, type SimCommand } from '../src/lib/sim';
import { applySnapshot, initialLive, lastHours, needsReload, setLevelHistory } from '../src/state/live';
import type { SimState } from '../src/api/types';

describe('форматирование', () => {
  it('сантиметры → метры; нет данных — null, а не 0', () => {
    expect(metersFromCm(532, 'ru')).toBe('5,32');
    expect(metersFromCm(532, 'en')).toBe('5.32');
    expect(metersFromCm(null, 'ru')).toBeNull();
    expect(metersFromCm(undefined, 'ru')).toBeNull();
    expect(metersFromCm(0, 'ru')).toBe('0,00');
  });

  it('знак ставится после округления: 0,02 → «0», 0,06 → «+0,1»', () => {
    expect(signed(0.02, 'ru')).toBe('0');
    expect(signed(0.06, 'ru')).toBe('+0,1');
    expect(signed(-4.5, 'ru')).toBe('-4,5');
  });

  it('время показывается по Казахстану (UTC+5)', () => {
    expect(dateTime('2026-10-28T07:00:00.000Z', 'ru')).toBe('28.10, 12:00');
    expect(dateTime(null, 'ru')).toBeNull();
  });
});

describe('доступность команд симулятора', () => {
  const table: Array<[SimState, Partial<Record<SimCommand, boolean>>]> = [
    ['IDLE', { create: true, start: true, pause: false, resume: false, step: false, stop: false, reset: false, intervene: false }],
    ['CREATED', { create: false, start: true, pause: false, resume: false, step: true, stop: true, reset: true, intervene: true }],
    ['RUNNING', { create: false, start: false, pause: true, resume: false, step: false, stop: true, reset: true, intervene: true }],
    ['PAUSED', { create: false, start: false, pause: false, resume: true, step: true, stop: true, reset: true, intervene: true }],
    ['COMPLETED', { create: true, start: true, pause: false, resume: false, step: false, stop: false, reset: true, intervene: false }],
    ['STOPPED', { create: true, start: true, pause: false, resume: false, step: false, stop: false, reset: true, intervene: false }],
  ];
  it.each(table)('%s', (state, expected) => {
    for (const [cmd, ok] of Object.entries(expected)) {
      expect(commandAvailable(cmd as SimCommand, state, true, false), `${state}/${cmd}`).toBe(ok);
    }
  });

  it('гостю и во время отправки команды всё недоступно (нет двойного нажатия)', () => {
    for (const cmd of ['create', 'start', 'pause', 'stop'] as const) {
      expect(commandAvailable(cmd, 'RUNNING', false, false)).toBe(false);
      expect(commandAvailable(cmd, 'IDLE', true, true)).toBe(false);
    }
  });
});

function station(code: string, cm: number | null, measuredAt: string, assessedCm: number | null = cm): SnapshotStation {
  return {
    id: 1,
    code,
    name: code,
    status: 'active',
    lastMessageAt: null,
    latest: cm === null ? {} : { water_level: { value: cm, unit: 'cm', measuredAt, source: 'simulator', quality: 'ok' } },
    risk: {
      risk: 'LOW',
      score: 0,
      maxScore: 12,
      levelCm: assessedCm,
      measuredAt,
      ageH: 0,
      warningCm: 450,
      dangerCm: 550,
      trend: 'STABLE',
      rateCmH: 0,
      dataStatus: 'OK',
      confidence: 'HIGH',
      topReasons: [],
      situation: { localLevel: 'NORMAL', localTrend: 'STABLE', localPoints: 0, upstreamPoints: 0, drivers: 'NONE', upstream: null },
    },
  };
}

function snap(runId: number, hour: number, cm: number): Snapshot {
  const t = new Date(Date.UTC(2026, 3, 10, hour)).toISOString();
  return {
    simulation: { state: 'RUNNING', run: null, realTime: t },
    context: { mode: 'LIVE', runId, runStatus: 'RUNNING', scenarioId: 'RAPID_FLOOD', virtualTime: t, realTime: t, lastReceivedAt: t },
    stations: [station('QRG-01', cm, t)],
  };
}

describe('живые данные', () => {
  it('снимки дополняют историю; старый или повторный снимок игнорируется', () => {
    let s = applySnapshot(initialLive, snap(1, 0, 300));
    s = applySnapshot(s, snap(1, 1, 310));
    s = applySnapshot(s, snap(1, 1, 310));
    const afterOld = applySnapshot(s, snap(1, 0, 999));
    expect(afterOld).toBe(s);
    expect(s.levels['QRG-01']!.points.map((p) => p.cm)).toEqual([300, 310]);
    expect(s.risks['QRG-01']!.points).toHaveLength(2);
  });

  it('новый прогон начинает новую историю и требует загрузки', () => {
    let s = applySnapshot(initialLive, snap(1, 5, 300));
    s = applySnapshot(s, snap(2, 0, 280));
    expect(s.levels['QRG-01']).toMatchObject({ runId: 2, loaded: false });
    expect(needsReload(s.levels['QRG-01'], 2)).toBe(true);
  });

  it('загруженная история объединяется с точками, пришедшими во время запроса', () => {
    let s = applySnapshot(initialLive, snap(1, 3, 330));
    const items = [0, 1, 2].map((h) => ({
      parameter: 'water_level',
      value: 300 + h * 10,
      unit: 'cm',
      measuredAt: new Date(Date.UTC(2026, 3, 10, h)).toISOString(),
      receivedAt: '',
      tick: h,
      source: 'simulator',
      quality: 'ok',
    }));
    s = setLevelHistory(s, 'QRG-01', 1, items);
    expect(s.levels['QRG-01']!.points.map((p) => p.cm)).toEqual([300, 310, 320, 330]);
    expect(needsReload(s.levels['QRG-01'], 1)).toBe(false);
  });

  it('гостю — последние 24 ч', () => {
    const pts = Array.from({ length: 30 }, (_, h) => ({ t: h * 3_600_000 }));
    expect(lastHours(pts, 24)).toHaveLength(24);
  });
});

describe('отображение уровня', () => {
  it('показывается последнее измерение; если оценка сделана по другому значению — это видно', () => {
    expect(levelView(station('A', 398.2, 't', 299.7))).toMatchObject({ measuredCm: 398.2, assessedCm: 299.7, differs: true });
    expect(levelView(station('A', 300, 't'))).toMatchObject({ measuredCm: 300, differs: false });
    expect(levelView(undefined)).toMatchObject({ measuredCm: null, differs: false });
  });
});
