// Eclipse: схема «Живая река» (только по данным сервера), подписи карты, ход обработки предупреждения,
// навигация по ролям, тема и новые строки интерфейса на трёх языках.

import { describe, expect, it } from 'vitest';
import type { SimState, Snapshot, SnapshotStation, StationMeta } from '../src/api/types';
import { NAV, navItems, ROUTES } from '../src/components/Shell';
import { DICTIONARIES } from '../src/i18n';
import { ru } from '../src/i18n/ru';
import { alertLifecycle, labelOnLeft, riverFlow } from '../src/lib/flow';
import { memoryStore, readThemePref, resolveTheme, KEYS } from '../src/lib/prefs';

const CODES = ['QRG-01', 'QRG-02', 'QRG-03', 'QRG-04'];
const metas: StationMeta[] = CODES.map(
  (code, i) =>
    ({
      code,
      name: `N${i + 1}`,
      upstreamCode: i === 0 ? null : CODES[i - 1]!,
      travelHours: i === 0 ? null : 51,
      lat: 54 + i * 0.4,
      lon: 68 + i * 0.3,
      parameters: [{ code: 'water_level', warning: 450, danger: 550 }],
    }) as StationMeta,
);

type Sit = SnapshotStation['risk']['situation'];
interface St {
  risk?: 'LOW' | 'MEDIUM' | 'HIGH';
  sit?: Partial<Sit>;
  cm?: number | null;
  source?: string;
}

function snapshot(stations: Record<string, St>, state: SimState = 'RUNNING'): Snapshot {
  return {
    simulation: { state, run: null, realTime: '' },
    context: { mode: 'LIVE', runId: 1, runStatus: null, scenarioId: 'RAPID_FLOOD', virtualTime: '2026-11-01T00:00:00.000Z', realTime: '', lastReceivedAt: null },
    stations: CODES.map((code) => {
      const s = stations[code] ?? {};
      const cm = s.cm === undefined ? 300 : s.cm;
      return {
        id: 1,
        code,
        name: code,
        status: 'active',
        lastMessageAt: null,
        latest: cm === null ? {} : { water_level: { value: cm, unit: 'cm', measuredAt: '2026-11-01T00:00:00.000Z', source: s.source ?? 'simulator', quality: 'ok' } },
        risk: {
          risk: s.risk ?? 'LOW',
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
          situation: { localLevel: 'NORMAL', localTrend: 'STABLE', localPoints: 0, upstreamPoints: 0, drivers: 'NONE', upstream: null, ...s.sit },
        },
      };
    }),
  };
}

const threatFrom = (code: string, risk: 'MEDIUM' | 'HIGH' = 'HIGH'): St => ({
  risk: 'MEDIUM',
  sit: { drivers: 'UPSTREAM', upstreamPoints: 2, upstream: { stationCode: code, risk, travelHours: 51 } },
});

describe('«Живая река» — состояние связей только по данным сервера', () => {
  it('без снимка: узлы «Нет данных», связи спокойные, столбиков нет (а не ноль)', () => {
    const f = riverFlow(metas, null);
    expect(f.nodes.map((n) => n.risk)).toEqual(['NO_DATA', 'NO_DATA', 'NO_DATA', 'NO_DATA']);
    expect(f.nodes.every((n) => n.gauge === null && n.levelCm === null)).toBe(true);
    expect(f.links).toHaveLength(3);
    expect(f.links.every((l) => l.state === 'calm')).toBe(true);
    expect(f.hasThreat).toBe(false);
  });

  it('спокойная река: всё «calm», следующей угрозы нет', () => {
    const f = riverFlow(metas, snapshot({}));
    expect(f.hasThreat).toBe(false);
    expect(f.nodes.some((n) => n.next)).toBe(false);
  });

  it('сервер сообщил о волне сверху у станции ниже → связь «угроза идёт», станция — «следующая»', () => {
    const f = riverFlow(metas, snapshot({ 'QRG-01': { risk: 'HIGH', sit: { localLevel: 'ABOVE_DANGER' } }, 'QRG-02': threatFrom('QRG-01') }));
    const link = f.links.find((l) => l.to === 'QRG-02')!;
    expect(link).toMatchObject({ from: 'QRG-01', state: 'threat', risk: 'HIGH', travelHours: 51 });
    expect(f.nodes.find((n) => n.next)?.code).toBe('QRG-02');
    expect(f.hasThreat).toBe(true);
  });

  it('станция ниже подтвердила подъём своими измерениями → «дошла», уже не «следующая»', () => {
    const f = riverFlow(metas, snapshot({ 'QRG-02': { ...threatFrom('QRG-01'), sit: { ...threatFrom('QRG-01').sit, localTrend: 'RISING' } } }));
    expect(f.links.find((l) => l.to === 'QRG-02')!.state).toBe('arrived');
    expect(f.nodes.some((n) => n.next)).toBe(false);
  });

  it('«следующая» — самая верхняя станция, к которой угроза идёт', () => {
    const f = riverFlow(metas, snapshot({ 'QRG-03': threatFrom('QRG-02'), 'QRG-04': threatFrom('QRG-03', 'MEDIUM') }));
    expect(f.nodes.filter((n) => n.next).map((n) => n.code)).toEqual(['QRG-03']);
  });

  it('угроза от другой станции, чем непосредственный исток, не рисуется на этой связи', () => {
    const f = riverFlow(metas, snapshot({ 'QRG-03': threatFrom('QRG-01') }));
    expect(f.links.find((l) => l.to === 'QRG-03')!.state).toBe('calm');
  });

  it('без измерений у станции ниже угроза не показывается (как в карточке станции)', () => {
    const f = riverFlow(metas, snapshot({ 'QRG-02': { ...threatFrom('QRG-01'), cm: null } }));
    expect(f.links.find((l) => l.to === 'QRG-02')!.state).toBe('calm');
    expect(f.nodes[1]!.risk).toBe('NO_DATA');
  });

  it('столбик: уровень относительно опасного порога, пороги — метками; значения в пределах 0…1', () => {
    const f = riverFlow(metas, snapshot({ 'QRG-01': { cm: 550 }, 'QRG-02': { cm: 9999 } }));
    expect(f.nodes[0]!.gauge).toBeCloseTo(550 / (550 * 1.25));
    expect(f.nodes[0]!.dangerMark).toBeCloseTo(0.8);
    expect(f.nodes[0]!.warningMark).toBeCloseTo(450 / (550 * 1.25));
    expect(f.nodes[1]!.gauge).toBe(1);
  });

  it('показание внешнего датчика помечается источником', () => {
    const f = riverFlow(metas, snapshot({ 'QRG-03': { source: 'device' } }));
    expect(f.nodes[2]!.fromDevice).toBe(true);
    expect(f.nodes[0]!.fromDevice).toBe(false);
  });
});

