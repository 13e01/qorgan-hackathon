// T4.1: «Демо за 2 минуты» по полному пути — тот же DemoController, что в интерфейсе, работает с настоящим сервером:
// кнопка → POST /api/simulation/start → симулятор T3 → POST /api/telemetry → SQLite → риск T2 → снимок WebSocket → этап демо.
// Время управляемое (ManualScheduler), реальных ожиданий нет.

import { describe, expect, it } from 'vitest';
import type { Snapshot, StationMeta } from '../../web/src/api/types';
import { DEMO_RUN, DEMO_STAGES, DemoController, type DemoApi, type DemoStage } from '../../web/src/lib/demo';
import { CommandGate } from '../../web/src/lib/gate';
import { memoryStore } from '../../web/src/lib/prefs';
import { CODES, levels, risks, simApp, type SimContext } from './sim-helpers';

/** Клиент API для контроллера: те же маршруты и та же cookie оператора, ошибки — с кодом сервера. */
function apiFor(s: SimContext): DemoApi {
  return {
    async post<T>(url: string, body?: unknown): Promise<T> {
      const res = await s.post(url, body ?? {});
      if (res.status >= 400) throw Object.assign(new Error(res.body?.error?.code ?? 'HTTP'), { code: res.body?.error?.code, status: res.status });
      return res.body as T;
    },
  };
}

/** Подписка на /ws: очередь снимков. */
async function socket(s: SimContext) {
  const queue: Snapshot[] = [];
  const waiters: Array<(m: Snapshot) => void> = [];
  const ws = await s.app.injectWS('/ws', {}, {
    onInit: (sock) =>
      sock.on('message', (m: Buffer) => {
        const msg = JSON.parse(m.toString()) as { type: string; data: Snapshot };
        if (msg.type !== 'snapshot') return;
        const w = waiters.shift();
        if (w) w(msg.data);
        else queue.push(msg.data);
      }),
  });
  const next = () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise<Snapshot>((resolve) => waiters.push(resolve)));
  /** Ждать снимок, в котором прогон дошёл до тика. */
  const untilTick = async (tick: number) => {
    for (;;) {
      const snap = await next();
      if ((snap.simulation.run?.currentTick ?? -1) >= tick) return snap;
    }
  };
  return { ws, next, untilTick, drain: () => queue.splice(0) };
}

