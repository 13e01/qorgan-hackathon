// Готовность к публичному размещению: защита от перебора паролей, cookie только по HTTPS, проверка секретов.

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { publicDeploymentProblems } from '../src/config';
import { testDb } from './helpers';

describe('вход', () => {
  it('после 10 неудачных попыток с одного IP — 429; верный пароль тоже не принимается до конца окна', async () => {
    let ms = Date.parse('2026-10-28T10:00:00Z');
    const app = await buildApp({ db: testDb(), sessionSecret: 'x'.repeat(40), sessionTtlHours: 1, now: () => new Date(ms) });
    const tryLogin = (password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password } });
    for (let i = 0; i < 10; i += 1) expect((await tryLogin('wrong-password')).statusCode).toBe(401);
    const blocked = await tryLogin('admin-test-pass');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('TOO_MANY_ATTEMPTS');
    ms += 11 * 60_000;
    expect((await tryLogin('admin-test-pass')).statusCode).toBe(200);
    await app.close();
  });

  it('публичное размещение: cookie сессии с флагом Secure; локально — без него', async () => {
    const pub = await buildApp({ db: testDb(), sessionSecret: 'x'.repeat(40), sessionTtlHours: 1, secureCookies: true, trustProxy: true });
    const res = await pub.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin-test-pass' } });
    expect(String(res.headers['set-cookie'])).toMatch(/Secure/);
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly/);
    await pub.close();
    const local = await buildApp({ db: testDb(), sessionSecret: 'x'.repeat(40), sessionTtlHours: 1 });
    const res2 = await local.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin-test-pass' } });
    expect(String(res2.headers['set-cookie'])).not.toMatch(/Secure/);
    await local.close();
  });
});

describe('проверка настроек публичного размещения', () => {
  it('демо-пароли, короткие пароли и пустой секрет запрещены', () => {
    expect(publicDeploymentProblems({ SESSION_SECRET: 'replace-me', SEED_ADMIN_PASSWORD: 'qorgan-admin-demo' })).toHaveLength(2);
    expect(publicDeploymentProblems({ SESSION_SECRET: 'a'.repeat(64), SEED_OPERATOR_PASSWORD: 'short' })).toHaveLength(1);
    expect(publicDeploymentProblems({ SESSION_SECRET: 'a'.repeat(64), SEED_ADMIN_PASSWORD: 'a-long-unique-pass-2026' })).toEqual([]);
  });
});
