// API параллельной оценки QORGAN Sentinel (docs/SENTINEL_ARCHITECTURE.md §5).
//   GET /api/ml/model                 — состояние и описание модели, краткие метрики (гость)
//   GET /api/stations/:id/ml          — последняя оценка ML станции + объяснение (SHAP) + оценка T2 на тот же момент (гость)
//   GET /api/stations/:id/ml/history  — оценки ML по тикам прогона (оператор)
// Оценки ML считаются в транзакции приёма пакета и только читаются здесь — на запрос ничего не обучается и не считается.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/plugin';
import type { Db } from '../db/connection';
import { AppError, parse } from '../errors';
import { latestMl, mlHistory, mlInfo, type MlRuntime } from '../ml/service';
import { createEvaluator, findStation, runExists } from '../risk/service';

const paramsSchema = z.object({ id: z.string().min(1).max(32) });
const querySchema = z.object({ runId: z.coerce.number().int().positive().optional() });
const historySchema = z.object({ runId: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(2000).default(500) });

export function mlRoutes(db: Db, now: () => Date, ml: () => MlRuntime) {
  return async (app: FastifyInstance) => {
    app.get('/api/ml/model', async () => mlInfo(ml()));

    app.get('/api/stations/:id/ml', async (request) => {
      const { id } = parse(paramsSchema, request.params);
      const query = parse(querySchema, request.query);
      if (query.runId !== undefined && !request.user) throw new AppError(401, 'UNAUTHORIZED', 'Параметр runId доступен после входа');
      const station = findStation(db, id);
      if (!station) throw new AppError(404, 'STATION_NOT_FOUND', `Станция не найдена: ${id}`);
      if (query.runId !== undefined && !runExists(db, query.runId)) throw new AppError(404, 'RUN_NOT_FOUND', `Прогон не найден: ${query.runId}`);
      const evaluator = createEvaluator(db, { runId: query.runId, computedAt: now().toISOString() });
      const rules = evaluator.evaluate(station.id).assessment;
      const info = mlInfo(ml());
      const row = evaluator.runId === null ? null : latestMl(db, evaluator.runId, station.id, evaluator.asOf);
      return {
        station: { id: station.id, code: station.code, name: station.name },
        runId: evaluator.runId,
        context: evaluator.context(),
        model: { status: info.status, problem: info.problem, version: info.model?.version ?? null, horizonH: info.model?.horizonH ?? null, demo: info.model?.demo ?? true },
        rules: { risk: rules.risk, score: rules.score, maxScore: rules.maxScore, model: rules.model.id },
        assessment: row,
      };
    });

    app.get('/api/stations/:id/ml/history', { preHandler: requireRole('operator') }, async (request) => {
      const { id } = parse(paramsSchema, request.params);
      const query = parse(historySchema, request.query);
      const station = findStation(db, id);
      if (!station) throw new AppError(404, 'STATION_NOT_FOUND', `Станция не найдена: ${id}`);
      const evaluator = createEvaluator(db, { runId: query.runId, computedAt: now().toISOString() });
      if (evaluator.runId === null) return { station: { code: station.code }, runId: null, items: [] };
      if (!runExists(db, evaluator.runId)) throw new AppError(404, 'RUN_NOT_FOUND', `Прогон не найден: ${evaluator.runId}`);
      return { station: { code: station.code }, runId: evaluator.runId, items: mlHistory(db, evaluator.runId, station.id, query.limit) };
    });
  };
}
