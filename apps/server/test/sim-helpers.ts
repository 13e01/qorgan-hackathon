import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../src/app';
import type { Db } from '../src/db/connection';
import type { Scheduler } from '../src/simulation/runner';
import { login, testDb } from './helpers';

/** Ручной планировщик: тики выполняются только по команде теста — без реального ожидания. */
export class ManualScheduler implements Scheduler {
  private seq = 0;
  readonly tasks = new Map<number, { fn: () => void; ms: number }>();

  setTimeout(fn: () => void, ms: number): unknown {
    this.seq += 1;
    this.tasks.set(this.seq, { fn, ms });
    return this.seq;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  get pending(): number {
    return this.tasks.size;
  }

  /** Задержка единственного запланированного тика (мс реального времени). */
  get nextDelay(): number | null {
    const first = this.tasks.values().next();
    return first.done ? null : first.value.ms;
  }
}

/** Управляемые реальные часы: идут только когда тест их сдвигает. */
export class TestClock {
  constructor(private ms = Date.parse('2026-10-28T10:37:12.000Z')) {}
  now = () => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface SimContext {
  app: FastifyInstance;
  db: Db;
  scheduler: ManualScheduler;
  clock: TestClock;
  operator: string;
  admin: string;
  /** Выполнить следующий запланированный тик и дождаться его обработки. */
  fire(): Promise<void>;
  /** Выполнить n тиков (или пока они запланированы). */
  run(n?: number): Promise<number>;
  post(url: string, body?: unknown, cookie?: string): Promise<{ status: number; body: any }>;
  get(url: string, cookie?: string): Promise<{ status: number; body: any }>;
}

export async function simApp(db: Db = testDb(), clock = new TestClock(), extra: Partial<AppOptions> = {}): Promise<SimContext> {
  const scheduler = new ManualScheduler();
  const app = await buildApp({ db, sessionSecret: 'test-secret-'.padEnd(40, 'x'), sessionTtlHours: 12, scheduler, now: clock.now, ...extra });
  const operator = await login(app, 'operator', 'operator-test-pass');
  const admin = await login(app, 'admin', 'admin-test-pass');

  const fire = async () => {
    const entry = scheduler.tasks.entries().next();
    if (entry.done) throw new Error('no scheduled tick');
    const [id, task] = entry.value;
    scheduler.tasks.delete(id);
    clock.advance(task.ms);
    task.fn();
    await app.simulation.idle();
  };

  const request = async (method: 'GET' | 'POST', url: string, body: unknown, cookie: string | undefined) => {
    const res = await app.inject({
      method,
      url,
      headers: cookie ? { cookie } : {},
      ...(body === undefined ? {} : { payload: body as object }),
    });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };

  return {
    app,
    db,
    scheduler,
    clock,
    operator,
    admin,
    fire,
    async run(n = Number.POSITIVE_INFINITY) {
      let done = 0;
      while (done < n && scheduler.pending > 0) {
        await fire();
        done += 1;
      }
      return done;
    },
    post: (url, body, cookie = operator) => request('POST', url, body, cookie),
    get: (url, cookie = operator) => request('GET', url, undefined, cookie),
  };
}

export const H = 3_600_000;

/** Уровни станции по тикам прогона. */
export function levels(db: Db, runId: number, code: string): Array<{ tick: number; value: number; source: string }> {
  return db
    .prepare(
      `SELECT m.tick, m.value, m.source FROM measurements m JOIN stations s ON s.id = m.station_id
       WHERE m.run_id = ? AND s.code = ? AND m.parameter_code = 'water_level' ORDER BY m.tick`,
    )
    .all(runId, code)
    .map((r) => ({ tick: Number(r.tick), value: Number(r.value), source: String(r.source) }));
}

/** Сохранённые оценки риска станции по тикам. */
export function risks(db: Db, runId: number, code: string): Array<{ tick: number; risk: string; score: number }> {
  return db
    .prepare(
      `SELECT r.tick, r.risk, r.score FROM risk_assessments r JOIN stations s ON s.id = r.station_id
       WHERE r.run_id = ? AND s.code = ? ORDER BY r.tick`,
    )
    .all(runId, code)
    .map((r) => ({ tick: Number(r.tick), risk: String(r.risk), score: Number(r.score) }));
}

export const CODES = ['QRG-01', 'QRG-02', 'QRG-03', 'QRG-04'] as const;
