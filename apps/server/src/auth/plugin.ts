import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { hasAccess, type AccessLevel, type PublicUser, type Role } from '@qorgan/shared';
import type { Db } from '../db/connection';
import { AppError } from '../errors';
import { findSessionUser } from './sessions';

export const SESSION_COOKIE = 'qorgan_sid';

declare module 'fastify' {
  interface FastifyRequest {
    /** Вошедший пользователь; null — гость. */
    user: PublicUser | null;
  }
}

export async function registerAuth(app: FastifyInstance, db: Db, sessionSecret: string): Promise<void> {
  await app.register(cookie, { secret: sessionSecret });
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    const sessionId = readSessionId(request);
    request.user = sessionId ? findSessionUser(db, sessionId) : null;
  });
}

/** Значение подписанной cookie сессии; null — если её нет или подпись не сошлась. */
export function readSessionId(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

export function accessLevel(request: FastifyRequest): AccessLevel {
  return request.user?.role ?? 'guest';
}

/**
 * Проверка роли перед обработчиком маршрута (матрица доступа — docs/ARCHITECTURE.md §10).
 * Гость → 401, недостаточная роль → 403.
 */
export function requireRole(role: Role): preHandlerHookHandler {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.user) throw new AppError(401, 'UNAUTHORIZED', 'Требуется вход в систему');
    if (!hasAccess(request.user.role, role)) throw new AppError(403, 'FORBIDDEN', 'Недостаточно прав');
  };
}
