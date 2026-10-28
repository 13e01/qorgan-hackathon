// T4.1: «Демо за 2 минуты» — этапы только по подтверждённым данным, команды к API, конфликт с активным прогоном,
// выход, повтор, защита от двойного запуска, восстановление после перезагрузки, обработка ошибок.

import { describe, expect, it } from 'vitest';
import type { SimState, Snapshot, SnapshotStation, StationMeta } from '../src/api/types';
import { advanceStage, DEMO_RUN, DemoController, emptyTracker, RISE_CONFIRM_H, stageEvidence, trackRises, type DemoApi, type SimView } from '../src/lib/demo';
import { CommandGate } from '../src/lib/gate';
import { KEYS, memoryStore } from '../src/lib/prefs';

const CODES = ['QRG-01', 'QRG-02', 'QRG-03', 'QRG-04'];
const metas = CODES.map((code, i) => ({ code, name: `N${i + 1}`, upstreamCode: i === 0 ? null : CODES[i - 1]! }) as StationMeta);

type Sit = SnapshotStation['risk']['situation'];
interface St {
  risk?: 'LOW' | 'MEDIUM' | 'HIGH';
  sit?: Partial<Sit>;
  cm?: number | null;
}
function snapshot(stations: Record<string, St>, runId = 7, state: SimState = 'RUNNING', hour = 0): Snapshot {
  return {
    simulation: { state, run: null, realTime: '' },
    context: { mode: 'LIVE', runId, runStatus: null, scenarioId: 'RAPID_FLOOD', virtualTime: new Date(Date.parse('2026-11-01T00:00:00.000Z') + hour * 3_600_000).toISOString(), realTime: '', lastReceivedAt: null },
    stations: CODES.map((code) => {
      const s = stations[code] ?? {};
      const cm = s.cm === undefined ? 300 : s.cm;
      return {
        id: 1,
        code,
        name: code,
        status: 'active',
        lastMessageAt: null,
        latest: cm === null ? {} : { water_level: { value: cm, unit: 'cm', measuredAt: '2026-11-01T00:00:00.000Z', source: 'simulator', quality: 'ok' } },
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

const rising: St = { sit: { localTrend: 'RISING' } };
/** Рост подтверждён несколько часов подряд у всех станций (для проверки самих этапов). */
const confirmed = Object.fromEntries(CODES.map((c) => [c, RISE_CONFIRM_H]));
const upstreamOnly: St = { risk: 'MEDIUM', sit: { drivers: 'UPSTREAM', upstream: { stationCode: 'QRG-01', risk: 'HIGH', travelHours: 51 } } };

describe('этапы демо — только по реальным данным', () => {
  it('спокойная река — первый этап, дальше не двигается', () => {
    expect(advanceStage(null, snapshot({}), metas)).toEqual({ stage: 'normal', stationCode: null });
  });

  it('подъём → опасность → волна ниже → объяснение, с названием станции из данных', () => {
    let s = advanceStage(null, snapshot({ 'QRG-01': rising }), metas, confirmed);
    expect(s).toEqual({ stage: 'rising', stationCode: 'QRG-01' });
    s = advanceStage(s, snapshot({ 'QRG-01': { ...rising, risk: 'HIGH' } }), metas, confirmed);
    expect(s).toEqual({ stage: 'risk', stationCode: 'QRG-01' });
    s = advanceStage(s, snapshot({ 'QRG-01': { risk: 'HIGH', sit: { localLevel: 'ABOVE_DANGER' } }, 'QRG-02': rising }), metas, confirmed);
    expect(s).toEqual({ stage: 'wave', stationCode: 'QRG-02' });
    s = advanceStage(s, snapshot({ 'QRG-03': { risk: 'HIGH', sit: { localLevel: 'ABOVE_DANGER' } }, 'QRG-04': rising }), metas, confirmed);
    expect(s).toEqual({ stage: 'explain', stationCode: 'QRG-03' });
  });

  it('угроза сверху без местного подъёма НЕ считается приходом волны', () => {
    const s = advanceStage({ stage: 'risk', stationCode: 'QRG-01' }, snapshot({ 'QRG-01': { risk: 'HIGH' }, 'QRG-02': upstreamOnly, 'QRG-03': upstreamOnly }), metas, confirmed);
    expect(s.stage).toBe('risk');
    expect(stageEvidence('wave', snapshot({ 'QRG-02': upstreamOnly }), metas, confirmed)).toBe(false);
  });

  it('этап не откатывается назад, когда вода спадает', () => {
    const s = advanceStage({ stage: 'wave', stationCode: 'QRG-02' }, snapshot({}), metas);
    expect(s).toEqual({ stage: 'wave', stationCode: 'QRG-02' });
  });

  it('станция без измерений не подтверждает этап', () => {
    expect(stageEvidence('rising', snapshot({ 'QRG-01': { ...rising, cm: null } }), metas, confirmed)).toBe(false);
    expect(stageEvidence('risk', snapshot({ 'QRG-01': { risk: 'HIGH', cm: null } }), metas)).toBe(false);
  });

  it('одиночный «рост» в шуме (1–2 часа) не объявляется подъёмом воды', () => {
    let tr = emptyTracker();
    tr = trackRises(tr, snapshot({ 'QRG-03': rising }, 7, 'RUNNING', 1));
    tr = trackRises(tr, snapshot({ 'QRG-03': rising }, 7, 'RUNNING', 1)); // повтор того же часа не считается
    expect(tr.streaks['QRG-03']).toBe(1);
    expect(stageEvidence('rising', snapshot({ 'QRG-03': rising }), metas, tr.streaks)).toBe(false);
    tr = trackRises(tr, snapshot({ 'QRG-03': rising }, 7, 'RUNNING', 2));
    tr = trackRises(tr, snapshot({}, 7, 'RUNNING', 3)); // рост прервался — счёт сначала
    expect(tr.streaks['QRG-03']).toBe(0);
    for (let h = 4; h < 4 + RISE_CONFIRM_H; h++) tr = trackRises(tr, snapshot({ 'QRG-03': rising }, 7, 'RUNNING', h));
    expect(stageEvidence('rising', snapshot({ 'QRG-03': rising }), metas, tr.streaks)).toBe('QRG-03');
  });

  it('выше предупредительного порога — подъём подтверждён сразу', () => {
    expect(stageEvidence('rising', snapshot({ 'QRG-02': { sit: { localLevel: 'ABOVE_WARNING' } } }), metas)).toBe('QRG-02');
  });

  it('завершение сценария открывает итог', () => {
    expect(stageEvidence('explain', snapshot({ 'QRG-02': { risk: 'MEDIUM' } }, 7, 'COMPLETED'), metas)).toBe('QRG-02');
  });
});

class FakeApi implements DemoApi {
  calls: Array<{ url: string; body: unknown }> = [];
  nextRunId = 10;
  fail: Record<string, { code: string } | undefined> = {};
  hold: Promise<void> | null = null;
  async post<T>(url: string, body?: unknown): Promise<T> {
    this.calls.push({ url, body });
    if (this.hold) await this.hold;
    const err = this.fail[url];
    if (err) throw Object.assign(new Error(err.code), err);
    if (url === '/api/simulation/start' && body) return { state: 'RUNNING', run: { id: this.nextRunId++ } } as T;
    return { state: 'RUNNING', run: null } as T;
  }
  urls() {
    return this.calls.map((c) => c.url);
  }
}

function setup(store = memoryStore()) {
  const api = new FakeApi();
  const gate = new CommandGate();
  const changes: unknown[] = [];
  const c = new DemoController(api, gate, store, (s) => changes.push(s));
  return { api, gate, c, store, changes };
}

const idle: SimView = { state: 'IDLE', runId: null };

describe('DemoController', () => {
  it('запуск: одна команда start с параметрами демо (создание и запуск на сервере — одной операцией)', async () => {
    const { api, c } = setup();
    await c.begin(idle);
    expect(api.calls).toEqual([{ url: '/api/simulation/start', body: DEMO_RUN }]);
    expect(c.state).toMatchObject({ phase: 'active', runId: 10, stage: { stage: 'normal' } });
    expect(DEMO_RUN).toEqual({ scenarioId: 'RAPID_FLOOD', seed: 42, tickMs: 500 });
  });

  it('двойное нажатие не создаёт второй прогон', async () => {
    const { api, c } = setup();
    let release!: () => void;
    api.hold = new Promise<void>((r) => (release = r));
    const a = c.begin(idle);
    const b = c.begin(idle);
    release();
    await Promise.all([a, b]);
    expect(api.urls()).toEqual(['/api/simulation/start']);
  });

  it('активный чужой прогон не уничтожается молча — сначала выбор пользователя', async () => {
    const { api, c } = setup();
    await c.begin({ state: 'RUNNING', runId: 3 });
    expect(c.state.phase).toBe('conflict');
    expect(api.calls).toEqual([]);
    c.cancelConflict();
    expect(c.state.phase).toBe('off');
  });

  it('«Показать текущий прогон»: на паузе — продолжить, без нового прогона', async () => {
    const { api, c } = setup();
    await c.begin({ state: 'PAUSED', runId: 3 });
    await c.continueExisting({ state: 'PAUSED', runId: 3 });
    expect(api.urls()).toEqual(['/api/simulation/resume']);
    expect(c.state).toMatchObject({ phase: 'active', runId: 3 });
  });

  it('«Остановить его и начать демо»: сначала стоп, затем новый прогон', async () => {
    const { api, c } = setup();
    await c.begin({ state: 'RUNNING', runId: 3 });
    await c.restart({ state: 'RUNNING', runId: 3 });
    expect(api.urls()).toEqual(['/api/simulation/stop', '/api/simulation/start']);
    expect(c.state).toMatchObject({ phase: 'active', runId: 10 });
  });

  it('выход останавливает идущий прогон демо и закрывает режим; таймеров не остаётся', async () => {
    const { api, c, store } = setup();
    await c.begin(idle);
    expect(store.data.has(KEYS.demo)).toBe(true);
    await c.exit({ state: 'RUNNING', runId: 10 });
    expect(api.urls()).toEqual(['/api/simulation/start', '/api/simulation/stop']);
    expect(c.state.phase).toBe('off');
    expect(store.data.has(KEYS.demo)).toBe(false);
  });

  it('выход после завершения сценария ничего не останавливает; чужой прогон не трогает', async () => {
    const { api, c } = setup();
    await c.begin(idle);
    await c.exit({ state: 'COMPLETED', runId: 10 });
    expect(api.urls()).toEqual(['/api/simulation/start']);
    await c.begin(idle);
    await c.exit({ state: 'RUNNING', runId: 99 });
    expect(api.urls()).toEqual(['/api/simulation/start', '/api/simulation/start']);
  });

  it('выход: прогон уже завершился сам (NO_ACTIVE_RUN) — не ошибка', async () => {
    const { api, c } = setup();
    await c.begin(idle);
    api.fail['/api/simulation/stop'] = { code: 'NO_ACTIVE_RUN' };
    await c.exit({ state: 'RUNNING', runId: 10 });
    expect(c.state.phase).toBe('off');
  });

  it('повтор после завершения — новый прогон, этапы с начала', async () => {
    const { api, c } = setup();
    await c.begin(idle);
    for (let h = 0; h < RISE_CONFIRM_H; h++) c.onSnapshot(snapshot({ 'QRG-01': rising }, 10, 'RUNNING', h), metas);
    expect(c.state.stage.stage).toBe('rising');
    await c.replay({ state: 'COMPLETED', runId: 10 });
    expect(api.urls()).toEqual(['/api/simulation/start', '/api/simulation/start']);
    expect(c.state).toMatchObject({ phase: 'active', runId: 11, stage: { stage: 'normal' } });
  });

  it('снимки другого прогона этапы не двигают', async () => {
    const { c } = setup();
    await c.begin(idle);
    for (let h = 0; h < RISE_CONFIRM_H; h++) c.onSnapshot(snapshot({ 'QRG-01': rising }, 99, 'RUNNING', h), metas);
    expect(c.state.stage.stage).toBe('normal');
  });

  it('восстановление после перезагрузки — только для того же прогона', async () => {
    const store = memoryStore();
    const first = setup(store);
    await first.c.begin(idle);
    for (let h = 0; h < RISE_CONFIRM_H; h++) first.c.onSnapshot(snapshot({ 'QRG-01': rising }, 10, 'RUNNING', h), metas);

    const again = setup(store);
    again.c.restore({ state: 'RUNNING', runId: 10 });
    expect(again.c.state).toMatchObject({ phase: 'active', runId: 10, stage: { stage: 'rising', stationCode: 'QRG-01' } });

    const other = setup(memoryStore(Object.fromEntries(store.data)));
    other.c.restore({ state: 'RUNNING', runId: 11 });
    expect(other.c.state.phase).toBe('off');
    expect(setup(memoryStore({ [KEYS.demo]: '{oops' })).c.state.phase).toBe('off');
  });

  it('ошибка сервера пробрасывается, режим демо не включается, кнопка снова доступна', async () => {
    const { api, c, gate } = setup();
    api.fail['/api/simulation/start'] = { code: 'RUN_LIMIT' };
    await expect(c.begin(idle)).rejects.toMatchObject({ code: 'RUN_LIMIT' });
    expect(c.state.phase).toBe('off');
    expect(gate.busy).toBe(false);
    api.fail = {};
    await c.begin(idle);
    expect(c.state.phase).toBe('active');
  });

  it('пауза и продолжение — команды сервера', async () => {
    const { api, c } = setup();
    await c.begin(idle);
    await c.pause();
    await c.resume();
    expect(api.urls()).toEqual(['/api/simulation/start', '/api/simulation/pause', '/api/simulation/resume']);
  });
});
