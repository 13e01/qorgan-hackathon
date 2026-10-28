import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { migrate, openDb, type Db } from '../src/db/connection';
import { seed, type SeedUser } from '../src/db/seed';

export const TEST_USERS: SeedUser[] = [
  { username: 'operator', password: 'operator-test-pass', role: 'operator' },
  { username: 'admin', password: 'admin-test-pass', role: 'admin' },
];

/** Новая БД в памяти со схемой и начальными данными. */
export function testDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  seed(db, TEST_USERS);
  return db;
}

export async function testApp(db: Db = testDb()): Promise<{ app: FastifyInstance; db: Db }> {
  const app = await buildApp({ db, sessionSecret: 'test-secret-'.padEnd(40, 'x'), sessionTtlHours: 12 });
  return { app, db };
}

/** Входит под пользователем и возвращает cookie для последующих запросов. */
export async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'qorgan_sid');
  if (!cookie) throw new Error('no session cookie');
  return `${cookie.name}=${cookie.value}`;
}
