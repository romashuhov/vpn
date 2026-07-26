// IPAM: выделение IPv4-адресов в подсети VPN.
// Сервер занимает первый хост подсети, клиенты выделяются со второго.
// Поддерживаются подсети с префиксом /16../30.

interface ParsedSubnet {
  /** Адрес сети (uint32). */
  network: number;
  prefix: number;
  /** Всего адресов в подсети (включая network и broadcast). */
  size: number;
}

const SUBNET_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

function parseSubnet(subnet: string): ParsedSubnet {
  const m = SUBNET_RE.exec(subnet.trim());
  if (!m) {
    throw new Error(
      `Некорректная подсеть «${subnet}»: ожидается формат a.b.c.d/prefix, например 10.8.0.0/24`,
    );
  }
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  for (const o of octets) {
    if (o > 255) {
      throw new Error(`Некорректная подсеть «${subnet}»: октет ${o} вне диапазона 0..255`);
    }
  }
  const prefix = Number(m[5]);
  if (prefix < 16 || prefix > 30) {
    throw new Error(
      `Некорректная подсеть «${subnet}»: поддерживаются префиксы от /16 до /30`,
    );
  }
  const ip = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  // Нормализуем к адресу сети: '10.8.0.5/24' трактуем как '10.8.0.0/24'.
  return { network: (ip & mask) >>> 0, prefix, size: 2 ** (32 - prefix) };
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Адрес сервера — первый хост подсети: '10.8.0.0/24' -> '10.8.0.1'. */
export function serverAddress(subnet: string): string {
  const { network } = parseSubnet(subnet);
  return intToIp(network + 1);
}

/** Длина префикса подсети: '10.8.0.0/24' -> 24. */
export function subnetPrefix(subnet: string): number {
  return parseSubnet(subnet).prefix;
}

/**
 * Следующий свободный клиентский IP (со второго хоста подсети).
 * Адрес сети, адрес сервера и broadcast никогда не выдаются.
 * Бросает понятную ошибку, если свободных адресов не осталось.
 */
export function nextFreeAddress(subnet: string, taken: string[]): string {
  const { network, size } = parseSubnet(subnet);
  const used = new Set(taken.map((a) => a.trim()));
  used.add(intToIp(network + 1)); // адрес сервера — на всякий случай
  const lastHost = network + size - 2; // последний хост (без broadcast)
  for (let n = network + 2; n <= lastHost; n++) {
    const ip = intToIp(n);
    if (!used.has(ip)) return ip;
  }
  throw new Error(
    `В подсети ${subnet.trim()} не осталось свободных адресов (максимум клиентов: ${size - 3}). ` +
      'Удалите неиспользуемых пользователей или расширьте подсеть через WG_SUBNET.',
  );
}
