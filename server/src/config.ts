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

/**
 * Движок туннеля. 'wg' — ванильный WireGuard (дефолт, сохраняет поведение
 * существующих установок), 'awg' — AmneziaWG (обфускация против DPI).
 * Смена движка требует перевыдачи ВСЕХ клиентских конфигов, поэтому дефолт
 * менять нельзя: новые установки включают awg явно через deploy/.env.
 */
function readEngine(): 'wg' | 'awg' {
  const raw = env('WG_ENGINE', 'wg').trim().toLowerCase();
  if (raw === 'wg' || raw === 'awg') return raw;
  console.warn(`[wg] Неизвестное значение WG_ENGINE="${raw}" — использую 'wg'. Допустимо: wg | awg.`);
  return 'wg';
}

const engine = readEngine();

/**
 * Сырое (нераспарсенное) значение env-переопределения параметра обфускации.
 * Валидацию и разбор делает awg.ts — там же формируются понятные сообщения
 * об ошибках, для которых нужна исходная строка.
 */
function awgEnvValue(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

export const config = {
  engine,
  // Производные имена бинарников: у awg-tools тот же CLI, что у wireguard-tools.
  wgBin: engine === 'awg' ? 'awg' : 'wg',
  wgQuickBin: engine === 'awg' ? 'awg-quick' : 'wg-quick',
  // Переопределения параметров обфускации из env (undefined = не задано).
  // Приоритетнее значений из БД и в БД не сохраняются.
  awgEnv: {
    jc: awgEnvValue('AWG_JC'),
    jmin: awgEnvValue('AWG_JMIN'),
    jmax: awgEnvValue('AWG_JMAX'),
    s1: awgEnvValue('AWG_S1'),
    s2: awgEnvValue('AWG_S2'),
    h1: awgEnvValue('AWG_H1'),
    h2: awgEnvValue('AWG_H2'),
    h3: awgEnvValue('AWG_H3'),
    h4: awgEnvValue('AWG_H4'),
  },
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
    // 1280 по умолчанию — консервативный минимум, проходящий через мобильные
    // сети и пути с уменьшенным MTU (PMTU blackhole — главный источник
    // «подключается, но ничего не грузит»). WG_MTU=off — не указывать MTU
    // вовсе (дефолт WireGuard 1420, чуть быстрее, но ловит blackhole).
    mtu: ((v) => (v === 'off' || v === '0' ? '' : v))(env('WG_MTU', '1280')),
    mock,
    mockSeed: env('WG_MOCK_SEED', mock ? '1' : '0') === '1',
  },
};

export type Config = typeof config;
