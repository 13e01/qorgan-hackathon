import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_CONFIG, hasAccess, PARAMETERS } from '../src';

describe('hasAccess', () => {
  it('admin ≥ operator ≥ guest', () => {
    expect(hasAccess('admin', 'operator')).toBe(true);
    expect(hasAccess('operator', 'operator')).toBe(true);
    expect(hasAccess('operator', 'admin')).toBe(false);
    expect(hasAccess('guest', 'operator')).toBe(false);
    expect(hasAccess('guest', 'guest')).toBe(true);
  });
});

describe('справочники', () => {
  it('у каждого показателя допустимый диапазон min < max', () => {
    for (const p of PARAMETERS) expect(p.minValid).toBeLessThan(p.maxValid);
  });

  it('коэффициенты риска согласованы между собой', () => {
    const c = DEFAULT_RISK_CONFIG;
    expect(c.minPoints).toBeLessThanOrEqual(c.windowSize);
    expect(c.highEtaH).toBeLessThan(c.mediumEtaH);
    expect(c.rainModerateMm).toBeLessThan(c.rainHeavyMm);
    expect(c.categories.mediumScore).toBeLessThan(c.categories.highScore);
  });
});
