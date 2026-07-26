import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

interface Props {
  title: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: LucideIcon;
}

/** Стат-карточка дашборда: заголовок, крупное значение, вторичная строка. */
export default function StatCard({ title, value, sub, icon: Icon }: Props) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm text-slate-400">{title}</span>
        {Icon && <Icon size={18} className="shrink-0 text-slate-500" aria-hidden />}
      </div>
      <div className="mt-2 min-h-8 text-2xl font-semibold text-slate-100">{value}</div>
      {sub !== undefined && <div className="mt-1 text-xs text-slate-400">{sub}</div>}
    </div>
  );
}
