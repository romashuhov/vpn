// stats/queries.ts — выборки для REST API: сводка, временные ряды, топ юзеров.
// Все границы интервалов — по локальному времени сервера.

import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type {
  OnlineUserDTO,
  OverviewDTO,
  Range,
  TimeseriesPoint,
  UserRow,
  UserUsage,
} from '../types.js';
import { HANDSHAKE_FUTURE_SKEW_MS, ONLINE_WINDOW_MS } from '../types.js';
import { getDb, getSetting, listUsers } from '../db.js';
import { serverAddress, subnetPrefix } from '../ipam.js';
import { getLiveRate } from './poller.js';

export type { Range } from '../types.js';

const HOUR = 3_600_000;
/**
 * Верхняя граница «из будущего» — та же константа, что использует поллер при
 * ЗАПИСИ метки (types.ts). Без верхней границы пир с меткой вперёд от now
 * числился бы онлайн вечно: now - lastHandshake отрицательно и условие
 * «< 180 сек» выполняется всегда.
 */
const HANDSHAKE_FUTURE_TOLERANCE_MS = HANDSHAKE_FUTURE_SKEW_MS;

/**
 * Единый критерий «онлайн» для всех мест (overview, onlineUsers, UserDTO.online):
 * метка обязана лежать в разумном прошлом — не старше окна и не в будущем
 * дальше допуска.
 */
export function isHandshakeOnline(lastHandshake: number | null, now: number = Date.now()): boolean {
  if (lastHandshake === null) return false;
  return (
    lastHandshake > now - ONLINE_WINDOW_MS && lastHandshake <= now + HANDSHAKE_FUTURE_TOLERANCE_MS
  );
}

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
 * Верхняя граница окна выборки по часовым корзинам.
 *
 * Корзина не может быть новее текущего часа — такая метка означает сломанные
 * часы, и без границы она вечно сидела бы в «трафике сегодня», не появляясь ни
 * на одном графике. Но граница взята с запасом в один час: обратная коррекция
 * часов (первая синхронизация NTP на VPS без RTC, откат снапшота ВМ) через
 * границу часа иначе разом прятала бы ЦЕЛУЮ уже записанную корзину из «сегодня»,
 * из графиков и из топа — цифры на дашборде проваливались бы без объяснения.
 * В нормальной работе поллер пишет только в startOfHour(now), поэтому запас ни
 * на что не влияет.
 *
 * Оговорка: корзины дальше этого запаса невидимы во всех выборках, но по-прежнему
 * учтены в users.total_rx/total_tx (rxTotal/txTotal считаются по users, а не по
 * traffic_hourly). То есть «за всё время» может быть больше суммы графиков;
 * вычистить это расхождение автоматически нельзя — исправить можно только часы.
 */
function bucketUpperBound(now: number): number {
  return startOfHour(now) + HOUR;
}

/** IPv4 в uint32; null — строка не похожа на адрес. */
function ipToInt(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = (n * 256 + o) >>> 0;
  }
  return n >>> 0;
}

/**
 * Пользователи, чей адрес не принадлежит текущей подсети WG_SUBNET.
 *
 * Такое расхождение возникает, если WG_SUBNET поменяли на живой установке:
 * адреса пользователей в БД остаются от старой подсети, интерфейс поднимается с
 * адресом новой, а MASQUERADE пишется тоже для новой — туннель у старых
 * клиентов устанавливается, но трафик никуда не идёт, и перевыдача конфига не
 * помогает (в конфиг попадает старый адрес с новым префиксом). Ошибка молчаливая,
 * поэтому её надо и логировать при старте, и показывать в панели.
 *
 * Живёт здесь, а не в ipam.ts, потому что нужна сразу двум потребителям
 * (bootstrap-диагностика в index.ts и overview()), а ipam.ts принадлежит
 * другому модулю-владельцу.
 */
function subnetMembership(subnet: string): ((address: string) => boolean) | null {
  let network: number;
  let mask: number;
  try {
    // serverAddress() = первый хост подсети, значит сеть = он минус 1.
    const first = ipToInt(serverAddress(subnet));
    if (first === null) return null;
    network = (first - 1) >>> 0;
    mask = (0xffffffff << (32 - subnetPrefix(subnet))) >>> 0;
  } catch {
    // Некорректная WG_SUBNET — про это громко скажет ipam при поднятии
    // интерфейса; молча ронять сводку/дашборд из-за этого не станем.
    return null;
  }
  return (address: string): boolean => {
    const ip = ipToInt(address);
    return ip !== null && ((ip & mask) >>> 0) === network;
  };
}

export function usersOutsideSubnet(subnet: string): UserRow[] {
  const inside = subnetMembership(subnet);
  if (!inside) return [];
  return listUsers().filter((u) => !inside(u.address));
}

