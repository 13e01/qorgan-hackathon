import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Формат хранения: scrypt$N$r$p$<соль base64>$<хеш base64>. Пароль в открытом виде не хранится.
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}
