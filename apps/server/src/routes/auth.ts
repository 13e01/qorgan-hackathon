import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PublicUser, Role } from '@qorgan/shared';
import { readSessionId, SESSION_COOKIE } from '../auth/plugin';
import { hashPassword, verifyPassword } from '../auth/password';
import { createSession, deleteSession } from '../auth/sessions';
import type { Db } from '../db/connection';
import { AppError, parse } from '../errors';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

// Сравнение с фиктивным хешем, когда пользователя нет, — чтобы по времени ответа нельзя было угадать логин.
const DUMMY_HASH = hashPassword('qorgan-dummy-password');

// Ограничение перебора паролей: не больше MAX_FAILURES неудачных попыток с одного IP за окно (в памяти процесса).
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60_000;

export function authRoutes(db: Db, sessionTtlHours: number, options: { secureCookies?: boolean; now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const failures = new Map<string, number[]>();
  const recentFailures = (ip: string) => {
    const since = now().getTime() - FAILURE_WINDOW_MS;
    // Не даём таблице расти без предела (много разных IP): изредка вычищаем все устаревшие записи.
    if (failures.size > 1000) {
      for (const [key, list] of failures) if (list.every((t) => t <= since)) failures.delete(key);
    }
    const list = (failures.get(ip) ?? []).filter((t) => t > since);
    if (list.length) failures.set(ip, list);
    else failures.delete(ip);
    return list;
  };
  return async (app: FastifyInstance) => {
    app.post('/api/auth/login', async (request, reply) => {
      if (recentFailures(request.ip).length >= MAX_FAILURES) {
        throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Слишком много неудачных попыток входа — подождите 10 минут');
      }
      const { username, password } = parse(loginSchema, request.body);
      const row = db
        .prepare('SELECT id, username, role, password_hash, is_active FROM users WHERE username = ?')
        .get(username);
      const passwordOk = verifyPassword(password, row ? String(row.password_hash) : DUMMY_HASH);
      if (!row || !passwordOk || Number(row.is_active) !== 1) {
        failures.set(request.ip, [...recentFailures(request.ip), now().getTime()]);
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Неверный логин или пароль');
      }

      const user: PublicUser = { id: Number(row.id), username: String(row.username), role: row.role as Role };
      const sessionId = createSession(db, user.id, sessionTtlHours);
      reply.setCookie(SESSION_COOKIE, sessionId, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: options.secureCookies ?? false,
        signed: true,
        maxAge: sessionTtlHours * 3600,
      });
      return { user };
    });

    app.post('/api/auth/logout', async (request, reply) => {
      const sessionId = readSessionId(request);
      if (sessionId) deleteSession(db, sessionId);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    app.get('/api/auth/me', async (request) => ({ user: request.user }));
  };
}