/**
 * То же, но только счётчик. Отдельная функция, потому что её зовёт overview(),
 * а его дашборд опрашивает каждые 30 секунд: listUsers() поднимал бы в память
 * все строки users целиком — вместе с приватными ключами клиентов и PSK —
 * ради одного числа. Здесь из базы читается ровно колонка address.
 */
export function countUsersOutsideSubnet(subnet: string): number {
  const inside = subnetMembership(subnet);
  if (!inside) return 0;
  const rows = stmt('SELECT address FROM users').all() as Array<{ address: string }>;
  let n = 0;
  for (const r of rows) if (!inside(r.address)) n++;
  return n;
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
      'COALESCE(SUM(CASE WHEN last_handshake > ? AND last_handshake <= ? THEN 1 ELSE 0 END), 0) ' +
      'AS users_online, ' +
      'COALESCE(SUM(total_rx), 0) AS rx_total, ' +
      'COALESCE(SUM(total_tx), 0) AS tx_total ' +
      'FROM users',
    // Верхняя граница — тот же критерий, что в isHandshakeOnline(): метка из
    // будущего иначе держала бы пира «онлайн» бесконечно.
  ).get(now - ONLINE_WINDOW_MS, now + HANDSHAKE_FUTURE_TOLERANCE_MS) as {
    users_total: number;
    users_online: number;
    rx_total: number;
    tx_total: number;
  };

  // Верхняя граница — см. bucketUpperBound(): корзины из далёкого будущего в
  // отчёт не пускаем, но обычный откат часов не должен прятать записанный час.
  const today = stmt(
    'SELECT COALESCE(SUM(rx), 0) AS rx, COALESCE(SUM(tx), 0) AS tx ' +
      'FROM traffic_hourly WHERE hour_ts >= ? AND hour_ts <= ?',
  ).get(startOfLocalDay(now), bucketUpperBound(now)) as { rx: number; tx: number };

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
      // >0 — WG_SUBNET сменили на живой установке: у этих пользователей туннель
      // поднимется, но интернета не будет. Фронтенду стоит показать баннер.
      usersOutsideSubnet: countUsersOutsideSubnet(cfg.wg.subnet),
    },
  };
}

export function timeseries(range: Range, userId?: number): TimeseriesPoint[] {
  const now = Date.now();
  const { starts, daily } = bucketStarts(range, now);
  const from = starts[0];
  // Верхняя граница окна — та же, что у «трафика сегодня» в overview: без неё
  // корзина с меткой из будущего попала бы в дневную точку «сегодня» на графике
  // за 30d, но не попала бы в overview, и те же данные давали бы разные числа.
  const upTo = bucketUpperBound(now);

  const rows = (
    userId !== undefined
      ? stmt(
          'SELECT hour_ts, rx, tx FROM traffic_hourly ' +
            'WHERE user_id = ? AND hour_ts >= ? AND hour_ts <= ?',
        ).all(userId, from, upTo)
      : stmt(
          'SELECT hour_ts, SUM(rx) AS rx, SUM(tx) AS tx FROM traffic_hourly ' +
            'WHERE hour_ts >= ? AND hour_ts <= ? GROUP BY hour_ts',
        ).all(from, upTo)
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
  const now = Date.now();
  const { starts } = bucketStarts(range, now);
  const from = starts[0];
  const upTo = bucketUpperBound(now); // то же окно, что у timeseries и «трафика сегодня»

  // LEFT JOIN — юзеры без трафика за период тоже попадают в список (с нулями).
  return stmt(
    'SELECT u.id AS id, u.name AS name, ' +
      'COALESCE(SUM(t.rx), 0) AS rx, COALESCE(SUM(t.tx), 0) AS tx ' +
      'FROM users u ' +
      'LEFT JOIN traffic_hourly t ON t.user_id = u.id AND t.hour_ts >= ? AND t.hour_ts <= ? ' +
      'GROUP BY u.id, u.name ' +
      'ORDER BY COALESCE(SUM(t.rx), 0) + COALESCE(SUM(t.tx), 0) DESC, u.id ASC',
  ).all(from, upTo) as UserUsage[];
}

/**
 * Онлайн-юзеры (критерий тот же, что в overview.usersOnline) с текущей
 * скоростью из поллера; самые «шумные» — первыми.
 */
export function onlineUsers(): OnlineUserDTO[] {
  const now = Date.now();
  // Обе границы — как в isHandshakeOnline(): метка из будущего не должна
  // навсегда прописывать пира в списке онлайна.
  const rows = stmt(
    'SELECT id, name, address, last_handshake FROM users ' +
      'WHERE last_handshake > ? AND last_handshake <= ? ORDER BY id',
  ).all(now - ONLINE_WINDOW_MS, now + HANDSHAKE_FUTURE_TOLERANCE_MS) as Array<{
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
