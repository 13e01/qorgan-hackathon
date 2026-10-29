// Очередь Telegram-уведомлений (transactional outbox, docs/SENTINEL_TELEGRAM.md §4).
//
// Запись в очередь — в той же транзакции приёма пакета, что и событие предупреждения: уведомление не теряется
// и не появляется без события. Отправка — позже, отдельным циклом (TelegramService), с повторами и паузами.
//
// Когда уведомляем: предупреждение открыто сразу с HIGH или обострилось MEDIUM → HIGH. Новое измерение при том же
// риске сообщения не создаёт. Защита от спама:
//   • dedup_key = alert:<id>:HIGH:<chat> — одно сообщение о высоком риске на предупреждение и чат (UNIQUE);
//   • «остывание» станции: если в этом прогоне по станции уже было сообщение о HIGH не раньше чем cooldownTicks
//     часов модели назад (предупреждение «мигнуло»: снято и открыто снова), новое записывается как SUPPRESSED.

import type { Db } from '../db/connection';
import type { AlertChange } from '../alerts/engine';
import type { StationEvaluation } from '../risk/service';
import type { AlertPayload, OutboxPayload } from './messages';

export interface OutboxOptions {
  /** null — все привязанные чаты; иначе только эти (TELEGRAM_ALLOWED_CHAT_IDS). */
  allowedChatIds: ReadonlySet<string> | null;
  cooldownTicks: number;
}

export const DEFAULT_COOLDOWN_TICKS = 6;

/** Чаты, которым можно отправлять: подписка включена, пользователь активен, чат разрешён. */
export function recipientChats(db: Db, allowed: ReadonlySet<string> | null): string[] {
  return db
    .prepare('SELECT l.chat_id FROM telegram_links l JOIN users u ON u.id = l.user_id WHERE l.subscribed = 1 AND u.is_active = 1 ORDER BY l.id')
    .all()
    .map((r) => String(r.chat_id))
    .filter((c) => !allowed || allowed.has(c));
}

