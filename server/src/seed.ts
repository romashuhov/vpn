// seed.ts — демо-данные для mock-режима: 5 юзеров и правдоподобная история
// трафика за 30 дней (суточный ритм, у каждого юзера свой масштаб потребления).

import type { Config } from './config.js';
import { addHourlyTraffic, createUser, getDb, listUsers, updateCounters } from './db.js';
import { nextFreeAddress } from './ipam.js';
import { genKeypair, genPresharedKey } from './wg/keys.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Суточный ритм: относительный вес каждого часа (локальное время).
// Ночью почти ноль, днём ровно, вечером (19–22) пик. Нормализуется по сумме.
const HOUR_WEIGHTS = [
  0.018, 0.012, 0.008, 0.006, 0.008, 0.015, // 00–05: почти тишина
  0.04, 0.09, 0.16, 0.24, 0.3, 0.34, //        06–11: утренний разгон
  0.38, 0.36, 0.33, 0.34, 0.38, 0.46, //       12–17: рабочий день
  0.62, 0.85, 1.0, 0.95, 0.55, 0.16, //        18–23: вечерний пик и отбой
];
const WEIGHT_SUM = HOUR_WEIGHTS.reduce((a, b) => a + b, 0);

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function startOfHour(ts: number): number {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

interface DemoProfile {
  name: string;
  /** Средний «даунлоад» клиента (tx сервера) за активный день, байт. */
  perDayTx: number;
  /** Вероятность, что в конкретный день юзер вообще не выходил в сеть. */
  skipDayChance: number;
  /** Как давно был последний хендшейк (мс назад от «сейчас»). */
  handshakeAgoMs: () => number;
}

// Масштабы: от сотен МБ (Даша) до десятков ГБ (Алиса) суммарно за месяц.
// Двое «онлайн» прямо сейчас (хендшейк 1–2 минуты назад), остальные —
// от нескольких часов до нескольких дней назад.
const PROFILES: DemoProfile[] = [
  { name: 'Алиса', perDayTx: 1.3e9, skipDayChance: 0.05, handshakeAgoMs: () => rand(45_000, 110_000) },
  { name: 'Борис', perDayTx: 4.5e8, skipDayChance: 0.12, handshakeAgoMs: () => rand(60_000, 120_000) },
  { name: 'Виктор', perDayTx: 1.7e8, skipDayChance: 0.2, handshakeAgoMs: () => rand(4, 8) * HOUR },
  { name: 'Галина', perDayTx: 6.5e7, skipDayChance: 0.25, handshakeAgoMs: () => rand(20, 40) * HOUR },
  { name: 'Даша', perDayTx: 2.5e7, skipDayChance: 0.35, handshakeAgoMs: () => rand(4.5, 7) * DAY },
];

/**
 * Бэкфилл traffic_hourly одного юзера за последние 30 дней.
 * Трафик идёт только до момента последнего хендшейка. Возвращает суммы.
 */
function backfillUser(
  userId: number,
  profile: DemoProfile,
  lastHandshake: number,
  now: number,
): { totalRx: number; totalTx: number } {
  const endHour = startOfHour(now);
  const startHour = endHour - 30 * 24 * HOUR + HOUR; // 720 часов, включая текущий
  const skipDays = new Map<number, boolean>();
  let totalRx = 0;
  let totalTx = 0;

  for (let ts = startHour; ts <= endHour; ts += HOUR) {
    if (ts > lastHandshake) break; // после последнего хендшейка трафика нет

    const d = new Date(ts);
    const dayStart = new Date(ts);
    dayStart.setHours(0, 0, 0, 0);
    const dayKey = dayStart.getTime();

    let skip = skipDays.get(dayKey);
    if (skip === undefined) {
      skip = Math.random() < profile.skipDayChance;
      skipDays.set(dayKey, skip);
    }
    if (skip) continue; // в этот день юзер не подключался

    const dow = d.getDay();
    const weekendFactor = dow === 0 || dow === 6 ? 1.35 : 1;
    // Текущий (неполный) час — пропорционально прошедшей его части.
    const partialFactor = ts === endHour ? Math.max((now - ts) / HOUR, 0.05) : 1;

    let txBytes =
      profile.perDayTx * (HOUR_WEIGHTS[d.getHours()] / WEIGHT_SUM) * weekendFactor * rand(0.35, 1.6);
    if (Math.random() < 0.02) txBytes *= rand(2.5, 4); // редкий вечер «с сериалом»
    txBytes *= partialFactor;

    const tx = Math.round(txBytes);
    const rx = Math.round(txBytes * rand(0.05, 0.16)); // upload — малая доля download
    if (tx <= 0 && rx <= 0) continue;

    addHourlyTraffic(userId, ts, rx, tx);
    totalRx += rx;
    totalTx += tx;
  }

  return { totalRx, totalTx };
}

export function maybeSeedDemo(cfg: Config): void {
  if (!cfg.wg.mockSeed) return;
  if (listUsers().length > 0) return; // сеем только в пустую БД

  const now = Date.now();
  const db = getDb();
  const backdate = db.prepare('UPDATE users SET created_at = ?, updated_at = ? WHERE id = ?');

  const seedAll = db.transaction(() => {
    const taken: string[] = [];
    for (const profile of PROFILES) {
      const { privateKey, publicKey } = genKeypair();
      const presharedKey = genPresharedKey();
      const address = nextFreeAddress(cfg.wg.subnet, taken);
      taken.push(address);

      const user = createUser({ name: profile.name, privateKey, publicKey, presharedKey, address });

      // Правдоподобный возраст аккаунта: заведён 31–45 дней назад,
      // чтобы 30-дневная история не начиналась раньше created_at.
      const createdAt = now - Math.round(rand(31, 45) * DAY);
      backdate.run(createdAt, createdAt, user.id);

      const lastHandshake = Math.round(now - profile.handshakeAgoMs());
      const { totalRx, totalTx } = backfillUser(user.id, profile, lastHandshake, now);
      updateCounters(user.id, { totalRx, totalTx, lastHandshake });
    }
  });

  try {
    seedAll();
    console.log('[seed] мок-режим: созданы 5 демо-пользователей и история трафика за 30 дней');
  } catch (err) {
    // Транзакция откатилась целиком — панель продолжает работать без демо-данных.
    console.error('[seed] не удалось засеять демо-данные:', err);
  }
}