describe('Демо за 2 минуты — полный путь через настоящий backend', () => {
  it('этапы включаются по реальным данным T3/T2 в правильном порядке; выход останавливает прогон без оставшихся таймеров', async () => {
    const s = await simApp();
    const stations = (await s.get('/api/stations')).body.items as StationMeta[];
    const sock = await socket(s);
    await sock.next(); // снимок при подключении (IDLE)
    const gate = new CommandGate();
    const demo = new DemoController(apiFor(s), gate, memoryStore());

    await demo.begin({ state: 'IDLE', runId: null });
    const runId = demo.state.runId!;
    expect(demo.state.phase).toBe('active');
    const state = (await s.get('/api/simulation/state')).body;
    expect(state).toMatchObject({ state: 'RUNNING', run: { id: runId, scenarioId: DEMO_RUN.scenarioId, seed: DEMO_RUN.seed, tickMs: DEMO_RUN.tickMs } });
    expect(s.scheduler.pending).toBe(1); // ровно один таймер — у сервера; у демо своих таймеров нет

    // Повторное нажатие во время показа не создаёт второй прогон.
    await demo.begin({ state: 'RUNNING', runId });
    expect((await s.get('/api/simulation/runs')).body.items).toHaveLength(1);

    const reachedAt: Partial<Record<DemoStage, number>> = { normal: -1 };
    const stationAt: Partial<Record<DemoStage, string | null>> = {};
    let tick = -1;
    let last: Snapshot | null = null;
    while (s.scheduler.pending > 0) {
      await s.fire();
      tick += 1;
      last = await sock.untilTick(tick);
      const before = demo.state.stage.stage;
      demo.onSnapshot(last, stations);
      const now = demo.state.stage.stage;
      if (now !== before) {
        reachedAt[now] = tick;
        stationAt[now] = demo.state.stage.stationCode;
      }
    }
    // Снимок о завершении приходит отдельным сообщением после последнего тика.
    while (last!.simulation.state !== 'COMPLETED') {
      last = await sock.next();
      demo.onSnapshot(last, stations);
    }
    expect(last!.simulation.state).toBe('COMPLETED');
    expect((await s.get('/api/simulation/state')).body.state).toBe('COMPLETED');

    // Все пять этапов — по порядку и задолго до конца сценария (260 ч).
    const ticks = DEMO_STAGES.map((st) => reachedAt[st]);
    expect(ticks.every((x) => x !== undefined), JSON.stringify(reachedAt)).toBe(true);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]!).toBeGreaterThanOrEqual(ticks[i - 1]!);
    expect(reachedAt.explain!).toBeLessThan(200);

    // Этап «подъём» — у станции-истока, и её уровень в SQLite к этому часу действительно вырос.
    expect(stationAt.rising).toBe('QRG-01');
    const src = levels(s.db, runId, 'QRG-01');
    expect(src[reachedAt.rising!]!.value).toBeGreaterThan(src[0]!.value);

    // Этап «волна ниже по течению» — у станции ниже истока, подъём подтверждён её собственными измерениями.
    const waveCode = stationAt.wave!;
    expect(CODES.indexOf(waveCode as (typeof CODES)[number])).toBeGreaterThan(0);
    const wl = levels(s.db, runId, waveCode);
    expect(wl[reachedAt.wave!]!.value).toBeGreaterThan(wl[0]!.value);

    // Этап «опасность» подтверждён сохранённой оценкой T2 (не ниже MEDIUM) у названной станции.
    const riskCode = stationAt.risk!;
    expect(risks(s.db, runId, riskCode)[reachedAt.risk!]!.risk).not.toBe('LOW');

    // Измерения и оценки сохранены в SQLite для всех станций и каждого часа.
    for (const code of CODES) {
      expect(levels(s.db, runId, code)).toHaveLength(260);
      expect(risks(s.db, runId, code)).toHaveLength(260);
    }

    // Выход после завершения: останавливать нечего, режим закрыт, таймеров нет.
    await demo.exit({ state: 'COMPLETED', runId });
    expect(demo.state.phase).toBe('off');
    expect(s.scheduler.pending).toBe(0);
    sock.ws.terminate();
  });

  it('выход во время показа останавливает прогон (данные сохраняются); повтор создаёт новый прогон', async () => {
    const s = await simApp();
    const demo = new DemoController(apiFor(s), new CommandGate(), memoryStore());
    await demo.begin({ state: 'IDLE', runId: null });
    const first = demo.state.runId!;
    await s.run(30);

    await demo.exit({ state: 'RUNNING', runId: first });
    expect(demo.state.phase).toBe('off');
    expect((await s.get('/api/simulation/state')).body).toMatchObject({ state: 'STOPPED', run: { id: first } });
    expect(s.scheduler.pending).toBe(0);
    expect(levels(s.db, first, 'QRG-01')).toHaveLength(30);

    await demo.replay({ state: 'STOPPED', runId: first });
    const second = demo.state.runId!;
    expect(second).not.toBe(first);
    expect((await s.get('/api/simulation/state')).body).toMatchObject({ state: 'RUNNING', run: { id: second, scenarioId: 'RAPID_FLOOD' } });
    await demo.exit({ state: 'RUNNING', runId: second });
    expect(s.scheduler.pending).toBe(0);
  });

  it('активный прогон оператора не уничтожается молча: конфликт → явный выбор', async () => {
    const s = await simApp();
    const res = await s.post('/api/simulation/start', { scenarioId: 'GRADUAL_FLOOD', seed: 7, tickMs: 1000 });
    const theirs = res.body.run.id as number;
    await s.run(5);
    const demo = new DemoController(apiFor(s), new CommandGate(), memoryStore());

    await demo.begin({ state: 'RUNNING', runId: theirs });
    expect(demo.state.phase).toBe('conflict');
    expect((await s.get('/api/simulation/state')).body).toMatchObject({ state: 'RUNNING', run: { id: theirs } });

    // «Показать текущий прогон» на паузе → продолжить тот же прогон.
    await s.post('/api/simulation/pause');
    await demo.continueExisting({ state: 'PAUSED', runId: theirs });
    expect(demo.state).toMatchObject({ phase: 'active', runId: theirs });
    expect((await s.get('/api/simulation/state')).body).toMatchObject({ state: 'RUNNING', run: { id: theirs } });

    // «Остановить его и начать демо» → прежний прогон STOPPED (данные на месте), новый — RAPID_FLOOD.
    await demo.restart({ state: 'RUNNING', runId: theirs });
    const runs = (await s.get('/api/simulation/runs')).body.items as Array<{ id: number; status: string; scenarioId: string }>;
    expect(runs.find((r) => r.id === theirs)).toMatchObject({ status: 'STOPPED' });
    expect(runs.find((r) => r.id === demo.state.runId)).toMatchObject({ status: 'RUNNING', scenarioId: 'RAPID_FLOOD' });
    expect(levels(s.db, theirs, 'QRG-01').length).toBeGreaterThan(0);
    expect(s.scheduler.pending).toBe(1);
  });

  it('гость не может запустить демо: ошибка сервера доходит до интерфейса', async () => {
    const s = await simApp();
    const guest: DemoApi = {
      async post<T>(url: string, body?: unknown): Promise<T> {
        const res = await s.post(url, body ?? {}, '');
        if (res.status >= 400) throw Object.assign(new Error('x'), { code: res.body?.error?.code, status: res.status });
        return res.body as T;
      },
    };
    const demo = new DemoController(guest, new CommandGate(), memoryStore());
    await expect(demo.begin({ state: 'IDLE', runId: null })).rejects.toMatchObject({ status: 401 });
    expect(demo.state.phase).toBe('off');
    expect((await s.get('/api/simulation/state')).body.state).toBe('IDLE');
  });
});
