// Прогноз по реке (QORGAN-ROUTE-1): маршрутизация измерений верхней станции вниз по течению.

import { describe, expect, it } from 'vitest';
import { computeOutlook, verifyOutlook, type OutlookStation } from '../src/outlook';
import type { MeasurementPoint } from '../src/risk/types';

const T0 = Date.parse('2026-04-10T00:00:00.000Z');
const at = (h: number) => new Date(T0 + h * 3_600_000).toISOString();
const series = (from: number, to: number, f: (h: number) => number): MeasurementPoint[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ measuredAt: at(from + i), value: f(from + i) }));

const st = (code: string, up: string | null, tau: number | null, extra: Partial<OutlookStation> = {}): OutlookStation => ({
  code, upstreamCode: up, travelHours: tau, attenuation: 1, responseHours: 1, baseLevelCm: 300, warningCm: 400, dangerCm: 500, ...extra,
});

// Верхняя станция: 300 см до часа 10, затем рост 10 см/ч.
const rising = (h: number) => (h < 10 ? 300 : 300 + 10 * (h - 10));

describe('маршрутизация', () => {
  it('нижняя станция повторяет измерения верхней со сдвигом τ (α = 1, w = 1, без расхождения)', () => {
    const r = computeOutlook({
      asOf: at(30),
      stations: [st('A', null, null), st('B', 'A', 12)],
      levels: { A: series(0, 30, rising), B: series(0, 30, (h) => rising(h - 12)) },
    });
    const b = r.stations[1]!;
    expect(b).toMatchObject({ method: 'ROUTED', upstreamCode: 'A', horizonH: 12, correctionCm: 0, sourceChain: ['A', 'B'] });
    // Через h часов у B будет то, что у A было h − 12 часов назад (≤ asOf, т. е. уже измерено).
    for (const p of b.points) expect(p.levelCm).toBeCloseTo(rising(30 + p.h - 12), 5);
    expect(b.points.at(-1)!.levelCm).toBe(rising(30));
    // Полоса не уже минимальной и расширяется с горизонтом.
    expect(b.points[0]!.highCm - b.points[0]!.levelCm).toBeGreaterThanOrEqual(5);
    expect(b.points.at(-1)!.highCm - b.points.at(-1)!.levelCm).toBeGreaterThan(b.points[0]!.highCm - b.points[0]!.levelCm);
  });

  it('ослабление α, сглаживание w и разные базовые уровни', () => {
    const r = computeOutlook({
      asOf: at(30),
      stations: [st('A', null, null), st('B', 'A', 10, { attenuation: 0.5, responseHours: 3, baseLevelCm: 200 })],
      levels: { A: series(0, 30, rising), B: series(0, 30, () => 200) },
    });
    const p = r.stations[1]!.points.find((x) => x.h === 5)!;
    // 200 + 0.5 · среднее(A(25), A(24), A(23) − 300) = 200 + 0.5 · 140
    const expected = 200 + 0.5 * ((rising(25) + rising(24) + rising(23)) / 3 - 300);
    // e₀ = 200 − маршрут(0) = 200 − (200 + 0.5·(среднее(A(20..18)) − 300)) — поправка затухает.
    const route0 = 200 + 0.5 * ((rising(20) + rising(19) + rising(18)) / 3 - 300);
    expect(p.levelCm).toBeCloseTo(expected + (200 - route0) * Math.exp(-5 / 48), 1);
  });

  it('каскад: горизонт растёт по цепочке (τ₁ + τ₂), используются прогнозы верхней станции', () => {
    const r = computeOutlook({
      asOf: at(30),
      stations: [st('A', null, null), st('B', 'A', 5), st('C', 'B', 7)],
      levels: { A: series(0, 30, rising), B: series(0, 30, (h) => rising(h - 5)), C: series(0, 30, (h) => rising(h - 12)) },
    });
    const [, b, c] = r.stations;
    expect(b!.horizonH).toBe(5);
    expect(c!.horizonH).toBe(12);
    expect(c!.sourceChain).toEqual(['A', 'B', 'C']);
    expect(c!.points.find((p) => p.h === 12)!.levelCm).toBeCloseTo(rising(30), 5);
  });

  it('поправка по текущей ошибке: местное превышение над маршрутом учитывается и затухает', () => {
    const r = computeOutlook({
      asOf: at(30),
      stations: [st('A', null, null), st('B', 'A', 12)],
      levels: { A: series(0, 30, () => 300), B: series(0, 30, () => 320) },
    });
    const b = r.stations[1]!;
    expect(b.correctionCm).toBe(20);
    expect(b.points[0]!.levelCm).toBeCloseTo(300 + 20 * Math.exp(-1 / 48), 1);
    expect(b.points.at(-1)!.levelCm).toBeLessThan(b.points[0]!.levelCm);
  });

  it('измерения позже asOf не используются (прогноз не «подсматривает» в будущее)', () => {
    const levels = { A: series(0, 60, rising), B: series(0, 60, (h) => rising(h - 12)) };
    const stations = [st('A', null, null), st('B', 'A', 12)];
    const full = computeOutlook({ asOf: at(15), stations, levels });
    const cut = computeOutlook({ asOf: at(15), stations, levels: { A: levels.A.slice(0, 16), B: levels.B.slice(0, 16) } });
    expect(full.stations).toEqual(cut.stations);
  });
});

