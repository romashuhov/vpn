import type {
  AmneziaExportDTO,
  AuthStatus,
  OnlineUserDTO,
  OverviewDTO,
  Range,
  TimeseriesPoint,
  UserDTO,
  UserUsage,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !path.startsWith('/api/auth/') && api.onUnauthorized) {
    api.onUnauthorized();
  }
  if (!res.ok) {
    let msg = `Ошибка ${res.status}`;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data.error === 'string') msg = data.error;
    } catch {
      /* тело не JSON */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export const api = {
  /** Вызывается при 401 на любом запросе кроме /api/auth/* — App сбрасывает сессию. */
  onUnauthorized: undefined as (() => void) | undefined,

  authStatus: () => req<AuthStatus>('GET', '/api/auth/status'),
  setup: (password: string) => req<void>('POST', '/api/auth/setup', { password }),
  login: (password: string) => req<void>('POST', '/api/auth/login', { password }),
  logout: () => req<void>('POST', '/api/auth/logout'),

  listUsers: () => req<UserDTO[]>('GET', '/api/users'),
  createUser: (name: string) => req<UserDTO>('POST', '/api/users', { name }),
  getUser: (id: number) => req<UserDTO>('GET', `/api/users/${id}`),
  updateUser: (id: number, patch: { name?: string; enabled?: boolean }) =>
    req<UserDTO>('PATCH', `/api/users/${id}`, patch),
  deleteUser: (id: number) => req<void>('DELETE', `/api/users/${id}`),
  getUserConfig: (id: number) => req<string>('GET', `/api/users/${id}/config`),
  /** Ссылка vpn://… и QR-чанки для приложения AmneziaVPN (только при engine 'awg'). */
  amneziaExport: (id: number) => req<AmneziaExportDTO>('GET', `/api/users/${id}/amnezia`),

  overview: () => req<OverviewDTO>('GET', '/api/stats/overview'),
  timeseries: (range: Range, userId?: number) =>
    req<TimeseriesPoint[]>(
      'GET',
      `/api/stats/timeseries?range=${range}${userId ? `&user=${userId}` : ''}`,
    ),
  topUsers: (range: Range) => req<UserUsage[]>('GET', `/api/stats/top?range=${range}`),
  onlineUsers: () => req<OnlineUserDTO[]>('GET', '/api/stats/online'),
};
