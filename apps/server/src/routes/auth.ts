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

export function authRoutes(db: Db, sessionTtlHours: number) {
  return async (app: FastifyInstance) => {
    app.post('/api/auth/login', async (request, reply) => {
      const { username, password } = parse(loginSchema, request.body);
      const row = db
        .prepare('SELECT id, username, role, password_hash, is_active FROM users WHERE username = ?')
        .get(username);
      const passwordOk = verifyPassword(password, row ? String(row.password_hash) : DUMMY_HASH);
      if (!row || !passwordOk || Number(row.is_active) !== 1) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Неверный логин или пароль');
      }

      const user: PublicUser = { id: Number(row.id), username: String(row.username), role: row.role as Role };
      const sessionId = createSession(db, user.id, sessionTtlHours);
      reply.setCookie(SESSION_COOKIE, sessionId, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
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
