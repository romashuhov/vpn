// Реальный WireGuard-runner для Linux: wg-quick для подъёма интерфейса,
// wg syncconf — для применения изменений пиров без разрыва соединений.
// Все внешние команды — строго через execFile (никаких shell-строк).
//
// При WG_ENGINE=awg вместо wg/wg-quick вызываются awg/awg-quick из
// amneziawg-tools: CLI и формат `show <iface> dump` у них идентичны, поэтому
// отличается только имя бинарника и дополнительные строки [Interface].

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import type { PeerStats, ServerWgState } from '../types.js';
import type { WgRunner } from './runner.js';
import { awgConfigLines } from '../awg.js';

const execFileAsync = promisify(execFile);

/**
 * Таймаут для быстрых команд (`wg show dump`, `wg syncconf`, `ip …`). Все они
 * либо отвечают за миллисекунды, либо не ответят вообще: `wg` общается с ядром
 * или с UAPI-сокетом userspace-демона, и если сокет повис (демон в D-state,
 * нехватка памяти, зависший amneziawg-go), ждать бессмысленно. Без таймаута
 * промис не разрешался бы НИКОГДА: поллер остался бы с взведённым флагом
 * «тик выполняется» и молча перестал собирать статистику — без единой ошибки
 * в логах.
 */
const EXEC_TIMEOUT_MS = 10_000;

/**
 * Таймаут для `wg-quick up/down`. Здесь 10 секунд мало: скрипт последовательно
 * дёргает ip/sysctl и десяток правил iptables (на нагруженном хосте с большим
 * набором правил это уже секунды), а в контейнере без модуля ядра ещё и
 * поднимает userspace-демон (amneziawg-go/wireguard-go). Полторы минуты —
 * заведомо больше нормального времени подъёма и заведомо конечны.
 */
const QUICK_TIMEOUT_MS = 90_000;

/**
 * Запас поверх execFile.timeout для страховочного таймера (см. run()).
 */
const WALL_GRACE_MS = 5_000;

/**
 * Сигнал завершения по таймауту для wg-quick.
 *
 * Для быстрых команд годится SIGKILL, но wg-quick — это shell-скрипт, который
 * выполняет шаги последовательно: ip link add, ip addr, setconf, затем PostUp с
 * набором правил iptables. Убитый SIGKILL посреди этой последовательности он не
 * откатывает и свой trap не отрабатывает — остаётся созданный интерфейс БЕЗ
 * правил MASQUERADE/FORWARD/TCPMSS. Дальше up() при следующем запуске увидит
 * существующий интерфейс и уйдёт в sync(), который PostUp не выполняет, — то
 * есть правила не восстановятся сами никогда, а симптом («хендшейк проходит,
 * панель зелёная, интернета нет») выглядит как проблема на стороне клиента.
 * SIGTERM даёт скрипту отработать trap и снести полуподнятый интерфейс;
 * страховочный таймер run() всё равно не даст висеть вечно.
 */
const QUICK_KILL_SIGNAL: NodeJS.Signals = 'SIGTERM';

function describeExecError(e: unknown): string {
  if (e !== null && typeof e === 'object') {
    const err = e as { stderr?: unknown; message?: unknown; killed?: unknown; signal?: unknown };
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
    const message = typeof err.message === 'string' ? err.message : String(e);
    const timedOut = err.killed === true ? ' (превышен таймаут, процесс убит)' : '';
    return stderr !== '' ? `${message}${timedOut} — stderr: ${stderr}` : `${message}${timedOut}`;
  }
  return String(e);
}

/** Запуск внешней команды; ошибка оборачивается вместе со stderr. */
async function run(
  cmd: string,
  args: string[],
  timeoutMs: number = EXEC_TIMEOUT_MS,
  killSignal: NodeJS.Signals = 'SIGKILL',
): Promise<string> {
  const exec = execFileAsync(cmd, args, {
    timeout: timeoutMs,
    killSignal,
    // `wg show dump` на установке с сотнями пиров легко перерастает дефолтный
    // 1 МБ, а переполнение буфера убивает процесс и роняет сбор статистики.
    maxBuffer: 16 * 1024 * 1024,
  });
  // Страховка поверх execFile.timeout. Node разрешает промис только когда
  // закрылись и процесс, и его stdout/stderr; если пайп унаследовал внучатый
  // процесс (userspace-демон, отпочковавшийся от wg-quick), SIGKILL по самому
  // процессу промис не разрешит. Тогда ждать нечего — рвём по стене.
  let guard: NodeJS.Timeout | undefined;
  const wall = new Promise<never>((_, reject) => {
    guard = setTimeout(
      () => reject(new Error(`нет ответа дольше ${timeoutMs + WALL_GRACE_MS} мс`)),
      timeoutMs + WALL_GRACE_MS,
    );
  });
  // Если победит страховочный таймер, промис exec останется отвергнутым без
  // обработчика — это уронило бы процесс по unhandledRejection.
  exec.catch(() => {});

  try {
    const { stdout } = await Promise.race([exec, wall]);
    return stdout;
  } catch (e) {
    throw new Error(`команда «${cmd} ${args.join(' ')}» завершилась с ошибкой: ${describeExecError(e)}`);
  } finally {
    clearTimeout(guard);
  }
}

