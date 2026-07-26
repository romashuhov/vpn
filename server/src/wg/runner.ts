import type { PeerStats, ServerWgState } from '../types.js';

// Абстракция над WireGuard: реальная реализация (linux) и mock для разработки.
export interface WgRunner {
  /** Создать/поднять интерфейс с данным состоянием. Идемпотентно. */
  up(state: ServerWgState): Promise<void>;
  /** Применить изменения пиров без разрыва существующих соединений. */
  sync(state: ServerWgState): Promise<void>;
  /** Текущая статистика по пирам. */
  stats(): Promise<PeerStats[]>;
  /** Погасить интерфейс. */
  down(): Promise<void>;
}
