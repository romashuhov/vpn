// awg.ts — параметры обфускации AmneziaWG (набор AWG 1.5: Jc/Jmin/Jmax/S1/S2/H1..H4).
//
// Главное требование — СТАБИЛЬНОСТЬ. S1, S2 и H1..H4 обязаны совпадать на
// сервере и клиенте, поэтому значения генерируются ровно один раз и хранятся
// в settings. Если они изменятся между рестартами, у ВСЕХ выданных клиентов
// пропадёт связь. Отсюда же и порядок приоритетов:
//   env (AWG_*) > settings в БД > свежая генерация (с записью в БД).
//
// env НЕ переписывает уже сохранённое значение в БД (это именно закрепление на
// время работы), но если ключа в settings нет, а env его задаёт, значение туда
// ДОПИСЫВАЕТСЯ. Причина неочевидна: набор ключей awg_* в базе обязан быть
// полным. Раньше закреплённые через env поля в БД не попадали, и в settings
// оседал неполный набор; после этого штатное действие «убрать аварийное
// переопределение из deploy/.env» превращало рабочую панель в незапускаемую —
// resolveExisting видел пропавший ключ и останавливал запуск (чинилось только
// ручным INSERT в settings). Значение из env к этому моменту уже зашито во все
// выданные конфиги, так что его запись в БД — фиксация факта, а не подмена.
//
// Ключевое правило целостности (см. resolveExisting): генерация S1/S2/H1..H4
// допустима ТОЛЬКО когда в settings нет НИ ОДНОГО ключа awg_* — то есть на
// первом запуске, когда клиентских конфигов ещё не существует. Если параметры в
// БД уже есть, но какой-то из них испорчен/конфликтует, мы НИКОГДА не подменяем
// и не перезаписываем их: подмена мгновенно и необратимо убила бы все выданные
// конфиги, причём молча. Вместо этого — громкая ошибка и остановка запуска.
// Исключение — Jc/Jmin/Jmax: по ARCHITECTURE.md они у сервера и клиента
// совпадать не обязаны, поэтому пропавшее значение восстанавливается генерацией
// с громким warning, а не роняет панель целиком.
//
// Параметры AWG 2.0 (S3/S4, I1..I5, Itime) намеренно не реализованы: они
// требуют ручного подбора сигнатур и клиента соответствующей версии.

import { randomInt } from 'node:crypto';
import type { Config } from './config.js';
import type { AwgParams } from './types.js';
import { getSetting, setSetting } from './db.js';

export type { AwgParams } from './types.js';

/** Ключи AwgParams в порядке вывода в конфиг. */
const FIELDS = ['jc', 'jmin', 'jmax', 's1', 's2', 'h1', 'h2', 'h3', 'h4'] as const;
type Field = (typeof FIELDS)[number];

/** Допустимые диапазоны каждого параметра (включительно). */
const RANGES: Record<Field, { min: number; max: number }> = {
  jc: { min: 1, max: 128 },
  jmin: { min: 0, max: 1279 },
  jmax: { min: 1, max: 1279 },
  s1: { min: 0, max: 1132 },
  s2: { min: 0, max: 1188 },
  h1: { min: 5, max: 2147483647 },
  h2: { min: 5, max: 2147483647 },
  h3: { min: 5, max: 2147483647 },
  h4: { min: 5, max: 2147483647 },
};

const H_MIN = RANGES.h1.min;
const H_MAX = RANGES.h1.max;

/** Имя ключа в таблице settings. */
function settingKey(f: Field): string {
  return `awg_${f}`;
}

/** Имя env-переменной (для сообщений об ошибках). */
function envName(f: Field): string {
  return `AWG_${f.toUpperCase()}`;
}

/** Разбор одного значения: целое в допустимом диапазоне либо текст проблемы. */
function parseFieldValue(f: Field, raw: string): { value: number } | { error: string } {
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    return { error: `«${raw}» — не целое число` };
  }
  const { min, max } = RANGES[f];
  if (n < min || n > max) {
    return { error: `${n} вне допустимого диапазона ${min}..${max}` };
  }
  return { value: n };
}

/** Строка → целое в допустимом диапазоне поля, либо null (с записью причины). */
function parseField(f: Field, raw: string, source: string): number | null {
  const parsed = parseFieldValue(f, raw);
  if ('error' in parsed) {
    console.error(`[awg] ${source}: ${parsed.error}, значение игнорируется`);
    return null;
  }
  return parsed.value;
}

