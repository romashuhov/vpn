// amnezia.ts — упаковка клиентского конфига в формат приложения AmneziaVPN.
//
// Зачем: текстовый .conf понимает приложение AmneziaWG (форк клиента
// WireGuard), но основное приложение AmneziaVPN ждёт свой упакованный формат.
// Отдав его, панель может прислать пользователю ссылку vpn://…, которая на
// телефоне открывает AmneziaVPN в одно нажатие — без камеры и без файлов.
//
// Формат (разобран по исходникам amnezia-vpn/amnezia-client):
//   1. JSON описания подключения (containers / defaultContainer / hostName / dns);
//      внутри контейнера — поле last_config со ВЛОЖЕННЫМ JSON, сериализованным
//      в строку (да, строка внутри JSON — так у них).
//   2. Сжатие, эквивалент Qt qCompress: [4 байта BE — длина исходного JSON] +
//      zlib-поток (deflateSync с level 8, заголовок 0x78 — ровно как у Qt).
//   3. Ссылка: 'vpn://' + base64url(сжатое) без '='.
//   4. QR-нагрузка — ЭТО НЕ строка vpn://, а тот же сжатый блок в обёртке
//      QDataStream (big-endian): magic 0x07C0, всего чанков, номер чанка,
//      длина блока (4 байта BE), сам блок; всё вместе → base64url без '='.
//
// ВАЖНО: ключи с пустыми значениями не выводятся вовсе — пустая строка ломает
// импорт на стороне клиента. В режиме 'wg' параметры обфускации Jc..H4 не
// включаются совсем.
//
// Текст .conf сюда приходит готовым (renderClientConfig из wg/confgen.ts):
// два источника правды для одного и того же конфига недопустимы.

import { deflateSync, inflateSync } from 'node:zlib';
import type { Config } from './config.js';
import type { UserRow } from './types.js';
import { getAwgParams } from './awg.js';

/** Магическое число заголовка QR-нагрузки (1984 у Amnezia). */
const QR_MAGIC = 0x07c0;

/**
 * Максимум байт сжатого блока в одном QR-чанке. Значение из клиента Amnezia:
 * больше — и QR перестаёт читаться дешёвыми камерами. Наши конфиги короче,
 * так что практически всегда получается один чанк.
 */
const QR_CHUNK_SIZE = 850;

/** Уровень сжатия, которым пользуется Qt qCompress по умолчанию у Amnezia. */
const DEFLATE_LEVEL = 8;

/** Только IPv4-литерал: AmneziaVPN кладёт dns1/dns2 в поля, не понимающие IPv6. */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export interface AmneziaExport {
  /** Ссылка вида vpn://… — открывает AmneziaVPN и импортирует подключение. */
  link: string;
  /**
   * Нагрузка для QR-кодов. Обычно один элемент; несколько — если сжатый блок
   * не влез в QR_CHUNK_SIZE (тогда одиночный QR нарисовать нельзя).
   */
  qrChunks: string[];
}

/** Проверка IPv4-литерала (октеты 0..255). */
function isIpv4(value: string): boolean {
  const m = IPV4_RE.exec(value);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}

/** Список через запятую → массив непустых значений без пробелов по краям. */
function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Имя пользователя станет названием подключения в приложении: вырезаем
 * управляющие символы (класс Unicode Cc), как и в conf-файле.
 */
function sanitizeName(name: string, fallback: string): string {
  const clean = name.replace(/\p{Cc}+/gu, ' ').trim();
  return clean === '' ? fallback : clean;
}

/** Положить значение в объект, если оно непустое (пустое ломает импорт). */
function put(target: Record<string, unknown>, key: string, value: string): void {
  if (value !== '') target[key] = value;
}

/**
 * Адрес сервера для полей hostName. Если WG_HOST не задан (dev/mock, забытая
 * переменная в проде), отдаём тот же видимый маркер, что и Endpoint в тексте
 * .conf: правило «никаких пустых ключей» иначе выкинуло бы hostName вовсе, и
 * AmneziaVPN молча создал бы подключение вообще без сервера.
 */
