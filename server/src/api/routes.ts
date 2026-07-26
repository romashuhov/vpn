// Все REST-маршруты панели. Контракт — ARCHITECTURE.md, раздел «REST API».

import type { FastifyInstance, FastifyReply } from 'fastify';
import '@fastify/cookie'; // типовая аугментация req.cookies / reply.setCookie
import type { Config } from '../config.js';
import type { Range, UserDTO, UserRow } from '../types.js';
import type { WgRunner } from '../wg/runner.js';
import {
  checkSession,
  createSession,
  destroySession,
  needsSetup,
  setupAdmin,
  verifyPasswordAsync,
} from '../auth.js';
import { createUser, deleteUser, getSetting, getUser, listUsers, updateUser } from '../db.js';
import { nextFreeAddress } from '../ipam.js';
import { buildServerState, renderClientConfig } from '../wg/confgen.js';
import { genKeypair, genPresharedKey } from '../wg/keys.js';
import { onlineUsers, overview, timeseries, topUsers } from '../stats/queries.js';

const SESSION_COOKIE = 'sid';
const ONLINE_WINDOW_MS = 180_000; // хендшейк < 180 сек назад = онлайн
const LOGIN_FAIL_DELAY_MS = 500; // задержка перед 401 при неверном пароле
const LOGIN_MAX_FAILURES = 5; // после стольких неудач подряд — временная блокировка IP
const LOGIN_BLOCK_BASE_MS = 30_000; // первая блокировка; дальше — экспоненциально
const LOGIN_BLOCK_MAX_MS = 60 * 60_000;
const LOGIN_FAIL_WINDOW_MS = 15 * 60_000; // период тишины, после которого неудачи забываются
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 256;
// Публичные МАРШРУТЫ (сравниваются со сматченным req.routeOptions.url, не с req.url).
const PUBLIC_API_ROUTES = new Set(['/api/auth/status', '/api/auth/setup', '/api/auth/login']);

// ---- Хелперы ----

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Троттлинг логина ----

interface LoginAttempts {
  failures: number;
  blockedUntil: number;
  lastFailAt: number;
}

/** Неудачные попытки логина по IP (в памяти процесса). */
const loginAttempts = new Map<string, LoginAttempts>();

function pruneLoginAttempts(now: number): void {
  for (const [ip, rec] of loginAttempts) {
    if (rec.blockedUntil <= now && now - rec.lastFailAt > LOGIN_FAIL_WINDOW_MS) {
      loginAttempts.delete(ip);
    }
  }
}

/**
 * Проверки пароля выполняются строго по одной: scrypt — дорогая CPU-операция
 * (десятки-сотни мс и 16 МБ на вызов), и поток параллельных POST /api/auth/login
 * не должен забивать threadpool и душить остальной сервер.
 */
let verifyQueue: Promise<unknown> = Promise.resolve();
function verifyPasswordQueued(password: string): Promise<boolean> {
  const result = verifyQueue.then(() => verifyPasswordAsync(password));
  verifyQueue = result.catch(() => undefined);
  return result;
}

/**
 * Валидация имени: trim, 1..64 символа, вырезать управляющие символы и
 * переводы строк (защита от инъекции в conf-файл). null = невалидно.
 */
function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Вырезаем управляющие символы (коды < 0x20 и 0x7F), включая переводы строк.
  let cleaned = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) cleaned += ch;
  }
  cleaned = cleaned.trim();
  if (cleaned.length < 1 || cleaned.length > 64) return null;
  return cleaned;
}

/** id из URL-параметра: положительное целое, иначе null. */
function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** range из query: отсутствует → '24h', невалидный → null. */
function parseRange(raw: unknown): Range | null {
  if (raw === undefined) return '24h';
  return raw === '24h' || raw === '7d' || raw === '30d' ? raw : null;
}

function toDTO(u: UserRow): UserDTO {
  return {
    id: u.id,
    name: u.name,
    address: u.address,
    publicKey: u.publicKey,
    enabled: u.enabled,
    createdAt: u.createdAt,
    totalRx: u.totalRx,
    totalTx: u.totalTx,
    lastHandshake: u.lastHandshake,
    online: u.lastHandshake !== null && Date.now() - u.lastHandshake < ONLINE_WINDOW_MS,
  };
}

function setSessionCookie(reply: FastifyReply, cfg: Config): void {
  reply.setCookie(SESSION_COOKIE, createSession(), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // COOKIE_SECURE=1 — панель за reverse proxy с TLS: cookie не должна уходить
    // по случайному http-запросу (набранный руками адрес, старая закладка).
    secure: cfg.cookieSecure,
    maxAge: Math.floor(cfg.sessionTtlMs / 1000),
  });
}