/** Вызывается в транзакции ingest после processAlerts. Возвращает число новых записей PENDING. */
export function enqueueAlertNotifications(
  db: Db,
  runId: number,
  tick: number,
  changes: AlertChange[],
  evaluations: StationEvaluation[],
  now: string,
  options: OutboxOptions,
): number {
  const relevant = changes.filter((c) => c.severity === 'HIGH' && (c.type === 'OPENED' || c.type === 'ESCALATED'));
  if (relevant.length === 0) return 0;
  const chats = recipientChats(db, options.allowedChatIds);
  if (chats.length === 0) return 0;
  const run = db.prepare('SELECT scenario_id FROM sim_runs WHERE id = ?').get(runId);
  const dataSource = run?.scenario_id === 'EXTERNAL_SENSORS' ? 'EXTERNAL_SENSOR' : 'INTERNAL_SIMULATION';
  const ml = db.prepare('SELECT category, p_danger, model_version FROM ml_assessments WHERE run_id = ? AND station_id = ? AND tick = ? AND status = ?');
  const recent = db.prepare(
    "SELECT 1 FROM telegram_outbox WHERE chat_id = ? AND run_id = ? AND station_id = ? AND tick >= ? AND status <> 'SUPPRESSED' LIMIT 1",
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO telegram_outbox (chat_id, alert_id, run_id, station_id, tick, dedup_key, payload_json, status, attempts, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  );
  let queued = 0;
  for (const c of relevant) {
    const e = evaluations.find((x) => x.station.code === c.stationCode);
    if (!e) continue;
    const a = e.assessment;
    const alert = db.prepare('SELECT trigger FROM alerts WHERE id = ?').get(c.alertId);
    const m = ml.get(runId, e.station.id, tick, 'OK');
    const payload: AlertPayload = {
      kind: 'ALERT',
      event: c.type === 'ESCALATED' ? 'ESCALATED' : 'OPENED',
      alertId: c.alertId,
      runId,
      tick,
      stationCode: e.station.code,
      stationName: e.station.name,
      severity: 'HIGH',
      levelCm: a.level.currentCm,
      warningCm: a.level.warningCm,
      dangerCm: a.level.dangerCm,
      measuredAt: a.level.measuredAt,
      trigger: (alert?.trigger ?? 'FORECAST') as AlertPayload['trigger'],
      reasons: a.reasons.slice(0, 3),
      ml: m ? { category: (m.category ?? null) as string | null, pDanger: m.p_danger === null ? null : Number(m.p_danger), modelVersion: String(m.model_version) } : null,
      dataSource,
    };
    for (const chat of chats) {
      const suppressed = recent.get(chat, runId, e.station.id, tick - options.cooldownTicks) !== undefined;
      const { changes: n } = insert.run(chat, c.alertId, runId, e.station.id, tick, `alert:${c.alertId}:HIGH:${chat}`, JSON.stringify(payload), suppressed ? 'SUPPRESSED' : 'PENDING', now, now);
      if (Number(n) > 0 && !suppressed) queued += 1;
    }
  }
  return queued;
}

/** Проверочное сообщение в чаты пользователя (кнопка в интерфейсе). Не чаще раза в минуту на чат. */
export function enqueueTestMessage(db: Db, userId: number, username: string, now: Date, allowed: ReadonlySet<string> | null): number {
  const chats = db
    .prepare('SELECT chat_id FROM telegram_links WHERE user_id = ?')
    .all(userId)
    .map((r) => String(r.chat_id))
    .filter((c) => !allowed || allowed.has(c));
  const minute = now.toISOString().slice(0, 16);
  const payload: OutboxPayload = { kind: 'TEST', username };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO telegram_outbox (chat_id, dedup_key, payload_json, status, attempts, next_attempt_at, created_at)
     VALUES (?, ?, ?, 'PENDING', 0, ?, ?)`,
  );
  let n = 0;
  for (const chat of chats) n += Number(insert.run(chat, `test:${chat}:${minute}`, JSON.stringify(payload), now.toISOString(), now.toISOString()).changes);
  return n;
}

export interface OutboxItem {
  id: number;
  chatId: string;
  payload: OutboxPayload;
  attempts: number;
  createdAt: string;
}

export function dueItems(db: Db, now: string, limit = 20): OutboxItem[] {
  return db
    .prepare("SELECT id, chat_id, payload_json, attempts, created_at FROM telegram_outbox WHERE status = 'PENDING' AND next_attempt_at <= ? ORDER BY id LIMIT ?")
    .all(now, limit)
    .map((r) => ({ id: Number(r.id), chatId: String(r.chat_id), payload: JSON.parse(String(r.payload_json)) as OutboxPayload, attempts: Number(r.attempts), createdAt: String(r.created_at) }));
}

export function markSent(db: Db, id: number, now: string): void {
  db.prepare("UPDATE telegram_outbox SET status = 'SENT', attempts = attempts + 1, sent_at = ?, last_error = NULL WHERE id = ?").run(now, id);
}

export function markRetry(db: Db, id: number, nextAt: string, error: string): void {
  db.prepare('UPDATE telegram_outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE id = ?').run(nextAt, error, id);
}

/** Повтор без увеличения числа попыток: Telegram сам попросил подождать (429). */
export function markDeferred(db: Db, id: number, nextAt: string, error: string): void {
  db.prepare('UPDATE telegram_outbox SET next_attempt_at = ?, last_error = ? WHERE id = ?').run(nextAt, error, id);
}

export function markFailed(db: Db, id: number, error: string): void {
  db.prepare("UPDATE telegram_outbox SET status = 'FAILED', attempts = attempts + 1, last_error = ? WHERE id = ?").run(error, id);
}

export interface OutboxRow {
  id: number;
  chatId: string;
  kind: string;
  alertId: number | null;
  stationCode: string | null;
  tick: number | null;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

/** Журнал отправок для интерфейса; userId — только чаты этого пользователя (оператор), null — все (админ). */
export function outboxLog(db: Db, userId: number | null, limit: number): OutboxRow[] {
  const rows = db
    .prepare(
      `SELECT o.*, s.code AS station_code FROM telegram_outbox o LEFT JOIN stations s ON s.id = o.station_id
       WHERE ? IS NULL OR o.chat_id IN (SELECT chat_id FROM telegram_links WHERE user_id = ?)
       ORDER BY o.id DESC LIMIT ?`,
    )
    .all(userId, userId, limit);
  return rows.map((r) => ({
    id: Number(r.id),
    chatId: maskChat(String(r.chat_id)),
    kind: (JSON.parse(String(r.payload_json)) as OutboxPayload).kind,
    alertId: r.alert_id === null ? null : Number(r.alert_id),
    stationCode: r.station_code ? String(r.station_code) : null,
    tick: r.tick === null ? null : Number(r.tick),
    status: String(r.status),
    attempts: Number(r.attempts),
    lastError: r.last_error ? String(r.last_error) : null,
    createdAt: String(r.created_at),
    sentAt: r.sent_at ? String(r.sent_at) : null,
  }));
}

/** Идентификатор чата в интерфейсе — только последние цифры. */
export function maskChat(chatId: string): string {
  return chatId.length <= 4 ? chatId : `…${chatId.slice(-4)}`;
}
