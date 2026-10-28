// «Демо за 2 минуты»: управляемый показ НАСТОЯЩЕГО прогона T3 (RAPID_FLOOD) через существующий API.
// Второй симуляции в браузере нет, таймеров нет: этапы показа выводятся только из снимков сервера,
// и этап включается лишь тогда, когда данные его подтверждают (например, «волна дошла ниже» — только при
// фактическом местном подъёме у станции ниже по течению, а не по одной угрозе сверху).
// Модуль без DOM и React — его использует и интеграционный тест сервера.

import type { SimState, SimulationState, Snapshot, SnapshotStation, StationMeta } from '../api/types';
import type { CommandGate } from './gate';
import { levelView } from './level';
import { KEYS, readPref, writePref, type KeyValueStore } from './prefs';

/** Сценарий показа: быстрый паводок, фиксированная повторяемость, 1 ч симуляции = 0,5 с (весь прогон ≈ 2 мин). */
export const DEMO_RUN = { scenarioId: 'RAPID_FLOOD', seed: 42, tickMs: 500 } as const;

export const DEMO_STAGES = ['normal', 'rising', 'risk', 'wave', 'explain'] as const;
export type DemoStage = (typeof DEMO_STAGES)[number];

export interface StageInfo {
  stage: DemoStage;
  /** Станция, о которой говорит этап (из данных), или null. */
  stationCode: string | null;
}

const LIVE: SimState[] = ['CREATED', 'RUNNING', 'PAUSED'];
export const isLive = (state: SimState): boolean => LIVE.includes(state);

const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;

/**
 * Сколько часов подряд тренд T2 должен показывать рост, чтобы демо назвало это подъёмом воды.
 * На 2–3 первых точках тренд может «увидеть» рост в обычных колебаниях (≈1 см/ч) — модель T2 не меняем,
 * а в рассказе требуем подтверждения несколькими измерениями подряд.
 */
export const RISE_CONFIRM_H = 3;

/** Счётчик часов подряд с местным ростом по станциям (обновляется один раз на час симуляции). */
export interface RiseTracker {
  t: string | null;
  streaks: Record<string, number>;
}

export const emptyTracker = (): RiseTracker => ({ t: null, streaks: {} });

export function trackRises(prev: RiseTracker, snapshot: Snapshot): RiseTracker {
  const t = snapshot.context.virtualTime;
  if (t === null || t === prev.t) return prev;
  const streaks: Record<string, number> = {};
  for (const st of snapshot.stations) {
    const up = levelView(st).measuredCm !== null && st.risk.situation.localTrend === 'RISING';
    streaks[st.code] = up ? (prev.streaks[st.code] ?? 0) + 1 : 0;
  }
  return { t, streaks };
}

/** Местный подъём подтверждён измерениями станции (не угрозой сверху): выше порога или рост несколько часов подряд. */
function locallyRising(st: SnapshotStation | undefined, streaks: Record<string, number>): boolean {
  if (!st || levelView(st).measuredCm === null) return false;
  const s = st.risk.situation;
  if (s.localLevel === 'ABOVE_WARNING' || s.localLevel === 'ABOVE_DANGER') return true;
  return s.localTrend === 'RISING' && (streaks[st.code] ?? 0) >= RISE_CONFIRM_H;
}

function find(snapshot: Snapshot, code: string): SnapshotStation | undefined {
  return snapshot.stations.find((s) => s.code === code);
}

/** Самая опасная станция; при равном риске — ниже по течению. */
function worstStation(snapshot: Snapshot, stations: StationMeta[]): string | null {
  let best: string | null = null;
  let rank = -1;
  for (const m of stations) {
    const st = find(snapshot, m.code);
    if (!st || levelView(st).measuredCm === null) continue;
    if (RANK[st.risk.risk] >= rank) {
      rank = RANK[st.risk.risk];
      best = m.code;
    }
  }
  return best;
}

