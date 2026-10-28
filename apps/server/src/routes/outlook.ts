// «Прогноз по реке» (docs/INNOVATION.md): маршрутизация измерений верхних станций вниз по течению.
//   GET /api/outlook                — прогноз всех станций на текущее виртуальное время прогона (оператор)
//   GET /api/outlook/verification   — проверка на истории прогона: ошибка, сравнение с persistence и с ETA локального тренда
// Модель и параметры волны берутся из БД (станции, пороги — правит администратор). Только чтение, ничего не сохраняет.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { computeOutlook, verifyOutlook, type MeasurementPoint, type OutlookStation } from '@qorgan/shared';
import { requireRole } from '../auth/plugin';
import type { Db } from '../db/connection';
import { AppError, parse } from '../errors';
import { createEvaluator, runExists } from '../risk/service';

const query = z.object({ runId: z.coerce.number().int().positive().optional() }).strict();
const verifyQuery = z
  .object({ runId: z.coerce.number().int().positive().optional(), leadH: z.coerce.number().int().min(1).max(72).default(24) })
  .strict();

const H = 3_600_000;

function outlookStations(db: Db): OutlookStation[] {
  return db
    .prepare(
      `SELECT s.code, u.code AS upstream_code, s.travel_hours, s.attenuation, s.response_hours, s.base_level_cm, sp.warning, sp.danger
       FROM stations s LEFT JOIN stations u ON u.id = s.upstream_station_id
       LEFT JOIN station_parameters sp ON sp.station_id = s.id AND sp.parameter_code = 'water_level'
       WHERE s.status <> 'disabled' ORDER BY s.id`,
    )
    .all()
    .map((r) => ({
      code: String(r.code),
      upstreamCode: r.upstream_code === null ? null : String(r.upstream_code),
      travelHours: r.travel_hours === null ? null : Number(r.travel_hours),
      attenuation: Number(r.attenuation),
      responseHours: Number(r.response_hours),
      baseLevelCm: r.base_level_cm === null ? null : Number(r.base_level_cm),
      warningCm: r.warning === null || r.warning === undefined ? null : Number(r.warning),
      dangerCm: r.danger === null || r.danger === undefined ? null : Number(r.danger),
    }));
}

function levelSeries(db: Db, runId: number, asOf: string, codes: string[]): Record<string, MeasurementPoint[]> {
  const stmt = db.prepare(
    `SELECT m.measured_at, m.value FROM measurements m JOIN stations s ON s.id = m.station_id
     WHERE m.run_id = ? AND s.code = ? AND m.parameter_code = 'water_level' AND m.measured_at <= ? ORDER BY m.measured_at`,
  );
  return Object.fromEntries(codes.map((c) => [c, stmt.all(runId, c, asOf).map((r) => ({ measuredAt: String(r.measured_at), value: Number(r.value) }))]));
}

export function outlookRoutes(db: Db, now: () => Date) {
  // Проверка на истории считается синхронно (до ~0,3 с на 1000 ч). Повторные запросы для того же момента прогона
  // и тех же настроек станций берутся из кэша, чтобы нажатия не блокировали сервер (тики, WebSocket).
  let cache: { key: string; body: unknown } | null = null;
  return async (app: FastifyInstance) => {
    const operator = { preHandler: requireRole('operator') };

    app.get('/api/outlook', operator, async (request) => {
      const q = parse(query, request.query);
      if (q.runId !== undefined && !runExists(db, q.runId)) throw new AppError(404, 'RUN_NOT_FOUND', `Прогон не найден: ${q.runId}`);
      const evaluator = createEvaluator(db, { runId: q.runId, computedAt: now().toISOString() });
      const context = evaluator.context();
      const stations = outlookStations(db);
      if (evaluator.runId === null) return { context, outlook: null };
      const outlook = computeOutlook({ asOf: evaluator.asOf, stations, levels: levelSeries(db, evaluator.runId, evaluator.asOf, stations.map((s) => s.code)) });
      return { context, outlook };
    });

    app.get('/api/outlook/verification', operator, async (request) => {
      const q = parse(verifyQuery, request.query);
      if (q.runId !== undefined && !runExists(db, q.runId)) throw new AppError(404, 'RUN_NOT_FOUND', `Прогон не найден: ${q.runId}`);
      const evaluator = createEvaluator(db, { runId: q.runId, computedAt: now().toISOString() });
      const context = evaluator.context();
      if (evaluator.runId === null || !evaluator.run) return { context, leadH: q.leadH, items: [] };
      const runId = evaluator.runId;
      const stations = outlookStations(db);
      const key = JSON.stringify([runId, evaluator.asOf, q.leadH, stations]);
      if (cache?.key === key) return { ...(cache.body as object), context };
      const levels = levelSeries(db, runId, evaluator.asOf, stations.map((s) => s.code));
      const startMs = Date.parse(evaluator.run.simStart);
      const endMs = Date.parse(evaluator.asOf);
      const issueTimes: string[] = [];
      for (let t = startMs; t <= endMs; t += H) issueTimes.push(new Date(t).toISOString());
      const items = verifyOutlook({ stations, levels, issueTimes, leadH: q.leadH });

      // Эталон для сравнения заблаговременности — ETA модуля риска T2 (экстраполяция локального тренда станции):
      // за сколько часов до фактического превышения он непрерывно называл срок достижения опасного порога.
      const etaRows = db.prepare(
        `SELECT r.measured_at, r.eta_danger_h FROM risk_assessments r JOIN stations s ON s.id = r.station_id
         WHERE r.run_id = ? AND s.code = ? AND r.measured_at < ? ORDER BY r.tick DESC`,
      );
      const body = {
        leadH: q.leadH,
        items: items.map((v) => {
          let localTrendLeadH: number | null = null;
          if (v.danger.actualTime) {
            let earliest: number | null = null;
            for (const r of etaRows.all(runId, v.code, v.danger.actualTime)) {
              if (r.eta_danger_h === null) break;
              earliest = Date.parse(String(r.measured_at));
            }
            localTrendLeadH = earliest === null ? 0 : Math.round((Date.parse(v.danger.actualTime) - earliest) / H);
          }
          return { ...v, danger: { ...v.danger, localTrendLeadH } };
        }),
      };
      cache = { key, body };
      return { ...body, context };
    });
  };
}