function hostName(cfg: Config): string {
  const h = cfg.wg.host.trim();
  return h === '' ? 'SERVER_IP_NOT_SET' : h;
}

/** Вложенный last_config — объект до сериализации в строку. */
function buildLastConfig(
  cfg: Config,
  user: UserRow,
  serverPublicKey: string,
  clientConf: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Параметры обфускации — строками и только при движке 'awg'.
  if (cfg.engine === 'awg') {
    const p = getAwgParams(cfg);
    out.Jc = String(p.jc);
    out.Jmin = String(p.jmin);
    out.Jmax = String(p.jmax);
    out.S1 = String(p.s1);
    out.S2 = String(p.s2);
    out.H1 = String(p.h1);
    out.H2 = String(p.h2);
    out.H3 = String(p.h3);
    out.H4 = String(p.h4);
  }

  const allowedIps = splitList(cfg.wg.allowedIps);
  if (allowedIps.length > 0) out.allowed_ips = allowedIps;

  put(out, 'client_ip', `${user.address}/32`);
  put(out, 'client_priv_key', user.privateKey);
  put(out, 'config', clientConf);
  put(out, 'hostName', hostName(cfg));
  put(out, 'mtu', cfg.wg.mtu);
  put(out, 'persistent_keep_alive', String(cfg.wg.persistentKeepalive));
  out.port = cfg.wg.port; // внутри last_config порт — ЧИСЛО
  put(out, 'psk_key', user.presharedKey);
  put(out, 'server_pub_key', serverPublicKey);

  return out;
}

/** Верхнеуровневый JSON описания подключения. */
function buildPayload(
  cfg: Config,
  user: UserRow,
  serverPublicKey: string,
  clientConf: string,
): Record<string, unknown> {
  const awg = cfg.engine === 'awg';
  const protoKey = awg ? 'awg' : 'wireguard';
  const containerName = awg ? 'amnezia-awg' : 'amnezia-wireguard';

  const container: Record<string, unknown> = {
    isThirdPartyConfig: true,
    last_config: JSON.stringify(buildLastConfig(cfg, user, serverPublicKey, clientConf)),
    port: String(cfg.wg.port), // а здесь порт — СТРОКА
    transport_proto: 'udp',
  };

  const payload: Record<string, unknown> = {
    containers: [{ [protoKey]: container, container: containerName }],
    defaultContainer: containerName,
    description: sanitizeName(user.name, `user-${user.id}`),
  };

  const dns = splitList(cfg.wg.dns).filter(isIpv4);
  if (dns[0] !== undefined) payload.dns1 = dns[0];
  if (dns[1] !== undefined) payload.dns2 = dns[1];
  put(payload, 'hostName', hostName(cfg));

  return payload;
}

/**
 * Сжатие в формате Qt qCompress: 4 байта BE с длиной исходных данных, затем
 * обычный zlib-поток. Node deflateSync даёт ровно zlib-обёртку (0x78 …).
 */
function qCompress(data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  return Buffer.concat([header, deflateSync(data, { level: DEFLATE_LEVEL })]);
}

/** Обратная операция к qCompress. */
function qUncompress(blob: Buffer): Buffer {
  if (blob.length < 4) throw new Error('qUncompress: блок короче заголовка длины');
  const expected = blob.readUInt32BE(0);
  const out = inflateSync(blob.subarray(4));
  if (out.length !== expected) {
    throw new Error(`qUncompress: длина не совпала (заголовок ${expected}, распаковано ${out.length})`);
  }
  return out;
}

