import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as QRCode from 'qrcode';
import { Check, Copy, Download, Link2, Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import { confFileName } from '../lib/filename';
import type { AmneziaExportDTO, WgEngine } from '../lib/types';

interface Props {
  userId: number;
  userName: string;
}

/** Формат выдачи конфига: текстовый .conf (AmneziaWG) или упакованная ссылка vpn:// (AmneziaVPN). */
type Format = 'conf' | 'link';

/**
 * Параметры QR одинаковы для обоих форматов — см. комментарий в загрузке конфига.
 * Картинка рендерится вдвое крупнее показываемых 420 px: нагрузка AmneziaVPN даёт
 * версию 22 (105x105 модулей), и на HiDPI-экране апскейл размывал бы границы
 * модулей — а сканируют код камерой прямо с экрана.
 */
const QR_OPTIONS = {
  errorCorrectionLevel: 'L',
  width: 840,
  margin: 4, // quiet zone по ISO/IEC 18004; при меньшей сканеры сбоят
  color: { dark: '#000000', light: '#ffffff' },
} as const;

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

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback для не-HTTPS окружений.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy failed');
}

/** Кнопка копирования с галочкой на 2 секунды; кнопок на экране две — состояние у каждой своё. */
function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const run = useCallback(async (text: string | null | undefined) => {
    if (!text) return;
    try {
      await writeClipboard(text);
      setFailed(false);
      setCopied(true);
    } catch {
      setCopied(false);
      setFailed(true);
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 2000);
  }, []);

  return { copied, failed, run };
}

function CopyButton({
  label,
  icon,
  state,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  state: { copied: boolean; failed: boolean };
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm transition-colors',
        state.failed
          ? 'border-red-500/30 text-red-400'
          : 'border-slate-700 text-slate-300 hover:bg-slate-800',
      ].join(' ')}
    >
      {state.copied ? (
        <>
          <Check size={16} className="text-emerald-400" />
          Скопировано
        </>
      ) : state.failed ? (
        'Не удалось скопировать'
      ) : (
        <>
          {icon}
          {label}
        </>
      )}
    </button>
  );
}

/**
 * Какое приложение открывает конфиг. Спокойная справка, а не предупреждение:
 * AmneziaWG — обычный режим работы панели, а не отклонение от нормы.
 */
