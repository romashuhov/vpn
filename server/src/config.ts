import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function env(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

// В БД лежат приватные ключи всех клиентов и сервера: ни один создаваемый
// процессом файл не должен читаться другими локальными пользователями.
// На Windows umask/chmod фактически no-op — это только для Linux (bare-metal).
process.umask(0o077);

const dataDir = path.resolve(env('DATA_DIR', './data'));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
try {
  fs.chmodSync(dataDir, 0o700); // каталог мог существовать с более широкими правами
} catch {
  // нет прав на chmod (например, каталог не наш) — оставляем как есть
}

const mockEnv = process.env.WG_MOCK;
const mock =
  mockEnv !== undefined && mockEnv !== ''
    ? mockEnv === '1' || mockEnv === 'true'
    : os.platform() !== 'linux';

export const config = {
  port: Number(env('PORT', '8080')),
  host: env('HOST', '0.0.0.0'),
  dataDir,
  dbPath: path.join(dataDir, 'wiredeck.db'),
  webDist: path.resolve(env('WEB_DIST', path.join(import.meta.dirname, '../../web/dist'))),
  pollIntervalMs: Number(env('POLL_INTERVAL_MS', '15000')),
  sessionTtlMs: 30 * 24 * 3600 * 1000,
  // COOKIE_SECURE=1 — ставить флаг Secure на сессионную cookie (панель за TLS).
  cookieSecure: env('COOKIE_SECURE', '') === '1' || env('COOKIE_SECURE', '') === 'true',
  wg: {
    host: env('WG_HOST', ''),
    port: Number(env('WG_PORT', '51820')),
    iface: env('WG_INTERFACE', 'wg0'),
    subnet: env('WG_SUBNET', '10.8.0.0/24'),
    dns: env('WG_DNS', '1.1.1.1'),
    allowedIps: env('WG_ALLOWED_IPS', '0.0.0.0/0, ::/0'),
    persistentKeepalive: Number(env('WG_PERSISTENT_KEEPALIVE', '25')),
    mtu: env('WG_MTU', ''),
    mock,
    mockSeed: env('WG_MOCK_SEED', mock ? '1' : '0') === '1',
  },
};

export type Config = typeof config;