/** Сжатый блок → массив base64url-строк для QR (обёртка QDataStream). */
function buildQrChunks(compressed: Buffer): string[] {
  const total = Math.max(1, Math.ceil(compressed.length / QR_CHUNK_SIZE));
  // Номер чанка — один байт, больше 255 штук в этот формат не уложить. Такой
  // конфиг через QR не передать в принципе, но ссылка vpn:// ограничения на
  // длину не имеет — поэтому мягко деградируем (пустой список = «QR нет», фронт
  // предложит ссылку), а не валим весь экспорт исключением.
  if (total > 255) return [];
  const chunks: string[] = [];
  for (let i = 0; i < total; i++) {
    const part = compressed.subarray(i * QR_CHUNK_SIZE, (i + 1) * QR_CHUNK_SIZE);
    const header = Buffer.alloc(8);
    header.writeUInt16BE(QR_MAGIC, 0);
    header.writeUInt8(total, 2);
    header.writeUInt8(i, 3);
    header.writeUInt32BE(part.length, 4);
    chunks.push(Buffer.concat([header, part]).toString('base64url'));
  }
  return chunks;
}

/**
 * Ссылка vpn:// и нагрузка для QR по готовому клиентскому конфигу.
 * clientConf — результат renderClientConfig(): единственный источник правды
 * для текста .conf.
 */
export function buildAmneziaExport(
  cfg: Config,
  user: UserRow,
  serverPublicKey: string,
  clientConf: string,
): AmneziaExport {
  const json = Buffer.from(
    JSON.stringify(buildPayload(cfg, user, serverPublicKey, clientConf)),
    'utf8',
  );
  const compressed = qCompress(json);
  return {
    // Node отдаёт base64url уже без '=' — ровно то, что ждёт клиент.
    link: `vpn://${compressed.toString('base64url')}`,
    qrChunks: buildQrChunks(compressed),
  };
}

/**
 * Обратный разбор — для самопроверки round-trip'ом (тестового фреймворка в
 * проекте нет, это осознанное отступление). Принимает ссылку vpn://…, одну
 * QR-строку или массив QR-строк (порядок чанков определяется заголовком).
 */
export function decodeForTest(qrChunkOrLink: string | string[]): Record<string, unknown> {
  const inputs = Array.isArray(qrChunkOrLink) ? qrChunkOrLink : [qrChunkOrLink];
  if (inputs.length === 0) throw new Error('decodeForTest: пустой вход');

  let compressed: Buffer;
  if (inputs.length === 1 && inputs[0].startsWith('vpn://')) {
    compressed = Buffer.from(inputs[0].slice('vpn://'.length), 'base64url');
  } else {
    const parts: Buffer[] = [];
    let total = inputs.length;
    for (const raw of inputs) {
      if (raw.startsWith('vpn://')) {
        throw new Error('decodeForTest: ссылку vpn:// нельзя смешивать с QR-чанками');
      }
      const buf = Buffer.from(raw, 'base64url');
      if (buf.length < 8) throw new Error('decodeForTest: чанк короче заголовка');
      const magic = buf.readUInt16BE(0);
      if (magic !== QR_MAGIC) {
        throw new Error(`decodeForTest: неверный magic 0x${magic.toString(16)}, ожидался 0x07c0`);
      }
      total = buf.readUInt8(2);
      const index = buf.readUInt8(3);
      const len = buf.readUInt32BE(4);
      const part = buf.subarray(8, 8 + len);
      if (part.length !== len) {
        throw new Error(`decodeForTest: чанк ${index} обрезан (заявлено ${len}, есть ${part.length})`);
      }
      parts[index] = part;
    }
    // Массив может оказаться разреженным (дубликаты/пропуски номеров), поэтому
    // собираем по индексам явно, а не полагаемся на some()/length.
    const ordered: Buffer[] = [];
    for (let i = 0; i < total; i++) {
      const part = parts[i];
      if (part === undefined) {
        throw new Error(`decodeForTest: не хватает чанка ${i} из ${total}`);
      }
      ordered.push(part);
    }
    compressed = Buffer.concat(ordered);
  }

  const parsed: unknown = JSON.parse(qUncompress(compressed).toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('decodeForTest: полезная нагрузка не JSON-объект');
  }
  return parsed as Record<string, unknown>;
}
