// QORGAN Sentinel: Telegram-уведомления. Настоящий Telegram не вызывается — fetch заменён заглушкой.
// Циклы бота в тестах — на ручном планировщике: отправку вызывает только сам тест (dispatchOnce / pollOnce).
// Полный путь: симулятор → POST /api/telemetry → риск → предупреждение HIGH → telegram_outbox → sendMessage.

import { describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../src/telegram/client';
import type { TelegramOptions } from '../src/telegram/service';
import { renderAlert, type AlertPayload } from '../src/telegram/messages';
import { ManualScheduler, simApp, TestClock } from './sim-helpers';

vi.setConfig({ testTimeout: 60_000 });

const START = '2026-04-10T00:00:00.000Z';
const TOKEN = '123456:TEST-TOKEN-never-sent-anywhere';

interface Call {
  method: string;
  body: Record<string, any>;
}

/** Заглушка Bot API: getMe, очередь getUpdates, sendMessage с заданными ответами по очереди. */
class FakeTelegram {
  calls: Call[] = [];
  updates: any[] = [];
  sendReplies: Array<{ status: number; body: unknown }> = [];
  nextUpdateId = 1;
  fetch: FetchFn = async (url, init) => {
    const method = url.split('/').pop()!;
    const body = JSON.parse(init.body);
    this.calls.push({ method, body });
    const ok = (result: unknown) => ({ status: 200, json: async () => ({ ok: true, result }) });
    if (method === 'getMe') return ok({ username: 'qorgan_demo_bot' });
    if (method === 'getUpdates') {
      const list = this.updates;
      this.updates = [];
      return ok(list);
    }
    const r = this.sendReplies.shift();
    if (r) return { status: r.status, json: async () => r.body };
    return ok({ message_id: 1 });
  };
  sent(): Call[] {
    return this.calls.filter((c) => c.method === 'sendMessage');
  }
  say(chatId: number, text: string, lang = 'ru'): void {
    this.updates.push({ update_id: this.nextUpdateId++, message: { message_id: 1, chat: { id: chatId, type: 'private' }, from: { id: chatId, username: `u${chatId}`, language_code: lang }, text } });
  }
}

async function setup(extra: Partial<TelegramOptions> = {}) {
  const tg = new FakeTelegram();
  const clock = new TestClock();
  const s = await simApp(undefined, clock, { telegram: { token: TOKEN, publicUrl: 'http://localhost:3000', allowedChatIds: null, fetch: tg.fetch, ...extra }, telegramScheduler: new ManualScheduler() });
  // getMe выполняется при старте; дождаться его.
  await new Promise((r) => setImmediate(r));
  const service = s.app.telegram;
  /** Привязать чат: код из API + «/start КОД» в бот. */
  const link = async (chatId: number, cookie = s.operator) => {
    const res = await s.post('/api/telegram/link-code', {}, cookie);
    expect(res.status).toBe(200);
    tg.say(chatId, `/start ${res.body.code}`);
    await service.pollOnce();
    return res.body.code as string;
  };
  return { s, tg, clock, service, link };
}

describe('Telegram: без токена', () => {
  it('QORGAN работает, бот выключен, API отвечает понятным кодом', async () => {
    const s = await simApp();
    expect(s.app.telegram.enabled).toBe(false);
    const st = await s.get('/api/telegram/status');
    expect(st.body).toMatchObject({ enabled: false, state: 'DISABLED' });
    expect((await s.post('/api/telegram/link-code', {})).body.error.code).toBe('TELEGRAM_DISABLED');
    const { body } = await s.post('/api/simulation/start', { scenarioId: 'RAPID_FLOOD', seed: 42, virtualStart: START });
    await s.run(80);
    expect(Number(s.db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE run_id = ?').get(body.run.id)?.n)).toBeGreaterThan(0);
    expect(Number(s.db.prepare('SELECT COUNT(*) AS n FROM telegram_outbox').get()?.n)).toBe(0);
    await s.app.close();
  });
});

describe('Telegram: привязка и команды', () => {
  it('только после входа; код одноразовый и истекает; неизвестный чат не получает данных', async () => {
    const { s, tg, clock, service, link } = await setup();
    expect(service.info()).toMatchObject({ state: 'ONLINE', botUsername: 'qorgan_demo_bot' });
    expect((await s.post('/api/telegram/link-code', {}, '')).status).toBe(401);

    tg.say(777, '/status');
    await service.pollOnce();
    expect(tg.sent().at(-1)!.body.text).toContain('не привязан');

    const code = await link(1001);
    expect(tg.sent().at(-1)!.body).toMatchObject({ chat_id: '1001' });
    expect(tg.sent().at(-1)!.body.text).toContain('operator');
    // Повторное использование кода другим чатом — отказ.
    tg.say(2002, `/start ${code}`);
    await service.pollOnce();
    expect(tg.sent().at(-1)!.body.text).toContain('не подошёл');
    // Истёкший код.
    const res = await s.post('/api/telegram/link-code', {});
    clock.advance(11 * 60_000);
    tg.say(2002, `/start ${res.body.code}`);
    await service.pollOnce();
    expect(tg.sent().at(-1)!.body.text).toContain('не подошёл');
    // Смещение getUpdates сохраняется: старые сообщения не обрабатываются повторно.
    expect(Number(s.db.prepare('SELECT update_offset FROM telegram_state').get()?.update_offset)).toBe(tg.nextUpdateId);
    // В БД — только хеш кода.
    expect(s.db.prepare('SELECT code_hash FROM telegram_link_codes').all().every((r) => String(r.code_hash).length === 64)).toBe(true);
    const status = await s.get('/api/telegram/status');
    expect(status.body.links).toHaveLength(1);
    expect(status.body.links[0].chat).toMatch(/1001$/);
    await s.app.close();
  });

  it('/help /status /stations /alerts /subscribe /unsubscribe отвечают по данным сервера (en по языку Telegram)', async () => {
    const { s, tg, service, link } = await setup();
    await link(1001);
    await s.post('/api/simulation/start', { scenarioId: 'RAPID_FLOOD', seed: 42, virtualStart: START });
    await s.run(40);
    for (const cmd of ['/help', '/status', '/stations', '/alerts', '/unsubscribe', '/subscribe', '/nonsense']) tg.say(1001, cmd);
    await service.pollOnce();
    const texts = tg.sent().slice(-7).map((c) => c.body.text as string);
    expect(texts[0]).toContain('/subscribe');
    expect(texts[1]).toContain('симуляция идёт');
    expect(texts[2]).toContain('Сергеевка (QRG-01)');
    expect(texts[2]).toMatch(/\d,\d\d м/);
    expect(texts[3]).toContain('Сергеевка');
    expect(texts[4]).toContain('выключена');
    expect(Number(s.db.prepare('SELECT subscribed FROM telegram_links').get()?.subscribed)).toBe(1);
    expect(texts[6]).toContain('Неизвестная');
    // Язык берётся из Telegram при привязке.
    const res = await s.post('/api/telegram/link-code', {}, s.admin);
    tg.say(3003, `/start ${res.body.code}`, 'en');
    tg.say(3003, '/status', 'en');
    await service.pollOnce();
    expect(tg.sent().at(-1)!.body.text).toContain('Data mode');
    await s.app.close();
  });
});

describe('Telegram: уведомления о высоком риске', () => {
  it('новый HIGH и MEDIUM → HIGH дают по одному сообщению на предупреждение; повторные измерения — нет', async () => {
    const { s, tg, service, link, clock } = await setup();
    await link(1001);
    const { body } = await s.post('/api/simulation/start', { scenarioId: 'RAPID_FLOOD', seed: 42, virtualStart: START });
    const runId = body.run.id;
    while (s.scheduler.pending > 0) {
      await s.fire();
      clock.advance(2_000);
      await service.dispatchOnce();
    }
    const highAlerts = s.db
      .prepare(
        `SELECT DISTINCT a.id FROM alerts a JOIN alert_events e ON e.alert_id = a.id
         WHERE a.run_id = ? AND ((e.type = 'OPENED' AND a.id IN (SELECT alert_id FROM alert_events WHERE type = 'OPENED')) OR e.type = 'ESCALATED')`,
      )
      .all(runId);
    const outbox = s.db.prepare('SELECT * FROM telegram_outbox ORDER BY id').all();
    const alertMsgs = outbox.filter((o) => String(o.dedup_key).startsWith('alert:'));
    // Каждая станция RAPID_FLOOD доходит до HIGH; по каждому предупреждению — не больше одного сообщения в чат.
    expect(new Set(alertMsgs.map((o) => o.station_id)).size).toBe(4);
    expect(new Set(alertMsgs.map((o) => o.alert_id)).size).toBe(alertMsgs.length);
    expect(alertMsgs.length).toBeLessThanOrEqual(highAlerts.length);
    const sent = tg.sent().filter((c) => String(c.body.text).startsWith('QORGAN | Предупреждение'));
    expect(sent.length).toBe(alertMsgs.filter((o) => o.status === 'SENT').length);
    expect(sent.length).toBeGreaterThanOrEqual(4);
    // Сообщение — из настоящего события: станция, уровень в метрах, высокий риск, время, причина, ссылка, пометка.
    const text = String(sent[0]!.body.text);
    expect(text).toMatch(/Станция: .+ \(QRG-0\d\)/);
    expect(text).toMatch(/Уровень: \d+,\d\d м/);
    expect(text).toContain('Риск: высокий');
    expect(text).toContain('(UTC+5)');
    expect(text).toContain('Причина:');
    expect(text).toContain('http://localhost:3000');
    expect(text).toContain('Учебная демонстрация');
    // Токен не попадает ни в БД, ни в ответы API.
    const dump = JSON.stringify(s.db.prepare('SELECT * FROM telegram_outbox').all()) + JSON.stringify((await s.get('/api/telegram/status')).body);
    expect(dump).not.toContain('TEST-TOKEN');
    await s.app.close();
  });

  it('отписанный чат и отключённый пользователь не получают сообщений; список разрешённых чатов соблюдается', async () => {
    const { s, tg, service, link } = await setup({ allowedChatIds: new Set(['1001']) });
    await link(1001);
    tg.say(5005, '/start ANYCODE');
    await service.pollOnce();
    expect(tg.sent().at(-1)!.body.text).toContain('не входит в список');
    tg.say(1001, '/unsubscribe');
    await service.pollOnce();
    await s.post('/api/simulation/start', { scenarioId: 'RAPID_FLOOD', seed: 42, virtualStart: START });
    await s.run(120);
    expect(Number(s.db.prepare('SELECT COUNT(*) AS n FROM telegram_outbox').get()?.n)).toBe(0);
    await s.app.close();
  });

  it('ошибки Telegram: 429 — пауза по retry_after; 5xx — повтор с паузой; 400 — FAILED; 403 — FAILED и отписка', async () => {
    const { s, tg, service, link, clock } = await setup();
    await link(1001);
    const before = tg.sent().length;
    // Четыре проверочных сообщения в разные минуты — четыре записи очереди.
    for (let i = 0; i < 4; i += 1) {
      await s.post('/api/telegram/test', {});
      clock.advance(61_000);
    }
    const rows = () => s.db.prepare("SELECT id, status, attempts, last_error, next_attempt_at FROM telegram_outbox WHERE dedup_key LIKE 'test:%' ORDER BY id").all();
    expect(rows()).toHaveLength(4);

    tg.sendReplies.push({ status: 429, body: { ok: false, parameters: { retry_after: 7 } } });
    expect(await service.dispatchOnce()).toBe(0);
    expect(rows()[0]).toMatchObject({ status: 'PENDING', attempts: 0, last_error: 'HTTP_429' });
    clock.advance(3_000);
    expect(await service.dispatchOnce()).toBe(0); // пауза ещё идёт — запросов нет
    const callsDuringPause = tg.sent().length;
    clock.advance(5_000);

    tg.sendReplies.push({ status: 502, body: {} });
    await service.dispatchOnce();
    expect(rows()[0]).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'HTTP_502' });
    expect(tg.sent().length).toBe(callsDuringPause + 1);

    clock.advance(2_500);
    tg.sendReplies.push({ status: 200, body: { ok: true, result: {} } }); // первая — успешно
    tg.sendReplies.push({ status: 400, body: { ok: false } }); // вторая — неверный запрос (но не раньше 1,1 с в этот чат)
    await service.dispatchOnce();
    expect(rows()[0]).toMatchObject({ status: 'SENT' });
    expect(rows()[1]).toMatchObject({ status: 'PENDING', last_error: 'CHAT_RATE' });
    clock.advance(1_200);
    tg.sendReplies.push({ status: 403, body: { ok: false } }); // третья — бот заблокирован пользователем
    await service.dispatchOnce();
    expect(rows()[1]).toMatchObject({ status: 'FAILED', last_error: 'HTTP_400' });
    expect(rows()[2]).toMatchObject({ status: 'FAILED', last_error: 'HTTP_403' });
    expect(Number(s.db.prepare('SELECT subscribed FROM telegram_links').get()?.subscribed)).toBe(0);
    expect(tg.sent().length).toBeGreaterThan(before);
    await s.app.close();
  });

  it('сеть недоступна: повторы с ограничением попыток, затем FAILED; сервер продолжает работу', async () => {
    const tgDown: FetchFn = async (url) => {
      if (url.endsWith('/getMe')) return { status: 200, json: async () => ({ ok: true, result: { username: 'b' } }) };
      throw Object.assign(new Error('offline'), { name: 'TypeError' });
    };
    const clock = new TestClock();
    const s = await simApp(undefined, clock, { telegram: { token: TOKEN, publicUrl: null, allowedChatIds: null, fetch: tgDown, maxAttempts: 3 }, telegramScheduler: new ManualScheduler() });
    await new Promise((r) => setImmediate(r));
    s.db.prepare("INSERT INTO telegram_links (chat_id, user_id, lang, subscribed, linked_at, updated_at) VALUES ('42', 1, 'ru', 1, 'x', 'x')").run();
    await s.post('/api/telegram/test', {});
    for (let i = 0; i < 5; i += 1) {
      await s.app.telegram.dispatchOnce();
      clock.advance(70_000);
    }
    expect(s.db.prepare('SELECT status, attempts, last_error FROM telegram_outbox').get()).toMatchObject({ status: 'FAILED', attempts: 3, last_error: 'NETWORK' });
    expect(s.app.telegram.info()).toMatchObject({ state: 'ERROR', lastError: 'NETWORK' });
    expect((await s.get('/api/health')).status).toBe(200);
    await s.app.close();
  });

  it('устаревшее сообщение после долгого обрыва не отправляется (EXPIRED)', async () => {
    const { s, tg, service, link, clock } = await setup();
    await link(1001);
    await s.post('/api/telegram/test', {});
    clock.advance(31 * 60_000);
    const before = tg.sent().length;
    await service.dispatchOnce();
    expect(s.db.prepare("SELECT status, last_error FROM telegram_outbox WHERE dedup_key LIKE 'test:%'").get()).toMatchObject({ status: 'FAILED', last_error: 'EXPIRED' });
    expect(tg.sent().length).toBe(before);
    await s.app.close();
  });

  it('отвязка и подписка через API: чужую привязку оператор изменить не может', async () => {
    const { s, link } = await setup();
    await link(1001, s.admin);
    const adminLink = Number(s.db.prepare('SELECT id FROM telegram_links').get()?.id);
    expect((await s.app.inject({ method: 'PATCH', url: `/api/telegram/links/${adminLink}`, headers: { cookie: s.operator }, payload: { subscribed: false } })).statusCode).toBe(403);
    expect((await s.app.inject({ method: 'PATCH', url: `/api/telegram/links/${adminLink}`, headers: { cookie: s.admin }, payload: { subscribed: 'no' } })).statusCode).toBe(400);
    expect((await s.app.inject({ method: 'PATCH', url: `/api/telegram/links/${adminLink}`, headers: { cookie: s.admin }, payload: { subscribed: false } })).statusCode).toBe(200);
    expect((await s.app.inject({ method: 'DELETE', url: `/api/telegram/links/${adminLink}`, headers: { cookie: s.admin } })).statusCode).toBe(200);
    expect(s.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'TELEGRAM_%' ORDER BY id").all().map((r) => r.action)).toEqual(['TELEGRAM_LINK', 'TELEGRAM_UNSUBSCRIBE', 'TELEGRAM_UNLINK']);
    await s.app.close();
  });
});

describe('Telegram: текст сообщения', () => {
  const p: AlertPayload = {
    kind: 'ALERT', event: 'ESCALATED', alertId: 3, runId: 1, tick: 50, stationCode: 'QRG-01', stationName: 'Сергеевка', severity: 'HIGH',
    levelCm: 601, warningCm: 450, dangerCm: 550, measuredAt: '2026-04-12T02:00:00.000Z', trigger: 'DANGER_LEVEL', reasons: [],
    ml: { category: 'HIGH', pDanger: 0.97, modelVersion: 'sentinel-1.0.0' }, dataSource: 'EXTERNAL_SENSOR',
  };
  it('ru / kk / en, уровень в метрах, время UTC+5, без ссылки, если адрес не задан', () => {
    const ru = renderAlert(p, 'ru', null);
    expect(ru).toContain('Уровень: 6,01 м');
    expect(ru).toContain('12.04.2026, 07:00 (UTC+5)');
    expect(ru).toContain('средний → высокий');
    expect(ru).toContain('превышен учебный опасный порог');
    expect(ru).toContain('97');
    expect(ru).toContain('внешний учебный датчик');
    expect(ru).not.toContain('http');
    expect(renderAlert(p, 'en', 'http://x')).toContain('Risk: high');
    expect(renderAlert(p, 'kk', 'http://x')).toContain('Қауіп: жоғары');
  });
});
