// QORGAN Sentinel в интерфейсе: объяснение ML простыми словами, звуковые предупреждения, переводы.

import { FEATURE_NAMES } from '@qorgan/shared';
import { describe, expect, it } from 'vitest';
import type { MlResult } from '../src/api/types';
import { DICTIONARIES, translate } from '../src/i18n';
import type { MessageKey } from '../src/i18n/ru';
import { describeFeature, featureValue, percent, summarize, topFactors } from '../src/lib/explain';
import { memoryStore } from '../src/lib/prefs';
import { DEFAULT_SOUND, MIN_GAP_MS, PATTERNS, readSoundPrefs, SOUND_KEY, SoundEngine, SoundGate, soundForSnapshot, writeSoundPrefs } from '../src/lib/sound';

const result = (over: Partial<MlResult> = {}): MlResult => ({
  status: 'OK',
  modelVersion: 'sentinel-1.0.0',
  horizonH: 6,
  category: 'HIGH',
  pDanger: 0.97,
  pWarning: 0.99,
  thresholds: { danger: 0.3, warning: 0.3 },
  explained: 'danger',
  baseValue: -4,
  contributions: [
    { feature: 'level_vs_danger_cm', value: -12, shap: 3.1 },
    { feature: 'delta_3h_cm', value: 27, shap: 2.4 },
    { feature: 'up_arriving_6h_cm', value: 0.2, shap: -0.3 },
    { feature: 'rain_6h_mm', value: null, shap: 0.1 },
    { feature: 'accel_3h_cm', value: 4, shap: 0.05 },
    { feature: 'data_age_h', value: 0, shap: 0.01 },
  ],
  features: {},
  ...over,
});

describe('объяснение ML простыми словами', () => {
  it('фраза выбирается по фактическому значению признака, числа — в формате языка', () => {
    expect(translate('ru', ...asArgs(describeFeature('delta_3h_cm', 27, 'ru')))).toBe('За 3 ч уровень вырос на 27 см.');
    expect(translate('ru', ...asArgs(describeFeature('delta_3h_cm', -8, 'ru')))).toBe('За 3 ч уровень снизился на 8 см.');
    expect(translate('ru', ...asArgs(describeFeature('delta_3h_cm', 0.2, 'ru')))).toBe('За 3 ч уровень почти не менялся.');
    expect(translate('ru', ...asArgs(describeFeature('level_vs_danger_cm', -12, 'ru')))).toBe('До опасного порога осталось 0,12 м.');
    expect(translate('ru', ...asArgs(describeFeature('level_vs_danger_cm', 51, 'ru')))).toBe('Уровень выше опасного порога на 0,51 м.');
    expect(translate('en', ...asArgs(describeFeature('up_arriving_6h_cm', 40, 'en')))).toContain('about 40 cm');
    expect(describeFeature('rain_6h_mm', null, 'ru').key).toBe('ml.say.noData');
    expect(translate('ru', ...asArgs(describeFeature('delta_1h_cm', 0.8, 'ru')))).toBe('За 1 ч уровень вырос на 0,8 см.');
    expect([percent(0.0003, 'ru'), percent(0.5, 'ru'), percent(0.999, 'en'), percent(null, 'ru')]).toEqual(['< 1 %', '50 %', '> 99 %', null]);
  });

  it('3–5 главных факторов по |SHAP|, направление влияния и относительный вес', () => {
    const f = topFactors(result().contributions, 'ru', 5);
    expect(f).toHaveLength(5);
    expect(f.map((x) => x.feature)).toEqual(['level_vs_danger_cm', 'delta_3h_cm', 'up_arriving_6h_cm', 'rain_6h_mm', 'accel_3h_cm']);
    expect(f[0]!.direction).toBe('up');
    expect(f[2]!.direction).toBe('down');
    expect(f[0]!.weight).toBe(1);
    expect(f[1]!.weight).toBeCloseTo(2.4 / 3.1, 6);
    expect(f[3]!.value).toBeNull(); // «Нет данных», а не ноль
    expect(featureValue('level_vs_danger_cm', -12, 'ru')).toEqual({ text: '-0,12', unit: 'unit.m' });
    expect(featureValue('slope_6h_cm_h', 2.25, 'en')).toEqual({ text: '+2.3', unit: 'unit.cmh' });
  });

  it('краткое объяснение: категория и вероятность + главные факторы в сторону оценки; LOW — что понижает', () => {
    const s = summarize(result(), 'ru').map((p) => translate('ru', ...asArgs(p)));
    expect(s[0]).toBe('Высокий риск по оценке ML: вероятность достичь опасного уровня в ближайшие 6 ч — 97 %.');
    expect(s.slice(1)).toEqual(['До опасного порога осталось 0,12 м.', 'За 3 ч уровень вырос на 27 см.']);
    const low = summarize(result({ category: 'LOW', explained: 'warning', pWarning: 0.01 }), 'ru');
    expect(low).toHaveLength(2);
    expect(low[1]!.key).toBe('ml.say.upNothing');
    expect(summarize(result({ status: 'INSUFFICIENT_DATA', category: null }), 'ru')[0]!.key).toBe('ml.summary.insufficient');
  });

  it('у каждого признака модели есть подпись на трёх языках', () => {
    for (const lang of ['ru', 'kk', 'en'] as const) {
      for (const f of FEATURE_NAMES) expect(DICTIONARIES[lang][`ml.f.${f}` as MessageKey], `${lang} ${f}`).toBeTruthy();
    }
  });
});

