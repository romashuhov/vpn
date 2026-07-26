// Зеркало DTO сервера (server/src/types.ts). Контракт — ARCHITECTURE.md.

export interface AuthStatus {
  needsSetup: boolean;
  authenticated: boolean;
}

export interface UserDTO {
  id: number;
  name: string;
  address: string;
  publicKey: string;
  enabled: boolean;
  createdAt: number; // unix ms
  totalRx: number; // байты, rx с точки зрения сервера = выгрузка юзера
  totalTx: number; // tx сервера = загрузка юзера
  lastHandshake: number | null; // unix ms
  online: boolean;
}

/** Движок туннеля: 'wg' — ванильный WireGuard, 'awg' — AmneziaWG (обфускация против DPI). */
export type WgEngine = 'wg' | 'awg';

export interface ServerInfo {
  host: string;
  port: number;
  publicKey: string;
  subnet: string;
  iface: string;
  mock: boolean;
  engine: WgEngine;
}

export interface OverviewDTO {
  usersTotal: number;
  usersOnline: number;
  rxToday: number;
  txToday: number;
  rxTotal: number;
  txTotal: number;
  server: ServerInfo;
}

export interface TimeseriesPoint {
  ts: number; // начало интервала, unix ms
  rx: number;
  tx: number;
}

export interface UserUsage {
  id: number;
  name: string;
  rx: number;
  tx: number;
}

export interface OnlineUserDTO {
  id: number;
  name: string;
  address: string;
  rateRx: number; // байт/сек: rx сервера = выгрузка юзера
  rateTx: number; // tx сервера = загрузка юзера
  lastHandshake: number | null;
}

export type Range = '24h' | '7d' | '30d';

/**
 * Конфиг в формате приложения AmneziaVPN (GET /api/users/:id/amnezia).
 * `link` — строка `vpn://…` (на телефоне открывает приложение в одно нажатие).
 * `qrChunks` — отдельная упаковка для QR (не сама ссылка!): при длинных конфигах
 * чанков может быть несколько, тогда одним QR-кодом их показать нельзя.
 */
export interface AmneziaExportDTO {
  link: string;
  qrChunks: string[];
}
