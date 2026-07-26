import { useState } from 'react';
import type { FormEvent } from 'react';
import { Loader2, Shield } from 'lucide-react';
import { api } from '../lib/api';

interface Props {
  needsSetup: boolean;
  onSuccess: () => void;
}

const inputClass =
  'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-emerald-500';

/** Логин / первичная настройка пароля администратора. */
export default function Login({ needsSetup, onSuccess }: Props) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setError(null);

    if (needsSetup) {
      if (password.length < 8) {
        setError('Пароль должен быть не короче 8 символов');
        return;
      }
      if (password !== confirm) {
        setError('Пароли не совпадают');
        return;
      }
    } else if (!password) {
      setError('Введите пароль');
      return;
    }

    setBusy(true);
    try {
      if (needsSetup) {
        await api.setup(password);
        await api.login(password);
      } else {
        await api.login(password);
      }
      // Логин может «пройти» (204), а cookie сессии — не сохраниться: браузер
      // молча отбрасывает Secure-cookie на http-адресах (кроме localhost).
      // Без этой проверки форма оставалась бы с вечным спиннером.
      const status = await api.authStatus();
      if (!status.authenticated) {
        setError(
          'Пароль верный, но браузер не сохранил cookie сессии. Обычно это ' +
            'COOKIE_SECURE=1 при входе по http:// — уберите его из deploy/.env ' +
            '(и сделайте ./restart.sh) либо откройте панель по https.',
        );
        setBusy(false);
        return;
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось войти');
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900/60 p-8">
        <div className="mb-6 flex flex-col items-center gap-3">
          <Shield size={36} className="text-emerald-400" />
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight text-slate-100">
              WireDeck
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              {needsSetup
                ? 'Придумайте пароль администратора'
                : 'Вход в панель управления'}
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <label className="flex flex-col gap-1.5 text-sm text-slate-400">
            Пароль
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete={needsSetup ? 'new-password' : 'current-password'}
              placeholder={needsSetup ? 'Минимум 8 символов' : '••••••••'}
              className={inputClass}
            />
          </label>

          {needsSetup && (
            <label className="flex flex-col gap-1.5 text-sm text-slate-400">
              Повторите пароль
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                placeholder="Ещё раз"
                className={inputClass}
              />
            </label>
          )}

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 font-medium text-slate-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            {needsSetup ? 'Сохранить и войти' : 'Войти'}
          </button>
        </form>
      </div>
    </div>
  );
}
