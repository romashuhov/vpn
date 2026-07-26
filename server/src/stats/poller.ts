// stats/poller.ts — периодический опрос статистики WireGuard и агрегация в БД.
//
// Каждый тик: runner.stats() → матчим пиров с юзерами по publicKey, считаем
// дельты против предыдущего замера (в памяти процесса), прибавляем к total_*
// и раскладываем по часовым корзинам traffic_hourly.

import type { PeerStats } from '../types.js';
import type { WgRunner } from '../wg/runner.js';
import { addHourlyTraffic, listUsers, updateCounters } from '../db.js';

function startOfHour(ts: number): number {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

// Текущая скорость по id юзера (байт/сек): дельта последнего тика, делённая на
// фактически прошедшее время между удачными тиками. Живёт в памяти процесса.
const liveRates = new Map<number, { rateRx: number; rateTx: number; at: number }>();
let pollPeriodMs = 15000; // фактический период поллера, выставляется в startPoller

/**
 * Скорость юзера или null, если замера нет либо он протух (опрос wg падает —
 * applyStats давно не обновлял запись). Протухшую скорость показывать нельзя:
 * юзер ещё числится онлайн по last_handshake, а «текущая» цифра уже мёртвая.
 */
export function getLiveRate(userId: number): { rateRx: number; rateTx: number } | null {
  const rate = liveRates.get(userId);
  if (!rate) return null;
  if (Date.now() - rate.at > 2.5 * pollPeriodMs) return null;
  return { rateRx: rate.rateRx, rateTx: rate.rateTx };
}

export function startPoller(runner: WgRunner, intervalMs: number): void {
  const period = Number.isFinite(intervalMs) && intervalMs >= 1000 ? intervalMs : 15000;
  pollPeriodMs = period;

  // Предыдущий замер по каждому пиру (ключ — publicKey). Живёт только в памяти:
  // после рестарта панели первый замер становится новой базовой точкой.
  const prev = new Map<string, { rx: number; tx: number }>();
  let running = false;
  let lastTickAt: number | null = null; // время предыдущего УДАЧНОГО замера

  function applyStats(stats: PeerStats[], elapsedSec: number | null): void {
    const users = listUsers();
    const byKey = new Map(users.map((u) => [u.publicKey, u]));
    const seen = new Set<string>();
    const seenIds = new Set<number>();
    const hourTs = startOfHour(Date.now());

    for (const peer of stats) {
      const user = byKey.get(peer.publicKey);
      if (!user) continue; // пир без юзера (например, юзер только что удалён)
      seen.add(peer.publicKey);
      seenIds.add(user.id);

      const last = prev.get(peer.publicKey);
      prev.set(peer.publicKey, { rx: peer.rx, tx: peer.tx });

      // Первый замер после старта процесса — только базовая точка (дельта 0),
      // иначе накопленные счётчики интерфейса задвоят total после рестарта панели.
      let dRx = 0;
      let dTx = 0;
      if (last) {
        // cur < prev — интерфейс перезапускался, счётчики пошли с нуля.
        dRx = peer.rx >= last.rx ? peer.rx - last.rx : peer.rx;
        dTx = peer.tx >= last.tx ? peer.tx - last.tx : peer.tx;
      }

      // Скорость: у первого замера (last/elapsedSec отсутствуют) — нули.
      if (last && elapsedSec !== null && elapsedSec > 0) {
        liveRates.set(user.id, {
          rateRx: dRx / elapsedSec,
          rateTx: dTx / elapsedSec,
          at: Date.now(),
        });
      } else {
        liveRates.set(user.id, { rateRx: 0, rateTx: 0, at: Date.now() });
      }

      // Время хендшейка двигаем только ВПЕРЁД. Свежесозданный интерфейс
      // (рестарт панели, смена движка, перезагрузка сервера) отдаёт для всех
      // пиров нулевой хендшейк — то есть «никогда». Записав этот ноль, мы бы
      // стёрли историю: юзер, который вчера выкачал гигабайты, показывался бы
      // как ни разу не подключавшийся.
      const nextHandshake =
        peer.lastHandshake !== null &&
        (user.lastHandshake === null || peer.lastHandshake > user.lastHandshake)
          ? peer.lastHandshake
          : user.lastHandshake;
      const handshakeChanged = nextHandshake !== user.lastHandshake;
      if (dRx <= 0 && dTx <= 0 && !handshakeChanged) continue; // писать нечего

      try {
        updateCounters(user.id, {
          totalRx: user.totalRx + dRx,
          totalTx: user.totalTx + dTx,
          lastHandshake: nextHandshake,
        });
        if (dRx > 0 || dTx > 0) {
          addHourlyTraffic(user.id, hourTs, dRx, dTx);
        }
      } catch (err) {
        console.error(`[poller] не удалось сохранить статистику юзера #${user.id}:`, err);
      }
    }

    // Убираем замеры исчезнувших пиров (удалённые/выключенные юзеры), чтобы
    // старый счётчик не сматчился с новым пиром и не дал ложную дельту.
    for (const key of prev.keys()) {
      if (!seen.has(key)) prev.delete(key);
    }
    for (const id of liveRates.keys()) {
      if (!seenIds.has(id)) liveRates.delete(id);
    }
  }

  async function tick(): Promise<void> {
    if (running) return; // предыдущий тик ещё не закончился — пропускаем
    running = true;
    try {
      let stats: PeerStats[];
      try {
        stats = await runner.stats();
      } catch (err) {
        console.error('[poller] ошибка опроса статистики, тик пропущен:', err);
        return;
      }
      // Скорость считаем по времени между удачными замерами: если тики
      // пропускались из-за ошибок, дельта размажется на весь реальный интервал.
      const now = Date.now();
      applyStats(stats, lastTickAt === null ? null : (now - lastTickAt) / 1000);
      lastTickAt = now;
    } catch (err) {
      console.error('[poller] непредвиденная ошибка тика:', err);
    } finally {
      running = false;
    }
  }

  void tick(); // немедленный первый замер — базовые точки для дельт
  const timer = setInterval(() => void tick(), period);
  timer.unref(); // поллер не должен мешать корректному завершению процесса
}
