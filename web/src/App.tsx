import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './lib/api';
import type { AuthStatus } from './lib/types';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Users from './pages/Users';
import UserDetail from './pages/UserDetail';

export default function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState(false);

  const refresh = useCallback(() => {
    api
      .authStatus()
      .then((s) => {
        setStatus(s);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    api.onUnauthorized = () =>
      setStatus((s) => (s ? { ...s, authenticated: false } : s));
    refresh();
  }, [refresh]);

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-slate-400">
        <p>Сервер недоступен</p>
        <button
          onClick={refresh}
          className="rounded-lg bg-emerald-500 px-4 py-2 font-medium text-slate-950 hover:bg-emerald-400"
        >
          Повторить
        </button>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex h-screen items-center justify-center text-slate-500">
        Загрузка…
      </div>
    );
  }

  if (!status.authenticated) {
    return <Login needsSetup={status.needsSetup} onSuccess={refresh} />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route
          element={
            <Layout
              onLogout={() => {
                void api.logout().finally(refresh);
              }}
            />
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="/users" element={<Users />} />
          <Route path="/users/:id" element={<UserDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