describe('подписи станций на карте', () => {
  it('подпись слева, только если прямо севернее есть соседняя станция', () => {
    const petro = { code: 'P', lat: 54.8825, lon: 69.1172 };
    const sokol = { code: 'S', lat: 55.1165, lon: 69.2103 };
    const yavl = { code: 'Y', lat: 54.3484, lon: 68.4465 };
    const all = [yavl, petro, sokol];
    expect(labelOnLeft(petro, all)).toBe(true);
    expect(labelOnLeft(sokol, all)).toBe(false);
    expect(labelOnLeft(yavl, all)).toBe(false);
  });
});

describe('ход обработки предупреждения', () => {
  it('Новое → Просмотрено → Обработано по статусу сервера', () => {
    expect(alertLifecycle('NEW').map((s) => s.step)).toEqual(['current', 'todo', 'todo']);
    expect(alertLifecycle('VIEWED').map((s) => s.step)).toEqual(['done', 'current', 'todo']);
    expect(alertLifecycle('RESOLVED').map((s) => s.step)).toEqual(['done', 'done', 'current']);
  });
});

describe('навигация', () => {
  it('все маршруты на месте и каждый в своей группе', () => {
    expect([...ROUTES].sort()).toEqual(NAV.map((n) => n.route).sort());
    expect(new Set(NAV.map((n) => n.group))).toEqual(new Set(['monitor', 'data', 'control']));
  });

  it('администрирование видит только администратор', () => {
    expect(navItems(null).map((n) => n.route)).not.toContain('admin');
    expect(navItems('operator').map((n) => n.route)).not.toContain('admin');
    expect(navItems('admin').map((n) => n.route)).toContain('admin');
    expect(navItems('operator')).toHaveLength(ROUTES.length - 1);
  });
});

describe('тема', () => {
  it('выбор хранится в браузере, «системная» следует настройке ОС', () => {
    expect(readThemePref(memoryStore({ [KEYS.theme]: 'dark' }))).toBe('dark');
    expect(readThemePref(memoryStore({ [KEYS.theme]: 'neon' }))).toBe('system');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
});

describe('строки Eclipse', () => {
  const ECLIPSE = Object.keys(ru).filter((k) => /^(flow\.|nav\.group\.|dash\.intro\.|demo\.facts\.|alert\.lifecycle|alert\.stage\.|map\.threat)/.test(k));

  it('новые ключи есть и переведены на казахский и английский (не копия русского)', () => {
    expect(ECLIPSE.length).toBeGreaterThan(15);
    for (const k of ECLIPSE) {
      for (const lang of ['kk', 'en'] as const) {
        const v = DICTIONARIES[lang][k as keyof typeof ru];
        expect(v, `${lang}:${k}`).toBeTruthy();
        if (k !== 'nav.group.monitor') expect(v, `${lang}:${k}`).not.toBe(ru[k as keyof typeof ru]);
      }
    }
  });

  it('схема явно названа схемой, а не моделью затопления — на всех языках', () => {
    expect(DICTIONARIES.ru['flow.note']).toMatch(/не гидродинамическая модель/);
    expect(DICTIONARIES.en['flow.note']).toMatch(/not a hydrodynamic model/);
    expect(DICTIONARIES.kk['flow.note']).toMatch(/гидродинамикалық модель де/);
  });
});
