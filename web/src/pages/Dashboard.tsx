import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, HardDrive, Server, Users } from 'lucide-react';
import { api } from '../lib/api';
import type { OnlineUserDTO, OverviewDTO, Range, TimeseriesPoint, UserUsage } from '../lib/types';
import { formatBytes } from '../lib/format';
import StatCard from '../components/charts/StatCard';
import RangeTabs from '../components/charts/RangeTabs';
import TrafficChart, { RX_COLOR, TX_COLOR } from '../components/charts/TrafficChart';

const RANGE_LABEL: Record<Range, string> = {
  '24h': 'за 24 часа',
  '7d': 'за 7 дней',
  '30d': 'за 30 дней',
};

/** Строка топа: имя, горизонтальный бар (доля от максимума) и суммарный трафик. */
function TopUserRow({ user, max }: { user: UserUsage; max: number }) {
  const navigate = useNavigate();
  const total = user.rx + user.tx;
  const txPct = (user.tx / max) * 100;
  const rxPct = (user.rx / max) * 100;
  return (
    <button
      type="button"
      onClick={() => navigate(`/users/${user.id}`)}
      title={`↓ ${formatBytes(user.tx)} · ↑ ${formatBytes(user.rx)}`}
      className="group -mx-2 w-[calc(100%+1rem)] rounded-lg px-2 py-2 text-left transition-colors hover:bg-slate-800/50"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-sm text-slate-200 transition-colors group-hover:text-emerald-400">
          {user.name}
        </span>
        <span className="shrink-0 text-sm font-medium tabular-nums text-slate-100">
          {formatBytes(total)}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
        {total > 0 && (
          <div className="flex h-full gap-0.5">
            <div
              className="h-full shrink-0"
              style={{ width: `${txPct}%`, backgroundColor: TX_COLOR }}
            />
            <div
              className="h-full shrink-0"
              style={{ width: `${rxPct}%`, backgroundColor: RX_COLOR }}
            />
          </div>
        )}
      </div>
    </button>
  );
}

