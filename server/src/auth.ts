// Аутентификация админа: пароль (scrypt) + сессии в памяти.
// Контракт — ARCHITECTURE.md, раздел «агент api».

import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;
import { getSetting, setSetting } from './db.js';

const HASH_KEY = 'admin_password_hash';
const SALT_BYTES = 16;
const HASH_BYTES = 64;

/** token -> unix ms, когда сессия истекает. */
const sessions = new Map<string, number>();

/** Пароль администратора ещё не задан. */
export function needsSetup(): boolean {
  return getSetting(HASH_KEY) === null;
}

/** Задать пароль администратора. Формат хранения: `<salt_hex>:<scrypt_hex>`. */
export function setupAdmin(password: string): void {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, HASH_BYTES);
  setSetting(HASH_KEY, `${salt.toString('hex')}:${hash.toString('hex')}`);
}

/** Разобрать сохранённый хэш; повреждённая запись не должна открывать вход. */
function parseStoredHash(): { salt: Buffer; expected: Buffer } | null {
  const stored = getSetting(HASH_KEY);
  if (!stored) return null;
  const sep = stored.indexOf(':');
  if (sep <= 0) return null;
  const salt = Buffer.from(stored.slice(0, sep), 'hex');
  const expected = Buffer.from(stored.slice(sep + 1), 'hex');
  if (salt.length !== SALT_BYTES || expected.length !== HASH_BYTES) return null;
  return { salt, expected };
}

/** Проверить пароль против сохранённого хэша (timingSafeEqual). */
export function verifyPassword(password: string): boolean {
  const parsed = parseStoredHash();
  if (!parsed) return false;
  try {
    return timingSafeEqual(parsed.expected, scryptSync(password, parsed.salt, HASH_BYTES));
  } catch {
    return false;
  }
}

/**
 * Асинхронная проверка пароля (crypto.scrypt в threadpool): не блокирует
 * event loop, в отличие от scryptSync — обработчик логина обязан ходить сюда.
 */
export async function verifyPasswordAsync(password: string): Promise<boolean> {
  const parsed = parseStoredHash();
  if (!parsed) return false;
  try {
    return timingSafeEqual(parsed.expected, await scryptAsync(password, parsed.salt, HASH_BYTES));
  } catch {
    return false;
  }
}

/** Создать сессию, вернуть токен (64 hex-символа). */
export function createSession(): string {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + config.sessionTtlMs);
  return token;
}

/** Валидна ли сессия. Протухшие удаляются лениво. */
export function checkSession(token: string | undefined): boolean {
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/** Удалить сессию (logout). Отсутствующий токен — no-op. */
export function destroySession(token: string | undefined): void {
  if (token) sessions.delete(token);
}

// Периодическая чистка протухших сессий, чтобы Map не рос бесконечно.
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // раз в час
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref(); // не удерживать процесс живым ради таймера