/** Подтверждают ли данные этап. Возвращает код станции, о которой говорит этап, или false. Станции — в порядке по течению. */
export function stageEvidence(stage: DemoStage, snapshot: Snapshot, stations: StationMeta[], streaks: Record<string, number> = {}): string | null | false {
  switch (stage) {
    case 'normal':
      return null;
    case 'rising': {
      const first = stations.find((m) => locallyRising(find(snapshot, m.code), streaks));
      return first ? first.code : false;
    }
    case 'risk': {
      const elevated = stations.some((m) => {
        const st = find(snapshot, m.code);
        return st && levelView(st).measuredCm !== null && st.risk.risk !== 'LOW';
      });
      return elevated ? worstStation(snapshot, stations) : false;
    }
    case 'wave': {
      // Станция ниже первой, у которой подъём подтверждён местными измерениями; берём самую нижнюю из таких.
      const downstream = stations.slice(1).filter((m) => locallyRising(find(snapshot, m.code), streaks));
      return downstream.length > 0 ? downstream.at(-1)!.code : false;
    }
    case 'explain': {
      const last = stations.at(-1);
      const reached = last ? locallyRising(find(snapshot, last.code), streaks) : false;
      return reached || snapshot.simulation.state === 'COMPLETED' ? worstStation(snapshot, stations) : false;
    }
  }
}

/**
 * Следующие этапы включаются по порядку и только при подтверждении данными; назад этап не откатывается.
 * maxSteps ограничивает число этапов за один вызов: демо делает не больше одного этапа за час симуляции,
 * чтобы каждый этап был виден, даже если данные подтвердили два сразу.
 */
export function advanceStage(current: StageInfo | null, snapshot: Snapshot, stations: StationMeta[], streaks: Record<string, number> = {}, maxSteps = Infinity): StageInfo {
  let info: StageInfo = current ?? { stage: 'normal', stationCode: null };
  let idx = DEMO_STAGES.indexOf(info.stage);
  let steps = 0;
  while (idx < DEMO_STAGES.length - 1 && steps < maxSteps) {
    const next = DEMO_STAGES[idx + 1]!;
    const code = stageEvidence(next, snapshot, stations, streaks);
    if (code === false) break;
    info = { stage: next, stationCode: code };
    idx += 1;
    steps += 1;
  }
  return info;
}

export interface DemoApi {
  post<T>(url: string, body?: unknown): Promise<T>;
}

export type DemoPhase = 'off' | 'conflict' | 'active';

export interface DemoState {
  phase: DemoPhase;
  /** Прогон, который показывается в демо. */
  runId: number | null;
  stage: StageInfo;
}

export interface SimView {
  state: SimState;
  runId: number | null;
}

const INITIAL_STAGE: StageInfo = { stage: 'normal', stationCode: null };

/**
 * Управление показом. Все команды идут через общий CommandGate — повторное нажатие не создаёт второй прогон.
 * Ошибки API пробрасываются вызывающему (интерфейс показывает их пользователю).
 */
export class DemoController {
  private s: DemoState = { phase: 'off', runId: null, stage: INITIAL_STAGE };
  private rises: RiseTracker = emptyTracker();

  constructor(
    private readonly api: DemoApi,
    private readonly gate: CommandGate,
    private readonly store: KeyValueStore | null,
    private readonly onChange: (s: DemoState) => void = () => undefined,
  ) {}

  get state(): DemoState {
    return this.s;
  }

