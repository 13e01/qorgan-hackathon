// Исполнитель симуляции: команды оператора, таймер тиков, доставка пакетов в API телеметрии.
//
// Правила, которые здесь обеспечиваются:
//  • Все команды и тики выполняются строго по очереди (одна цепочка промисов) — гонок между паузой и тиком нет.
//  • Таймер максимум один; повторный «Старт» не создаёт второй.
//  • Виртуальное время двигается только тиками; пауза/остановка снимают таймер, и часы стоят.
//  • После остановки приём данных этого прогона закрыт и на стороне API (RUN_NOT_ACTIVE).
//  • Состояние хранится в БД; после перезапуска сервера идущий прогон встаёт на паузу.

import { closeRunAlerts } from '../alerts/engine';
import {
  createGenerator,
  PARAMETERS,
  resolveScenario,
  SCENARIOS,
  type ParameterCode,
  type ScenarioId,
  type ScenarioParams,
} from '@qorgan/shared';
import { transaction, type Db } from '../db/connection';
import { AppError } from '../errors';
import {
  activeRun,
  getRun,
  insertRun,
  LIVE_STATUSES,
  listInterventions,
  setActiveRun,
  stationModels,
  updateRun,
  virtualTime,
  type RunInfo,
  type RunStatus,
} from './repository';

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface TelemetryBatch {
  runId: number;
  tick: number;
  records: Array<{ stationCode: string; parameter: ParameterCode; value: number; unit: string; measuredAt: string; source: 'simulator' | 'manual' }>;
}

export interface Delivery {
  ok: boolean;
  status: number;
  body: unknown;
}

export type RunnerEvent =
  | { type: 'state' }
  | { type: 'tick'; runId: number; tick: number };

export interface RunnerDeps {
  db: Db;
  scheduler: Scheduler;
  now: () => Date;
  deliver: (batch: TelemetryBatch) => Promise<Delivery>;
  onChange?: (event: RunnerEvent) => void;
  logError?: (message: string, details?: unknown) => void;
}

export const MAX_RUNS = 50;
export const MAX_INTERVENTIONS_PER_RUN = 200;
export const DEFAULT_SEED = 42;
export const DEFAULT_TICK_MS = 1000;

export interface CreateRunInput {
  scenarioId: ScenarioId;
  seed?: number;
  tickMs?: number;
  /** Начало виртуального времени (ISO). По умолчанию — начало текущего реального часа (UTC). */
  virtualStart?: string;
  params?: ScenarioParams;
}

export interface InterventionInput {
  type: 'LEVEL_SHIFT' | 'RISE_RATE' | 'MANUAL_READING';
  stationCode: string;
  value: number;
  parameter?: ParameterCode;
  durationH?: number;
}

export interface SimulationState {
  /** IDLE — нет активного прогона; иначе статус активного прогона. */
  state: 'IDLE' | RunStatus;
  run: (RunInfo & {
    virtualTime: string | null;
    nextVirtualTime: string | null;
    progress: number | null;
    /** Сколько виртуальных секунд проходит за одну реальную секунду при текущей скорости. */
    acceleration: number;
  }) | null;
  realTime: string;
}