/** Мини-список онлайн-юзеров с текущей скоростью — внутри карточки «Пользователи». */
function OnlineList({ online }: { online: OnlineUserDTO[] }) {
  if (online.length === 0) return null;
  return (
    // ~5 строк видно, дальше — вертикальный скролл.
    <div className="-mx-1 mt-2 max-h-[7.5rem] space-y-0.5 overflow-y-auto pr-1">
      {online.map((u) => (
        <Link
          key={u.id}
          to={`/users/${u.id}`}
          className="flex items-center justify-between gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-slate-800/50"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
            <span className="truncate text-slate-300">{u.name}</span>
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
            ↓ {formatBytes(u.rateTx)}/с · ↑ {formatBytes(u.rateRx)}/с
          </span>
        </Link>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const [range, setRange] = useState<Range>('24h');
  const [overview, setOverview] = useState<OverviewDTO | null>(null);
  const [series, setSeries] = useState<TimeseriesPoint[] | null>(null);
  const [top, setTop] = useState<UserUsage[] | null>(null);
  const [online, setOnline] = useState<OnlineUserDTO[] | null>(null);
  const [chartLoading, setChartLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Онлайн-список живее остального дашборда: свой поллинг каждые 10 сек.
  // Ошибки молча — виджет вспомогательный, показываем последние данные.
  useEffect(() => {
    let cancelled = false;
    let seq = 0; // защита от out-of-order: применяем только ответ последнего запроса
    const load = () => {
      const mySeq = ++seq;
      api
        .onlineUsers()
        .then((list) => {
          if (!cancelled && mySeq === seq) setOnline(list);
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async (initial: boolean) => {
      // При смене периода график «тускнеет» до прихода новых данных;
      // фоновое автообновление кадр не трогает.
      if (initial) setChartLoading(true);
      try {
        const [ov, ts, tu] = await Promise.all([
          api.overview(),
          api.timeseries(range),
          api.topUsers(range),
        ]);
        if (cancelled) return;
        setOverview(ov);
        setSeries(ts);
        setTop(tu);
        setError(null);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Не удалось загрузить статистику');
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
  }, [range, reloadKey]);

  const top5 = (top ?? []).filter((u) => u.rx + u.tx > 0).slice(0, 5);
  const maxTotal = Math.max(...top5.map((u) => u.rx + u.tx), 1);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-slate-100">Дашборд</h1>

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <span>{error}</span>
          {!overview && (
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="rounded-lg bg-emerald-500 px-3 py-1.5 font-medium text-slate-950 transition-colors hover:bg-emerald-400"
            >
              Повторить
            </button>
          )}
        </div>
      )}

      {/* Смена WG_SUBNET на живой установке — молчаливый отказ: у пользователей
          со старыми адресами хендшейк проходит и панель показывает их онлайн, но
          трафик наружу не идёт (адрес из старой подсети, MASQUERADE — из новой),
          и перевыдача конфига не помогает. Без баннера владелец видит только
          «всё зелёное» и ищет причину на стороне клиентов. */}
      {(overview?.server.usersOutsideSubnet ?? 0) > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
          <p className="font-medium">
            Подсеть VPN не совпадает с адресами пользователей ({overview?.server.usersOutsideSubnet}{' '}
            польз.)
          </p>
          <p className="mt-1 text-amber-400/80">
            Похоже, WG_SUBNET сменили на уже работающей установке. У этих клиентов туннель
            поднимается и хендшейк проходит, но интернета через VPN нет, и перевыдача конфига это
            не лечит. Верните прежнее значение WG_SUBNET в deploy/.env и перезапустите панель —
            либо оставьте новую подсеть и пересоздайте этих пользователей (им понадобятся новые
            конфиги).
          </p>
        </div>
      )}

      {overview ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            title="Пользователи"
            icon={Users}
            value={
              <>
                {overview.usersTotal}
                <span className="ml-1.5 text-sm font-normal text-slate-400">всего</span>
              </>
            }
            sub={
              // Счётчик берём из более свежего /api/stats/online (поллинг 10с),
              // чтобы не расходился со списком под ним; overview — только до
              // первого ответа (критерий онлайна на сервере один и тот же).
              <div>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      (online?.length ?? overview.usersOnline) > 0
                        ? 'animate-pulse bg-emerald-400'
                        : 'bg-slate-600'
                    }`}
                  />
                  {online?.length ?? overview.usersOnline} онлайн
                </span>
                <OnlineList online={online ?? []} />
              </div>
            }
          />
          <StatCard
            title="Трафик сегодня"
            icon={Activity}
            value={formatBytes(overview.txToday + overview.rxToday)}
            sub={`↓ ${formatBytes(overview.txToday)} · ↑ ${formatBytes(overview.rxToday)}`}
          />
          <StatCard
            title="Трафик за всё время"
            icon={HardDrive}
            value={formatBytes(overview.txTotal + overview.rxTotal)}
            sub={`↓ ${formatBytes(overview.txTotal)} · ↑ ${formatBytes(overview.rxTotal)}`}
          />
          <StatCard
            title="Сервер"
            icon={Server}
            value={
              overview.server.mock ? (
                <span className="inline-flex rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-sm font-medium text-amber-400">
                  демо-режим
                </span>
              ) : overview.server.host ? (
                <span className="text-lg break-all">
                  {overview.server.host}:{overview.server.port}
                </span>
              ) : (
                <span className="text-lg text-slate-500">WG_HOST не задан</span>
              )
            }
            sub={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  {overview.server.iface} · {overview.server.subnet}
                </span>
                {overview.server.engine === 'awg' && (
                  <span
                    title="Трафик маскируется от DPI — клиентам нужно приложение AmneziaWG (не AmneziaVPN)"
                    className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-400"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                    AmneziaWG
                  </span>
                )}
              </span>
            }
          />
        </div>
      ) : (
        !error && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-28 animate-pulse rounded-xl border border-slate-800 bg-slate-900/40"
              />
            ))}
          </div>
        )
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium text-slate-100">Трафик</h2>
        <RangeTabs value={range} onChange={setRange} />
      </div>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <TrafficChart
          data={series ?? []}
          range={range}
          heightClass="h-80"
          loading={chartLoading}
        />
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="mb-3 flex items-baseline gap-2">
          <h2 className="font-medium text-slate-100">Топ-5 пользователей</h2>
          <span className="text-xs text-slate-500">{RANGE_LABEL[range]}</span>
        </div>
        {top === null ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 animate-pulse rounded-lg bg-slate-800/40" />
            ))}
          </div>
        ) : top5.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500">
            Нет данных о трафике за выбранный период
          </p>
        ) : (
          <div className="space-y-1">
            {top5.map((u) => (
              <TopUserRow key={u.id} user={u} max={maxTotal} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
