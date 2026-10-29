// Telegram-бот QORGAN (docs/SENTINEL_TELEGRAM.md): опрос getUpdates (long polling, без входящих соединений) и
// отправка очереди уведомлений. Без TELEGRAM_BOT_TOKEN сервис выключен — QORGAN работает как обычно.
//
// Отправка (dispatchOnce): по порядку из telegram_outbox; не чаще одного сообщения в чат за minChatIntervalMs и не
// больше maxPerDispatch за проход (проход раз в dispatchIntervalMs ⇒ ≤ 20 сообщений/с); 429 → пауза на retry_after
// для всей очереди (лимит Telegram общий); сеть/5xx → повтор через 2, 4, 8 … 60 с, не больше maxAttempts;
// 400/404 → FAILED; 403 (бот заблокирован) → FAILED и подписка чата выключается; старше expireAfterMin → EXPIRED
// (устаревшее предупреждение не отправляется после долгого обрыва связи). Тесты: ManualScheduler + заглушка fetch.

import type { Db } from '../db/connection';
import type { Scheduler } from '../simulation/runner';
import { createTelegramClient, TelegramError, type FetchFn, type TelegramClient, type TgUpdate } from './client';
import { consumeLinkCode, linkedUser, setSubscribed } from './links';
import { botLang, bt, fmtMeters, fmtTime, renderPayload, riskWord, type BotLang } from './messages';
import { dueItems, markDeferred, markFailed, markRetry, markSent } from './outbox';

export interface TelegramOptions {
  token: string;
  publicUrl: string | null;
  allowedChatIds: ReadonlySet<string> | null;
  fetch?: FetchFn;
  apiBase?: string;
  pollTimeoutS?: number;
  dispatchIntervalMs?: number;
  minChatIntervalMs?: number;
  maxPerDispatch?: number;
  maxAttempts?: number;
  expireAfterMin?: number;
  cooldownTicks?: number;
}

export type TelegramState = 'DISABLED' | 'STARTING' | 'ONLINE' | 'ERROR';

/** Данные для команд /status, /stations, /alerts — те же, что видит гость на карте. */
export interface BotStatusData {
  mode: string;
  virtualTime: string | null;
  ml: { status: string; version: string | null };
  stations: Array<{ code: string; name: string; levelCm: number | null; risk: string; mlCategory: string | null }>;
  alerts: Array<{ stationName: string; severity: string; openedAt: string }>;
}

export interface TelegramDeps {
  db: Db;
  scheduler: Scheduler;
  now: () => Date;
  statusData: () => BotStatusData;
  log: (message: string, details?: unknown) => void;
}

export class TelegramService {
  private readonly client: TelegramClient | null;
  private stateValue: TelegramState;
  private lastError: string | null = null;
  private botUsername: string | null = null;
  private pollTimer: unknown = null;
  private dispatchTimer: unknown = null;
  private closed = false;
  private dispatching = false;
  private pausedUntil = 0;
  private pollBackoffMs = 5_000;
  private readonly lastSentAt = new Map<string, number>();
  private readonly o: Required<Omit<TelegramOptions, 'fetch' | 'apiBase' | 'token' | 'publicUrl' | 'allowedChatIds'>>;

