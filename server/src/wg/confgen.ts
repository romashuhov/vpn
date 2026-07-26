// Рендер конфигураций WireGuard: состояние серверного интерфейса и клиентский .conf.

import type { Config } from '../config.js';
import type { ServerWgState, UserRow, WgPeer } from '../types.js';
import { serverAddress, subnetPrefix } from '../ipam.js';
import { awgConfigLines, getAwgParams } from '../awg.js';

/**
 * Имя юзера попадает в комментарий conf-файла — вырезаем переводы строк и
 * прочие управляющие символы (класс Unicode Cc), чтобы исключить инъекцию
 * строк в конфиг. Имя уже санитизировано API-слоем, это второй рубеж.
 */
function sanitizeName(name: string, fallback: string): string {
  const clean = name.replace(/\p{Cc}+/gu, ' ').trim();
  return clean === '' ? fallback : clean;
}

/** Хост для Endpoint: IPv6-литерал оборачиваем в скобки, пустой — заглушка. */
function endpointHost(host: string): string {
  const h = host.trim();
  if (h === '') return 'SERVER_IP_NOT_SET'; // WG_HOST не задан (dev/mock-режим)
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]`;
  return h;
}

/** Полное состояние серверного интерфейса. Пиры — только enabled-юзеры. */
export function buildServerState(
  cfg: Config,
  serverPrivateKey: string,
  users: UserRow[],
): ServerWgState {
  const peers: WgPeer[] = users
    .filter((u) => u.enabled)
    .map((u) => ({
      publicKey: u.publicKey,
      presharedKey: u.presharedKey,
      allowedIps: `${u.address}/32`,
    }));
  const state: ServerWgState = {
    iface: cfg.wg.iface,
    privateKey: serverPrivateKey,
    address: `${serverAddress(cfg.wg.subnet)}/${subnetPrefix(cfg.wg.subnet)}`,
    listenPort: cfg.wg.port,
    peers,
  };
  if (cfg.wg.mtu !== '') state.mtu = cfg.wg.mtu;
  // Движок 'wg' обязан давать ровно прежний результат — поле не появляется вовсе.
  if (cfg.engine === 'awg') state.awg = getAwgParams(cfg);
  return state;
}

/** Текст клиентского конфига (то, что уходит в QR и в скачиваемый .conf). */
export function renderClientConfig(
  cfg: Config,
  serverPublicKey: string,
  user: UserRow,
): string {
  const name = sanitizeName(user.name, `user-${user.id}`);
  const lines: string[] = [
    `# WireDeck — ${name}`,
    '[Interface]',
    `PrivateKey = ${user.privateKey}`,
    `Address = ${user.address}/${subnetPrefix(cfg.wg.subnet)}`,
    `DNS = ${cfg.wg.dns}`,
  ];
  if (cfg.wg.mtu !== '') lines.push(`MTU = ${cfg.wg.mtu}`);
  // AmneziaWG: S1/S2/H1..H4 обязаны совпадать с серверными, иначе связи не будет.
  // Такой конфиг открывается приложением AmneziaWG (форк клиента WireGuard).
  // Основное приложение AmneziaVPN ждёт свой упакованный формат vpn:// и
  // этот текст не импортирует.
  if (cfg.engine === 'awg') lines.push(...awgConfigLines(getAwgParams(cfg)));
  lines.push(
    '',
    '[Peer]',
    `PublicKey = ${serverPublicKey}`,
    `PresharedKey = ${user.presharedKey}`,
    `Endpoint = ${endpointHost(cfg.wg.host)}:${cfg.wg.port}`,
    `AllowedIPs = ${cfg.wg.allowedIps}`,
    `PersistentKeepalive = ${cfg.wg.persistentKeepalive}`,
  );
  return lines.join('\n') + '\n';
}
