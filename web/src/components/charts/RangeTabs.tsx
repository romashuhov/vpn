import type { Range } from '../../lib/types';

const OPTIONS: ReadonlyArray<{ value: Range; label: string }> = [
  { value: '24h', label: '24 ч' },
  { value: '7d', label: '7 дн' },
  { value: '30d', label: '30 дн' },
];

interface Props {
  value: Range;
  onChange: (range: Range) => void;
}

/** Сегментированный переключатель периода 24ч / 7д / 30д. */
export default function RangeTabs({ value, onChange }: Props) {
  return (
    <div
      role="tablist"
      aria-label="Период"
      className="inline-flex shrink-0 rounded-lg border border-slate-800 bg-slate-900/60 p-0.5"
    >
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={[
            'rounded-md px-3 py-1 text-sm transition-colors',
            value === o.value
              ? 'bg-slate-800 font-medium text-slate-100'
              : 'text-slate-400 hover:text-slate-200',
          ].join(' ')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
