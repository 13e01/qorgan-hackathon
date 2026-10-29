// Клиент Telegram Bot API (docs/SENTINEL_TELEGRAM.md). Только три метода: getMe, getUpdates, sendMessage.
// fetch передаётся снаружи — в тестах это заглушка, настоящие сообщения тесты не отправляют.
// Токен бота входит только в URL запроса; ни в ошибки, ни в журнал он не попадает.

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Классы ошибок: RATE_LIMIT — Telegram просит подождать retryAfter с (HTTP 429); TEMPORARY — сеть, 5xx, таймаут;
 * BLOCKED — пользователь заблокировал бота (403); PERMANENT — неверный запрос/чат (400, 404), токен отозван (401).
 */
export type TelegramErrorKind = 'RATE_LIMIT' | 'TEMPORARY' | 'BLOCKED' | 'PERMANENT' | 'UNAUTHORIZED';

export class TelegramError extends Error {
  constructor(
    readonly kind: TelegramErrorKind,
    /** Короткий код для журнала: HTTP_429, HTTP_400, NETWORK, TIMEOUT, … (без токена и текста запроса). */
    readonly code: string,
    readonly retryAfterS: number | null = null,
  ) {
    super(`Telegram ${kind} ${code}`);
  }
}

export interface TgUser {
  id: number;
  username?: string;
  language_code?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number; type: string }; from?: TgUser; text?: string };
}

export interface TelegramClient {
  getMe(): Promise<{ username: string }>;
  getUpdates(offset: number, timeoutS: number): Promise<TgUpdate[]>;
  sendMessage(chatId: string, text: string): Promise<void>;
}

export const TELEGRAM_API = 'https://api.telegram.org';

export function createTelegramClient(token: string, fetchFn: FetchFn = fetch as unknown as FetchFn, apiBase = TELEGRAM_API): TelegramClient {
  const call = async <T>(method: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> => {
    let res: { status: number; json(): Promise<unknown> };
    try {
      res = await fetchFn(`${apiBase}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      throw new TelegramError('TEMPORARY', name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
    }
    let data: { ok?: boolean; result?: T; parameters?: { retry_after?: number } } = {};
    try {
      data = (await res.json()) as typeof data;
    } catch {
      // тело не JSON — решаем по коду ответа
    }
    if (res.status === 200 && data.ok) return data.result as T;
    const code = `HTTP_${res.status}`;
    if (res.status === 429) throw new TelegramError('RATE_LIMIT', code, Math.max(1, Number(data.parameters?.retry_after ?? 5)));
    if (res.status === 401) throw new TelegramError('UNAUTHORIZED', code);
    if (res.status === 403) throw new TelegramError('BLOCKED', code);
    if (res.status >= 500 || res.status === 0) throw new TelegramError('TEMPORARY', code);
    throw new TelegramError('PERMANENT', code);
  };
  return {
    getMe: () => call<{ username: string }>('getMe', {}, 10_000),
    getUpdates: (offset, timeoutS) => call<TgUpdate[]>('getUpdates', { offset, timeout: timeoutS, allowed_updates: ['message'] }, (timeoutS + 10) * 1000),
    sendMessage: async (chatId, text) => {
      // Обычный текст без parse_mode: значения из БД не нужно экранировать, разметка не сломается.
      await call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }, 15_000);
    },
  };
}
