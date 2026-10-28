import { describe, expect, it } from 'vitest';
import { requireRole } from '../src/auth/plugin';
import { MIGRATIONS } from '../src/db/migrations';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { login, testApp } from './helpers';

describe('пароли', () => {
  it('хеш scrypt проверяется, неверный пароль — нет; соль разная', () => {
    const a = hashPassword('secret-1');
    const b = hashPassword('secret-1');
    expect(a).not.toBe(b);
    expect(verifyPassword('secret-1', a)).toBe(true);
    expect(verifyPassword('secret-2', a)).toBe(false);
    expect(verifyPassword('secret-1', 'garbage')).toBe(false);
  });
});

describe('GET /api/health', () => {
  it('отвечает 200 с версией схемы и числом станций', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: { schemaVersion: MIGRATIONS.at(-1)?.version, stations: 4 } });
  });
});

describe('TC-P07 вход', () => {
  it('верный пароль → 200, пользователь и httpOnly-cookie', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'operator', password: 'operator-test-pass' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: 1, username: 'operator', role: 'operator' } });
    const cookie = res.cookies.find((c) => c.name === 'qorgan_sid');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
  });

  it('неверный пароль и несуществующий пользователь → одинаковый 401', async () => {
    const { app } = await testApp();
    for (const payload of [
      { username: 'operator', password: 'wrong' },
      { username: 'nobody', password: 'wrong' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'Неверный логин или пароль' } });
    }
  });

  it('логин не зависит от регистра', async () => {
    const { app } = await testApp();
    await expect(login(app, 'ADMIN', 'admin-test-pass')).resolves.toMatch(/^qorgan_sid=/);
  });

  it('отключённый пользователь не входит', async () => {
    const { app, db } = await testApp();
    db.prepare("UPDATE users SET is_active = 0 WHERE username = 'operator'").run();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'operator', password: 'operator-test-pass' } });
    expect(res.statusCode).toBe(401);
  });

  it('пустое или неверное тело → 400 VALIDATION (TC-P04)', async () => {
    const { app } = await testApp();
    for (const payload of [{}, { username: '', password: 'x' }, { username: 'a', password: 5 }]) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION');
    }
  });
});

describe('сессия', () => {
  it('/api/auth/me: гость → null; после входа → пользователь; после выхода → снова null', async () => {
    const { app } = await testApp();
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).json()).toEqual({ user: null });

    const cookie = await login(app, 'admin', 'admin-test-pass');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json()).toEqual({ user: { id: 2, username: 'admin', role: 'admin' } });

    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(after.json()).toEqual({ user: null });
  });

  it('подделанная cookie не принимается', async () => {
    const { app, db } = await testApp();
    await login(app, 'admin', 'admin-test-pass');
    const sessionId = String(db.prepare('SELECT id FROM sessions').get()?.id);
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `qorgan_sid=${sessionId}.forged` } });
    expect(res.json()).toEqual({ user: null });
  });

  it('истёкшая сессия и отключение пользователя завершают доступ', async () => {
    const { app, db } = await testApp();
    const cookie = await login(app, 'operator', 'operator-test-pass');
    db.prepare("UPDATE users SET is_active = 0 WHERE username = 'operator'").run();
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json()).toEqual({ user: null });

    db.prepare("UPDATE users SET is_active = 1 WHERE username = 'operator'").run();
    db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json()).toEqual({ user: null });
  });
});

describe('TC-P05 проверка ролей', () => {
  async function appWithGuardedRoutes() {
    const ctx = await testApp();
    ctx.app.get('/test/operator', { preHandler: requireRole('operator') }, async () => ({ ok: true }));
    ctx.app.get('/test/admin', { preHandler: requireRole('admin') }, async () => ({ ok: true }));
    return ctx;
  }

  it('гость → 401, оператор в админ-маршрут → 403, админ → 200', async () => {
    const { app } = await appWithGuardedRoutes();
    const operator = await login(app, 'operator', 'operator-test-pass');
    const admin = await login(app, 'admin', 'admin-test-pass');

    const cases: Array<[string, string | undefined, number]> = [
      ['/test/operator', undefined, 401],
      ['/test/admin', undefined, 401],
      ['/test/operator', operator, 200],
      ['/test/admin', operator, 403],
      ['/test/operator', admin, 200],
      ['/test/admin', admin, 200],
    ];
    for (const [url, cookie, status] of cases) {
      const res = await app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
      expect(res.statusCode, `${url} as ${cookie ? 'user' : 'guest'}`).toBe(status);
    }
    const denied = await app.inject({ method: 'GET', url: '/test/admin', headers: { cookie: operator } });
    expect(denied.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Недостаточно прав' } });
  });
});

describe('ошибки', () => {
  it('неизвестный маршрут → 404 в едином формате', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('битый JSON → 400 в едином формате, сервер не падает', async () => {
    const { app } = await testApp();
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '{bad',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error.code');
  });
});
