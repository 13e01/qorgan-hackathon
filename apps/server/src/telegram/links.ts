// Привязка Telegram-чата к пользователю QORGAN (docs/SENTINEL_TELEGRAM.md §3).
// Оператор после входа получает одноразовый код (10 минут, в БД — только SHA-256) и отправляет боту «/start КОД».
// Без привязки бот не отвечает данными и не присылает предупреждений: знать имя бота недостаточно.

import { createHash, randomInt } from 'node:crypto';
import type { Db } from '../db/connection';
import { transaction } from '../db/connection';
import type { BotLang } from './messages';

export const LINK_CODE_TTL_MIN = 10;
// Без похожих символов (0/O, 1/I/L): код набирают вручную.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const sha = (code: string) => createHash('sha256').update(code.trim().toUpperCase()).digest('hex');

export function createLinkCode(db: Db, userId: number, now: Date): { code: string; expiresAt: string } {
  let code = '';
  for (let i = 0; i < 8; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MIN * 60_000).toISOString();
  transaction(db, () => {
    // Старые неиспользованные коды пользователя больше не действуют.
    db.prepare('DELETE FROM telegram_link_codes WHERE user_id = ? OR expires_at < ?').run(userId, now.toISOString());
    db.prepare('INSERT INTO telegram_link_codes (code_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha(code), userId, expiresAt, now.toISOString());
  });
  return { code, expiresAt };
}

export interface LinkedUser {
  linkId: number;
  userId: number;
  username: string;
  lang: BotLang;
  subscribed: boolean;
}

export function linkedUser(db: Db, chatId: string): LinkedUser | null {
  const r = db
    .prepare('SELECT l.id, l.user_id, l.lang, l.subscribed, u.username FROM telegram_links l JOIN users u ON u.id = l.user_id WHERE l.chat_id = ? AND u.is_active = 1')
    .get(chatId);
  return r ? { linkId: Number(r.id), userId: Number(r.user_id), username: String(r.username), lang: r.lang as BotLang, subscribed: Number(r.subscribed) === 1 } : null;
}

/** Код верный и не истёк → чат привязан (или перепривязан) к владельцу кода. Код одноразовый. */
export function consumeLinkCode(db: Db, code: string, chatId: string, tgUsername: string | null, lang: BotLang, now: Date): LinkedUser | null {
  return transaction(db, () => {
    const row = db.prepare('SELECT user_id, expires_at, used_at FROM telegram_link_codes WHERE code_hash = ?').get(sha(code));
    if (!row || row.used_at !== null || String(row.expires_at) < now.toISOString()) return null;
    const user = db.prepare('SELECT id, username, role FROM users WHERE id = ? AND is_active = 1').get(Number(row.user_id));
    if (!user) return null;
    const at = now.toISOString();
    db.prepare('UPDATE telegram_link_codes SET used_at = ? WHERE code_hash = ?').run(at, sha(code));
    db.prepare(
      `INSERT INTO telegram_links (chat_id, user_id, tg_username, lang, subscribed, linked_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET user_id = excluded.user_id, tg_username = excluded.tg_username, lang = excluded.lang, subscribed = 1, updated_at = excluded.updated_at`,
    ).run(chatId, Number(user.id), tgUsername, lang, at, at);
    db.prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, before_json, after_json, created_at) VALUES (?, 'TELEGRAM_LINK', 'telegram_link', ?, NULL, ?, ?)").run(
      Number(user.id),
      chatId.slice(-4),
      JSON.stringify({ tgUsername }),
      at,
    );
    return linkedUser(db, chatId);
  });
}

export function setSubscribed(db: Db, chatId: string, subscribed: boolean, now: Date): void {
  db.prepare('UPDATE telegram_links SET subscribed = ?, updated_at = ? WHERE chat_id = ?').run(subscribed ? 1 : 0, now.toISOString(), chatId);
}

export interface LinkView {
  id: number;
  chat: string;
  tgUsername: string | null;
  username: string;
  lang: string;
  subscribed: boolean;
  linkedAt: string;
}

export function listLinks(db: Db, userId: number | null): LinkView[] {
  return db
    .prepare(
      `SELECT l.*, u.username FROM telegram_links l JOIN users u ON u.id = l.user_id
       WHERE ? IS NULL OR l.user_id = ? ORDER BY l.id`,
    )
    .all(userId, userId)
    .map((r) => ({
      id: Number(r.id),
      chat: String(r.chat_id).length <= 4 ? String(r.chat_id) : `…${String(r.chat_id).slice(-4)}`,
      tgUsername: r.tg_username ? String(r.tg_username) : null,
      username: String(r.username),
      lang: String(r.lang),
      subscribed: Number(r.subscribed) === 1,
      linkedAt: String(r.linked_at),
    }));
}
