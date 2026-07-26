// db.ts — единая точка доступа к SQLite (better-sqlite3, синхронный API).
// Синглтон модуля: openDb() вызывается один раз при старте процесса,
// дальше все обращения — через экспортированные функции контракта.

import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { UserRow } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  private_key TEXT NOT NULL,
  public_key TEXT NOT NULL,
  preshared_key TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  total_rx INTEGER NOT NULL DEFAULT 0,
  total_tx INTEGER NOT NULL DEFAULT 0,
  last_handshake INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS traffic_hourly(
  user_id INTEGER NOT NULL,
  hour_ts INTEGER NOT NULL,
  rx INTEGER NOT NULL DEFAULT 0,
  tx INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, hour_ts)
);
CREATE INDEX IF NOT EXISTS idx_traffic_hourly_hour_ts ON traffic_hourly(hour_ts);
`;

// Строка таблицы users как она лежит в БД (snake_case).
interface UserDbRow {
  id: number;
  name: string;
  private_key: string;
  public_key: string;
  preshared_key: string;
  address: string;
  enabled: number;
  total_rx: number;
  total_tx: number;
  last_handshake: number | null;
  created_at: number;
  updated_at: number;
}

function mapUser(row: UserDbRow): UserRow {
  return {
    id: row.id,
    name: row.name,
    privateKey: row.private_key,
    publicKey: row.public_key,
    presharedKey: row.preshared_key,
    address: row.address,
    enabled: row.enabled === 1,
    totalRx: row.total_rx,
    totalTx: row.total_tx,
    lastHandshake: row.last_handshake ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface Statements {
  getSetting: Database.Statement;
  setSetting: Database.Statement;
  listUsers: Database.Statement;
  getUser: Database.Statement;
  insertUser: Database.Statement;
  updateUser: Database.Statement;
  updateCounters: Database.Statement;
  addHourly: Database.Statement;
  deleteTraffic: Database.Statement;
  deleteUser: Database.Statement;
}

/** Одна почасовая корзина трафика (unix ms начала часа + байты). */
export interface TrafficBucket {
  hourTs: number;
  rx: number;
  tx: number;
}

/** Счётчики юзера, записываемые одним апдейтом. */
export interface CounterUpdate {
  totalRx: number;
  totalTx: number;
  lastHandshake: number | null;
}

let db: Database.Database | null = null;
let stmts: Statements | null = null;
let deleteUserTx: ((id: number) => boolean) | null = null;
let recordTrafficTx:
  | ((userId: number, c: CounterUpdate, buckets: readonly TrafficBucket[]) => void)
  | null = null;

function requireDb(): Database.Database {
  if (!db) throw new Error('db: база данных не открыта — сначала вызовите openDb()');
  return db;
}

function st(): Statements {
  if (!stmts) throw new Error('db: база данных не открыта — сначала вызовите openDb()');
  return stmts;
}

export function openDb(dbPath: string): void {
  if (db) return; // повторный вызов — no-op

  const handle = new Database(dbPath);
  handle.pragma('journal_mode = WAL');
  handle.pragma('synchronous = NORMAL');
  handle.pragma('busy_timeout = 5000');
  handle.exec(SCHEMA);

  // В БД — приватные ключи клиентов и сервера: дожимаем права до 0600.
  // Новые файлы уже создаются с 0600 (umask в config.ts); это для баз,
  // созданных ранними версиями с дефолтным umask.
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.chmodSync(dbPath + suffix, 0o600);
    } catch {
      // файла может не быть, или chmod недоступен (Windows) — не критично
    }
  }

  db = handle;
  stmts = {
    getSetting: handle.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: handle.prepare(
      'INSERT INTO settings(key, value) VALUES(?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ),
    listUsers: handle.prepare('SELECT * FROM users ORDER BY id'),
    getUser: handle.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: handle.prepare(
      'INSERT INTO users(name, private_key, public_key, preshared_key, address, enabled, created_at, updated_at) ' +
        'VALUES(?, ?, ?, ?, ?, 1, ?, ?)',
    ),
    updateUser: handle.prepare('UPDATE users SET name = ?, enabled = ?, updated_at = ? WHERE id = ?'),
    updateCounters: handle.prepare(
      'UPDATE users SET total_rx = ?, total_tx = ?, last_handshake = ? WHERE id = ?',
    ),
    addHourly: handle.prepare(
      'INSERT INTO traffic_hourly(user_id, hour_ts, rx, tx) VALUES(?, ?, ?, ?) ' +
        'ON CONFLICT(user_id, hour_ts) DO UPDATE SET rx = rx + excluded.rx, tx = tx + excluded.tx',
    ),
    deleteTraffic: handle.prepare('DELETE FROM traffic_hourly WHERE user_id = ?'),
    deleteUser: handle.prepare('DELETE FROM users WHERE id = ?'),
  };
  // Удаление юзера вместе с его историей трафика — атомарно.
  deleteUserTx = handle.transaction((id: number): boolean => {
    st().deleteTraffic.run(id);
    return st().deleteUser.run(id).changes > 0;
  });
  // Счётчики юзера и почасовые корзины обязаны меняться атомарно. Поллер к
  // этому моменту уже вычислил дельту относительно предыдущего замера, и если
  // total_* записались, а traffic_hourly нет (SQLITE_BUSY при конкурентном
  // чекпойнте WAL, SQLITE_FULL, диск ушёл в read-only), то «трафик за всё
  // время» навсегда разойдётся с графиками: восстановить пропавшую корзину
  // неоткуда. Транзакция даёт всё-или-ничего, а поллер по факту исключения
  // не двигает базовую точку и пересчитает ту же дельту на следующем тике.
  recordTrafficTx = handle.transaction(
    (userId: number, c: CounterUpdate, buckets: readonly TrafficBucket[]): void => {
      st().updateCounters.run(c.totalRx, c.totalTx, c.lastHandshake, userId);
      for (const b of buckets) {
        if (b.rx > 0 || b.tx > 0) st().addHourly.run(userId, b.hourTs, b.rx, b.tx);
      }
    },
  );
}

/**
 * Внутренний доступ к открытому соединению для модулей этого же агента
 * (stats/queries.ts, seed.ts). Не часть внешнего контракта.
 */
export function getDb(): Database.Database {
  return requireDb();
}

export function getSetting(key: string): string | null {
  const row = st().getSetting.get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  st().setSetting.run(key, value);
}

export function listUsers(): UserRow[] {
  return (st().listUsers.all() as UserDbRow[]).map(mapUser);
}

export function getUser(id: number): UserRow | null {
  const row = st().getUser.get(id) as UserDbRow | undefined;
  return row ? mapUser(row) : null;
}

export function createUser(u: {
  name: string;
  privateKey: string;
  publicKey: string;
  presharedKey: string;
  address: string;
}): UserRow {
  const now = Date.now();
  const info = st().insertUser.run(u.name, u.privateKey, u.publicKey, u.presharedKey, u.address, now, now);
  const row = getUser(Number(info.lastInsertRowid));
  if (!row) throw new Error('db: не удалось прочитать только что созданного пользователя');
  return row;
}

export function updateUser(id: number, patch: { name?: string; enabled?: boolean }): UserRow | null {
  const current = getUser(id);
  if (!current) return null;

  const name = patch.name ?? current.name;
  const enabled = patch.enabled ?? current.enabled;
  if (name === current.name && enabled === current.enabled) return current; // нечего менять

  st().updateUser.run(name, enabled ? 1 : 0, Date.now(), id);
  return getUser(id);
}

export function deleteUser(id: number): boolean {
  if (!deleteUserTx) throw new Error('db: база данных не открыта — сначала вызовите openDb()');
  return deleteUserTx(id);
}

export function updateCounters(
  id: number,
  c: { totalRx: number; totalTx: number; lastHandshake: number | null },
): void {
  st().updateCounters.run(c.totalRx, c.totalTx, c.lastHandshake, id);
}

export function addHourlyTraffic(userId: number, hourTs: number, rxDelta: number, txDelta: number): void {
  st().addHourly.run(userId, hourTs, rxDelta, txDelta);
}

/**
 * Отдельный тип ошибки для невалидного замера. Нужен вызывающему (поллеру),
 * чтобы отличить ДЕТЕРМИНИРОВАННУЮ ошибку данных от транзиентной ошибки SQLite:
 * транзиентную имеет смысл повторить следующим тиком, а испорченный замер будет
 * падать бесконечно, пока базовую точку не сбросят принудительно.
 */
export class InvalidMetricError extends Error {}

/**
 * Колонки rx/tx/total_* объявлены INTEGER, но SQLite хранит то, что ему
 * привязали: дробное значение осело бы в базе как REAL и потом «поехало» бы
 * в суммах и сравнениях. Пропорциональная развёртка дельты по часам даёт
 * дроби, поэтому округляем здесь, а не молча портим тип колонки.
 * NaN/Infinity — это уже сломанный замер: лучше громкая ошибка, чем запись,
 * после которой суммы юзера станут NULL/NaN без шанса на восстановление.
 */
function toInt(value: number, what: string): number {
  if (!Number.isFinite(value)) {
    throw new InvalidMetricError(`db: недопустимое значение ${what}: ${String(value)}`);
  }
  return Math.round(value);
}

/**
 * Атомарная запись результата одного тика поллера: новые счётчики юзера
 * (total_rx/total_tx/last_handshake) и почасовые корзины трафика.
 *
 * `hourTs/rxDelta/txDelta` — основная (текущая) корзина; `extraBuckets` —
 * дополнительные часы, когда дельту размазывают по пропущенным часам.
 * Либо применяется всё, либо не применяется ничего.
 */
export function recordTraffic(
  userId: number,
  counters: CounterUpdate,
  hourTs: number,
  rxDelta: number,
  txDelta: number,
  extraBuckets?: readonly TrafficBucket[],
): void {
  if (!recordTrafficTx) throw new Error('db: база данных не открыта — сначала вызовите openDb()');

  const buckets: TrafficBucket[] = [
    { hourTs: toInt(hourTs, 'hour_ts'), rx: toInt(rxDelta, 'rx'), tx: toInt(txDelta, 'tx') },
  ];
  for (const b of extraBuckets ?? []) {
    buckets.push({ hourTs: toInt(b.hourTs, 'hour_ts'), rx: toInt(b.rx, 'rx'), tx: toInt(b.tx, 'tx') });
  }

  recordTrafficTx(
    userId,
    {
      totalRx: toInt(counters.totalRx, 'total_rx'),
      totalTx: toInt(counters.totalTx, 'total_tx'),
      lastHandshake: counters.lastHandshake === null ? null : toInt(counters.lastHandshake, 'last_handshake'),
    },
    buckets,
  );
}
