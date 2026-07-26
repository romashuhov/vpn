import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Plus, UserPlus, Users as UsersIcon } from 'lucide-react';
import { api } from '../lib/api';
import type { UserDTO } from '../lib/types';
import { formatBytes, timeAgo } from '../lib/format';
import Modal from '../components/Modal';
import PeerConfig from '../components/PeerConfig';
import Toggle from '../components/Toggle';

const POLL_MS = 10_000;

const primaryBtn =
  'flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60';
const errorBox =
  'rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400';
const inputClass =
  'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-emerald-500';

/** Список пользователей: таблица, создание, тумблер enabled, поллинг раз в 10 сек. */
export default function Users() {
  const navigate = useNavigate();

  const [users, setUsers] = useState<UserDTO[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<number>>(new Set());
  const pendingRef = useRef<Set<number>>(new Set());

  const [modalOpen, setModalOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdUser, setCreatedUser] = useState<UserDTO | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.listUsers();
      setUsers((prev) => {
        // Не затирать оптимистичное значение enabled, пока PATCH в полёте.
        if (!prev || pendingRef.current.size === 0) return list;
        return list.map((u) => {
          if (!pendingRef.current.has(u.id)) return u;
          const old = prev.find((p) => p.id === u.id);
          return old ? { ...u, enabled: old.enabled } : u;
        });
      });
      setLoadError(null);
    } catch (e) {
      setLoadError(
        e instanceof Error ? e.message : 'Не удалось загрузить список',
      );
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const toggleUser = useCallback(async (u: UserDTO) => {
    const next = !u.enabled;
    pendingRef.current.add(u.id);
    setPending(new Set(pendingRef.current));
    // Оптимистичное обновление.
    setUsers((prev) =>
      prev ? prev.map((x) => (x.id === u.id ? { ...x, enabled: next } : x)) : prev,
    );
    try {
      const updated = await api.updateUser(u.id, { enabled: next });
      setUsers((prev) =>
        prev ? prev.map((x) => (x.id === u.id ? updated : x)) : prev,
      );
      setActionError(null);
    } catch (e) {
      // Откат.
      setUsers((prev) =>
        prev
          ? prev.map((x) => (x.id === u.id ? { ...x, enabled: u.enabled } : x))
          : prev,
      );
      setActionError(
        e instanceof Error
          ? e.message
          : `Не удалось изменить статус пользователя «${u.name}»`,
      );
    } finally {
      pendingRef.current.delete(u.id);
      setPending(new Set(pendingRef.current));
    }
  }, []);

  const openModal = () => {
    setNewName('');
    setCreateError(null);
    setCreatedUser(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    if (creating) return;
    setModalOpen(false);
    setCreatedUser(null);
    setCreateError(null);
    setNewName('');
  };

  const submitCreate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (creating) return;
    const name = newName.trim();
    if (!name) {
      setCreateError('Введите имя пользователя');
      return;
    }
    if (name.length > 64) {
      setCreateError('Имя не длиннее 64 символов');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.createUser(name);
      setUsers((prev) => (prev ? [...prev, created] : [created]));
      setCreatedUser(created);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : 'Не удалось создать пользователя',
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">
          Пользователи
          {users !== null && users.length > 0 && (
            <span className="ml-2 text-sm font-normal text-slate-500">
              {users.length}
            </span>
          )}
        </h1>
        <button type="button" onClick={openModal} className={primaryBtn}>
          <Plus size={16} />
          Добавить пользователя
        </button>
      </div>

      {actionError && (
        <div className={errorBox} role="alert">
          {actionError}
        </div>
      )}

      {users !== null && loadError && (
        <div className={errorBox} role="alert">
          {loadError} — показаны последние загруженные данные.
        </div>
      )}

      {users === null && loadError && (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-slate-800 bg-slate-900/60 px-6 py-12 text-center">
          <div className={errorBox}>{loadError}</div>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-800"
          >
            Повторить
          </button>
        </div>
      )}

      {users === null && !loadError && (
        <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-11 animate-pulse rounded-lg bg-slate-800/60" />
          ))}
        </div>
      )}

      {users !== null && users.length === 0 && (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-slate-800 bg-slate-900/60 px-6 py-16 text-center">
          <UsersIcon size={40} className="text-slate-600" />
          <div>
            <p className="font-medium text-slate-100">
              Пока нет ни одного пользователя
            </p>
            <p className="mt-1 text-sm text-slate-400">
              Добавьте первого пользователя, чтобы выдать ему доступ к VPN.
            </p>
          </div>
          <button type="button" onClick={openModal} className={primaryBtn}>
            <Plus size={16} />
            Добавить пользователя
          </button>
        </div>
      )}

      {users !== null && users.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3 font-medium">Имя</th>
                <th className="px-4 py-3 font-medium">IP-адрес</th>
                <th className="px-4 py-3 font-medium">Статус</th>
                <th className="px-4 py-3 font-medium">Трафик</th>
                <th className="px-4 py-3 text-right font-medium">Вкл.</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr
                  key={u.id}
                  onClick={() => navigate(`/users/${u.id}`)}
                  className="cursor-pointer border-t border-slate-800 transition-colors hover:bg-slate-800/40"
                >
                  <td className="px-4 py-3 font-medium text-slate-100">
                    {u.name}
                  </td>
                  <td className="px-4 py-3 font-mono text-slate-400">
                    {u.address}
                  </td>
                  <td className="px-4 py-3">
                    {u.online ? (
                      <span className="flex items-center gap-2 text-slate-100">
                        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-400" />
                        онлайн
                      </span>
                    ) : (
                      <span className="flex items-center gap-2 text-slate-400">
                        <span className="h-2 w-2 shrink-0 rounded-full bg-slate-600" />
                        {timeAgo(u.lastHandshake)}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-400">
                    <span className="text-sky-400">↓</span>{' '}
                    {formatBytes(u.totalTx)}
                    <span className="ml-3 text-emerald-400">↑</span>{' '}
                    {formatBytes(u.totalRx)}
                  </td>
                  <td
                    className="px-4 py-3 text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Toggle
                      checked={u.enabled}
                      disabled={pending.has(u.id)}
                      onChange={() => void toggleUser(u)}
                      ariaLabel={
                        u.enabled
                          ? `Отключить пользователя ${u.name}`
                          : `Включить пользователя ${u.name}`
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <Modal
          title={createdUser ? 'Пользователь создан' : 'Новый пользователь'}
          onClose={closeModal}
        >
          {createdUser ? (
            <div className="flex flex-col gap-4">
              <p className="text-center text-sm text-slate-400">
                Отсканируйте QR в приложении WireGuard или скачайте файл
                конфигурации для{' '}
                <span className="font-medium text-slate-100">
                  {createdUser.name}
                </span>
                .
              </p>
              <PeerConfig
                userId={createdUser.id}
                userName={createdUser.name}
              />
              <button
                type="button"
                onClick={closeModal}
                className="w-full rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-800"
              >
                Готово
              </button>
            </div>
          ) : (
            <form onSubmit={submitCreate} className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5 text-sm text-slate-400">
                Имя пользователя
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={64}
                  placeholder="Например, ноутбук Алисы"
                  className={inputClass}
                />
              </label>
              {createError && <div className={errorBox}>{createError}</div>}
              <button
                type="submit"
                disabled={creating}
                className={`${primaryBtn} w-full justify-center`}
              >
                {creating ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <UserPlus size={16} />
                )}
                Создать
              </button>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}