describe('время до порогов', () => {
  it('опасный порог ожидается: центральный срок, ранний и поздний по полосе', () => {
    const r = computeOutlook({
      asOf: at(30),
      stations: [st('A', null, null), st('B', 'A', 30)],
      levels: { A: series(0, 30, rising), B: series(0, 30, (h) => rising(h - 30)) },
    });
    const d = r.stations[1]!.danger;
    // A достигла 500 на часе 30 → B достигнет через 30 ч.
    expect(d).toMatchObject({ status: 'EXPECTED', thresholdCm: 500, h: 30 });
    expect(d.earliestH!).toBeLessThanOrEqual(30);
    expect(d.latestH === null || d.latestH >= 30).toBe(true);
    expect(r.stations[1]!.warning).toMatchObject({ status: 'EXPECTED', h: 20 });
    expect(r.stations[1]!.peak).toMatchObject({ levelCm: 500, atHorizonEnd: true });
    // Зоны для интерфейса считает модуль, а не браузер.
    const b = r.stations[1]!;
    expect(b.points.find((p) => p.h === 30)!.zone).toBe('DANGER');
    expect(b.points.find((p) => p.h === 20)!.zone).toBe('WARNING');
    expect(b.points.find((p) => p.h === 1)!.zone).toBe('OK');
  });

  it('уровень уже выше порога / подъёма нет / порог не задан', () => {
    const r = computeOutlook({
      asOf: at(30),
      stations: [st('A', null, null, { dangerCm: 350 }), st('B', 'A', 10), st('C', 'B', 5, { dangerCm: null })],
      levels: { A: series(0, 30, () => 360), B: series(0, 30, () => 300), C: series(0, 30, () => 300) },
    });
    expect(r.stations[0]!.danger.status).toBe('ALREADY_ABOVE');
    expect(r.stations[1]!.danger.status).toBe('NOT_EXPECTED');
    expect(r.stations[2]!.danger.status).toBe('NO_THRESHOLD');
  });

  it('исток — только короткий тренд (3 ч); без данных — NONE с причиной', () => {
    const r = computeOutlook({
      asOf: at(30),
      stations: [st('A', null, null), st('B', 'A', 10), st('C', null, null)],
      levels: { A: series(20, 30, rising), B: [], C: series(29, 30, () => 300) },
    });
    expect(r.stations[0]).toMatchObject({ method: 'TREND', horizonH: 3 });
    expect(r.stations[0]!.points[0]!.levelCm).toBeCloseTo(rising(31), 5);
    expect(r.stations[1]).toMatchObject({ method: 'NONE', issue: 'NO_DATA' });
    expect(r.stations[2]).toMatchObject({ method: 'NONE', issue: 'INSUFFICIENT_DATA' });
  });

  it('нет базового уровня → NO_BASE_LEVEL; у верхней станции нет данных → UPSTREAM_NO_DATA', () => {
    const r = computeOutlook({
      asOf: at(30),
      stations: [st('A', null, null), st('B', 'A', 10, { baseLevelCm: null }), st('Z', null, null), st('C', 'Z', 10)],
      levels: { A: series(25, 30, () => 300), B: series(0, 30, () => 300), Z: [], C: series(0, 30, () => 300) },
    });
    expect(r.stations[1]!.issue).toBe('NO_BASE_LEVEL');
    expect(r.stations[3]!.issue).toBe('UPSTREAM_NO_DATA');
  });

  it('до начала наблюдений верхняя станция считается стоявшей на первом измеренном уровне — с пометкой', () => {
    const r = computeOutlook({
      asOf: at(30),
      stations: [st('A', null, null), st('B', 'A', 10)],
      levels: { A: series(25, 30, (h) => 300 + (h - 25) * 10), B: series(0, 30, () => 300) },
    });
    const b = r.stations[1]!;
    expect(b).toMatchObject({ method: 'ROUTED', assumedHistory: true, horizonH: 10 });
    // A(20) неизвестна → 300 (первое измерение на часе 25); A(26) = 310 измерена.
    expect(b.points.find((p) => p.h === 6)!.levelCm).toBeCloseTo(310, 5);
    const full = computeOutlook({ asOf: at(30), stations: [st('A', null, null), st('B', 'A', 10)], levels: { A: series(0, 30, () => 300), B: series(0, 30, () => 300) } });
    expect(full.stations[1]!.assumedHistory).toBe(false);
  });
});

