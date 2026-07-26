// stats/queries.ts — выборки для REST API: сводка, временные ряды, топ юзеров.
// Все границы интервалов — по локальному времени сервера.

import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { OnlineUserDTO, OverviewDTO, Range, TimeseriesPoint, UserUsage } from '../types.js';
import { getDb, getSetting } from '../db.js';
import { getLiveRate } from './poller.js';

export type { Range } from '../types.js';

const HOUR = 3_600_000;
const ONLINE_WINDOW_MS = 180_000; // онлайн = хендшейк младше 180 секунд

// Кэш подготовленных запросов (готовятся лениво, после openDb).
const stmtCache = new Map<string, Database.Statement>();

function stmt(sql: string): Database.Statement {
  let prepared = stmtCache.get(sql);
  if (!prepared) {
    prepared = getDb().prepare(sql);
    stmtCache.set(sql, prepared);
  }
  return prepared;
}

function startOfHour(ts: number): number {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Начала интервалов ряда для периода: 24h → 24 часовых, 7d → 168 часовых,
 * 30d → 30 дневных (границы дней — локальные, поэтому через Date, а не шаг 24ч).
 * Последний интервал — текущий (неполный) час/день.
 */
function bucketStarts(range: Range, now: number): { starts: number[]; daily: boolean } {
  if (range === '30d') {
    const starts: number[] = [];
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      starts.push(d.getTime());
    }
    return { starts, daily: true };
  }
  const n = range === '24h' ? 24 : 168;
  const end = startOfHour(now);
  const starts: number[] = [];
  for (let i = n - 1; i >= 0; i--) starts.push(end - i * HOUR);
  return { starts, daily: false };
}

export function overview(cfg: Config): OverviewDTO {
  const now = Date.now();

  const totals = stmt(
    'SELECT COUNT(*) AS users_total, ' +
      'COALESCE(SUM(CASE WHEN last_handshake > ? THEN 1 ELSE 0 END), 0) AS users_online, ' +
      'COALESCE(SUM(total_rx), 0) AS rx_total, ' +
      'COALESCE(SUM(total_tx), 0) AS tx_total ' +
      'FROM users',
  ).get(now - ONLINE_WINDOW_MS) as {
    users_total: number;
    users_online: number;
    rx_total: number;
    tx_total: number;
  };

  const today = stmt(
    'SELECT COALESCE(SUM(rx), 0) AS rx, COALESCE(SUM(tx), 0) AS tx ' +
      'FROM traffic_hourly WHERE hour_ts >= ?',
  ).get(startOfLocalDay(now)) as { rx: number; tx: number };

  return {
    usersTotal: totals.users_total,
    usersOnline: totals.users_online,
    rxToday: today.rx,
    txToday: today.tx,
    rxTotal: totals.rx_total,
    txTotal: totals.tx_total,
    server: {
      host: cfg.wg.host,
      port: cfg.wg.port,
      publicKey: getSetting('server_public_key') ?? '',
      subnet: cfg.wg.subnet,
      iface: cfg.wg.iface,
      mock: cfg.wg.mock,
      engine: cfg.engine,
    },
  };
}

export function timeseries(range: Range, userId?: number): TimeseriesPoint[] {
  const now = Date.now();
  const { starts, daily } = bucketStarts(range, now);
  const from = starts[0];

  const rows = (
    userId !== undefined
      ? stmt('SELECT hour_ts, rx, tx FROM traffic_hourly WHERE user_id = ? AND hour_ts >= ?').all(userId, from)
      : stmt(
          'SELECT hour_ts, SUM(rx) AS rx, SUM(tx) AS tx FROM traffic_hourly ' +
            'WHERE hour_ts >= ? GROUP BY hour_ts',
        ).all(from)
  ) as Array<{ hour_ts: number; rx: number; tx: number }>;

  // Непрерывный ряд: сначала нули по всем интервалам, потом накладываем данные.
  const points = new Map<number, TimeseriesPoint>();
  for (const ts of starts) points.set(ts, { ts, rx: 0, tx: 0 });

  for (const row of rows) {
    const key = daily ? startOfLocalDay(row.hour_ts) : row.hour_ts;
    const point = points.get(key);
    if (!point) continue; // корзина за границей окна — игнорируем
    point.rx += row.rx;
    point.tx += row.tx;
  }

  return [...points.values()]; // порядок вставки = по возрастанию ts
}

export function topUsers(range: Range): UserUsage[] {
  const { starts } = bucketStarts(range, Date.now());
  const from = starts[0];

  // LEFT JOIN — юзеры без трафика за период тоже попадают в список (с нулями).
  return stmt(
    'SELECT u.id AS id, u.name AS name, ' +
      'COALESCE(SUM(t.rx), 0) AS rx, COALESCE(SUM(t.tx), 0) AS tx ' +
      'FROM users u ' +
      'LEFT JOIN traffic_hourly t ON t.user_id = u.id AND t.hour_ts >= ? ' +
      'GROUP BY u.id, u.name ' +
      'ORDER BY COALESCE(SUM(t.rx), 0) + COALESCE(SUM(t.tx), 0) DESC, u.id ASC',
  ).all(from) as UserUsage[];
}

/**
 * Онлайн-юзеры (критерий тот же, что в overview.usersOnline) с текущей
 * скоростью из поллера; самые «шумные» — первыми.
 */
export function onlineUsers(): OnlineUserDTO[] {
  const rows = stmt(
    'SELECT id, name, address, last_handshake FROM users WHERE last_handshake > ? ORDER BY id',
  ).all(Date.now() - ONLINE_WINDOW_MS) as Array<{
    id: number;
    name: string;
    address: string;
    last_handshake: number;
  }>;

  return rows
    .map((r) => {
      const rate = getLiveRate(r.id);
      return {
        id: r.id,
        name: r.name,
        address: r.address,
        rateRx: Math.round(rate?.rateRx ?? 0),
        rateTx: Math.round(rate?.rateTx ?? 0),
        lastHandshake: r.last_handshake,
      };
    })
    .sort((a, b) => b.rateRx + b.rateTx - (a.rateRx + a.rateTx) || a.id - b.id);
}
