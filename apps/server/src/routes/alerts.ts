// Журнал предупреждений (ТЗ §5.6, ARCHITECTURE §9–§11):
//   GET  /api/alerts                — гость: активные предупреждения текущего прогона; оператор: журнал с фильтрами
//   GET  /api/alerts/:id/events     — история предупреждения (оператор)
//   POST /api/alerts/:id/view       — «Просмотрено» (NEW → VIEWED)
//   POST /api/alerts/:id/resolve    — «Обработано» с комментарием (NEW/VIEWED → RESOLVED)

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/plugin';
import { transaction, type Db } from '../db/connection';
import { AppError, parse } from '../errors';
import { SELECT, toAlert } from '../alerts/repository';
import { currentRunId, runExists } from '../risk/service';

const listQuery = z
  .object({
    runId: z.coerce.number().int().positive().optional(),
    status: z.enum(['NEW', 'VIEWED', 'RESOLVED']).optional(),
    active: z.enum(['true', 'false']).optional(),
    /** true — требуют внимания оператора: ещё не обработаны (NEW/VIEWED), независимо от того, действует ли условие. */
    unhandled: z.enum(['true']).optional(),
    station: z.string().min(1).max(32).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

const idParam = z.object({ id: z.coerce.number().int().positive() });
const resolveBody = z.object({ comment: z.string().trim().max(500).optional() }).strict();

export function alertRoutes(db: Db, now: () => Date, onChanged: () => void) {
  return async (app: FastifyInstance) => {
    const operator = { preHandler: requireRole('operator') };

    app.get('/api/alerts', async (request) => {
      const q = parse(listQuery, request.query);
      const guest = !request.user;
      if (guest && (q.runId !== undefined || q.status !== undefined || q.active === 'false' || q.unhandled !== undefined)) {
        throw new AppError(401, 'UNAUTHORIZED', 'Полный журнал предупреждений доступен после входа');
      }
      if (q.runId !== undefined && !runExists(db, q.runId)) throw new AppError(404, 'RUN_NOT_FOUND', `Прогон не найден: ${q.runId}`);
      const runId = q.runId ?? currentRunId(db);
      if (runId === null) return { runId: null, items: [] };
      // Гостю — только опубликованные (активные) предупреждения (ТЗ §4, INT-001).
      const active = guest ? 'true' : q.active;
      const rows = db
        .prepare(
          `${SELECT} WHERE a.run_id = ? AND (? IS NULL OR a.status = ?) AND (? IS NULL OR a.is_active = ?)
             AND (? IS NULL OR s.code = ? COLLATE NOCASE) AND (? IS NULL OR a.status <> 'RESOLVED')
           ORDER BY a.opened_tick DESC, a.id DESC LIMIT ?`,
        )
        .all(
          runId, q.status ?? null, q.status ?? null,
          active === undefined ? null : 1, active === undefined ? null : active === 'true' ? 1 : 0,
          q.station ?? null, q.station ?? null, q.unhandled ?? null, q.limit,
        );
      return { runId, items: rows.map(toAlert) };
    });

    app.get('/api/alerts/:id/events', operator, async (request) => {
      const { id } = parse(idParam, request.params);
      const row = db.prepare(`${SELECT} WHERE a.id = ?`).get(id);
      if (!row) throw new AppError(404, 'ALERT_NOT_FOUND', `Предупреждение не найдено: ${id}`);
      const events = db
        .prepare(
          `SELECT e.id, e.tick, e.type, e.comment, e.created_at, u.username FROM alert_events e
           LEFT JOIN users u ON u.id = e.user_id WHERE e.alert_id = ? ORDER BY e.id`,
        )
        .all(id)
        .map((e) => ({
          id: Number(e.id),
          tick: e.tick === null ? null : Number(e.tick),
          type: String(e.type),
          comment: e.comment === null ? null : String(e.comment),
          user: e.username === null ? null : String(e.username),
          createdAt: String(e.created_at),
        }));
      return { alert: toAlert(row), events };
    });

    const mark = (target: 'VIEWED' | 'RESOLVED') => async (request: { params: unknown; body: unknown; user: { id: number } | null }) => {
      const { id } = parse(idParam, request.params);
      const { comment } = target === 'RESOLVED' ? parse(resolveBody, request.body ?? {}) : { comment: undefined };
      const at = now().toISOString();
      const result = transaction(db, () => {
        const row = db.prepare('SELECT status, last_tick FROM alerts WHERE id = ?').get(id);
        if (!row) throw new AppError(404, 'ALERT_NOT_FOUND', `Предупреждение не найдено: ${id}`);
        const from = String(row.status);
        if (from === 'RESOLVED') throw new AppError(409, 'ALERT_ALREADY_RESOLVED', 'Предупреждение уже обработано');
        if (target === 'VIEWED' && from !== 'NEW') throw new AppError(409, 'ALERT_ALREADY_VIEWED', 'Предупреждение уже просмотрено');
        db.prepare('UPDATE alerts SET status = ?, updated_at = ? WHERE id = ?').run(target, at, id);
        db.prepare('INSERT INTO alert_events (alert_id, tick, type, user_id, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
          id, Number(row.last_tick), target, request.user?.id ?? null, comment || null, at,
        );
        return toAlert(db.prepare(`${SELECT} WHERE a.id = ?`).get(id)!);
      });
      onChanged();
      return { alert: result };
    };

    app.post('/api/alerts/:id/view', operator, mark('VIEWED'));
    app.post('/api/alerts/:id/resolve', operator, mark('RESOLVED'));
  };
}