  constructor(
    private readonly deps: TelegramDeps,
    private readonly options: TelegramOptions | null,
  ) {
    this.client = options ? createTelegramClient(options.token, options.fetch, options.apiBase) : null;
    this.stateValue = options ? 'STARTING' : 'DISABLED';
    this.o = {
      pollTimeoutS: options?.pollTimeoutS ?? 25,
      dispatchIntervalMs: options?.dispatchIntervalMs ?? 1_000,
      minChatIntervalMs: options?.minChatIntervalMs ?? 1_100,
      maxPerDispatch: options?.maxPerDispatch ?? 20,
      maxAttempts: options?.maxAttempts ?? 6,
      expireAfterMin: options?.expireAfterMin ?? 30,
      cooldownTicks: options?.cooldownTicks ?? 6,
    };
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  get allowedChatIds(): ReadonlySet<string> | null {
    return this.options?.allowedChatIds ?? null;
  }

  get cooldownTicks(): number {
    return this.o.cooldownTicks;
  }

  info() {
    return { state: this.stateValue, lastError: this.lastError, botUsername: this.botUsername, allowlist: this.options?.allowedChatIds !== null && this.options !== null };
  }

  /** Запуск циклов опроса и отправки. Ошибки сети не мешают серверу: сервис ждёт и пробует снова. */
  start(): void {
    if (!this.client || this.closed) return;
    void this.connect();
    this.scheduleDispatch(this.o.dispatchIntervalMs);
  }

  close(): void {
    this.closed = true;
    if (this.pollTimer) this.deps.scheduler.clearTimeout(this.pollTimer);
    if (this.dispatchTimer) this.deps.scheduler.clearTimeout(this.dispatchTimer);
    this.pollTimer = this.dispatchTimer = null;
  }

  /** Новое событие в очереди — отправить скоро, не дожидаясь следующего прохода. */
  kick(): void {
    if (!this.client || this.closed) return;
    this.scheduleDispatch(0);
  }

  private async connect(): Promise<void> {
    try {
      const me = await this.client!.getMe();
      this.botUsername = me.username;
      this.setState('ONLINE', null);
      this.schedulePoll(0);
    } catch (err) {
      this.fail(err);
      this.pollTimer = this.deps.scheduler.setTimeout(() => void this.connect(), this.nextBackoff());
    }
  }

  private schedulePoll(ms: number): void {
    if (this.closed) return;
    this.pollTimer = this.deps.scheduler.setTimeout(() => void this.pollOnce().then((ok) => this.schedulePoll(ok ? 0 : this.nextBackoff())), ms);
  }

  private scheduleDispatch(ms: number): void {
    if (this.closed) return;
    if (this.dispatchTimer) this.deps.scheduler.clearTimeout(this.dispatchTimer);
    this.dispatchTimer = this.deps.scheduler.setTimeout(() => {
      this.dispatchTimer = null;
      void this.dispatchOnce().finally(() => this.scheduleDispatch(this.o.dispatchIntervalMs));
    }, ms);
  }

  private nextBackoff(): number {
    const ms = this.pollBackoffMs;
    this.pollBackoffMs = Math.min(60_000, this.pollBackoffMs * 2);
    return ms;
  }

  private setState(state: TelegramState, error: string | null): void {
    this.stateValue = state;
    this.lastError = error;
    if (state === 'ONLINE') this.pollBackoffMs = 5_000;
  }

  private fail(err: unknown): void {
    const code = err instanceof TelegramError ? err.code : 'UNEXPECTED';
    this.setState('ERROR', code);
    // Только код ошибки: токен и тексты сообщений в журнал не попадают.
    this.deps.log('Telegram: ошибка связи', { code });
  }

  /** Один запрос getUpdates и обработка команд. Возвращает false при ошибке (тогда следующий опрос — с паузой). */
  async pollOnce(): Promise<boolean> {
    if (!this.client) return false;
    const db = this.deps.db;
    const offset = Number(db.prepare('SELECT update_offset FROM telegram_state WHERE id = 1').get()?.update_offset ?? 0);
    let updates: TgUpdate[];
    try {
      updates = await this.client.getUpdates(offset, this.o.pollTimeoutS);
    } catch (err) {
      this.fail(err);
      return false;
    }
    this.setState('ONLINE', null);
    for (const u of updates) {
      // Смещение сохраняется до обработки: команда, вызвавшая ошибку, не будет обрабатываться бесконечно.
      db.prepare('UPDATE telegram_state SET update_offset = ? WHERE id = 1').run(u.update_id + 1);
      try {
        await this.handleUpdate(u);
      } catch (err) {
        this.deps.log('Telegram: ошибка обработки команды', { code: err instanceof TelegramError ? err.code : 'UNEXPECTED' });
      }
    }
    return true;
  }

  async handleUpdate(u: TgUpdate): Promise<void> {
    const msg = u.message;
    if (!msg?.text || msg.chat.type !== 'private') return;
    const chatId = String(msg.chat.id);
    const [rawCommand = '', ...rest] = msg.text.trim().split(/\s+/);
    const command = rawCommand.split('@')[0]!.toLowerCase();
    const arg = rest.join(' ');
    const now = this.deps.now();
    const linked = linkedUser(this.deps.db, chatId);
    const lang: BotLang = linked?.lang ?? botLang(msg.from?.language_code);
    const reply = (text: string) => this.client!.sendMessage(chatId, text);
    const allowed = this.allowedChatIds;

    if (command === '/start') {
      if (allowed && !allowed.has(chatId)) return reply(bt(lang, 'notAllowed'));
      if (arg) {
        const user = consumeLinkCode(this.deps.db, arg, chatId, msg.from?.username ?? null, botLang(msg.from?.language_code), now);
        return reply(user ? bt(user.lang, 'linked', { user: user.username }) : bt(lang, 'badCode'));
      }
      return reply(linked ? bt(lang, 'alreadyLinked', { user: linked.username }) : bt(lang, 'startNeedCode'));
    }
    if (command === '/help') return reply(bt(lang, 'help'));
    if (!linked || (allowed && !allowed.has(chatId))) return reply(bt(lang, 'notLinked'));

    switch (command) {
      case '/subscribe':
        setSubscribed(this.deps.db, chatId, true, now);
        return reply(bt(lang, 'subscribed'));
      case '/unsubscribe':
        setSubscribed(this.deps.db, chatId, false, now);
        return reply(bt(lang, 'unsubscribed'));
      case '/status': {
        const s = this.deps.statusData();
        const high = s.alerts.filter((a) => a.severity === 'HIGH').length;
        return reply(
          [
            bt(lang, 'statusTitle'),
            `${bt(lang, 'mode')}: ${bt(lang, `mode_${s.mode}` as 'mode_LIVE')}`,
            `${bt(lang, 'virtual')}: ${fmtTime(s.virtualTime, lang)}`,
            bt(lang, 'activeAlerts', { n: s.alerts.length, h: high }),
            bt(lang, 'mlStatus', { s: bt(lang, `ml_${s.ml.status}` as 'ml_READY', { v: s.ml.version ?? '' }) }),
            bt(lang, 'demo'),
          ].join('\n'),
        );
      }
      case '/stations': {
        const s = this.deps.statusData();
        const lines = s.stations.map((st) => {
          const level = st.levelCm === null ? bt(lang, 'noData') : `${fmtMeters(st.levelCm, lang)} ${bt(lang, 'm')}`;
          const ml = st.mlCategory ? ` · ML: ${riskWord(st.mlCategory, lang)}` : '';
          return `${st.name} (${st.code}): ${level} · ${bt(lang, 'risk')}: ${riskWord(st.risk, lang)}${ml}`;
        });
        return reply([bt(lang, 'stationsTitle'), ...lines, bt(lang, 'demo')].join('\n'));
      }
      case '/alerts': {
        const s = this.deps.statusData();
        const lines = s.alerts.map((a) => bt(lang, 'alertLine', { risk: riskWord(a.severity, lang), station: a.stationName, time: fmtTime(a.openedAt, lang) }));
        return reply([bt(lang, 'alertsTitle'), ...(lines.length ? lines : [bt(lang, 'noAlerts')]), bt(lang, 'demo')].join('\n'));
      }
      default:
        return reply(bt(lang, 'unknown'));
    }
  }

  /** Один проход отправки очереди. Возвращает число отправленных сообщений. */
  async dispatchOnce(): Promise<number> {
    if (!this.client || this.dispatching) return 0;
    const nowMs = this.deps.now().getTime();
    if (nowMs < this.pausedUntil) return 0;
    this.dispatching = true;
    let sent = 0;
    try {
      const db = this.deps.db;
      const iso = (ms: number) => new Date(ms).toISOString();
      for (const item of dueItems(db, iso(nowMs), this.o.maxPerDispatch)) {
        if (nowMs - Date.parse(item.createdAt) > this.o.expireAfterMin * 60_000) {
          markFailed(db, item.id, 'EXPIRED');
          continue;
        }
        const last = this.lastSentAt.get(item.chatId);
        if (last !== undefined && nowMs - last < this.o.minChatIntervalMs) {
          markDeferred(db, item.id, iso(last + this.o.minChatIntervalMs), 'CHAT_RATE');
          continue;
        }
        const link = linkedUser(db, item.chatId);
        if (!link || (this.allowedChatIds && !this.allowedChatIds.has(item.chatId))) {
          markFailed(db, item.id, 'NOT_LINKED');
          continue;
        }
        if (item.payload.kind === 'ALERT' && !link.subscribed) {
          markFailed(db, item.id, 'UNSUBSCRIBED');
          continue;
        }
        try {
          await this.client.sendMessage(item.chatId, renderPayload(item.payload, link.lang, this.options!.publicUrl));
          this.lastSentAt.set(item.chatId, nowMs);
          markSent(db, item.id, iso(this.deps.now().getTime()));
          sent += 1;
        } catch (err) {
          const e = err instanceof TelegramError ? err : new TelegramError('TEMPORARY', 'UNEXPECTED');
          if (e.kind === 'RATE_LIMIT') {
            this.pausedUntil = nowMs + (e.retryAfterS ?? 5) * 1000;
            markDeferred(db, item.id, iso(this.pausedUntil), e.code);
            break;
          }
          if (e.kind === 'BLOCKED') {
            setSubscribed(db, item.chatId, false, this.deps.now());
            markFailed(db, item.id, e.code);
          } else if (e.kind === 'TEMPORARY' && item.attempts + 1 < this.o.maxAttempts) {
            markRetry(db, item.id, iso(nowMs + Math.min(60_000, 2_000 * 2 ** item.attempts)), e.code);
          } else {
            markFailed(db, item.id, e.code);
          }
          // Сеть или Telegram недоступны (или отозван токен) — остальные сообщения этого прохода не пробуем.
          if (e.kind === 'UNAUTHORIZED' || e.kind === 'TEMPORARY') {
            this.fail(e);
            break;
          }
        }
      }
    } finally {
      this.dispatching = false;
    }
    return sent;
  }
}