  /** Восстановление после перезагрузки страницы: демо продолжается, только если идёт тот же прогон. */
  restore(sim: SimView): void {
    const raw = readPref(this.store, KEYS.demo);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as { runId?: unknown; stage?: unknown; stationCode?: unknown };
      const stage = DEMO_STAGES.includes(saved.stage as DemoStage) ? (saved.stage as DemoStage) : 'normal';
      if (typeof saved.runId === 'number' && saved.runId === sim.runId && sim.state !== 'IDLE') {
        this.set({ phase: 'active', runId: saved.runId, stage: { stage, stationCode: typeof saved.stationCode === 'string' ? saved.stationCode : null } });
        return;
      }
    } catch {
      // повреждённая запись — просто забываем её
    }
    writePref(this.store, KEYS.demo, null);
  }

  /** Кнопка «Демо за 2 минуты». Активный чужой прогон молча не уничтожается — пользователь выбирает сам. */
  async begin(sim: SimView): Promise<void> {
    if (isLive(sim.state) && sim.runId !== this.s.runId) {
      this.set({ ...this.s, phase: 'conflict' });
      return;
    }
    if (isLive(sim.state) && sim.runId === this.s.runId) {
      this.set({ ...this.s, phase: 'active' });
      return;
    }
    await this.startNew(false);
  }

  /** Выбор в диалоге: показать уже идущий прогон (на паузе — продолжить, созданный — запустить). */
  async continueExisting(sim: SimView): Promise<void> {
    if (!isLive(sim.state) || sim.runId === null) return this.startNew(false);
    const runId = sim.runId;
    await this.gate.run(async () => {
      if (sim.state === 'CREATED') await this.api.post('/api/simulation/start');
      else if (sim.state === 'PAUSED') await this.api.post('/api/simulation/resume');
      this.activate(runId, INITIAL_STAGE);
    });
  }

  /** Выбор в диалоге: явно остановить текущий прогон (его данные сохраняются) и начать демо заново. */
  async restart(sim: SimView): Promise<void> {
    await this.startNew(isLive(sim.state));
  }

  cancelConflict(): void {
    if (this.s.phase === 'conflict') this.set({ ...this.s, phase: this.s.runId === null ? 'off' : 'active' });
  }

  /** «Повторить демо» после завершения или остановки. */
  async replay(sim: SimView): Promise<void> {
    if (isLive(sim.state) && sim.runId !== this.s.runId) {
      this.set({ ...this.s, phase: 'conflict' });
      return;
    }
    await this.startNew(isLive(sim.state));
  }

  async pause(): Promise<void> {
    await this.gate.run(() => this.api.post('/api/simulation/pause'));
  }

  async resume(): Promise<void> {
    await this.gate.run(() => this.api.post('/api/simulation/resume'));
  }

  /** «Завершить демо»: идущий прогон демо останавливается (данные остаются для просмотра), режим показа закрывается. */
  async exit(sim: SimView): Promise<void> {
    const runId = this.s.runId;
    const mustStop = runId !== null && sim.runId === runId && isLive(sim.state);
    if (mustStop) {
      const done = await this.gate.run(async () => {
        try {
          await this.api.post('/api/simulation/stop');
        } catch (err) {
          // прогон уже завершился сам — останавливать нечего
          if ((err as { code?: string }).code !== 'NO_ACTIVE_RUN') throw err;
        }
        return true;
      });
      if (done === null) return; // идёт другая команда — выход не выполнен, кнопку можно нажать снова
    }
    this.set({ phase: 'off', runId: null, stage: INITIAL_STAGE });
  }

  /** Новый снимок сервера: двигаем этап, если данные это подтверждают. */
  onSnapshot(snapshot: Snapshot, stations: StationMeta[]): void {
    if (this.s.phase !== 'active' || snapshot.context.runId !== this.s.runId) return;
    const prevHour = this.rises.t;
    this.rises = trackRises(this.rises, snapshot);
    // Один этап за час симуляции; снимок о завершении прогона (тот же час) тоже может открыть итог.
    if (this.rises.t === prevHour && snapshot.simulation.state !== 'COMPLETED') return;
    const stage = advanceStage(this.s.stage, snapshot, stations, this.rises.streaks, 1);
    if (stage.stage !== this.s.stage.stage) this.set({ ...this.s, stage });
  }

  private async startNew(stopFirst: boolean): Promise<void> {
    await this.gate.run(async () => {
      if (stopFirst) await this.api.post('/api/simulation/stop');
      const res = await this.api.post<SimulationState>('/api/simulation/start', { ...DEMO_RUN });
      if (!res.run) throw Object.assign(new Error('no run'), { code: 'NO_ACTIVE_RUN' });
      this.activate(res.run.id, INITIAL_STAGE);
    });
  }

  private activate(runId: number, stage: StageInfo): void {
    this.rises = emptyTracker();
    this.set({ phase: 'active', runId, stage });
  }

  private set(next: DemoState): void {
    this.s = next;
    writePref(this.store, KEYS.demo, next.runId === null ? null : JSON.stringify({ runId: next.runId, stage: next.stage.stage, stationCode: next.stage.stationCode }));
    this.onChange(next);
  }
}