describe('звуковые предупреждения: когда звучать', () => {
  const a = (id: number, severity: 'MEDIUM' | 'HIGH') => ({ id, severity });

  it('первый снимок после загрузки и смена прогона — без звука', () => {
    expect(soundForSnapshot(null, 1, [a(1, 'HIGH')]).kind).toBeNull();
    const { seen } = soundForSnapshot(null, 1, [a(1, 'HIGH')]);
    expect(soundForSnapshot(seen, 2, [a(5, 'HIGH')]).kind).toBeNull();
  });

  it('новое MEDIUM → мягкий сигнал; новое HIGH или MEDIUM → HIGH → заметный; без изменений — тишина', () => {
    let { seen } = soundForSnapshot(null, 1, []);
    let r = soundForSnapshot(seen, 1, [a(1, 'MEDIUM')]);
    expect(r.kind).toBe('MEDIUM');
    seen = r.seen;
    r = soundForSnapshot(seen, 1, [a(1, 'MEDIUM')]);
    expect(r.kind).toBeNull(); // новое измерение при том же риске
    r = soundForSnapshot(r.seen, 1, [a(1, 'HIGH')]);
    expect(r.kind).toBe('HIGH');
    r = soundForSnapshot(r.seen, 1, [a(1, 'MEDIUM')]);
    expect(r.kind).toBeNull(); // понижение не звучит
    r = soundForSnapshot(r.seen, 1, [a(1, 'MEDIUM'), a(2, 'MEDIUM'), a(3, 'HIGH')]);
    expect(r.kind).toBe('HIGH'); // самый серьёзный повод
  });

  it('защита от повторов: не чаще раза в 4 с; HIGH сразу после MEDIUM разрешён', () => {
    const g = new SoundGate();
    expect(g.allow('MEDIUM', 0)).toBe(true);
    expect(g.allow('MEDIUM', 1000)).toBe(false);
    expect(g.allow('HIGH', 1500)).toBe(true);
    expect(g.allow('HIGH', 2000)).toBe(false);
    expect(g.allow('MEDIUM', 1500 + MIN_GAP_MS)).toBe(true);
  });
});