// ---- Регистрация маршрутов ----

export function registerRoutes(
  app: FastifyInstance,
  deps: { cfg: Config; runner: WgRunner },
): void {
  const { cfg, runner } = deps;

  /**
   * Пересобрать состояние WireGuard и применить его. Вызывается после каждого
   * изменения юзеров. Ошибки sync логируются, но HTTP-ответ не валят.
   * Вызовы сериализуются через очередь: runner.sync() содержит несколько
   * await-точек, и параллельное выполнение могло бы применить в ядро устаревший
   * набор пиров. State пересобирается из БД непосредственно перед применением,
   * поэтому последний вызов в очереди всегда применяет самые свежие данные.
   */
  let syncQueue: Promise<void> = Promise.resolve();
  function syncPeers(): Promise<void> {
    syncQueue = syncQueue.then(async () => {
      try {
        const serverPrivateKey = getSetting('server_private_key');
        if (!serverPrivateKey) throw new Error('server_private_key отсутствует в settings');
        await runner.sync(buildServerState(cfg, serverPrivateKey, listUsers()));
      } catch (err) {
        console.error('[wg] Ошибка синхронизации пиров:', err);
      }
    });
    return syncQueue;
  }

  // Авторизация: всё /api/* кроме auth/status|setup|login требует валидную сессию.
  // Решение принимается по СМАТЧЕННОМУ маршруту (req.routeOptions.url), а не по
  // сырой строке req.url: роутер декодирует percent-encoding («/%61pi/users»
  // матчится в /api/users), и проверка сырого префикса обходится кодированием.
  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions.url;
    if (route === undefined || !(route === '/api' || route.startsWith('/api/'))) return;
    if (PUBLIC_API_ROUTES.has(route)) return;
    if (!checkSession(req.cookies?.[SESSION_COOKIE])) {
      return reply.code(401).send({ error: 'Не авторизован' });
    }
  });

  // Ошибки (в т.ч. кривой JSON в теле) — всегда JSON { error } на русском.
  app.setErrorHandler((err: unknown, req, reply) => {
    const statusCode =
      err !== null && typeof err === 'object' && 'statusCode' in err
        ? (err as { statusCode?: unknown }).statusCode
        : undefined;
    const status = typeof statusCode === 'number' && statusCode >= 400 ? statusCode : 500;
    if (status >= 500) {
      console.error(`[http] Ошибка обработки ${req.method} ${req.url}:`, err);
    }
    const message = status >= 500 ? 'Внутренняя ошибка сервера' : 'Некорректный запрос';
    reply.code(status).send({ error: message });
  });

  // ---- Auth ----

  app.get('/api/auth/status', async (req, reply) => {
    return reply.code(200).send({
      needsSetup: needsSetup(),
      authenticated: checkSession(req.cookies?.[SESSION_COOKIE]),
    });
  });

  app.post('/api/auth/setup', async (req, reply) => {
    if (!needsSetup()) {
      return reply.code(409).send({ error: 'Пароль администратора уже настроен' });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const password = body.password;
    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
      return reply
        .code(400)
        .send({ error: `Пароль должен быть не короче ${PASSWORD_MIN_LENGTH} символов` });
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
      return reply
        .code(400)
        .send({ error: `Пароль слишком длинный (максимум ${PASSWORD_MAX_LENGTH} символов)` });
    }
    setupAdmin(password);
    setSessionCookie(reply, cfg);
    return reply.code(204).send();
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const password = body.password;
    if (typeof password !== 'string' || password.length === 0) {
      return reply.code(400).send({ error: 'Укажите пароль' });
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
      return reply
        .code(400)
        .send({ error: `Пароль слишком длинный (максимум ${PASSWORD_MAX_LENGTH} символов)` });
    }
    const now = Date.now();
    pruneLoginAttempts(now);
    const attempts = loginAttempts.get(req.ip);
    if (attempts && attempts.blockedUntil > now) {
      return reply
        .code(429)
        .send({ error: 'Слишком много неудачных попыток входа, попробуйте позже' });
    }
    if (!(await verifyPasswordQueued(password))) {
      const rec = attempts ?? { failures: 0, blockedUntil: 0, lastFailAt: 0 };
      rec.failures += 1;
      rec.lastFailAt = now;
      if (rec.failures >= LOGIN_MAX_FAILURES) {
        rec.blockedUntil =
          now +
          Math.min(LOGIN_BLOCK_BASE_MS * 2 ** (rec.failures - LOGIN_MAX_FAILURES), LOGIN_BLOCK_MAX_MS);
      }
      loginAttempts.set(req.ip, rec);
      await delay(LOGIN_FAIL_DELAY_MS); // замедляем перебор
      return reply.code(401).send({ error: 'Неверный пароль' });
    }
    loginAttempts.delete(req.ip);
    setSessionCookie(reply, cfg);
    return reply.code(204).send();
  });

  app.post('/api/auth/logout', async (req, reply) => {
    destroySession(req.cookies?.[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  // ---- Users ----

  app.get('/api/users', async (_req, reply) => {
    return reply.code(200).send(listUsers().map(toDTO));
  });

  app.post('/api/users', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = sanitizeName(body.name);
    if (!name) {
      return reply.code(400).send({ error: 'Имя должно быть строкой от 1 до 64 символов' });
    }
    let address: string;
    try {
      address = nextFreeAddress(
        cfg.wg.subnet,
        listUsers().map((u) => u.address),
      );
    } catch {
      return reply.code(409).send({ error: 'В подсети не осталось свободных адресов' });
    }
    const { privateKey, publicKey } = genKeypair();
    const user = createUser({
      name,
      privateKey,
      publicKey,
      presharedKey: genPresharedKey(),
      address,
    });
    await syncPeers();
    return reply.code(201).send(toDTO(user));
  });

  app.get<{ Params: { id: string } }>('/api/users/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'Некорректный идентификатор' });
    const user = getUser(id);
    if (!user) return reply.code(404).send({ error: 'Пользователь не найден' });
    return reply.code(200).send(toDTO(user));
  });

  app.patch<{ Params: { id: string } }>('/api/users/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'Некорректный идентификатор' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: { name?: string; enabled?: boolean } = {};
    if (body.name !== undefined) {
      const name = sanitizeName(body.name);
      if (!name) {
        return reply.code(400).send({ error: 'Имя должно быть строкой от 1 до 64 символов' });
      }
      patch.name = name;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return reply.code(400).send({ error: 'Поле enabled должно быть булевым' });
      }
      patch.enabled = body.enabled;
    }
    if (patch.name === undefined && patch.enabled === undefined) {
      return reply.code(400).send({ error: 'Нечего обновлять: укажите name или enabled' });
    }

    const before = getUser(id);
    if (!before) return reply.code(404).send({ error: 'Пользователь не найден' });
    const updated = updateUser(id, patch);
    if (!updated) return reply.code(404).send({ error: 'Пользователь не найден' });

    if (patch.enabled !== undefined && patch.enabled !== before.enabled) {
      await syncPeers();
    }
    return reply.code(200).send(toDTO(updated));
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'Некорректный идентификатор' });
    if (!deleteUser(id)) return reply.code(404).send({ error: 'Пользователь не найден' });
    await syncPeers();
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/users/:id/config', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'Некорректный идентификатор' });
    const user = getUser(id);
    if (!user) return reply.code(404).send({ error: 'Пользователь не найден' });
    const serverPublicKey = getSetting('server_public_key');
    if (!serverPublicKey) {
      return reply.code(500).send({ error: 'Серверный ключ не найден в настройках' });
    }
    const text = renderClientConfig(cfg, serverPublicKey, user);
    // Безопасное имя файла: только [a-zA-Z0-9_-], иначе wg-client-<id>.
    const base = user.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const filename = `${base.length > 0 ? base : `wg-client-${user.id}`}.conf`;
    return reply
      .code(200)
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(text);
  });

  // ---- Stats ----

  app.get('/api/stats/overview', async (_req, reply) => {
    return reply.code(200).send(overview(cfg));
  });

  app.get<{ Querystring: { range?: string; user?: string } }>(
    '/api/stats/timeseries',
    async (req, reply) => {
      const range = parseRange(req.query.range);
      if (range === null) {
        return reply.code(400).send({ error: 'Некорректный период: допустимо 24h, 7d, 30d' });
      }
      let userId: number | undefined;
      if (req.query.user !== undefined) {
        const parsed = parseId(req.query.user);
        if (parsed === null) {
          return reply.code(400).send({ error: 'Некорректный параметр user' });
        }
        userId = parsed;
      }
      return reply.code(200).send(timeseries(range, userId));
    },
  );

  app.get<{ Querystring: { range?: string } }>('/api/stats/top', async (req, reply) => {
    const range = parseRange(req.query.range);
    if (range === null) {
      return reply.code(400).send({ error: 'Некорректный период: допустимо 24h, 7d, 30d' });
    }
    return reply.code(200).send(topUsers(range));
  });

  app.get('/api/stats/online', async (_req, reply) => {
    return reply.code(200).send(onlineUsers());
  });
}
