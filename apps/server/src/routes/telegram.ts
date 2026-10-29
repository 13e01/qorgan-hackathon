// API Telegram-уведомлений (docs/SENTINEL_TELEGRAM.md §5). Всё — после входа (оператор); админ видит все привязки.
//   GET    /api/telegram/status          — состояние бота, свои привязки, журнал отправок
//   POST   /api/telegram/link-code       — одноразовый код привязки (10 мин)
//   PATCH  /api/telegram/links/:id       — включить/выключить подписку
//   DELETE /api/telegram/links/:id       — отвязать чат
//   POST   /api/telegram/test            — проверочное сообщение в свои чаты (не чаще раза в минуту)

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/plugin';
import { transaction, type Db } from '../db/connection';
import { AppError, parse } from '../errors';
import { createLinkCode, LINK_CODE_TTL_MIN, listLinks } from '../telegram/links';
import { enqueueTestMessage, outboxLog } from '../telegram/outbox';
import type { TelegramService } from '../telegram/service';

const idSchema = z.object({ id: z.coerce.number().int().positive() });
const patchSchema = z.object({ subscribed: z.boolean() });
const logSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(30) });

export function telegramRoutes(db: Db, now: () => Date, telegram: TelegramService) {
  return async (app: FastifyInstance) => {
    const scope = (request: FastifyRequest) => (request.user!.role === 'admin' ? null : request.user!.id);
    const requireEnabled = () => {
      if (!telegram.enabled) throw new AppError(409, 'TELEGRAM_DISABLED', 'Telegram-бот не настроен (нет TELEGRAM_BOT_TOKEN)');
    };
    const ownLink = (request: FastifyRequest, id: number) => {
      const row = db.prepare('SELECT id, user_id, chat_id FROM telegram_links WHERE id = ?').get(id);
      if (!row) throw new AppError(404, 'LINK_NOT_FOUND', 'Привязка не найдена');
      if (request.user!.role !== 'admin' && Number(row.user_id) !== request.user!.id) throw new AppError(403, 'FORBIDDEN', 'Это привязка другого пользователя');
      return row;
    };
    const audit = (userId: number, action: string, chatId: string, after: unknown) =>
      db.prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, before_json, after_json, created_at) VALUES (?, ?, 'telegram_link', ?, NULL, ?, ?)").run(
        userId, action, chatId.slice(-4), JSON.stringify(after), now().toISOString(),
      );

    app.get('/api/telegram/status', { preHandler: requireRole('operator') }, async (request) => {
      const { limit } = parse(logSchema, request.query);
      return {
        enabled: telegram.enabled,
        ...telegram.info(),
        cooldownTicks: telegram.cooldownTicks,
        links: listLinks(db, scope(request)),
        outbox: outboxLog(db, scope(request), limit),
      };
    });

    app.post('/api/telegram/link-code', { preHandler: requireRole('operator') }, async (request) => {
      requireEnabled();
      const { code, expiresAt } = createLinkCode(db, request.user!.id, now());
      const bot = telegram.info().botUsername;
      return { code, expiresAt, ttlMin: LINK_CODE_TTL_MIN, botUsername: bot, deepLink: bot ? `https://t.me/${bot}?start=${code}` : null };
    });

    app.patch('/api/telegram/links/:id', { preHandler: requireRole('operator') }, async (request) => {
      const { id } = parse(idSchema, request.params);
      const { subscribed } = parse(patchSchema, request.body);
      return transaction(db, () => {
        const row = ownLink(request, id);
        db.prepare('UPDATE telegram_links SET subscribed = ?, updated_at = ? WHERE id = ?').run(subscribed ? 1 : 0, now().toISOString(), id);
        audit(request.user!.id, subscribed ? 'TELEGRAM_SUBSCRIBE' : 'TELEGRAM_UNSUBSCRIBE', String(row.chat_id), { subscribed });
        return { ok: true };
      });
    });

    app.delete('/api/telegram/links/:id', { preHandler: requireRole('operator') }, async (request) => {
      const { id } = parse(idSchema, request.params);
      return transaction(db, () => {
        const row = ownLink(request, id);
        db.prepare('DELETE FROM telegram_links WHERE id = ?').run(id);
        audit(request.user!.id, 'TELEGRAM_UNLINK', String(row.chat_id), null);
        return { ok: true };
      });
    });

    app.post('/api/telegram/test', { preHandler: requireRole('operator') }, async (request) => {
      requireEnabled();
      const queued = enqueueTestMessage(db, request.user!.id, request.user!.username, now(), telegram.allowedChatIds);
      const linked = listLinks(db, request.user!.id).length;
      if (linked === 0) throw new AppError(409, 'TELEGRAM_NOT_LINKED', 'Сначала привяжите Telegram-чат');
      telegram.kick();
      return { queued };
    });
  };
}
