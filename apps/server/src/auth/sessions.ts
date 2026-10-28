import { randomBytes } from 'node:crypto';
import type { PublicUser, Role } from '@qorgan/shared';
import type { Db } from '../db/connection';

export function createSession(db: Db, userId: number, ttlHours: number, now = new Date()): string {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString());
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    userId,
    expiresAt,
    now.toISOString(),
  );
  return id;
}

/** Пользователь по действующей сессии; null — если сессия истекла, удалена или пользователь отключён. */
export function findSessionUser(db: Db, sessionId: string, now = new Date()): PublicUser | null {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.is_active = 1`,
    )
    .get(sessionId, now.toISOString());
  if (!row) return null;
  return { id: Number(row.id), username: String(row.username), role: row.role as Role };
}

export function deleteSession(db: Db, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}