/** Записать файл и гарантировать права 600 (даже если файл уже существовал). */
async function writeFile600(file: string, content: string): Promise<void> {
  await fs.writeFile(file, content, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

/** Egress-интерфейс по default-маршруту; fallback — eth0. */
async function detectEgressIface(): Promise<string> {
  try {
    const out = await run('ip', ['-4', 'route', 'show', 'default']);
    const line = out.split('\n').find((l) => l.trim() !== '');
    if (line !== undefined) {
      const tokens = line.trim().split(/\s+/);
      const i = tokens.indexOf('dev');
      if (i !== -1 && tokens[i + 1]) return tokens[i + 1];
    }
  } catch (e) {
    console.error(`[wg] не удалось определить egress-интерфейс: ${(e as Error).message}`);
  }
  console.error('[wg] egress-интерфейс не найден в default-маршруте, использую eth0');
  return 'eth0';
}

/** Разбор вывода `wg show <iface> dump` (поля разделены табами). */
function parseDump(out: string): PeerStats[] {
  const lines = out.split('\n').filter((l) => l.trim() !== '');
  const stats: PeerStats[] = [];
  // Первая строка — сам интерфейс (private_key, public_key, listen_port, fwmark).
  for (const line of lines.slice(1)) {
    const f = line.split('\t');
    // Пир: public_key, preshared_key, endpoint, allowed_ips, latest_handshake,
    //      transfer_rx, transfer_tx, persistent_keepalive
    if (f.length < 7) continue;
    const handshakeSec = Number(f[4]);
    stats.push({
      publicKey: f[0],
      endpoint: f[2] === '(none)' || f[2] === '' ? null : f[2],
      lastHandshake:
        Number.isFinite(handshakeSec) && handshakeSec > 0 ? handshakeSec * 1000 : null,
      rx: Number(f[5]) || 0,
      tx: Number(f[6]) || 0,
    });
  }
  return stats;
}

export class LinuxRunner implements WgRunner {
  private iface: string;
  /** Счётчик для уникальных имён временных syncconf-файлов. */
  private syncSeq = 0;

  constructor(private readonly cfg: Config) {
    this.iface = cfg.wg.iface;
  }

  private confPath(): string {
    return path.join(this.cfg.dataDir, `${this.iface}.conf`);
  }

  async up(state: ServerWgState): Promise<void> {
    this.iface = state.iface;
    if (await this.linkExists(state.iface)) {
      // Интерфейс пережил рестарт панели — просто досинхронизируем состояние.
      console.log(`[wg] интерфейс ${state.iface} уже поднят — синхронизирую конфигурацию`);
      await this.sync(state);
      return;
    }
    await this.writeQuickConf(state);
    try {
      await run(this.cfg.wgQuickBin, ['up', this.confPath()], QUICK_TIMEOUT_MS, QUICK_KILL_SIGNAL);
    } catch (e) {
      // Диагностика обязательна: вызывающий (index.ts) ловит ошибку и продолжает
      // работу панели, а сам по себе отказ up() почти всегда означает, что
      // интерфейс остался в промежуточном состоянии, из которого автоматика уже
      // не выберется (следующий старт увидит link и уйдёт в sync без PostUp).
      console.error(
        `[wg] ${this.cfg.wgQuickBin} up завершился неудачей. Интерфейс мог остаться ` +
          'ПОЛУПОДНЯТЫМ: адрес назначен, а правила PostUp (MASQUERADE/FORWARD/TCPMSS) — нет. ' +
          'Симптом у клиентов: хендшейк проходит, панель зелёная, интернета нет. ' +
          'Сам по себе он не починится — при следующем старте панель увидит существующий ' +
          'интерфейс и пойдёт по пути sync(), который PostUp НЕ выполняет. ' +
          `Погасите интерфейс вручную и поднимите заново: ${this.cfg.wgQuickBin} down ` +
          `${this.confPath()} && ${this.cfg.wgQuickBin} up ${this.confPath()}`,
      );
      throw e;
    }
    console.log(`[wg] интерфейс ${state.iface} поднят, пиров: ${state.peers.length}`);
  }

  async sync(state: ServerWgState): Promise<void> {
    this.iface = state.iface;
    // Держим wg-quick-конфиг на диске актуальным (на случай ручного рестарта).
    await this.writeQuickConf(state);
    await this.syncNative(state);
    console.log(`[wg] конфигурация ${state.iface} синхронизирована, пиров: ${state.peers.length}`);
  }

  async stats(): Promise<PeerStats[]> {
    // Ошибку НЕ глотаем: поллер по контракту пропускает тик при исключении,
    // сохраняя базовые точки дельт. Пустой массив он трактует как «пиров нет»
    // и сбрасывает базовые точки — трафик с последнего успешного замера терялся бы.
    return parseDump(await run(this.cfg.wgBin, ['show', this.iface, 'dump']));
  }

  async down(): Promise<void> {
    try {
      await run(this.cfg.wgQuickBin, ['down', this.confPath()], QUICK_TIMEOUT_MS, QUICK_KILL_SIGNAL);
      console.log(`[wg] интерфейс ${this.iface} погашен`);
    } catch (e) {
      // Ошибки down() глотаем: интерфейс мог быть уже погашен.
      console.error(`[wg] down: ${(e as Error).message}`);
    }
  }

  private async linkExists(iface: string): Promise<boolean> {
    try {
      // Через run(): нужен тот же таймаут, что и у остальных команд. Зависший
      // `ip link show` на старте заблокировал бы bootstrap целиком.
      await run('ip', ['link', 'show', iface]);
      return true;
    } catch {
      return false;
    }
  }

  /** Полный конфиг для wg-quick: <DATA_DIR>/<iface>.conf, chmod 600. */
  private async writeQuickConf(state: ServerWgState): Promise<void> {
    const egress = await detectEgressIface();
    const subnet = this.cfg.wg.subnet;
    // MSS-clamping обязателен: без него TCP внутри туннеля договаривается о
    // полноразмерных сегментах, а полноразмерные внешние UDP-пакеты дропаются
    // на путях с уменьшенным MTU и фильтрованным ICMP (мобильные сети, CGNAT) —
    // симптом «подключается, но не грузит / периодически висит».
    const fw = (act: 'A' | 'D'): string =>
      [
        `iptables -t nat -${act} POSTROUTING -s ${subnet} -o ${egress} -j MASQUERADE`,
        `iptables -${act} FORWARD -i %i -j ACCEPT`,
        `iptables -${act} FORWARD -o %i -j ACCEPT`,
        `iptables -t mangle -${act} FORWARD -i %i -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu`,
        `iptables -t mangle -${act} FORWARD -o %i -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu`,
      ].join('; ');
    const lines: string[] = [
      '# Сгенерировано WireDeck — не редактируйте вручную',
      '[Interface]',
      `PrivateKey = ${state.privateKey}`,
      `Address = ${state.address}`,
      `ListenPort = ${state.listenPort}`,
    ];
    if (state.mtu) lines.push(`MTU = ${state.mtu}`);
    lines.push(`PostUp = ${fw('A')}`, `PostDown = ${fw('D')}`);
    // awg-quick сам обрабатывает Address/MTU/DNS/Table/Pre*/Post*/SaveConfig,
    // а всё остальное из [Interface] отдаёт в `awg setconf` — параметры
    // обфускации попадают в устройство именно так.
    if (state.awg) lines.push(...awgConfigLines(state.awg));
    for (const p of state.peers) {
      lines.push(
        '',
        '[Peer]',
        `PublicKey = ${p.publicKey}`,
        `PresharedKey = ${p.presharedKey}`,
        `AllowedIPs = ${p.allowedIps}`,
      );
    }
    await writeFile600(this.confPath(), lines.join('\n') + '\n');
  }

  /**
   * wg-нативный конфиг (только PrivateKey/ListenPort + пиры, без Address/PostUp)
   * во временный файл → `wg syncconf` → удалить файл.
   */
  private async syncNative(state: ServerWgState): Promise<void> {
    // Имя уникально на каждый вызов: параллельный sync() не должен перезаписать
    // или удалить файл, который другой вызов ещё передаёт в `wg syncconf`.
    const tmp = path.join(
      this.cfg.dataDir,
      `.${state.iface}.sync.${process.pid}.${++this.syncSeq}.conf`,
    );
    const lines: string[] = [
      '[Interface]',
      `PrivateKey = ${state.privateKey}`,
      `ListenPort = ${state.listenPort}`,
    ];
    // КРИТИЧНО: параметры обфускации обязаны быть и здесь. syncconf применяет
    // конфиг целиком, и без этих строк awg сбросил бы обфускацию на дефолт —
    // все клиенты отвалились бы при первом же добавлении пользователя.
    if (state.awg) lines.push(...awgConfigLines(state.awg));
    for (const p of state.peers) {
      lines.push(
        '',
        '[Peer]',
        `PublicKey = ${p.publicKey}`,
        `PresharedKey = ${p.presharedKey}`,
        `AllowedIPs = ${p.allowedIps}`,
      );
    }
    await writeFile600(tmp, lines.join('\n') + '\n');
    try {
      await run(this.cfg.wgBin, ['syncconf', state.iface, tmp]);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }
}
