// Mock-runner для разработки без WireGuard (Windows/Mac): живая симуляция.
// Часть enabled-пиров периодически «онлайн» (сессии включаются/выключаются
// раз в несколько минут), у онлайн-пиров счётчики монотонно растут,
// lastHandshake обновляется. Счётчики переживают sync(); удалённые из
// конфигурации пиры вычищаются.

import type { PeerStats, ServerWgState, WgPeer } from '../types.js';
import type { WgRunner } from './runner.js';

const MB = 1024 * 1024;
/** Вероятность оказаться «онлайн» при очередном пересмотре сессии. */
const ONLINE_PROB = 0.6;
/** Сессия пересматривается раз в 2–7 минут. */
const FLIP_MIN_MS = 2 * 60_000;
const FLIP_MAX_MS = 7 * 60_000;
/** Прирост за один вызов stats(): rx 0.1–2 МБ, tx 0.5–8 МБ. */
const RX_STEP_MIN = 0.1 * MB;
const RX_STEP_MAX = 2 * MB;
const TX_STEP_MIN = 0.5 * MB;
const TX_STEP_MAX = 8 * MB;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function randomEndpoint(): string {
  // Правдоподобный публичный адрес клиента.
  return `${randInt(11, 95)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}:${randInt(1024, 65000)}`;
}

interface MockPeer {
  allowedIps: string;
  online: boolean;
  /** Когда в следующий раз пересмотреть онлайн-статус (unix ms). */
  nextFlipAt: number;
  rx: number;
  tx: number;
  lastHandshake: number | null; // unix ms
  endpoint: string | null;
}

export class MockRunner implements WgRunner {
  private peers = new Map<string, MockPeer>();
  private iface = 'wg0';
  private running = false;

  async up(state: ServerWgState): Promise<void> {
    this.iface = state.iface;
    this.running = true;
    // При старте раздаём пирам случайные фазы, чтобы панель сразу выглядела живой.
    this.applyPeers(state.peers, { initial: true });
    console.log(
      `[wg] mock: интерфейс ${this.iface} «поднят», пиров: ${state.peers.length}`,
    );
  }

  async sync(state: ServerWgState): Promise<void> {
    this.iface = state.iface;
    // Счётчики существующих пиров не трогаем — переживают sync().
    this.applyPeers(state.peers, { initial: false });
    console.log(
      `[wg] mock: конфигурация ${this.iface} синхронизирована, пиров: ${state.peers.length}`,
    );
  }

  async stats(): Promise<PeerStats[]> {
    if (!this.running) return [];
    const now = Date.now();
    const result: PeerStats[] = [];
    for (const [publicKey, p] of this.peers) {
      // Раз в несколько минут пересматриваем «сессию» пира.
      if (now >= p.nextFlipAt) {
        const wasOnline = p.online;
        p.online = Math.random() < ONLINE_PROB;
        p.nextFlipAt = now + rand(FLIP_MIN_MS, FLIP_MAX_MS);
        if (p.online && !wasOnline) p.endpoint = randomEndpoint();
        if (!p.online) p.endpoint = null;
      }
      if (p.online) {
        p.rx += Math.round(rand(RX_STEP_MIN, RX_STEP_MAX));
        p.tx += Math.round(rand(TX_STEP_MIN, TX_STEP_MAX));
        // Хендшейк недавний, слегка «дрожит», но монотонно не убывает.
        p.lastHandshake = Math.max(p.lastHandshake ?? 0, now - randInt(0, 20_000));
      }
      result.push({
        publicKey,
        endpoint: p.endpoint,
        lastHandshake: p.lastHandshake,
        rx: p.rx,
        tx: p.tx,
      });
    }
    return result;
  }

  async down(): Promise<void> {
    this.running = false;
    console.log(`[wg] mock: интерфейс ${this.iface} «погашен»`);
  }

  private applyPeers(peers: WgPeer[], opts: { initial: boolean }): void {
    const now = Date.now();
    const seen = new Set<string>();
    for (const p of peers) {
      seen.add(p.publicKey);
      const existing = this.peers.get(p.publicKey);
      if (existing) {
        existing.allowedIps = p.allowedIps;
        continue;
      }
      if (opts.initial) {
        // Пир существовал «до старта»: случайная фаза и правдоподобная история.
        const online = Math.random() < ONLINE_PROB;
        this.peers.set(p.publicKey, {
          allowedIps: p.allowedIps,
          online,
          nextFlipAt: now + rand(FLIP_MIN_MS, FLIP_MAX_MS),
          rx: 0,
          tx: 0,
          lastHandshake: online
            ? now - randInt(0, 90_000)
            : now - randInt(10 * 60_000, 48 * 3_600_000),
          endpoint: online ? randomEndpoint() : null,
        });
      } else {
        // Свежесозданный юзер: ещё ни разу не подключался,
        // «оживёт» при ближайшем пересмотре сессии.
        this.peers.set(p.publicKey, {
          allowedIps: p.allowedIps,
          online: false,
          nextFlipAt: now + rand(30_000, FLIP_MIN_MS),
          rx: 0,
          tx: 0,
          lastHandshake: null,
          endpoint: null,
        });
      }
    }
    // Пиров, удалённых из конфигурации, вычищаем вместе с их состоянием.
    for (const key of [...this.peers.keys()]) {
      if (!seen.has(key)) this.peers.delete(key);
    }
  }
}
