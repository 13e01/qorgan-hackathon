// Разделение итоговой оценки на локальную обстановку и угрозу сверху.

import { describe, expect, it } from 'vitest';
import { assessRisk, DEFAULT_RISK_CONFIG, describeSituation, type RiskInput } from '../src';

const AS_OF = '2026-04-02T12:00:00.000Z';
const hourly = (values: number[]) =>
  values.map((value, i) => ({ measuredAt: new Date(Date.parse(AS_OF) - (values.length - 1 - i) * 3_600_000).toISOString(), value }));

const assess = (levels: number[], extra: Partial<RiskInput> = {}) =>
  assessRisk({
    asOf: AS_OF,
    thresholds: { warning: 450, danger: 550 },
    sensors: ['water_level'],
    series: { water_level: hourly(levels) },
    upstream: null,
    config: DEFAULT_RISK_CONFIG,
    ...extra,
  });

describe('describeSituation', () => {
  it('MEDIUM только из-за станции выше: локальный уровень в норме, вклад — угроза сверху', () => {
    const a = assess([300, 300, 300, 300, 300, 300], { upstream: { stationCode: 'QRG-02', risk: 'HIGH', travelHours: 51 } });
    expect(a.risk).toBe('MEDIUM');
    expect(describeSituation(a)).toEqual({
      localLevel: 'NORMAL',
      localTrend: 'STABLE',
      localPoints: 0,
      upstreamPoints: 2,
      drivers: 'UPSTREAM',
      upstream: { stationCode: 'QRG-02', risk: 'HIGH', travelHours: 51 },
    });
  });

  it('местная опасность: уровень выше D, тренд растёт, сверху спокойно', () => {
    const s = describeSituation(assess([540, 550, 560, 570, 580, 590]));
    expect(s).toMatchObject({ localLevel: 'ABOVE_DANGER', localTrend: 'RISING', localPoints: 7, upstreamPoints: 0, drivers: 'LOCAL', upstream: null });
  });

  it('оба источника: уровень выше W и угроза сверху', () => {
    const s = describeSituation(assess([450, 450, 450, 450, 450, 450], { upstream: { stationCode: 'QRG-01', risk: 'MEDIUM', travelHours: 17 } }));
    expect(s).toMatchObject({ localLevel: 'ABOVE_WARNING', drivers: 'MIXED', upstream: { stationCode: 'QRG-01', risk: 'MEDIUM', travelHours: 17 } });
  });

  it('верхняя станция есть, но баллов не дала (далеко или LOW) — угроза сверху не показывается', () => {
    const s = describeSituation(assess([300, 300, 300], { upstream: { stationCode: 'QRG-01', risk: 'HIGH', travelHours: 80 } }));
    expect(s).toMatchObject({ drivers: 'NONE', upstream: null });
  });

  it('нет данных и нет порогов', () => {
    expect(describeSituation(assess([])).localLevel).toBe('NO_DATA');
    expect(describeSituation(assess([300, 300, 300], { thresholds: { warning: null, danger: null } })).localLevel).toBe('NO_THRESHOLD');
  });
});