export class SimulationRunner {
  private timer: unknown = null;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly deps: RunnerDeps) {}

  /** Выполняет операции строго по одной. */
  private serialize<T>(op: () => Promise<T> | T): Promise<T> {
    const result = this.chain.then(op, op);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private nowIso(): string {
    return this.deps.now().toISOString();
  }

  private changed(event: RunnerEvent = { type: 'state' }): void {
    try {
      this.deps.onChange?.(event);
    } catch (err) {
      this.deps.logError?.('onChange failed', err);
    }
  }

  private audit(userId: number | null, action: string, runId: number | null, after: unknown = null): void {
    this.deps.db
      .prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, after_json, created_at) VALUES (?, ?, 'sim_run', ?, ?, ?)")
      .run(userId, action, runId === null ? null : String(runId), after === null ? null : JSON.stringify(after), this.nowIso());
  }

  private clearTimer(): void {
    if (this.timer !== null) this.deps.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(runId: number, ms: number): void {
    this.clearTimer();
    if (this.closed) return;
    this.timer = this.deps.scheduler.setTimeout(() => {
      this.timer = null;
      this.serialize(() => this.tick(runId, 'auto')).catch((err) => this.deps.logError?.('tick failed', err));
    }, ms);
  }

  /** Есть ли запланированный тик (для тестов и диагностики). */
  get hasTimer(): boolean {
    return this.timer !== null;
  }

  state(): SimulationState {
    const run = activeRun(this.deps.db);
    const realTime = this.nowIso();
    if (!run) return { state: 'IDLE', run: null, realTime };
    const total = run.totalTicks;
    return {
      state: run.status,
      run: {
        ...run,
        virtualTime: run.currentTick === null ? null : virtualTime(run, run.currentTick),
        nextVirtualTime: total !== null && (run.currentTick ?? -1) + 1 >= total ? null : virtualTime(run, (run.currentTick ?? -1) + 1),
        progress: total === null ? null : Math.round((((run.currentTick ?? -1) + 1) / total) * 1000) / 1000,
        acceleration: Math.round((run.stepMinutes * 60_000) / run.tickMs),
      },
      realTime,
    };
  }

  private requireLive(): RunInfo {
    const run = activeRun(this.deps.db);
    if (!run || !LIVE_STATUSES.includes(run.status)) throw new AppError(409, 'NO_ACTIVE_RUN', 'Нет активного прогона');
    return run;
  }

  private createSync(input: CreateRunInput, userId: number | null): RunInfo {
    const db = this.deps.db;
    const current = activeRun(db);
    if (current && LIVE_STATUSES.includes(current.status)) {
      throw new AppError(409, 'ACTIVE_RUN_EXISTS', `Прогон ${current.id} ещё активен (${current.status}) — остановите или сбросьте его`);
    }
    const total = Number(db.prepare("SELECT COUNT(*) AS n FROM sim_runs WHERE scenario_id <> 'TEST_FIXTURE'").get()?.n ?? 0);
    if (total >= MAX_RUNS) throw new AppError(409, 'RUN_LIMIT', `Сохранено ${total} прогонов — удалите старые (администратор)`);
    if (!(input.scenarioId in SCENARIOS)) throw new AppError(400, 'VALIDATION', `Неизвестный сценарий: ${input.scenarioId}`);

    const scenario = resolveScenario(input.scenarioId, input.params ?? {});
    const now = this.deps.now();
    const start = input.virtualStart ? new Date(input.virtualStart) : new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    const id = transaction(db, () => {
      const runId = insertRun(
        db,
        {
          scenarioId: input.scenarioId,
          seed: input.seed ?? DEFAULT_SEED,
          params: input.params ?? {},
          tickMs: input.tickMs ?? DEFAULT_TICK_MS,
          totalTicks: scenario.totalTicks,
          simStart: start.toISOString(),
          userId,
        },
        now.toISOString(),
      );
      setActiveRun(db, runId, now.toISOString());
      this.audit(userId, 'SIM_CREATE', runId, { ...input, seed: input.seed ?? DEFAULT_SEED });
      return runId;
    });
    return getRun(db, id)!;
  }

  create(input: CreateRunInput, userId: number | null): Promise<SimulationState> {
    return this.serialize(() => {
      this.createSync(input, userId);
      this.changed();
      return this.state();
    });
  }

  /** Старт созданного прогона; если передан сценарий и созданного прогона нет — создаёт и сразу запускает. */
  start(input: CreateRunInput | undefined, userId: number | null): Promise<SimulationState> {
    return this.serialize(() => {
      let run = activeRun(this.deps.db);
      if (run?.status === 'RUNNING') throw new AppError(409, 'ALREADY_RUNNING', 'Симуляция уже идёт');
      if (run?.status === 'PAUSED') throw new AppError(409, 'RUN_PAUSED', 'Прогон на паузе — используйте «Продолжить»');
      if (run?.status === 'CREATED') {
        if (input) throw new AppError(409, 'ACTIVE_RUN_EXISTS', `Прогон ${run.id} уже создан — запустите его без параметров`);
      } else {
        if (!input) throw new AppError(409, 'NO_ACTIVE_RUN', 'Сначала создайте прогон или укажите сценарий');
        run = this.createSync(input, userId);
      }
      updateRun(this.deps.db, run.id, { status: 'RUNNING', lastError: null });
      this.audit(userId, 'SIM_START', run.id);
      this.schedule(run.id, 0);
      this.changed();
      return this.state();
    });
  }

  pause(userId: number | null): Promise<SimulationState> {
    return this.serialize(() => {
      const run = this.requireLive();
      if (run.status !== 'RUNNING') throw new AppError(409, 'NOT_RUNNING', 'Симуляция не идёт');
      this.clearTimer();
      updateRun(this.deps.db, run.id, { status: 'PAUSED' });
      this.audit(userId, 'SIM_PAUSE', run.id);
      this.changed();
      return this.state();
    });
  }

  resume(userId: number | null): Promise<SimulationState> {
    return this.serialize(() => {
      const run = this.requireLive();
      if (run.status !== 'PAUSED') throw new AppError(409, 'NOT_PAUSED', 'Прогон не на паузе');
      updateRun(this.deps.db, run.id, { status: 'RUNNING', lastError: null });
      this.audit(userId, 'SIM_RESUME', run.id);
      this.schedule(run.id, run.tickMs);
      this.changed();
      return this.state();
    });
  }

  /** Один тик вручную (на паузе или до старта). */
  step(userId: number | null): Promise<SimulationState> {
    return this.serialize(async () => {
      const run = this.requireLive();
      if (run.status === 'RUNNING') throw new AppError(409, 'ALREADY_RUNNING', 'Во время хода симуляции шаг недоступен — поставьте паузу');
      if (run.status === 'CREATED') updateRun(this.deps.db, run.id, { status: 'PAUSED' });
      this.audit(userId, 'SIM_STEP', run.id);
      await this.tick(run.id, 'step');
      return this.state();
    });
  }

  /** Остановка: прогон завершается окончательно, его данные сохраняются и доступны как история. */
  stop(userId: number | null): Promise<SimulationState> {
    return this.serialize(() => {
      const run = this.requireLive();
      this.clearTimer();
      updateRun(this.deps.db, run.id, { status: 'STOPPED', stoppedAt: this.nowIso() });
      closeRunAlerts(this.deps.db, run.id, this.nowIso());
      this.audit(userId, 'SIM_STOP', run.id);
      this.changed();
      return this.state();
    });
  }

  /** Сброс: активный прогон (если идёт) останавливается, симулятор возвращается в IDLE. Данные НЕ удаляются. */
  reset(userId: number | null): Promise<SimulationState> {
    return this.serialize(() => {
      const run = activeRun(this.deps.db);
      this.clearTimer();
      transaction(this.deps.db, () => {
        if (run && LIVE_STATUSES.includes(run.status)) {
          updateRun(this.deps.db, run.id, { status: 'STOPPED', stoppedAt: this.nowIso() });
          closeRunAlerts(this.deps.db, run.id, this.nowIso());
        }
        setActiveRun(this.deps.db, null, this.nowIso());
        this.audit(userId, 'SIM_RESET', run?.id ?? null);
      });
      this.changed();
      return this.state();
    });
  }

  setSpeed(tickMs: number, userId: number | null): Promise<SimulationState> {
    return this.serialize(() => {
      const run = this.requireLive();
      updateRun(this.deps.db, run.id, { tickMs });
      this.audit(userId, 'SIM_SPEED', run.id, { tickMs });
      if (run.status === 'RUNNING') this.schedule(run.id, tickMs);
      this.changed();
      return this.state();
    });
  }

  /** Ручное вмешательство: действует со следующего тика, прошлое не меняется. */
  addIntervention(input: InterventionInput, userId: number | null): Promise<{ id: number; effectiveTick: number; state: SimulationState }> {
    return this.serialize(() => {
      const db = this.deps.db;
      const run = this.requireLive();
      const effectiveTick = (run.currentTick ?? -1) + 1;
      if (run.totalTicks !== null && effectiveTick >= run.totalTicks) throw new AppError(409, 'RUN_FINISHING', 'Прогон завершается — вмешательство некуда применить');
      const station = db.prepare("SELECT id, status FROM stations WHERE code = ? COLLATE NOCASE").get(input.stationCode);
      if (!station) throw new AppError(404, 'STATION_NOT_FOUND', `Станция не найдена: ${input.stationCode}`);
      if (station.status === 'disabled') throw new AppError(409, 'STATION_DISABLED', 'Станция отключена');
      const stationId = Number(station.id);
      const count = Number(db.prepare('SELECT COUNT(*) AS n FROM sim_interventions WHERE run_id = ?').get(run.id)?.n ?? 0);
      if (count >= MAX_INTERVENTIONS_PER_RUN) throw new AppError(409, 'INTERVENTION_LIMIT', 'Слишком много вмешательств в одном прогоне');

      let parameter: ParameterCode | null = null;
      if (input.type === 'MANUAL_READING') {
        parameter = input.parameter ?? 'water_level';
        const def = PARAMETERS.find((p) => p.code === parameter)!;
        if (!db.prepare('SELECT 1 FROM station_parameters WHERE station_id = ? AND parameter_code = ?').get(stationId, parameter)) {
          throw new AppError(400, 'UNKNOWN_PARAM', `У станции нет датчика ${parameter}`);
        }
        if (input.value < def.minValid || input.value > def.maxValid) {
          throw new AppError(400, 'VALIDATION', `Значение вне допустимого диапазона ${def.minValid}…${def.maxValid} ${def.unit}`);
        }
      } else if (input.type === 'LEVEL_SHIFT' || input.type === 'RISE_RATE') {
        if (!db.prepare("SELECT 1 FROM station_parameters WHERE station_id = ? AND parameter_code = 'water_level'").get(stationId)) {
          throw new AppError(400, 'UNKNOWN_PARAM', 'У станции нет датчика уровня');
        }
      }
      const now = this.nowIso();
      const id = transaction(db, () => {
        if (parameter) {
          db.prepare("DELETE FROM sim_interventions WHERE run_id = ? AND station_id = ? AND parameter_code = ? AND effective_tick = ? AND type = 'MANUAL_READING'")
            .run(run.id, stationId, parameter, effectiveTick);
        }
        const newId = Number(
          db
            .prepare(
              `INSERT INTO sim_interventions (run_id, effective_tick, type, station_id, parameter_code, value, duration_h, user_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(run.id, effectiveTick, input.type, stationId, parameter, input.value, input.type === 'RISE_RATE' ? (input.durationH ?? 1) : null, userId, now)
            .lastInsertRowid,
        );
        this.audit(userId, 'SIM_INTERVENTION', run.id, { ...input, effectiveTick });
        return newId;
      });
      this.changed();
      return { id, effectiveTick, state: this.state() };
    });
  }

  /** Один тик: генерация показаний → POST /api/telemetry → проверка завершения → планирование следующего. */
  private async tick(runId: number, mode: 'auto' | 'step'): Promise<void> {
    if (this.closed) return;
    const db = this.deps.db;
    const run = getRun(db, runId);
    const active = activeRun(db);
    if (!run || active?.id !== runId) return;
    if (mode === 'auto' && run.status !== 'RUNNING') return;
    const next = (run.currentTick ?? -1) + 1;
    if (run.totalTicks !== null && next >= run.totalTicks) {
      this.complete(run);
      return;
    }

    const scenario = resolveScenario(run.scenarioId as ScenarioId, run.params);
    const generator = createGenerator({ scenario, seed: run.seed, stations: stationModels(db), interventions: listInterventions(db, run.id) });
    const measuredAt = virtualTime(run, next);
    const batch: TelemetryBatch = {
      runId,
      tick: next,
      records: generator.readingsAt(next).map((r) => ({ ...r, measuredAt })),
    };

    let delivery: Delivery;
    try {
      delivery = await this.deps.deliver(batch);
    } catch (err) {
      delivery = { ok: false, status: 0, body: String(err) };
    }
    if (!delivery.ok) {
      // Не повторяем бесконечно: прогон встаёт на паузу с описанием ошибки, оператор решает, что делать.
      this.clearTimer();
      const latest = getRun(db, runId);
      if (latest && LIVE_STATUSES.includes(latest.status)) {
        updateRun(db, runId, { status: 'PAUSED', lastError: `DELIVERY_FAILED ${delivery.status}: ${JSON.stringify(delivery.body).slice(0, 300)}` });
      }
      this.deps.logError?.('telemetry delivery failed', delivery);
      this.changed();
      return;
    }

    const after = getRun(db, runId)!;
    this.changed({ type: 'tick', runId, tick: next });
    if (after.totalTicks !== null && next >= after.totalTicks - 1) this.complete(after);
    else if (mode === 'auto' && after.status === 'RUNNING') this.schedule(runId, after.tickMs);
  }

  private complete(run: RunInfo): void {
    this.clearTimer();
    updateRun(this.deps.db, run.id, { status: 'COMPLETED', finishedAt: this.nowIso() });
    closeRunAlerts(this.deps.db, run.id, this.nowIso());
    this.audit(null, 'SIM_COMPLETE', run.id);
    this.changed();
  }

  /** После перезапуска сервера: прогоны, которые «шли», ставятся на паузу (таймеров в памяти уже нет). */
  recover(): number[] {
    const db = this.deps.db;
    const ids = db.prepare("SELECT id FROM sim_runs WHERE status = 'RUNNING'").all().map((r) => Number(r.id));
    for (const id of ids) {
      updateRun(db, id, { status: 'PAUSED', lastError: 'SERVER_RESTART' });
      db.prepare("INSERT INTO device_log (level, code, details_json, created_at) VALUES ('info', 'SIM_RECOVERED_PAUSED', ?, ?)").run(
        JSON.stringify({ runId: id }),
        this.nowIso(),
      );
    }
    return ids;
  }

  /** Останавливает таймер; после закрытия новые тики не выполняются. */
  close(): void {
    this.closed = true;
    this.clearTimer();
  }

  /** Дождаться завершения уже поставленных в очередь операций (для тестов и корректного выключения). */
  idle(): Promise<void> {
    return this.serialize(() => undefined);
  }
}