describe('звуковые предупреждения: настройка и воспроизведение', () => {
  it('по умолчанию выключено, громкость 50 %; сохраняется и восстанавливается; мусор и недоступное хранилище не ломают', () => {
    const store = memoryStore();
    expect(readSoundPrefs(store)).toEqual(DEFAULT_SOUND);
    expect(DEFAULT_SOUND.enabled).toBe(false);
    writeSoundPrefs(store, { enabled: true, volume: 0.3 });
    expect(readSoundPrefs(store)).toEqual({ enabled: true, volume: 0.3 });
    store.setItem(SOUND_KEY, JSON.stringify({ enabled: 'yes', volume: 7 }));
    expect(readSoundPrefs(store)).toEqual({ enabled: false, volume: 1 });
    store.setItem(SOUND_KEY, '{oops');
    expect(readSoundPrefs(store)).toEqual(DEFAULT_SOUND);
    expect(readSoundPrefs(null)).toEqual(DEFAULT_SOUND);
  });

  it('до разрешения пользователя ничего не играет; сигналы MEDIUM и HIGH различаются; громкость применяется', async () => {
    const created: FakeCtx[] = [];
    const Ctor = class extends FakeCtx {
      constructor() {
        super();
        created.push(this);
      }
    } as unknown as typeof AudioContext;
    const engine = new SoundEngine(Ctor);
    expect(engine.play('HIGH', 0.5)).toBe(false);
    expect(created).toHaveLength(0); // контекст не создаётся без действия пользователя
    expect(await engine.unlock()).toBe(true);
    expect(engine.play('MEDIUM', 0.4)).toBe(true);
    const ctx = created[0]!;
    expect(ctx.oscillators.map((o) => o.type)).toEqual(['sine', 'sine']);
    expect(ctx.masters.at(-1)!.gain.value).toBe(0.4);
    engine.play('HIGH', 2);
    expect(ctx.oscillators.slice(2).map((o) => o.type)).toEqual(['triangle', 'triangle', 'triangle', 'triangle']);
    expect(ctx.masters.at(-1)!.gain.value).toBe(1);
    expect(engine.play('HIGH', 0)).toBe(false); // громкость 0 — тишина
    expect(PATTERNS.MEDIUM.notes).not.toEqual(PATTERNS.HIGH.notes);
    // Без сирен: короткие сигналы, пик громкости ограничен.
    for (const p of Object.values(PATTERNS)) {
      expect(Math.max(...p.notes.map(([, s, d]) => s + d))).toBeLessThan(1);
      expect(p.peak).toBeLessThanOrEqual(0.3);
    }
    expect(new SoundEngine(null).supported).toBe(false);
  });
});

// ---- вспомогательное ----

function asArgs(p: { key: MessageKey; params: Record<string, string | number | null | undefined> }): [MessageKey, Record<string, string | number | null | undefined>] {
  return [p.key, p.params];
}

class FakeParam {
  value = 0;
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
}
class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  type = '';
  constructor(private readonly ctx: FakeCtx) {}
  connect(n: unknown) {
    // Общий узел громкости — тот, что подключён прямо к выходу.
    if (n === this.ctx.destination) this.ctx.masters.push(this);
    return n;
  }
  start() {}
  stop() {}
}
class FakeCtx {
  state = 'suspended';
  currentTime = 0;
  destination = {};
  oscillators: FakeNode[] = [];
  masters: FakeNode[] = [];
  async resume() {
    this.state = 'running';
  }
  createOscillator() {
    const n = new FakeNode(this);
    this.oscillators.push(n);
    return n;
  }
  createGain() {
    return new FakeNode(this);
  }
}

describe('объяснение ML у истока', () => {
  it('у станции без станции выше признаки «сверху» — «неприменимо», а не «нет данных»', () => {
    const r = result({ features: { up_travel_h: null } });
    const f = topFactors([{ feature: 'up_arriving_6h_cm', value: null, shap: -0.2 }], 'ru', 5, false);
    expect(f[0]!.phrase.key).toBe('ml.say.noUpstream');
    expect(summarize({ ...r, category: 'LOW', contributions: [{ feature: 'up_delta_3h_cm', value: null, shap: -1 }] }, 'ru')[1]!.key).toBe('ml.say.noUpstream');
    expect(describeFeature('up_delta_3h_cm', null, 'ru', true).key).toBe('ml.say.noData');
  });
});