describe('проверка на истории', () => {
  it('точная маршрутизация: ошибка ≈ 0, лучше persistence, полоса содержит факт; ранний сигнал опасности', () => {
    const stations = [st('A', null, null), st('B', 'A', 24)];
    const levels = { A: series(0, 80, rising), B: series(0, 80, (h) => rising(h - 24)) };
    const v = verifyOutlook({ stations, levels, issueTimes: Array.from({ length: 70 }, (_, i) => at(i + 6)), leadH: 12 });
    const b = v.find((x) => x.code === 'B')!;
    expect(b.method).toBe('ROUTED');
    expect(b.samples).toBeGreaterThan(40);
    expect(b.maeCm).toBeCloseTo(0, 5);
    expect(b.persistenceMaeCm!).toBeGreaterThan(10);
    expect(b.skill).toBe(1);
    expect(b.bandCoverage).toBe(1);
    // B превышает 500 на часе 54 (A — на 30). Прогноз ждал этого с момента, когда A пошла вверх достаточно (час 30).
    expect(b.danger.actualTime).toBe(at(54));
    expect(b.danger.outlookLeadH).toBe(24);
  });

  it('производительность: проверка 1000-часового прогона по 4 станциям — меньше секунды', () => {
    const stations = [st('A', null, null), st('B', 'A', 51, { responseHours: 6 }), st('C', 'B', 51, { responseHours: 6 }), st('D', 'C', 17, { responseHours: 3 })];
    const wave = (h: number) => 300 + 200 * Math.max(0, Math.sin((h - 50) / 80));
    const levels = { A: series(0, 999, wave), B: series(0, 999, (h) => wave(h - 51)), C: series(0, 999, (h) => wave(h - 102)), D: series(0, 999, (h) => wave(h - 119)) };
    const started = Date.now();
    const v = verifyOutlook({ stations, levels, issueTimes: Array.from({ length: 1000 }, (_, i) => at(i)), leadH: 24 });
    const ms = Date.now() - started;
    expect(v.find((x) => x.code === 'C')!.samples).toBeGreaterThan(800);
    expect(ms).toBeLessThan(1000);
  });
});

