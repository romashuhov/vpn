import { useCallback, useEffect, useRef, useState } from 'react';
import * as QRCode from 'qrcode';
import { Check, Copy, Download, Loader2, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import type { WgEngine } from '../lib/types';

interface Props {
  userId: number;
  userName: string;
}

/** Имя файла как на сервере: только [a-zA-Z0-9_-], иначе wg-client-<id>. */
function confFileName(userName: string, userId: number): string {
  const safe = userName.replace(/[^a-zA-Z0-9_-]/g, '');
  return `${safe || `wg-client-${userId}`}.conf`;
}

// Движок туннеля меняется только рестартом сервера — тянем один раз на вкладку
// и делим промис между всеми PeerConfig (их на странице может быть несколько).
// Ошибка — молча 'wg' (QR важнее предупреждения) + сброс кэша, чтобы следующее
// монтирование переспросило.
let enginePromise: Promise<WgEngine> | null = null;

function loadEngine(): Promise<WgEngine> {
  if (!enginePromise) {
    enginePromise = api.overview().then(
      (o) => (o.server.engine === 'awg' ? 'awg' : 'wg'),
      () => {
        enginePromise = null;
        return 'wg' as WgEngine;
      },
    );
  }
  return enginePromise;
}

/** Конфиг AmneziaWG не открывается официальным клиентом WireGuard — предупреждаем заранее. */
function AmneziaNotice() {
  return (
    <div className="flex w-full items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-left text-amber-400">
      <TriangleAlert size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 space-y-1 text-xs leading-relaxed">
        <p className="text-sm font-medium">Нужно приложение AmneziaVPN</p>
        <p className="text-amber-400/80">
          Конфиг использует AmneziaWG (WireGuard с обфускацией) — официальное приложение
          WireGuard его <span className="font-medium">не откроет</span>. Установите AmneziaVPN
          для Android, iOS, Windows или macOS, затем импортируйте файл или отсканируйте
          QR-код.
        </p>
        <p className="font-medium break-all select-all text-amber-300">https://amnezia.org/</p>
      </div>
    </div>
  );
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
  const [engine, setEngine] = useState<WgEngine>('wg');
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void loadEngine().then((e) => {
      if (!cancelled) setEngine(e);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
      //
      // Размер и коррекция ошибок подобраны под длинные конфиги: у AmneziaWG
      // добавляется девять строк параметров обфускации, код разрастается до
      // версии 17 (85x85 модулей), и при 260 px модуль выходит меньше 3 px —
      // камера такое не берёт. Уровень 'L' вместо 'M' убирает две версии
      // (73x73), а 380 px дают ~5 px на модуль. Избыточная коррекция здесь не
      // нужна: код показывается на экране, а не печатается на бумаге.
      try {
        const dataUrl = await QRCode.toDataURL(text, {
          errorCorrectionLevel: 'L',
          width: 380,
          margin: 2, // quiet zone: сканеры требуют светлое поле вокруг кода
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
      {engine === 'awg' && <AmneziaNotice />}

      {qr ? (
        // Картинка 380x380 показывается во всю доступную ширину (но не крупнее
        // натурального размера): чем больше модуль на экране, тем увереннее
        // сканируется — особенно длинный конфиг AmneziaWG.
        <img
          src={qr}
          alt={`QR-код конфигурации ${engine === 'awg' ? 'AmneziaWG' : 'WireGuard'} для ${userName}`}
          width={380}
          height={380}
          className="h-auto w-full max-w-[380px] rounded-lg bg-white p-2"
        />
      ) : (
        <div className="flex aspect-square w-full max-w-[380px] items-center justify-center rounded-lg border border-slate-800 bg-slate-900/60 px-4 text-center text-sm text-slate-500">
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
