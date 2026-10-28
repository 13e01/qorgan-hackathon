// API симулятора (docs/ARCHITECTURE.md §11). Чтение состояния и сценариев — всем; управление — оператору;
// удаление прогона — администратору.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SCENARIO_IDS, SCENARIOS, PARAMETER_CODES } from '@qorgan/shared';
import { requireRole } from '../auth/plugin';
import { transaction, type Db } from '../db/connection';
import { AppError, parse } from '../errors';
import { activeRun, deleteRunData, getRun, LIVE_STATUSES, listInterventions, listRuns, virtualTime } from '../simulation/repository';
import type { SimulationRunner } from '../simulation/runner';

const tickMs = z.number().int().min(50).max(5000);

const paramsSchema = z
  .object({
    amplitudeCm: z.number().min(0).max(600),
    startTick: z.number().int().min(0).max(200),
    riseH: z.number().int().min(1).max(168),
    peakH: z.number().int().min(0).max(168),
    fallH: z.number().int().min(1).max(336),
    totalTicks: z.number().int().min(1).max(1000),
    levelNoiseCm: z.number().min(0).max(10),
    levelDailyAmplitudeCm: z.number().min(0).max(20),
  })
  .partial()
  .strict();

const createSchema = z
  .object({
    scenarioId: z.enum(SCENARIO_IDS),
    seed: z.number().int().min(0).max(2_147_483_647).optional(),
    tickMs: tickMs.optional(),
    virtualStart: z.iso.datetime({ offset: true }).optional(),
    params: paramsSchema.optional(),
  })
  .strict();

const interventionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('LEVEL_SHIFT'), stationCode: z.string().min(1).max(32), value: z.number().min(-300).max(300) }).strict(),
  z
    .object({
      type: z.literal('RISE_RATE'),
      stationCode: z.string().min(1).max(32),
      value: z.number().min(-50).max(50),
      durationH: z.number().int().min(1).max(72),
    })
    .strict(),
  z
    .object({
      type: z.literal('MANUAL_READING'),
      stationCode: z.string().min(1).max(32),
      parameter: z.enum(PARAMETER_CODES).default('water_level'),
      value: z.number(),
    })
    .strict(),
]);

const idParam = z.object({ id: z.coerce.number().int().positive() });

export function simulationRoutes(db: Db, runner: SimulationRunner, now: () => Date) {
  return async (app: FastifyInstance) => {
    const operator = { preHandler: requireRole('operator') };
    const admin = { preHandler: requireRole('admin') };
    const userId = (request: { user: { id: number } | null }) => request.user?.id ?? null;

    app.get('/api/simulation/scenarios', async () => ({
      stepMinutes: 60,
      items: SCENARIO_IDS.map((id) => {
        const s = SCENARIOS[id];
        return { id, totalTicks: s.totalTicks, sourceStation: s.sourceStation, wave: s.wave, localInflowCm: s.localInflowCm, rain: s.rain, temperature: s.temperature };
      }),
    }));

    app.get('/api/simulation/state', async () => runner.state());

    app.get('/api/simulation/runs', operator, async () => ({
      items: listRuns(db).map((r) => ({
        ...r,
        isActive: activeRun(db)?.id === r.id,
        virtualTime: r.currentTick === null ? null : virtualTime(r, r.currentTick),
      })),
    }));

    app.get('/api/simulation/runs/:id', operator, async (request) => {
      const { id } = parse(idParam, request.params);
      const run = getRun(db, id);
      if (!run) throw new AppError(404, 'RUN_NOT_FOUND', `Прогон не найден: ${id}`);
      const count = (sql: string) => Number(db.prepare(sql).get(id)?.n ?? 0);
      return {
        run: { ...run, virtualTime: run.currentTick === null ? null : virtualTime(run, run.currentTick), isActive: activeRun(db)?.id === id },
        counts: {
          measurements: count('SELECT COUNT(*) AS n FROM measurements WHERE run_id = ?'),
          assessments: count('SELECT COUNT(*) AS n FROM risk_assessments WHERE run_id = ?'),
          interventions: count('SELECT COUNT(*) AS n FROM sim_interventions WHERE run_id = ?'),
        },
        interventions: listInterventions(db, id),
      };
    });

    app.post('/api/simulation/runs', operator, async (request, reply) => {
      const input = parse(createSchema, request.body);
      const state = await runner.create(input, userId(request));
      return reply.status(201).send(state);
    });

    app.post('/api/simulation/start', operator, async (request) => {
      const raw = request.body;
      const input = raw === undefined || raw === null || (typeof raw === 'object' && Object.keys(raw).length === 0) ? undefined : parse(createSchema, raw);
      return runner.start(input, userId(request));
    });
    app.post('/api/simulation/pause', operator, async (request) => runner.pause(userId(request)));
    app.post('/api/simulation/resume', operator, async (request) => runner.resume(userId(request)));
    app.post('/api/simulation/step', operator, async (request) => runner.step(userId(request)));
    app.post('/api/simulation/stop', operator, async (request) => runner.stop(userId(request)));
    app.post('/api/simulation/reset', operator, async (request) => runner.reset(userId(request)));

    app.patch('/api/simulation/speed', operator, async (request) => {
      const { tickMs: ms } = parse(z.object({ tickMs }).strict(), request.body);
      return runner.setSpeed(ms, userId(request));
    });

    app.get('/api/simulation/interventions', operator, async () => {
      const run = activeRun(db);
      return { runId: run?.id ?? null, items: run ? listInterventions(db, run.id) : [] };
    });

    app.post('/api/simulation/interventions', operator, async (request, reply) => {
      const input = parse(interventionSchema, request.body);
      const result = await runner.addIntervention(input, userId(request));
      return reply.status(201).send(result);
    });

    app.delete('/api/simulation/runs/:id', admin, async (request) => {
      const { id } = parse(idParam, request.params);
      const run = getRun(db, id);
      if (!run) throw new AppError(404, 'RUN_NOT_FOUND', `Прогон не найден: ${id}`);
      if (LIVE_STATUSES.includes(run.status)) throw new AppError(409, 'RUN_ACTIVE', 'Активный прогон удалить нельзя — сначала остановите его');
      transaction(db, () => {
        deleteRunData(db, id);
        db.prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, created_at) VALUES (?, 'SIM_DELETE', 'sim_run', ?, ?)").run(
          userId(request),
          String(id),
          now().toISOString(),
        );
      });
      return { deleted: id };
    });
  };
}
