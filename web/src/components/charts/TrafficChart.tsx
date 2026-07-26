import { useId, useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Range, TimeseriesPoint } from '../../lib/types';
import { formatBytes } from '../../lib/format';

/** rx с точки зрения сервера = выгрузка юзера ↑ (контракт: #34d399). */
export const RX_COLOR = '#34d399';
/** tx с точки зрения сервера = загрузка юзера ↓ (контракт: #38bdf8). */
export const TX_COLOR = '#38bdf8';

const GRID_COLOR = '#1e293b';
const TICK_COLOR = '#64748b';
const CURSOR_COLOR = '#334155';
/** Поверхность карточки — кольцо вокруг активной точки, чтобы она читалась поверх линий. */
const SURFACE_COLOR = '#0f172a';

function formatTick(ts: number, range: Range): string {
  const d = new Date(ts);
  if (range === '24h') {
    return d.toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short' });
}

function formatTooltipTs(ts: number, range: Range): string {
  const d = new Date(ts);
  if (range === '30d') {
    return d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  return d.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface TooltipItem {
  dataKey?: string | number;
  value?: number | string;
}

interface ChartTooltipProps {
  range: Range;
  /* active/payload/label подставляет recharts при клонировании элемента. */
  active?: boolean;
  label?: number | string;
  payload?: TooltipItem[];
}

function ChartTooltip({ range, active, label, payload }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0 || typeof label !== 'number') return null;
  const tx = Number(payload.find((p) => p.dataKey === 'tx')?.value ?? 0);
  const rx = Number(payload.find((p) => p.dataKey === 'rx')?.value ?? 0);
  return (
    <div className="min-w-44 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 shadow-xl">
      <p className="mb-1.5 text-xs text-slate-500">{formatTooltipTs(label, range)}</p>
      <div className="space-y-1 text-xs">
        <div className="flex items-center gap-2">
          <span
            className="h-0.5 w-3 shrink-0 rounded-full"
            style={{ backgroundColor: TX_COLOR }}
          />
          <span className="text-slate-400">Загрузка ↓</span>
          <span className="ml-auto font-medium tabular-nums text-slate-100">
            {formatBytes(tx)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="h-0.5 w-3 shrink-0 rounded-full"
            style={{ backgroundColor: RX_COLOR }}
          />
          <span className="text-slate-400">Выгрузка ↑</span>
          <span className="ml-auto font-medium tabular-nums text-slate-100">
            {formatBytes(rx)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 border-t border-slate-800 pt-1">
          <span className="text-slate-400">Всего</span>
          <span className="ml-auto font-medium tabular-nums text-slate-100">
            {formatBytes(tx + rx)}
          </span>
        </div>
      </div>
    </div>
  );
}

interface Props {
  data: TimeseriesPoint[];
  range: Range;
  /** Явная высота области графика (обязательна для ResponsiveContainer). */
  heightClass?: string;
  /** Пока true и данные уже есть — держим прежний кадр с пониженной прозрачностью. */
  loading?: boolean;
}

/** Area-график трафика (rx/tx) с легендой, кастомным тултипом и осями под период. */
export default function TrafficChart({
  data,
  range,
  heightClass = 'h-72',
  loading = false,
}: Props) {
  // useId может содержать двоеточия — в url(#id) они мешают, вычищаем.
  const gid = useId().replace(/[^a-zA-Z0-9]/g, '');

  const ticks = useMemo(() => {
    if (data.length === 0) return undefined;
    if (range === '24h') {
      // Часовые точки — подписи каждые 3 часа.
      return data.filter((p) => new Date(p.ts).getHours() % 3 === 0).map((p) => p.ts);
    }
    if (range === '7d') {
      // Часовые точки за неделю — подписи по полуночам (датам).
      return data.filter((p) => new Date(p.ts).getHours() === 0).map((p) => p.ts);
    }
    // 30 дневных точек — подпись каждые 5 дней.
    return data.filter((_, i) => i % 5 === 0).map((p) => p.ts);
  }, [data, range]);

  if (data.length === 0) {
    if (loading) {
      return <div className={`w-full ${heightClass} animate-pulse rounded-lg bg-slate-800/40`} />;
    }
    return (
      <div
        className={`flex w-full items-center justify-center ${heightClass} text-sm text-slate-500`}
      >
        Нет данных за выбранный период
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end gap-4 text-xs text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full" style={{ backgroundColor: TX_COLOR }} />
          Загрузка ↓
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full" style={{ backgroundColor: RX_COLOR }} />
          Выгрузка ↑
        </span>
      </div>
      <div
        className={`w-full ${heightClass} transition-opacity duration-300 ${
          loading ? 'opacity-50' : 'opacity-100'
        }`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`${gid}tx`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={TX_COLOR} stopOpacity={0.28} />
                <stop offset="100%" stopColor={TX_COLOR} stopOpacity={0} />
              </linearGradient>
              <linearGradient id={`${gid}rx`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={RX_COLOR} stopOpacity={0.28} />
                <stop offset="100%" stopColor={RX_COLOR} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={GRID_COLOR} strokeWidth={1} vertical={false} />
            <XAxis
              dataKey="ts"
              ticks={ticks}
              interval={0}
              tickFormatter={(v: number) => formatTick(v, range)}
              tick={{ fill: TICK_COLOR, fontSize: 11 }}
              axisLine={{ stroke: GRID_COLOR }}
              tickLine={false}
              tickMargin={8}
            />
            <YAxis
              tickFormatter={(v: number) => formatBytes(v)}
              tick={{ fill: TICK_COLOR, fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={64}
              domain={[0, (dataMax: number) => (dataMax > 0 ? dataMax : 1024)]}
            />
            <Tooltip
              content={<ChartTooltip range={range} />}
              cursor={{ stroke: CURSOR_COLOR, strokeWidth: 1 }}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="tx"
              name="Загрузка ↓"
              stroke={TX_COLOR}
              strokeWidth={2}
              fill={`url(#${gid}tx)`}
              dot={false}
              activeDot={{ r: 4, fill: TX_COLOR, stroke: SURFACE_COLOR, strokeWidth: 2 }}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="rx"
              name="Выгрузка ↑"
              stroke={RX_COLOR}
              strokeWidth={2}
              fill={`url(#${gid}rx)`}
              dot={false}
              activeDot={{ r: 4, fill: RX_COLOR, stroke: SURFACE_COLOR, strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
