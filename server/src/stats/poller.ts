// stats/poller.ts — периодический опрос статистики WireGuard и агрегация в БД.
//
// Каждый тик: runner.stats() → матчим пиров с юзерами по publicKey, считаем
// дельты против предыдущего замера (в памяти процесса), прибавляем к total_*
// и раскладываем по часовым корзинам traffic_hourly.

import type { PeerStats } from '../types.js';
import { HANDSHAKE_FUTURE_SKEW_MS, ONLINE_WINDOW_MS } from '../types.js';
import type { WgRunner } from '../wg/runner.js';
import { InvalidMetricError, listUsers, recordTraffic, type TrafficBucket } from '../db.js';

const HOUR_MS = 3_600_000;

function startOfHour(ts: number): number {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/**
 * Максимум часовых корзин, по которым размазывается одна дельта. Ограничение
 * защищает от гигантской транзакции, если панель сутками не могла писать в БД.
 */
const MAX_SPREAD_HOURS = 168; // неделя

// Текущая скорость по id юзера (байт/сек): дельта последнего тика, делённая на
// фактически прошедшее время между удачными тиками. Живёт в памяти процесса.
const liveRates = new Map<number, { rateRx: number; rateTx: number; at: number }>();
let pollPeriodMs = 15000; // фактический период поллера, выставляется в startPoller

// Жалобы на сломанные часы дросселируем: иначе при сбитом времени лог будет
// заполняться одной и той же строкой каждые 15 секунд по каждому пиру.
const CLOCK_WARN_INTERVAL_MS = 600_000;
const clockWarnedAt = new Map<string, number>();

function warnClock(key: string, message: string): void {
  const now = Date.now();
  const at = clockWarnedAt.get(key);
  if (at !== undefined && now - at < CLOCK_WARN_INTERVAL_MS) return;
  clockWarnedAt.set(key, now);
  console.error(message);
}

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

interface HandshakeDecision {
  value: number | null;
  /** В замере пришла метка из будущего — как источник она непригодна. */
  observedFromFuture: boolean;
  /** В БД уже лежала метка из будущего — её пришлось откатить назад. */
  storedRepaired: boolean;
}

/**
 * Куда опускается испорченная (пришедшая из будущего) метка в БД: заведомо за
 * пределы окна онлайна. Подставлять «сейчас» нельзя — это выдуманное значение,
 * неотличимое от настоящего: пир, не подключавшийся неделями, после исправления
 * часов мгновенно становился бы «онлайн» с зелёной точкой и подписью
 * «подключился только что», хотя трафика нет. Настоящая метка в этом сценарии
 * уже потеряна, и честнее показать «давно», чем правдоподобную выдумку.
 */
function repairedHandshakeBase(now: number): number {
  return now - ONLINE_WINDOW_MS - 1;
}

/**
 * Правило «хендшейк только вперёд» с верхней границей.
 *
 * Только вперёд — потому что свежесозданный интерфейс (рестарт панели, смена
 * движка, перезагрузка сервера) отдаёт для всех пиров нулевой хендшейк, то
 * есть «никогда»; записав этот ноль, мы бы стёрли историю.
 *
 * Верхняя граница — потому что монотонность без потолка необратима. Если часы
 * сервера хоть раз ушли в будущее (VPS без RTC, снапшот ВМ, старт до синка
 * NTP, ручной date -s), в last_handshake попадёт метка из будущего, и дальше
 * НИ ОДИН реальный хендшейк её уже не перебьёт: юзер навсегда «онлайн»
 * (Date.now() - lastHandshake даёт отрицательное число, т.е. всегда < 180 с),
 * а фактические подключения перестают фиксироваться. Самоизлечения нет.
 *
 * Поэтому: метка из будущего как источник игнорируется, а уже сохранённая
 * метка из будущего чинится — она опускается ЗА пределы окна онлайна (см.
 * repairedHandshakeBase) и дальше нормально перебивается свежими значениями.
 * Если в этом же тике пришёл валидный хендшейк, он всё равно победит: он
 * заведомо новее опущенной базы.
 */
function resolveHandshake(
  stored: number | null,
  observed: number | null,
  now: number,
): HandshakeDecision {
  const limit = now + HANDSHAKE_FUTURE_SKEW_MS;
  const observedFromFuture = observed !== null && observed > limit;
  const storedRepaired = stored !== null && stored > limit;

  const base = storedRepaired ? repairedHandshakeBase(now) : stored;
  const fresh = observed !== null && observed > 0 && !observedFromFuture ? observed : null;
  const value = fresh !== null && (base === null || fresh > base) ? fresh : base;

  return { value, observedFromFuture, storedRepaired };
}

type NonEmptyBuckets = [TrafficBucket, ...TrafficBucket[]];

/**
 * Разложить дельту между двумя удачными замерами по часовым корзинам
 * пропорционально времени.
 *
 * Обычный тик (15 сек) целиком попадает в текущий час — тогда возвращается
 * одна корзина, поведение прежнее. Но если замеры прерывались дольше часа
 * (wg не отвечал, БД была недоступна), весь накопленный трафик сваливался бы
 * в текущий час: на графике дыра, следом пик, а через полночь трафик ещё и
 * «переезжал» из вчера в сегодня, ломая «за сегодня» в обзоре.
 */
function splitDeltaByHour(fromTs: number, toTs: number, rx: number, tx: number): NonEmptyBuckets {
  const currentHour = startOfHour(toTs);
  // Критерий ровно один — попадают ли оба конца интервала в ОДИН час. Раньше
  // здесь была ещё проверка длительности (> часа), из-за которой разрыв короче
  // часа не разносился вовсе: пауза с 23:20 до 00:10 (одна неудачная запись плюс
  // пара пропущенных тиков) целиком ложилась в корзину 00:00 нового дня и
  // завышала «трафик за сегодня» на вчерашние байты — тот самый переезд трафика
  // через полночь, ради которого функция и написана. Обычный 15-секундный тик
  // почти всегда остаётся в одном часе, так что поведение не меняется.
  if (startOfHour(fromTs) === currentHour) {
    return [{ hourTs: currentHour, rx, tx }];
  }

  const start = Math.max(fromTs, toTs - MAX_SPREAD_HOURS * HOUR_MS);
  const segments: { hourTs: number; ms: number }[] = [];
  let cursor = start;
  while (cursor < toTs && segments.length <= MAX_SPREAD_HOURS) {
    const bucket = startOfHour(cursor);
    const d = new Date(bucket);
    d.setHours(d.getHours() + 1);
    const boundary = d.getTime();
    const end = boundary > cursor ? Math.min(boundary, toTs) : toTs;
    segments.push({ hourTs: bucket, ms: end - cursor });
    cursor = end;
  }

  const totalMs = segments.reduce((s, x) => s + x.ms, 0);
  if (segments.length === 0 || totalMs <= 0) return [{ hourTs: currentHour, rx, tx }];

  // Целочисленное распределение с остатком в последнюю корзину: сумма корзин
  // обязана в точности равняться дельте, иначе total_* разойдётся с графиками.
  const out: TrafficBucket[] = [];
  let usedRx = 0;
  let usedTx = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isLast = i === segments.length - 1;
    const bRx = isLast ? rx - usedRx : Math.floor((rx * seg.ms) / totalMs);
    const bTx = isLast ? tx - usedTx : Math.floor((tx * seg.ms) / totalMs);
    usedRx += bRx;
    usedTx += bTx;
    if (bRx > 0 || bTx > 0) out.push({ hourTs: seg.hourTs, rx: bRx, tx: bTx });
  }

  if (out.length === 0) return [{ hourTs: currentHour, rx, tx }];
  const [head, ...rest] = out;
  return [head, ...rest];
}