function AppHint({ engine, format }: { engine: WgEngine; format: Format }) {
  if (engine !== 'awg') {
    return (
      <div className="w-full space-y-1 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-left text-xs leading-relaxed break-words text-slate-400">
        <p className="text-sm font-medium text-slate-200">Приложение: WireGuard</p>
        <p>
          Официальный клиент для Android, iOS, Windows, macOS и Linux —{' '}
          <span className="text-slate-300 select-all">wireguard.com/install</span>
        </p>
      </div>
    );
  }

  if (format === 'link') {
    return (
      <div className="w-full space-y-1 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-left text-xs leading-relaxed break-words text-slate-400">
        <p className="text-sm font-medium text-slate-200">Приложение: AmneziaVPN</p>
        <p>
          Основное приложение Amnezia для Android, iOS, Windows, macOS и Linux —{' '}
          <span className="text-slate-300 select-all">amnezia.org</span>, Android и iOS
          также в Google Play и App Store.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full space-y-1 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-left text-xs leading-relaxed text-slate-400">
      <p className="text-sm font-medium text-slate-200">Приложение: AmneziaWG</p>
      <p>
        Android — Google Play или APK{' '}
        <span className="text-slate-300 select-all">
          github.com/amnezia-vpn/amneziawg-android/releases
        </span>
        ; iOS — App Store; Windows —{' '}
        <span className="text-slate-300 select-all">
          github.com/amnezia-vpn/amneziawg-windows-client/releases
        </span>
        .
      </p>
    </div>
  );
}

/** Сегментированный переключатель формата — по образцу RangeTabs. */
function FormatTabs({
  value,
  onChange,
}: {
  value: Format;
  onChange: (f: Format) => void;
}) {
  const options: ReadonlyArray<{ value: Format; label: string }> = [
    { value: 'conf', label: 'AmneziaWG' },
    { value: 'link', label: 'AmneziaVPN' },
  ];
  return (
    <div
      role="tablist"
      aria-label="Формат конфигурации"
      className="inline-flex shrink-0 rounded-lg border border-slate-800 bg-slate-900/60 p-0.5"
    >
      {options.map((o) => (
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

/** Конфиг пира: QR-код + кнопки «Скачать .conf» и «Скопировать». */
export default function PeerConfig({ userId, userName }: Props) {
  const [config, setConfig] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  // null — движок ещё неизвестен: подсказку и табы до этого момента не рисуем,
  // иначе на первом заходе мелькает «Приложение: WireGuard» и следом прыгает
  // вёрстка (overview приходит позже конфига).
  const [engine, setEngine] = useState<WgEngine | null>(null);
  const [format, setFormat] = useState<Format>('conf');

  // Формат AmneziaVPN грузим лениво — только когда его открыли.
  const [amnezia, setAmnezia] = useState<AmneziaExportDTO | null>(null);
  const [amneziaQr, setAmneziaQr] = useState<string | null>(null);
  const [amneziaLoading, setAmneziaLoading] = useState(false);
  const [amneziaError, setAmneziaError] = useState<string | null>(null);
  const [amneziaKey, setAmneziaKey] = useState(0);
  const amneziaRequestedFor = useRef<number | null>(null);

  const copyConfig = useCopyFeedback();
  const copyLink = useCopyFeedback();

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
    // Другой юзер (или перезагрузка) — прошлый экспорт AmneziaVPN недействителен.
    setAmnezia(null);
    setAmneziaQr(null);
    setAmneziaError(null);
    amneziaRequestedFor.current = null;

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
      // (73x73), а показ во всю ширину (до 420 px) даёт ~5 px на модуль.
      // Избыточная коррекция здесь не нужна: код показывается на экране, а не
      // печатается на бумаге.
      try {
        const dataUrl = await QRCode.toDataURL(text, QR_OPTIONS);
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

  // Ленивая загрузка формата AmneziaVPN: один запрос на юзера, повтор только
  // после ошибки (ref сбрасывается) или смены юзера.
  useEffect(() => {
    if (format !== 'link') return;
    if (amneziaRequestedFor.current === userId) return;
    amneziaRequestedFor.current = userId;

    let cancelled = false;
    let settled = false;
    setAmneziaLoading(true);
    setAmneziaError(null);

    (async () => {
      let data: AmneziaExportDTO;
      try {
        data = await api.amneziaExport(userId);
      } catch (e) {
        settled = true;
        if (!cancelled) {
          amneziaRequestedFor.current = null;
          setAmneziaError(e instanceof Error ? e.message : 'Не удалось получить ссылку');
          setAmneziaLoading(false);
        }
        return;
      }
      if (cancelled) return;
      settled = true;
      setAmnezia(data);

      // Несколько чанков одним QR не показать — рисуем только одиночный.
      // Список нормализуем: битый ответ не должен ронять вкладку исключением.
      const chunks = Array.isArray(data.qrChunks) ? data.qrChunks : [];
      if (chunks.length === 1) {
        try {
          const dataUrl = await QRCode.toDataURL(chunks[0], QR_OPTIONS);
          if (!cancelled) setAmneziaQr(dataUrl);
        } catch {
          /* останется ссылка */
        }
      }
      if (!cancelled) setAmneziaLoading(false);
    })();

    return () => {
      cancelled = true;
      // Ушли со вкладки, не дождавшись ответа: снимаем отметку о запросе, иначе
      // возврат на вкладку упрётся в guard выше и оставит вечный спиннер
      // (результат этого запроса уже погашен флагом cancelled).
      if (!settled) amneziaRequestedFor.current = null;
    };
  }, [format, userId, reloadKey, amneziaKey]);

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

  if (loading || engine === null) {
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

  const showLinkFormat = engine === 'awg' && format === 'link';

  return (
    <div className="flex flex-col items-center gap-4">
      {engine === 'awg' && <FormatTabs value={format} onChange={setFormat} />}

      <AppHint engine={engine} format={format} />

      {showLinkFormat ? (
        <AmneziaLinkPane
          userName={userName}
          data={amnezia}
          qr={amneziaQr}
          loading={amneziaLoading}
          error={amneziaError}
          copyState={copyLink}
          onCopy={() => void copyLink.run(amnezia?.link)}
          onRetry={() => {
            amneziaRequestedFor.current = null;
            setAmneziaKey((k) => k + 1);
          }}
        />
      ) : (
        <>
          {qr ? (
            // Картинка 420x420 показывается во всю доступную ширину (но не крупнее
            // натурального размера): чем больше модуль на экране, тем увереннее
            // сканируется — особенно длинный конфиг AmneziaWG.
            <img
              src={qr}
              alt={`QR-код конфигурации ${engine === 'awg' ? 'AmneziaWG' : 'WireGuard'} для ${userName}`}
              width={420}
              height={420}
              className="h-auto w-full max-w-[420px] rounded-lg bg-white p-2"
            />
          ) : (
            <div className="flex aspect-square w-full max-w-[420px] items-center justify-center rounded-lg border border-slate-800 bg-slate-900/60 px-4 text-center text-sm text-slate-500">
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
            <CopyButton
              label="Скопировать"
              icon={<Copy size={16} />}
              state={copyConfig}
              onClick={() => void copyConfig.run(config)}
            />
          </div>

          <p className="text-center text-xs text-slate-500">
            В приложении: «+» → Scan QR code, либо импортируйте файл .conf.
          </p>
        </>
      )}
    </div>
  );
}

/** Вкладка «AmneziaVPN»: QR из первого чанка и ссылка vpn://…. */
function AmneziaLinkPane({
  userName,
  data,
  qr,
  loading,
  error,
  copyState,
  onCopy,
  onRetry,
}: {
  userName: string;
  data: AmneziaExportDTO | null;
  qr: string | null;
  loading: boolean;
  error: string | null;
  copyState: { copied: boolean; failed: boolean };
  onCopy: () => void;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div className="flex h-[300px] w-full flex-col items-center justify-center gap-3 text-slate-500">
        <Loader2 size={24} className="animate-spin" />
        <span className="text-sm">Готовим ссылку…</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex w-full flex-col items-center gap-3">
        <div className="w-full rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error ?? 'Не удалось получить ссылку'}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-800"
        >
          Повторить
        </button>
      </div>
    );
  }

  const manyChunks = Array.isArray(data.qrChunks) && data.qrChunks.length > 1;

  return (
    <>
      {qr ? (
        <img
          src={qr}
          alt={`QR-код AmneziaVPN для ${userName}`}
          width={420}
          height={420}
          className="h-auto w-full max-w-[420px] rounded-lg bg-white p-2"
        />
      ) : (
        <div className="flex aspect-square w-full max-w-[420px] items-center justify-center rounded-lg border border-slate-800 bg-slate-900/60 px-6 text-center text-sm leading-relaxed text-slate-500">
          {manyChunks
            ? 'Конфигурация слишком длинная для одного QR-кода. Воспользуйтесь ссылкой ниже или вкладкой «AmneziaWG» с файлом .conf.'
            : 'QR-код построить не удалось — воспользуйтесь ссылкой ниже.'}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2">
        <CopyButton
          label="Скопировать ссылку"
          icon={<Link2 size={16} />}
          state={copyState}
          onClick={onCopy}
        />
      </div>

      <div className="w-full space-y-1.5 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-xs leading-relaxed">
        <a
          href={data.link}
          className="block break-all font-mono text-emerald-400 transition-colors hover:text-emerald-300"
        >
          {data.link}
        </a>
        <p className="text-slate-500">
          Ссылка открывает AmneziaVPN и добавляет подключение в одно нажатие — и на
          телефоне, и на компьютере, если приложение установлено. Если нет —
          перешлите ссылку на телефон или отсканируйте QR-код в приложении.
        </p>
      </div>
    </>
  );
}
