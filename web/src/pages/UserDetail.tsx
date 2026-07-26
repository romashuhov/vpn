import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Pencil, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { Range, TimeseriesPoint, UserDTO } from '../lib/types';
import { formatBytes, formatDate, timeAgo } from '../lib/format';
import PeerConfig from '../components/PeerConfig';
import Toggle from '../components/Toggle';
import Modal from '../components/Modal';
import RangeTabs from '../components/charts/RangeTabs';
import TrafficChart from '../components/charts/TrafficChart';

export default function UserDetail() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const validId = Number.isInteger(id) && id > 0;
  const navigate = useNavigate();

  const [user, setUser] = useState<UserDTO | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [range, setRange] = useState<Range>('24h');
  const [series, setSeries] = useState<TimeseriesPoint[] | null>(null);
  const [chartLoading, setChartLoading] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const cancelEditRef = useRef(false);

  const [toggling, setToggling] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Сброс состояния при переходе на другого юзера.
  useEffect(() => {
    setUser(null);
    setNotFound(false);
    setLoadError(null);
    setActionError(null);
    setSeries(null);
    setEditing(false);
  }, [id]);

  // Загрузка юзера + поллинг каждые 10 сек.
  useEffect(() => {
    if (!validId) return;
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const u = await api.getUser(id);
        if (!cancelled) {
          setUser(u);
          setLoadError(null);
        }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setNotFound(true);
          if (timer !== undefined) window.clearInterval(timer);
        } else {
          setLoadError(e instanceof Error ? e.message : 'Не удалось загрузить пользователя');
        }
      }
    };
    void load();
    timer = window.setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [id, validId, reloadKey]);

  // График трафика юзера: перезагрузка при смене периода + автообновление каждые 30 сек.
  useEffect(() => {
    if (!validId || notFound) return;
    let cancelled = false;
    const load = async (initial: boolean) => {
      if (initial) setChartLoading(true);
      try {
        const ts = await api.timeseries(range, id);
        if (!cancelled) {
          setSeries(ts);
          setChartError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setChartError(e instanceof Error ? e.message : 'Не удалось загрузить график');
        }
      } finally {
        if (!cancelled) setChartLoading(false);
      }
    };
    void load(true);
    const timer = window.setInterval(() => void load(false), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [id, range, validId, notFound]);

  const startEdit = () => {
    if (!user || saving) return;
    setNameDraft(user.name);
    setEditing(true);
  };

  const commitRename = async () => {
    setEditing(false);
    if (!user) return;
    const name = nameDraft.trim();
    if (!name || name === user.name) return;
    if (name.length > 64) {
      setActionError('Имя должно быть от 1 до 64 символов');
      return;
    }
    setSaving(true);
    try {
      const u = await api.updateUser(user.id, { name });
      setUser(u);
      setActionError(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Не удалось переименовать пользователя');
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async () => {
    if (!user || toggling) return;
    setToggling(true);
    try {
      const u = await api.updateUser(user.id, { enabled: !user.enabled });
      setUser(u);
      setActionError(null);
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : 'Не удалось изменить состояние пользователя',
      );
    } finally {
      setToggling(false);
    }
  };

  const doDelete = async () => {
    if (!user || deleting) return;
    setDeleting(true);
    try {
      await api.deleteUser(user.id);
      navigate('/users');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Не удалось удалить пользователя');
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  if (!validId || notFound) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-slate-400">
        <p>Пользователь не найден</p>
        <Link to="/users" className="text-emerald-400 transition-colors hover:text-emerald-300">
          К списку пользователей
        </Link>
      </div>
    );
  }

  if (loadError && !user) {
    return (
      <div className="space-y-4">
        <Link
          to="/users"
          className="inline-flex items-center gap-1.5 text-sm text-slate-400 transition-colors hover:text-slate-200"
        >
          <ArrowLeft size={16} /> Пользователи
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="rounded-lg bg-emerald-500 px-3 py-1.5 font-medium text-slate-950 transition-colors hover:bg-emerald-400"
          >
            Повторить
          </button>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="space-y-4">
        <div className="h-5 w-40 animate-pulse rounded bg-slate-800/60" />
        <div className="h-24 animate-pulse rounded-xl border border-slate-800 bg-slate-900/40" />
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="h-96 animate-pulse rounded-xl border border-slate-800 bg-slate-900/40 lg:col-span-2" />
          <div className="h-96 animate-pulse rounded-xl border border-slate-800 bg-slate-900/40" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        to="/users"
        className="inline-flex items-center gap-1.5 text-sm text-slate-400 transition-colors hover:text-slate-200"
      >
        <ArrowLeft size={16} /> Пользователи
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {editing ? (
              <input
                autoFocus
                value={nameDraft}
                maxLength={64}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  } else if (e.key === 'Escape') {
                    cancelEditRef.current = true;
                    e.currentTarget.blur();
                  }
                }}
                onBlur={() => {
                  if (cancelEditRef.current) {
                    cancelEditRef.current = false;
                    setEditing(false);
                    return;
                  }
                  void commitRename();
                }}
                aria-label="Имя пользователя"
                className="w-64 max-w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xl font-semibold text-slate-100 outline-none focus:border-emerald-500"
              />
            ) : (
              <>
                <h1 className="truncate text-2xl font-semibold text-slate-100">{user.name}</h1>
                <button
                  type="button"
                  onClick={startEdit}
                  title="Переименовать"
                  aria-label="Переименовать"
                  className="shrink-0 rounded-lg p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
                >
                  <Pencil size={16} />
                </button>
              </>
            )}
            {saving && <Loader2 size={16} className="shrink-0 animate-spin text-slate-500" />}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-400">
            {!user.enabled ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-slate-600" />
                отключён
              </span>
            ) : user.online ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                онлайн
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-slate-600" />
                {user.lastHandshake
                  ? `был в сети ${timeAgo(user.lastHandshake)}`
                  : 'не подключался'}
              </span>
            )}
            <span className="font-mono text-slate-300">{user.address}</span>
            <span>создан {formatDate(user.createdAt)}</span>
            <span title="Загрузка ↓ и выгрузка ↑ за всё время" className="tabular-nums">
              ↓ {formatBytes(user.totalTx)} · ↑ {formatBytes(user.totalRx)}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-4">
          <div className="flex items-center gap-2">
            <Toggle
              checked={user.enabled}
              disabled={toggling}
              onChange={() => void toggleEnabled()}
              ariaLabel={user.enabled ? 'Отключить пользователя' : 'Включить пользователя'}
            />
            <span className="text-sm text-slate-400">
              {user.enabled ? 'Включён' : 'Отключён'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm text-red-400 transition-colors hover:bg-red-500/20"
          >
            <Trash2 size={16} /> Удалить
          </button>
        </div>
      </div>

      {actionError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {actionError}
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium text-slate-100">Трафик</h2>
            <RangeTabs value={range} onChange={setRange} />
          </div>
          {chartError && <p className="mb-2 text-xs text-red-400">{chartError}</p>}
          <TrafficChart
            data={series ?? []}
            range={range}
            heightClass="h-64"
            loading={chartLoading}
          />
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="mb-3 font-medium text-slate-100">Подключение</h2>
          <PeerConfig userId={user.id} userName={user.name} />
        </section>
      </div>

      {confirmDelete && (
        <Modal
          title="Удалить пользователя?"
          onClose={() => {
            if (!deleting) setConfirmDelete(false);
          }}
        >
          <p className="text-sm text-slate-400">
            «{user.name}» будет удалён вместе с конфигурацией WireGuard и всей статистикой
            трафика. Это действие нельзя отменить.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={deleting}
              onClick={() => setConfirmDelete(false)}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-800 disabled:opacity-60"
            >
              Отмена
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() => void doDelete()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-400 disabled:opacity-60"
            >
              {deleting && <Loader2 size={14} className="animate-spin" />}
              {deleting ? 'Удаление…' : 'Удалить'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
