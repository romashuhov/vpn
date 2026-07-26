// Реальный WireGuard-runner для Linux: wg-quick для подъёма интерфейса,
// wg syncconf — для применения изменений пиров без разрыва соединений.
// Все внешние команды — строго через execFile (никаких shell-строк).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import type { PeerStats, ServerWgState } from '../types.js';
import type { WgRunner } from './runner.js';

const execFileAsync = promisify(execFile);

function describeExecError(e: unknown): string {
  if (e !== null && typeof e === 'object') {
    const err = e as { stderr?: unknown; message?: unknown };
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
    const message = typeof err.message === 'string' ? err.message : String(e);
    return stderr !== '' ? `${message} — stderr: ${stderr}` : message;
  }
  return String(e);
}

/** Запуск внешней команды; ошибка оборачивается вместе со stderr. */
async function run(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args);
    return stdout;
  } catch (e) {
    throw new Error(`команда «${cmd} ${args.join(' ')}» завершилась с ошибкой: ${describeExecError(e)}`);
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
    await run('wg-quick', ['up', this.confPath()]);
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
    return parseDump(await run('wg', ['show', this.iface, 'dump']));
  }

  async down(): Promise<void> {
    try {
      await run('wg-quick', ['down', this.confPath()]);
      console.log(`[wg] интерфейс ${this.iface} погашен`);
    } catch (e) {
      // Ошибки down() глотаем: интерфейс мог быть уже погашен.
      console.error(`[wg] down: ${(e as Error).message}`);
    }
  }

  private async linkExists(iface: string): Promise<boolean> {
    try {
      await execFileAsync('ip', ['link', 'show', iface]);
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
      await run('wg', ['syncconf', state.iface, tmp]);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }
}