export function startPoller(runner: WgRunner, intervalMs: number): void {
  const period = Number.isFinite(intervalMs) && intervalMs >= 1000 ? intervalMs : 15000;
  pollPeriodMs = period;

  // Предыдущий замер по каждому пиру (ключ — publicKey). Живёт только в памяти:
  // после рестарта панели первый замер становится новой базовой точкой.
  // `at` — момент, на который эта базовая точка зафиксирована; из него же
  // считается и скорость, и интервал для разложения дельты по часам.
  const prev = new Map<string, { rx: number; tx: number; at: number }>();

  function applyStats(stats: PeerStats[], now: number): void {
    const users = listUsers();
    const byKey = new Map(users.map((u) => [u.publicKey, u]));
    const seen = new Set<string>();
    const seenIds = new Set<number>();

    for (const peer of stats) {
      const user = byKey.get(peer.publicKey);
      if (!user) continue; // пир без юзера (например, юзер только что удалён)
      seen.add(peer.publicKey);
      seenIds.add(user.id);

      const last = prev.get(peer.publicKey);

      // Первый замер после старта процесса — только базовая точка (дельта 0),
      // иначе накопленные счётчики интерфейса задвоят total после рестарта панели.
      let dRx = 0;
      let dTx = 0;
      if (last) {
        // cur < prev — интерфейс перезапускался, счётчики пошли с нуля.
        dRx = peer.rx >= last.rx ? peer.rx - last.rx : peer.rx;
        dTx = peer.tx >= last.tx ? peer.tx - last.tx : peer.tx;
      }

      // Скорость: у первого замера (last отсутствует) — нули. Интервал берём
      // от базовой точки, а не «один период»: если запись в БД падала, дельта
      // накопилась за несколько периодов и делить её надо на них же.
      const elapsedSec = last ? (now - last.at) / 1000 : 0;
      liveRates.set(
        user.id,
        elapsedSec > 0
          ? { rateRx: dRx / elapsedSec, rateTx: dTx / elapsedSec, at: now }
          : { rateRx: 0, rateTx: 0, at: now },
      );

      const hs = resolveHandshake(user.lastHandshake, peer.lastHandshake, now);
      if (hs.observedFromFuture) {
        warnClock(
          `observed:${peer.publicKey}`,
          `[poller] хендшейк пира ${peer.publicKey} помечен будущим временем ` +
            `(${new Date(peer.lastHandshake ?? 0).toISOString()}, сейчас ${new Date(now).toISOString()}) — ` +
            'значение проигнорировано, проверьте часы сервера (NTP)',
        );
      }
      if (hs.storedRepaired) {
        warnClock(
          `stored:${peer.publicKey}`,
          `[poller] в БД у пользователя #${user.id} была метка хендшейка из будущего ` +
            `(${new Date(user.lastHandshake ?? 0).toISOString()}) — она отброшена как ` +
            'непригодная и заменена на «давно» (вне окна онлайна). Настоящее время ' +
            'последнего подключения восстановить неоткуда: оно потеряно ещё при записи. ' +
            'Проверьте часы сервера (NTP).',
        );
      }
      const handshakeChanged = hs.value !== user.lastHandshake;

      if (dRx <= 0 && dTx <= 0 && !handshakeChanged) {
        // Писать нечего, но базовую точку двигаем: дельта действительно нулевая.
        prev.set(peer.publicKey, { rx: peer.rx, tx: peer.tx, at: now });
        continue;
      }

      const buckets: NonEmptyBuckets =
        dRx > 0 || dTx > 0
          ? splitDeltaByHour(last ? last.at : now, now, dRx, dTx)
          : [{ hourTs: startOfHour(now), rx: 0, tx: 0 }];
      const [head, ...rest] = buckets;

      try {
        // Счётчики и корзины — одной транзакцией: иначе при отказе между двумя
        // statement'ами total_* уедет вперёд относительно графиков навсегда.
        recordTraffic(
          user.id,
          {
            totalRx: user.totalRx + dRx,
            totalTx: user.totalTx + dTx,
            lastHandshake: hs.value,
          },
          head.hourTs,
          head.rx,
          head.tx,
          rest,
        );
        // Базовую точку двигаем ТОЛЬКО после успешной записи. Иначе дельта
        // «съедена» из памяти, а в БД не попала — байты теряются навсегда.
        prev.set(peer.publicKey, { rx: peer.rx, tx: peer.tx, at: now });
      } catch (err) {
        if (err instanceof InvalidMetricError) {
          // Ошибка валидации детерминирована: базовая точка не двигается, на
          // следующем тике считается ТА ЖЕ испорченная дельта и летит то же
          // исключение. Статистика юзера замерла бы навсегда, а лог каждые 15
          // секунд успокаивающе обещал бы запись «следующим тиком». Поэтому
          // здесь базовую точку сдвигаем принудительно: испорченная дельта
          // теряется (её всё равно нельзя записать), зато сбор возобновляется.
          prev.set(peer.publicKey, { rx: peer.rx, tx: peer.tx, at: now });
          console.error(
            `[poller] замер юзера #${user.id} испорчен и записан быть не может ` +
              '(нечисловое значение). Эта дельта потеряна, базовая точка сброшена — ' +
              'дальнейший трафик считается заново. Если повторяется, проверьте ' +
              'total_rx/total_tx этого пользователя в базе:',
            err,
          );
          continue;
        }
        console.error(
          `[poller] не удалось сохранить статистику юзера #${user.id} ` +
            '(дельта сохранена в памяти и будет записана следующим тиком):',
          err,
        );
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

  // Сторожевой таймер — страховка для раннеров БЕЗ собственного таймаута.
  // Реальный LinuxRunner ограничивает stats() сам (execFile.timeout плюс
  // страховочный таймер по стене, суммарно ~15 с), так что до этой ветки он не
  // доходит; mock и любой будущий раннер такой гарантии не дают, а зависший
  // промис оставил бы флаг «тик выполняется» взведённым навсегда — сбор
  // статистики умер бы молча, не написав в лог ни строки.
  //
  // Порог не даём опустить ниже минуты: при POLL_INTERVAL_MS=1000 (нижняя
  // допустимая граница) пять периодов = 5 с, то есть МЕНЬШЕ собственного
  // таймаута LinuxRunner, и мы штатно запускали бы по несколько параллельных
  // `wg show dump`. Отменить уже улетевший вызов мы не можем (WgRunner.stats()
  // не принимает AbortSignal), поэтому единственная защита — не объявлять тик
  // зависшим раньше, чем раннер успел бы сдаться сам.
  const STUCK_PERIODS = 5;
  const STUCK_MIN_MS = 60_000;
  const stuckAfterMs = Math.max(period * STUCK_PERIODS, STUCK_MIN_MS);
  let tickSeq = 0;
  let activeTick: { token: number; startedAt: number } | null = null;

  async function tick(): Promise<void> {
    if (activeTick !== null) {
      const busyForMs = Date.now() - activeTick.startedAt;
      if (busyForMs <= stuckAfterMs) return; // предыдущий тик ещё жив
      console.error(
        `[poller] предыдущий опрос статистики не завершился за ${Math.round(busyForMs / 1000)} с ` +
          '— считаю его зависшим и запускаю новый. Отменить его нельзя: старый вызов ' +
          'остаётся в полёте вместе со своим дочерним процессом. Проверьте, отвечает ли wg/awg.',
      );
    }

    const token = ++tickSeq;
    activeTick = { token, startedAt: Date.now() };
    try {
      let stats: PeerStats[];
      try {
        stats = await runner.stats();
      } catch (err) {
        console.error('[poller] ошибка опроса статистики, тик пропущен:', err);
        return;
      }
      // Зависший тик мог «ожить» уже после того, как его сменили. Его данные
      // устарели, а базовые точки успел подвинуть более свежий тик — применив
      // их, мы задвоили бы или потеряли трафик.
      if (activeTick === null || activeTick.token !== token) {
        console.error('[poller] результат просроченного тика отброшен');
        return;
      }
      applyStats(stats, Date.now());
    } catch (err) {
      console.error('[poller] непредвиденная ошибка тика:', err);
    } finally {
      if (activeTick !== null && activeTick.token === token) activeTick = null;
    }
  }

  void tick(); // немедленный первый замер — базовые точки для дельт
  const timer = setInterval(() => void tick(), period);
  timer.unref(); // поллер не должен мешать корректному завершению процесса
}
