// Общие типы сервера. Контракт — см. ARCHITECTURE.md.

export interface UserRow {
  id: number;
  name: string;
  privateKey: string;
  publicKey: string;
  presharedKey: string;
  address: string; // чистый IP, например '10.8.0.2'
  enabled: boolean;
  totalRx: number;
  totalTx: number;
  lastHandshake: number | null; // unix ms
  createdAt: number; // unix ms
  updatedAt: number; // unix ms
}

export interface PeerStats {
  publicKey: string;
  endpoint: string | null;
  lastHandshake: number | null; // unix ms, null = никогда
  rx: number; // bytes, суммарно с поднятия интерфейса
  tx: number;
}

export interface WgPeer {
  publicKey: string;
  presharedKey: string;
  allowedIps: string; // '10.8.0.x/32'
}

export interface ServerWgState {
  iface: string;
  privateKey: string;
  address: string; // '10.8.0.1/24'
  listenPort: number;
  mtu?: string;
  peers: WgPeer[];
}

// ---- DTO для REST API ----

export interface UserDTO {
  id: number;
  name: string;
  address: string;
  publicKey: string;
  enabled: boolean;
  createdAt: number;
  totalRx: number;
  totalTx: number;
  lastHandshake: number | null;
  online: boolean; // handshake < 180 сек назад
}

export interface ServerInfo {
  host: string;
  port: number;
  publicKey: string;
  subnet: string;
  iface: string;
  mock: boolean;
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
