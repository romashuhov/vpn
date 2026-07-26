// awg.ts — параметры обфускации AmneziaWG (набор AWG 1.5: Jc/Jmin/Jmax/S1/S2/H1..H4).
//
// Главное требование — СТАБИЛЬНОСТЬ. S1, S2 и H1..H4 обязаны совпадать на
// сервере и клиенте, поэтому значения генерируются ровно один раз и хранятся
// в settings. Если они изменятся между рестартами, у ВСЕХ выданных клиентов
// пропадёт связь. Отсюда же и порядок приоритетов:
//   env (AWG_*) > settings в БД > свежая генерация (с записью в БД).
// Значения из env в БД НЕ пишутся: env — это ручное закрепление, а БД —
// автоматическое.
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

/** Строка → целое в допустимом диапазоне поля, либо null (с записью причины). */
function parseField(f: Field, raw: string, source: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    console.error(`[awg] ${source}: «${raw}» — не целое число, значение игнорируется`);
    return null;
  }
  const { min, max } = RANGES[f];
  if (n < min || n > max) {
    console.error(`[awg] ${source}: ${n} вне допустимого диапазона ${min}..${max}, значение игнорируется`);
    return null;
  }
  return n;
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

interface Resolved {
  value: number;
  /** Значение закреплено через env — менять и писать в БД нельзя. */
  pinned: boolean;
  /** Значение получено из БД без изменений — перезапись не нужна. */
  fromDb: boolean;
}

/** env → БД → генерация, с валидацией диапазона на каждом шаге. */
function resolveField(cfg: Config, f: Field): Resolved {
  const fromEnv = cfg.awgEnv[f];
  if (fromEnv !== undefined) {
    const v = parseField(f, fromEnv, envName(f));
    if (v !== null) return { value: v, pinned: true, fromDb: false };
  }
  const stored = getSetting(settingKey(f));
  if (stored !== null) {
    const v = parseField(f, stored, `настройка ${settingKey(f)}`);
    if (v !== null) return { value: v, pinned: false, fromDb: true };
    console.error(`[awg] ${settingKey(f)} испорчен — параметр будет сгенерирован заново`);
  }
  return { value: generate(f), pinned: false, fromDb: false };
}

/** Присвоить полю новое значение (с пометкой «требует записи в БД»). */
function assign(r: Resolved, value: number): void {
  r.value = value;
  r.fromDb = false;
}

/**
 * Совместные ограничения, которые нельзя проверить по одному полю.
 * Правило разрешения конфликта: правим то поле, которое НЕ закреплено env;
 * если закреплены оба — пишем внятную ошибку и всё равно правим (иначе
 * amneziawg откажется поднимать интерфейс и туннеля не будет вовсе).
 */
function enforceJointRules(r: Record<Field, Resolved>): void {
  // 0 <= Jmin < Jmax < 1280
  if (r.jmin.value >= r.jmax.value) {
    console.error(
      `[awg] нарушено требование Jmin < Jmax (Jmin=${r.jmin.value}, Jmax=${r.jmax.value}) — исправляю`,
    );
    if (!r.jmax.pinned) {
      assign(r.jmax, Math.min(1279, r.jmin.value + 1));
      if (r.jmin.value >= r.jmax.value) assign(r.jmin, r.jmax.value - 1);
    } else if (!r.jmin.pinned) {
      assign(r.jmin, Math.max(0, r.jmax.value - 1));
    } else {
      console.error('[awg] оба значения закреплены через env (AWG_JMIN/AWG_JMAX) — использую 50/1000');
      assign(r.jmin, 50);
      assign(r.jmax, 1000);
    }
  }

  // S1 + 56 != S2 (иначе init-пакет неотличим от response-пакета)
  if (r.s1.value + 56 === r.s2.value) {
    console.error(
      `[awg] нарушено требование S1 + 56 != S2 (S1=${r.s1.value}, S2=${r.s2.value}) — исправляю`,
    );
    if (!r.s2.pinned) {
      assign(r.s2, r.s2.value > RANGES.s2.min ? r.s2.value - 1 : r.s2.value + 1);
    } else if (!r.s1.pinned) {
      assign(r.s1, r.s1.value > RANGES.s1.min ? r.s1.value - 1 : r.s1.value + 1);
    } else {
      console.error('[awg] оба значения закреплены через env (AWG_S1/AWG_S2) — сдвигаю S2 на 1');
      assign(r.s2, r.s2.value > RANGES.s2.min ? r.s2.value - 1 : r.s2.value + 1);
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
    console.error(`[awg] ${f.toUpperCase()} дублирует другой magic-заголовок — генерирую новый`);
    if (r[f].pinned) {
      console.error(`[awg] ${envName(f)} задан через env, но конфликтует — значение будет заменено`);
    }
    let candidate = r[f].value;
    // Диапазон 5..2^31-1 огромен, коллизия практически исключена; цикл — страховка.
    for (let attempt = 0; attempt < 100 && seen.has(candidate); attempt++) {
      candidate = rnd(H_MIN, H_MAX);
    }
    assign(r[f], candidate);
    seen.add(candidate);
  }
}

let cached: AwgParams | null = null;

/**
 * Параметры обфускации для текущей установки. Результат кешируется на процесс:
 * значения обязаны быть одинаковыми для серверного конфига и всех клиентских.
 * Должна вызываться после openDb().
 */
export function getAwgParams(cfg: Config): AwgParams {
  if (cached) return cached;

  // Если ни одного параметра ещё нет в БД — это первая инициализация, а не
  // порча данных: генерацию в этом случае логируем как обычное событие.
  const fresh = FIELDS.every((f) => getSetting(settingKey(f)) === null);

  const resolved = {} as Record<Field, Resolved>;
  for (const f of FIELDS) resolved[f] = resolveField(cfg, f);

  // Если magic-заголовков в БД/env нет вовсе — берём разнесённый по диапазону
  // набор вместо четырёх независимых случайных чисел.
  const headers: Field[] = ['h1', 'h2', 'h3', 'h4'];
  if (headers.every((f) => !resolved[f].pinned && !resolved[f].fromDb)) {
    const generated = genHeaders();
    headers.forEach((f, i) => assign(resolved[f], generated[i]));
  }

  enforceJointRules(resolved);

  // Сохраняем всё, что не закреплено env и отличается от лежащего в БД.
  for (const f of FIELDS) {
    const r = resolved[f];
    if (r.pinned || r.fromDb) continue;
    setSetting(settingKey(f), String(r.value));
  }

  const params: AwgParams = {
    jc: resolved.jc.value,
    jmin: resolved.jmin.value,
    jmax: resolved.jmax.value,
    s1: resolved.s1.value,
    s2: resolved.s2.value,
    h1: resolved.h1.value,
    h2: resolved.h2.value,
    h3: resolved.h3.value,
    h4: resolved.h4.value,
  };

  if (fresh) {
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
