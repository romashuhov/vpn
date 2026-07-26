import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { LayoutDashboard, LogOut, Shield, Users } from 'lucide-react';
import { api } from '../lib/api';

interface Props {
  onLogout: () => void;
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
    isActive
      ? 'bg-emerald-500/10 text-emerald-400'
      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100',
  ].join(' ');

/** Каркас панели: тёмный сайдбар (на мобильном — верхняя панель) + Outlet. */
export default function Layout({ onLogout }: Props) {
  const [mock, setMock] = useState(false);

  // Один раз узнаём, работает ли сервер в демо-режиме. Ошибки молча —
  // бейдж не критичен для работы панели.
  useEffect(() => {
    let cancelled = false;
    api
      .overview()
      .then((o) => {
        if (!cancelled) setMock(o.server.mock);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex items-center gap-4 border-b border-slate-800 bg-slate-900/60 px-4 py-3 md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:flex-col md:items-stretch md:gap-0 md:border-b-0 md:border-r md:py-6">
        <div className="flex shrink-0 items-center gap-2 md:px-3">
          <Shield size={24} className="shrink-0 text-emerald-400" />
          <span className="text-lg font-semibold tracking-tight text-slate-100">
            WireDeck
          </span>
        </div>

        <nav className="flex min-w-0 items-center gap-1 md:mt-8 md:flex-col md:items-stretch">
          <NavLink to="/" end className={navLinkClass}>
            <LayoutDashboard size={18} className="shrink-0" />
            <span className="hidden sm:inline">Дашборд</span>
          </NavLink>
          <NavLink to="/users" className={navLinkClass}>
            <Users size={18} className="shrink-0" />
            <span className="hidden sm:inline">Пользователи</span>
          </NavLink>
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2 md:ml-0 md:mt-auto md:flex-col md:items-stretch md:gap-3">
          {mock && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-400 md:self-start md:ml-3">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              демо-режим
            </span>
          )}
          <button
            type="button"
            onClick={onLogout}
            title="Выйти"
            className="flex items-center gap-2.5 rounded-lg p-2 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-slate-100 md:px-3 md:py-2"
          >
            <LogOut size={16} className="shrink-0" />
            <span className="hidden md:inline">Выйти</span>
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
        <Outlet />
      </main>
    </div>
  );
}
