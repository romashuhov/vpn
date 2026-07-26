import { useCallback, useEffect, useRef, useState } from 'react';
import * as QRCode from 'qrcode';
import { Check, Copy, Download, Loader2 } from 'lucide-react';
import { api } from '../lib/api';

interface Props {
  userId: number;
  userName: string;
}

/** Имя файла как на сервере: только [a-zA-Z0-9_-], иначе wg-client-<id>. */
function confFileName(userName: string, userId: number): string {
  const safe = userName.replace(/[^a-zA-Z0-9_-]/g, '');
  return `${safe || `wg-client-${userId}`}.conf`;
}

/** Конфиг пира: QR-код + кнопки «Скачать .conf» и «Скопировать». */
export default function PeerConfig({ userId, userName }: Props) {
  const [config, setConfig] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setConfig(null);
    setQr(null);

    (async () => {
      let text: string;
      try {
        text = await api.getUserConfig(userId);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : 'Не удалось загрузить конфигурацию',
          );
          setLoading(false);
        }
        return;
      }
      if (cancelled) return;
      setConfig(text);

      // QR отдельно: если генерация не удалась, кнопки всё равно работают.
      // Тёмные модули на белом фоне — так QR надёжно читается камерой телефона.
      try {
        const dataUrl = await QRCode.toDataURL(text, {
          width: 260,
          margin: 1,
          color: { dark: '#0f172a', light: '#ffffff' },
        });
        if (!cancelled) setQr(dataUrl);
      } catch {
        /* останутся кнопки скачивания/копирования */
      }
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, reloadKey]);

  // Сброс таймера галочки при размонтировании.
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const download = useCallback(() => {
    if (!config) return;
    const blob = new Blob([config], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = confFileName(userName, userId);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [config, userId, userName]);

  const copy = useCallback(async () => {
    if (!config) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(config);
      } else {
        // Fallback для не-HTTPS окружений.
        const ta = document.createElement('textarea');
        ta.value = config;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (!ok) throw new Error('copy failed');
      }
      setCopyFailed(false);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, 2000);
  }, [config]);

  if (loading) {
    return (
      <div className="flex h-[300px] flex-col items-center justify-center gap-3 text-slate-500">
        <Loader2 size={24} className="animate-spin" />
        <span className="text-sm">Загрузка конфигурации…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3">
        <div className="w-full rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-800"
        >
          Повторить
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      {qr ? (
        <img
          src={qr}
          alt={`QR-код конфигурации WireGuard для ${userName}`}
          width={260}
          height={260}
          className="rounded-lg bg-white p-1"
        />
      ) : (
        <div className="flex h-[260px] w-[260px] items-center justify-center rounded-lg border border-slate-800 bg-slate-900/60 px-4 text-center text-sm text-slate-500">
          Не удалось построить QR-код — скачайте файл конфигурации
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={download}
          className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 transition-colors hover:bg-emerald-400"
        >
          <Download size={16} />
          Скачать .conf
        </button>
        <button
          type="button"
          onClick={() => void copy()}
          className={[
            'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm transition-colors',
            copyFailed
              ? 'border-red-500/30 text-red-400'
              : 'border-slate-700 text-slate-300 hover:bg-slate-800',
          ].join(' ')}
        >
          {copied ? (
            <>
              <Check size={16} className="text-emerald-400" />
              Скопировано
            </>
          ) : copyFailed ? (
            'Не удалось скопировать'
          ) : (
            <>
              <Copy size={16} />
              Скопировать
            </>
          )}
        </button>
      </div>
    </div>
  );
}