/** Случайное целое в [min, max] включительно. */
function rnd(min: number, max: number): number {
  return randomInt(min, max + 1);
}

/**
 * Четыре РАЗНЫХ magic-заголовка, разнесённых по диапазону 5..2147483647:
 * диапазон делится на четыре непересекающиеся полосы, из каждой берётся одно
 * случайное значение, затем порядок перемешивается (чтобы h1<h2<h3<h4 не было
 * само по себе сигнатурой).
 */
function genHeaders(): number[] {
  const span = H_MAX - H_MIN + 1;
  const band = Math.floor(span / 4);
  const values = [0, 1, 2, 3].map((i) => {
    const lo = H_MIN + i * band;
    return rnd(lo, lo + band - 1);
  });
  for (let i = values.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

/** Значение по умолчанию для поля, если его нигде нет. */
function generate(f: Field): number {
  switch (f) {
    case 'jc':
      return rnd(4, 12); // типичный рабочий диапазон
    case 'jmin':
      return 50;
    case 'jmax':
      return 1000;
    case 's1':
    case 's2':
      return rnd(15, 150);
    default:
      return rnd(H_MIN, H_MAX); // на практике перекрывается genHeaders()
  }
}

/** Поля, которые можно безопасно перегенерировать у РАБОТАЮЩЕЙ установки. */
const REGENERABLE: ReadonlySet<Field> = new Set<Field>(['jc', 'jmin', 'jmax']);

interface Resolved {
  value: number;
  /** Значение закреплено через env — правки конфликтов на нём запрещены. */
  pinned: boolean;
}

/** Присвоить полю новое значение. */
function assign(r: Resolved, value: number): void {
  r.value = value;
}

/**
 * Останавливает запуск, подробно объяснив, что именно сломано и как это чинить.
 * Отдельная функция — чтобы текст «почему мы не чиним молча» был ровно один.
 *
 * `firstRun` обязателен: на первом запуске в settings ещё пусто и конфигов никто
 * не получал, поэтому советы «восстановите awg_* из бэкапа» и «удалите awg_* из
 * settings» там не просто бесполезны — они уводят от единственной настоящей
 * причины (неверные AWG_* в deploy/.env).
 */
function failIntegrity(problems: string[], firstRun: boolean): never {
  console.error('[awg] ==========================================================================');
  console.error('[awg] ОСТАНОВКА: параметры обфускации AmneziaWG невалидны, запуск прерван.');
  for (const p of problems) console.error(`[awg]   • ${p}`);
  if (firstRun) {
    console.error(
      '[awg] Это ПЕРВЫЙ запуск в режиме awg: параметры ещё не сохранены, клиентские конфиги ' +
        'не выдавались, база не изменена. Причина всегда в значениях AWG_* из deploy/.env — ' +
        'поправьте перечисленные выше и запустите панель снова. Проще всего убрать эти ' +
        'переменные совсем: без них корректный набор параметров сгенерируется сам.',
    );
    console.error('[awg] ==========================================================================');
    throw new Error(`Параметры обфускации AmneziaWG невалидны: ${problems.join('; ')}`);
  }
  console.error(
    '[awg] Эти значения уже зашиты во ВСЕ ранее выданные клиентские конфиги. ' +
      'Сгенерировать новые вместо испорченных — значит мгновенно и необратимо ' +
      'оборвать связь у всех клиентов, и владелец узнал бы об этом только по ' +
      'жалобам. Поэтому база НЕ изменена и ничего не перегенерировано.',
  );
  console.error('[awg] Как починить (любой из вариантов, затем перезапустить панель):');
  console.error(
    `[awg]   1) задать корректные значения через AWG_* в deploy/.env — env приоритетнее ` +
      'базы и саму базу не меняет (это штатный аварийный путь);',
  );
  console.error('[awg]   2) восстановить ключи awg_* в таблице settings из резервной копии БД;');
  console.error(
    '[awg]   3) только если готовы перевыдать конфиги ВСЕМ пользователям — удалить из ' +
      'таблицы settings ВСЕ ключи awg_* сразу; тогда параметры сгенерируются заново.',
  );
  console.error('[awg] ==========================================================================');
  throw new Error(`Параметры обфускации AmneziaWG невалидны: ${problems.join('; ')}`);
}

/**
 * Совместные ограничения, которые нельзя проверить по одному полю. Применяется
 * ТОЛЬКО на первом запуске (когда в БД ещё ничего нет и ломать нечего).
 * Правило разрешения конфликта: правим то поле, которое НЕ закреплено env.
 *
 * Если конфликтуют ДВА закреплённых env значения — это фатально, молча править
 * их нельзя. Отказ, который закрывается: раньше пара AWG_S1=100/AWG_S2=156
 * давала warning, S2 молча становился 155, панель поднималась и раздавала
 * конфиги с S2=155 — а любой следующий рестарт шёл уже через resolveExisting,
 * где та же пара из env даёт `s1 + 56 === s2` и останавливает запуск. Панель,
 * месяц проработавшая в проде, не поднималась после рутинного ./restart.sh.
 * Вдобавок источник правды расходился с реальностью: в .env и в сообщениях
 * значилось 156, а у клиентов было 155. Теперь владелец получает ошибку сразу,
 * ДО выдачи первого конфига.
 */
function enforceJointRules(r: Record<Field, Resolved>): void {
  const fatal: string[] = [];

  // 0 <= Jmin < Jmax < 1280
  if (r.jmin.value >= r.jmax.value) {
    if (r.jmin.pinned && r.jmax.pinned) {
      fatal.push(
        `${envName('jmin')}=${r.jmin.value} и ${envName('jmax')}=${r.jmax.value} нарушают ` +
          'требование Jmin < Jmax — задайте корректную пару значений',
      );
    } else {
      console.error(
        `[awg] нарушено требование Jmin < Jmax (Jmin=${r.jmin.value}, Jmax=${r.jmax.value}) — исправляю`,
      );
      if (!r.jmax.pinned) {
        assign(r.jmax, Math.min(1279, r.jmin.value + 1));
        if (r.jmin.value >= r.jmax.value) assign(r.jmin, r.jmax.value - 1);
      } else {
        assign(r.jmin, Math.max(0, r.jmax.value - 1));
      }
    }
  }

  // S1 + 56 != S2 (иначе init-пакет неотличим от response-пакета)
  if (r.s1.value + 56 === r.s2.value) {
    if (r.s1.pinned && r.s2.pinned) {
      fatal.push(
        `${envName('s1')}=${r.s1.value} и ${envName('s2')}=${r.s2.value} нарушают требование ` +
          'S1 + 56 != S2 (init-пакет неотличим от response) — задайте корректную пару значений',
      );
    } else {
      console.error(
        `[awg] нарушено требование S1 + 56 != S2 (S1=${r.s1.value}, S2=${r.s2.value}) — исправляю`,
      );
      if (!r.s2.pinned) {
        assign(r.s2, r.s2.value > RANGES.s2.min ? r.s2.value - 1 : r.s2.value + 1);
      } else {
        assign(r.s1, r.s1.value > RANGES.s1.min ? r.s1.value - 1 : r.s1.value + 1);
      }
    }
  }

  // H1..H4 обязаны попарно различаться
  const headers: Field[] = ['h1', 'h2', 'h3', 'h4'];
  const seen = new Set<number>();
  for (const f of headers) {
    if (!seen.has(r[f].value)) {
      seen.add(r[f].value);
      continue;
    }
    if (r[f].pinned) {
      // Заменить закреплённое env значение случайным нельзя: env приоритетнее
      // базы, значит при каждом рестарте конфликт возникал бы заново и давал
      // НОВОЕ число — все клиентские конфиги умирали бы после первого же
      // перезапуска панели.
      fatal.push(
        `${envName(f)}=${r[f].value} дублирует другой magic-заголовок; H1..H4 обязаны ` +
          'попарно различаться — задайте другое значение',
      );
      continue;
    }
    console.error(`[awg] ${f.toUpperCase()} дублирует другой magic-заголовок — генерирую новый`);
    let candidate = r[f].value;
    // Диапазон 5..2^31-1 огромен, коллизия практически исключена; цикл — страховка.
    for (let attempt = 0; attempt < 100 && seen.has(candidate); attempt++) {
      candidate = rnd(H_MIN, H_MAX);
    }
    assign(r[f], candidate);
    seen.add(candidate);
  }

  if (fatal.length > 0) failIntegrity(fatal, true);
}

/**
 * Первый запуск: в settings нет ни одного ключа awg_*, клиентских конфигов ещё
 * не существует — значит генерировать безопасно. env, если задан, приоритетнее.
 */
function resolveFirstRun(cfg: Config): AwgParams {
  const resolved = {} as Record<Field, Resolved>;
  for (const f of FIELDS) {
    const fromEnv = cfg.awgEnv[f];
    if (fromEnv !== undefined) {
      const v = parseField(f, fromEnv, envName(f));
      if (v !== null) {
        resolved[f] = { value: v, pinned: true };
        continue;
      }
    }
    resolved[f] = { value: generate(f), pinned: false };
  }

  // Если magic-заголовки не закреплены env — берём разнесённый по диапазону
  // набор вместо четырёх независимых случайных чисел.
  const headers: Field[] = ['h1', 'h2', 'h3', 'h4'];
  if (headers.every((f) => !resolved[f].pinned)) {
    const generated = genHeaders();
    headers.forEach((f, i) => assign(resolved[f], generated[i]));
  }

  enforceJointRules(resolved);

  // В БД пишем ВСЕ девять значений, включая закреплённые через env. Отказ,
  // который это закрывает: раньше pinned-поля пропускались, и после первого
  // запуска с хотя бы одним AWG_* в settings оседал НЕПОЛНЫЙ набор ключей.
  // Дальше любое удаление этой переменной из deploy/.env (штатный способ
  // вернуться к дефолту) приводило к остановке запуска в resolveExisting —
  // рабочая панель переставала подниматься, и чинилось это только ручным
  // INSERT в settings. Значения из env к этому моменту уже зашиты в выданные
  // конфиги, так что запись — фиксация факта; приоритет env над БД сохраняется.
  for (const f of FIELDS) {
    setSetting(settingKey(f), String(resolved[f].value));
  }

  return toParams(resolved);
}

/**
 * Установка уже работает: в settings есть хотя бы один ключ awg_*, значит
 * клиентские конфиги, скорее всего, уже выданы. Испорченное значение или
 * нарушенный инвариант здесь фатальны — см. failIntegrity.
 *
 * Отдельно разбирается ПРОПАВШИЙ ключ (его в БД нет вовсе):
 *   • он приходит из env — значение уже зашито в выданные конфиги, поэтому
 *     дописываем его в settings и работаем дальше (восстановление полноты
 *     набора, а не подмена). Иначе следующее же удаление AWG_* из deploy/.env
 *     оставляло бы панель незапускаемой;
 *   • его нет и в env — для S1/S2/H1..H4 это фатально (совпадение с клиентом
 *     обязательно), а для Jc/Jmin/Jmax допустимо сгенерировать заново: по
 *     ARCHITECTURE.md они у сервера и клиента совпадать не обязаны, и ронять
 *     из-за них всю панель нельзя.
 *
 * Записи в БД делаются ТОЛЬКО после того, как все проверки пройдены: при
 * остановке база обязана остаться нетронутой (об этом же говорит failIntegrity).
 */
function resolveExisting(cfg: Config, stored: Record<Field, string | null>): AwgParams {
  const problems: string[] = [];
  const values: Partial<Record<Field, number>> = {};
  const repairs: { f: Field; value: number; message: string }[] = [];

  for (const f of FIELDS) {
    const fromEnv = cfg.awgEnv[f];
    const raw = stored[f];
    if (fromEnv !== undefined) {
      // Невалидный env — предупреждение и фолбэк на БД (контракт ARCHITECTURE.md).
      const v = parseField(f, fromEnv, envName(f));
      if (v !== null) {
        values[f] = v;
        if (raw === null) {
          repairs.push({
            f,
            value: v,
            message:
              `[awg] ${settingKey(f)} не было в базе, но значение закреплено через ${envName(f)} — ` +
              `записываю ${v} в settings. Оно уже зашито в выданные клиентские конфиги, а без ` +
              `записи удаление ${envName(f)} из deploy/.env остановило бы запуск панели.`,
          });
        }
        continue;
      }
    }
    if (raw === null) {
      if (REGENERABLE.has(f)) {
        const v = generate(f);
        values[f] = v;
        repairs.push({
          f,
          value: v,
          message:
            `[awg] ВНИМАНИЕ: ${settingKey(f)} отсутствует и в базе, и в env — сгенерировано ` +
            `значение ${v} и сохранено. Jc/Jmin/Jmax у сервера и клиента совпадать не обязаны ` +
            '(ARCHITECTURE.md), поэтому выданные конфиги от этого не ломаются. Но сам по себе ' +
            'ключ из settings пропасть не может — проверьте целостность базы и бэкапы.',
        });
        continue;
      }
      problems.push(
        `настройка ${settingKey(f)} отсутствует в базе, хотя остальные параметры обфускации ` +
          `есть — восстановите её значение или задайте ${envName(f)}`,
      );
      continue;
    }
    const parsed = parseFieldValue(f, raw);
    if ('error' in parsed) {
      problems.push(
        `настройка ${settingKey(f)} испорчена (${parsed.error}) — исправьте значение в базе ` +
          `или задайте ${envName(f)}`,
      );
      continue;
    }
    values[f] = parsed.value;
  }

  // Совместные инварианты проверяем только когда все значения на месте:
  // иначе сообщение об «конфликте» уводило бы от настоящей причины.
  if (problems.length === 0) {
    const v = values as Record<Field, number>;
    if (v.jmin >= v.jmax) {
      problems.push(
        `нарушено требование Jmin < Jmax (Jmin=${v.jmin}, Jmax=${v.jmax}) — поправьте ` +
          `${envName('jmin')}/${envName('jmax')} или значения в базе`,
      );
    }
    if (v.s1 + 56 === v.s2) {
      problems.push(
        `нарушено требование S1 + 56 != S2 (S1=${v.s1}, S2=${v.s2}): init-пакет неотличим от ` +
          `response — поправьте ${envName('s1')}/${envName('s2')} или значения в базе`,
      );
    }
    const headers: Field[] = ['h1', 'h2', 'h3', 'h4'];
    for (let i = 0; i < headers.length; i++) {
      for (let j = i + 1; j < headers.length; j++) {
        if (v[headers[i]] === v[headers[j]]) {
          problems.push(
            `${headers[i].toUpperCase()} и ${headers[j].toUpperCase()} совпадают (${v[headers[i]]}), ` +
              'а magic-заголовки обязаны попарно различаться',
          );
        }
      }
    }
  }

  if (problems.length > 0) failIntegrity(problems, false);

  // Все проверки пройдены — только теперь можно трогать базу.
  for (const r of repairs) {
    console.error(r.message);
    setSetting(settingKey(r.f), String(r.value));
  }

  const v = values as Record<Field, number>;
  return {
    jc: v.jc,
    jmin: v.jmin,
    jmax: v.jmax,
    s1: v.s1,
    s2: v.s2,
    h1: v.h1,
    h2: v.h2,
    h3: v.h3,
    h4: v.h4,
  };
}

function toParams(r: Record<Field, Resolved>): AwgParams {
  return {
    jc: r.jc.value,
    jmin: r.jmin.value,
    jmax: r.jmax.value,
    s1: r.s1.value,
    s2: r.s2.value,
    h1: r.h1.value,
    h2: r.h2.value,
    h3: r.h3.value,
    h4: r.h4.value,
  };
}

let cached: AwgParams | null = null;

/**
 * Параметры обфускации для текущей установки. Результат кешируется на процесс:
 * значения обязаны быть одинаковыми для серверного конфига и всех клиентских.
 * Должна вызываться после openDb().
 *
 * Бросает исключение, если у уже работающей установки параметры в БД повреждены
 * (см. resolveExisting): падение с внятным логом обратимо, а тихая замена
 * параметров — нет.
 */
export function getAwgParams(cfg: Config): AwgParams {
  if (cached) return cached;

  const stored = {} as Record<Field, string | null>;
  for (const f of FIELDS) stored[f] = getSetting(settingKey(f));

  // Первый запуск ⇔ в settings нет НИ ОДНОГО ключа awg_*. Частично заполненный
  // набор первым запуском не считается: там уже есть выданные конфиги, а
  // недостающий ключ — это потеря данных, а не повод сгенерировать новый.
  const firstRun = FIELDS.every((f) => stored[f] === null);

  const params = firstRun ? resolveFirstRun(cfg) : resolveExisting(cfg, stored);

  if (firstRun) {
    console.log(
      `[awg] Сгенерированы параметры обфускации: Jc=${params.jc} Jmin=${params.jmin} ` +
        `Jmax=${params.jmax} S1=${params.s1} S2=${params.s2}`,
    );
  }
  cached = params;
  return params;
}

/** Строки [Interface] с параметрами обфускации — общий вид для всех конфигов. */
export function awgConfigLines(p: AwgParams): string[] {
  return [
    `Jc = ${p.jc}`,
    `Jmin = ${p.jmin}`,
    `Jmax = ${p.jmax}`,
    `S1 = ${p.s1}`,
    `S2 = ${p.s2}`,
    `H1 = ${p.h1}`,
    `H2 = ${p.h2}`,
    `H3 = ${p.h3}`,
    `H4 = ${p.h4}`,
  ];
}

/** Сброс кеша — только для тестов. */
export function resetAwgParamsCache(): void {
  cached = null;
}
