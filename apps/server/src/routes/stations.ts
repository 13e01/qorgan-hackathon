// Станции и их данные:
//   GET /api/stations                         — список станций (все)
//   GET /api/stations/:id/measurements        — история измерений (гость: текущий прогон, последние 24 виртуальных часа)
//   GET /api/stations/:id/risk/history        — сохранённые оценки риска по тикам (оператор)

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PARAMETER_CODES } from '@qorgan/shared';
import { requireRole } from '../auth/plugin';
import type { Db } from '../db/connection';
import { AppError, parse } from '../errors';
import { createEvaluator, findStation, runExists } from '../risk/service';

const idParam = z.object({ id: z.string().min(1).max(32) });

const measurementsQuery = z
  .object({
    parameter: z.enum(PARAMETER_CODES).optional(),
    runId: z.coerce.number().int().positive().optional(),
    fromTick: z.coerce.number().int().min(0).optional(),
    toTick: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(1000),
  })
  .strict();

const historyQuery = z
  .object({
    runId: z.coerce.number().int().positive().optional(),
    fromTick: z.coerce.number().int().min(0).optional(),
    toTick: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(1000),
  })
  .strict();

const GUEST_WINDOW_H = 24;

export function stationRoutes(db: Db, now: () => Date) {
  return async (app: FastifyInstance) => {
    app.get('/api/stations', async () => {
      const rows = db
        .prepare(
          `SELECT s.id, s.code, s.name, s.hazard_type, s.station_type, s.status, s.lat, s.lon, u.code AS upstream_code,
                  s.travel_hours, s.attenuation, s.response_hours, s.base_level_cm, s.last_message_at
           FROM stations s LEFT JOIN stations u ON u.id = s.upstream_station_id ORDER BY s.id`,
        )
        .all();
      const params = db.prepare('SELECT parameter_code, warning, danger FROM station_parameters WHERE station_id = ? ORDER BY parameter_code');
      return {
        items: rows.map((r) => ({
          id: Number(r.id),
          code: r.code,
          name: r.name,
          hazardType: r.hazard_type,
          stationType: r.station_type,
          status: r.status,
          lat: r.lat,
          lon: r.lon,
          upstreamCode: r.upstream_code,
          travelHours: r.travel_hours,
          attenuation: r.attenuation,
          responseHours: r.response_hours,
          baseLevelCm: r.base_level_cm,
          lastMessageAt: r.last_message_at,
          parameters: params.all(Number(r.id)).map((p) => ({ code: p.parameter_code, warning: p.warning, danger: p.danger })),
        })),
      };
    });

    app.get('/api/stations/:id/measurements', async (request) => {
      const { id } = parse(idParam, request.params);
      const q = parse(measurementsQuery, request.query);
      const station = findStation(db, id);
      if (!station) throw new AppError(404, 'STATION_NOT_FOUND', `Станция не найдена: ${id}`);
      if (!request.user && (q.runId !== undefined || q.fromTick !== undefined || q.toTick !== undefined)) {
        throw new AppError(401, 'UNAUTHORIZED', 'Полная история доступна после входа');
      }
      if (q.runId !== undefined && !runExists(db, q.runId)) throw new AppError(404, 'RUN_NOT_FOUND', `Прогон не найден: ${q.runId}`);

      const evaluator = createEvaluator(db, { runId: q.runId, computedAt: now().toISOString() });
      const context = evaluator.context();
      const ref = { id: station.id, code: station.code, name: station.name, status: station.status };
      if (evaluator.runId === null) return { station: ref, context, parameter: q.parameter ?? null, items: [] };
      const since = request.user ? '' : new Date(Date.parse(evaluator.asOf) - GUEST_WINDOW_H * 3_600_000).toISOString();
      const rows = db
        .prepare(
          `SELECT parameter_code, value, unit, measured_at, received_at, tick, source, quality FROM measurements
           WHERE run_id = ? AND station_id = ? AND (? IS NULL OR parameter_code = ?)
             AND measured_at <= ? AND measured_at > ? AND (? IS NULL OR tick >= ?) AND (? IS NULL OR tick <= ?)
           ORDER BY measured_at, parameter_code LIMIT ?`,
        )
        .all(
          evaluator.runId, station.id, q.parameter ?? null, q.parameter ?? null, evaluator.asOf, since,
          q.fromTick ?? null, q.fromTick ?? null, q.toTick ?? null, q.toTick ?? null, q.limit,
        );
      return {
        station: ref,
        context,
        parameter: q.parameter ?? null,
        items: rows.map((r) => ({
          parameter: r.parameter_code,
          value: r.value,
          unit: r.unit,
          measuredAt: r.measured_at,
          receivedAt: r.received_at,
          tick: r.tick,
          source: r.source,
          quality: r.quality,
        })),
      };
    });

    app.get('/api/stations/:id/risk/history', { preHandler: requireRole('operator') }, async (request) => {
      const { id } = parse(idParam, request.params);
      const q = parse(historyQuery, request.query);
      const station = findStation(db, id);
      if (!station) throw new AppError(404, 'STATION_NOT_FOUND', `Станция не найдена: ${id}`);
      if (q.runId !== undefined && !runExists(db, q.runId)) throw new AppError(404, 'RUN_NOT_FOUND', `Прогон не найден: ${q.runId}`);
      const evaluator = createEvaluator(db, { runId: q.runId, computedAt: now().toISOString() });
      const rows =
        evaluator.runId === null
          ? []
          : db
              .prepare(
                `SELECT tick, measured_at, risk, score, level_cm, rate_cm_h, trend, forecast_3h_cm, eta_danger_h, confidence, config_version
                 FROM risk_assessments WHERE run_id = ? AND station_id = ? AND (? IS NULL OR tick >= ?) AND (? IS NULL OR tick <= ?)
                 ORDER BY tick LIMIT ?`,
              )
              .all(evaluator.runId, station.id, q.fromTick ?? null, q.fromTick ?? null, q.toTick ?? null, q.toTick ?? null, q.limit);
      return {
        station: { id: station.id, code: station.code, name: station.name, status: station.status },
        context: evaluator.context(),
        items: rows.map((r) => ({
          tick: r.tick,
          virtualTime: r.measured_at,
          risk: r.risk,
          score: r.score,
          levelCm: r.level_cm,
          rateCmH: r.rate_cm_h,
          trend: r.trend,
          forecast3hCm: r.forecast_3h_cm,
          etaDangerH: r.eta_danger_h,
          confidence: r.confidence,
          configVersion: r.config_version,
        })),
      };
    });
  };
}
