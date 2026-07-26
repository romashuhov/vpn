const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 Б';
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const s = v >= 100 || i === 0 ? String(Math.round(v)) : v.toFixed(1).replace('.', ',');
  return `${s} ${UNITS[i]}`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function timeAgo(ms: number | null): string {
  if (!ms) return 'никогда';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 15) return 'только что';
  if (s < 60) return `${s} сек назад`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  return `${d} дн назад`;
}
