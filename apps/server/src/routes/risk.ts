// API оценки риска станции (docs/ARCHITECTURE.md §11).
//   GET /api/stations/:id/risk              — текущий риск (гость)
//   GET /api/stations/:id/risk/explanation  — факторы, вклад, причины, качество данных (гость)
//   GET /api/stations/:id/forecast          — прогноз на 3 ч и время до порога с диапазонами (оператор)
// :id — числовой id или код станции (QRG-01). Параметры runId и at (оценка на прошлый момент) — только после входа.
// Каждый ответ содержит context: режим данных (LIVE / PAUSED / HISTORICAL / NO_DATA), виртуальное и реальное время.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { describeSituation } from '@qorgan/shared';
import { requireRole } from '../auth/plugin';
import type { Db } from '../db/connection';
import { AppError, parse } from '../errors';
import { createEvaluator, findStation, runExists, type EvaluationContext, type StationEvaluation } from '../risk/service';

const paramsSchema = z.object({ id: z.string().min(1).max(32) });
const querySchema = z.object({
  runId: z.coerce.number().int().positive().optional(),
  at: z.iso.datetime({ offset: true }).optional(),
});

export function riskRoutes(db: Db, now: () => Date) {
  return async (app: FastifyInstance) => {
    const evaluate = (request: FastifyRequest): StationEvaluation & { context: EvaluationContext } => {
      const { id } = parse(paramsSchema, request.params);
      const query = parse(querySchema, request.query);
      if ((query.runId !== undefined || query.at !== undefined) && !request.user) {
        throw new AppError(401, 'UNAUTHORIZED', 'Параметры runId и at доступны после входа');
      }
      const station = findStation(db, id);
      if (!station) throw new AppError(404, 'STATION_NOT_FOUND', `Станция не найдена: ${id}`);
      if (query.runId !== undefined && !runExists(db, query.runId)) {
        throw new AppError(404, 'RUN_NOT_FOUND', `Прогон не найден: ${query.runId}`);
      }
      const evaluator = createEvaluator(db, { runId: query.runId, at: query.at, computedAt: now().toISOString() });
      return { ...evaluator.evaluate(station.id), context: evaluator.context() };
    };

    app.get('/api/stations/:id/risk', async (request) => {
      const { station, runId, assessment: a, context } = evaluate(request);
      return {
        station,
        runId,
        context,
        model: a.model,
        asOf: a.asOf,
        computedAt: a.computedAt,
        risk: a.risk,
        score: a.score,
        maxScore: a.maxScore,
        level: a.level,
        trend: { direction: a.trend.direction, rateCmH: a.trend.rateCmH },
        dataQuality: { status: a.dataQuality.status, confidence: a.dataQuality.confidence },
        topReasons: a.reasons.slice(0, 3),
        situation: describeSituation(a),
      };
    });

    app.get('/api/stations/:id/risk/explanation', async (request) => {
      const { station, runId, assessment: a, context } = evaluate(request);
      return {
        station,
        runId,
        context,
        model: a.model,
        asOf: a.asOf,
        computedAt: a.computedAt,
        risk: a.risk,
        score: a.score,
        maxScore: a.maxScore,
        level: a.level,
        trend: a.trend,
        factors: a.factors,
        reasons: a.reasons,
        dataQuality: a.dataQuality,
        situation: describeSituation(a),
      };
    });

    app.get('/api/stations/:id/forecast', { preHandler: requireRole('operator') }, async (request) => {
      const { station, runId, assessment: a, context } = evaluate(request);
      return {
        station,
        runId,
        context,
        model: a.model,
        asOf: a.asOf,
        computedAt: a.computedAt,
        level: a.level,
        trend: a.trend,
        forecast: a.forecast,
        eta: a.eta,
        dataQuality: a.dataQuality,
      };
    });
  };
}
