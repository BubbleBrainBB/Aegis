// Runs cua-driver for the Computer use gateway.
//
// Two child processes of the main process, started on first use and never
// while the switch is off:
//   cua-driver serve --embedded --parent-liveness-stdio --socket S   acts on the desktop
//   cua-driver mcp   --embedded --socket S                           a stdio MCP proxy
// The daemon must be spawned directly by the app that holds the macOS
// Accessibility and Screen Recording grants (no `open`, no shell in between),
// or macOS attributes its checks to something else. Embedded, it never shows
// a system prompt of its own.
//
// What was measured on the pinned version (0.57.0), and is relied on here:
// - The daemon watches its parent only with `--parent-liveness-stdio`: then
//   it exits when its stdin closes, which is what happens when this process
//   dies however it dies.
// - That exit fails when the daemon's stderr is a pipe to the dead parent
//   (its last message cannot be written), so stderr goes to a log file.
// - A call in flight cannot be cancelled over the stdio proxy (it drops
//   plain notifications). Cancelling one therefore stops the driver: the
//   only way to know a desktop action is no longer running.
//
// A driver pair ends in one way, whatever ends it (`retire`): a call that was
// cancelled or timed out, a process that went away by itself, or a stop. Both
// processes are told to go, killed if they do not, and waited for. Nobody is
// told "stopped", "cancelled" or "timed out" before they are gone, and no new
// driver starts before the old one is.
//
// Providers never see either process: only the gateway holds the pipe.

import { spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildCuaDriverEnv } from './driver-env';
import { buildCuaDriverPolicy } from './policy';

export { buildCuaDriverEnv } from './driver-env';

export interface DriverToolResult {
  isError: boolean;
  text: string;
  structured: Record<string, unknown> | null;
  images: Array<{ mimeType: string; data: string }>;
}

export interface DriverCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * The driver process the call is meant for (from `start`). A call made
   * with what an earlier process returned (a pid, a snapshot) is refused
   * once that process is gone, and never starts a new one.
   */
  instance?: number;
}

/** What the gateway needs from a driver; the tests pass a scripted one. */
export interface ComputerUseDriver {
  /** Starts the driver if it is not running. The number names this driver process. */
  start(signal?: AbortSignal): Promise<number>;
  /**
   * Rejects when the call was cancelled, timed out or lost its driver, and
   * only once the driver process that had it is gone: a rejection means the
   * desktop action is over, not merely given up on.
   */
  call(tool: string, args: Record<string, unknown>, options?: DriverCallOptions): Promise<DriverToolResult>;
  isRunning(): boolean;
  /** Resolves when no driver process is left, including one that was already on its way out. */
  stop(): Promise<void>;
  stopSync(): void;
}

export const COMPUTER_USE_DRIVER_STOPPED_MESSAGE = 'Computer use stopped unexpectedly. Try again.';
export const COMPUTER_USE_DRIVER_RESTARTED_MESSAGE =
  'Computer use was restarted since this app was last looked at. Call get_app_state again.';
export const COMPUTER_USE_CANCELLED_MESSAGE = 'Computer use was cancelled.';

const START_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;
/** How long a driver gets to leave when told to, before it is killed. */
const EXIT_WAIT_MS = 2_000;
const MCP_PROTOCOL_VERSION = '2025-06-18';
/** macOS limits a unix socket path to 104 bytes including the terminator. */
const SOCKET_PATH_LIMIT = 100;

/**
 * The daemon's arguments. `--parent-liveness-stdio`: exit when Aegis does,
 * however it goes. `--permission-mode standard`: said outright, so that no
 * default of the driver's decides it (in this mode input aimed at a macOS
 * security prompt is refused).
 */
export function cuaDriverDaemonArgs(socketPath: string, hostBundleId: string): string[] {
  return [
    'serve',
    '--embedded',
    '--parent-liveness-stdio',
    '--permission-mode',
    'standard',
    '--socket',
    socketPath,
    '--host-bundle-id',
    hostBundleId,
  ];
}

export function cuaDriverSocketPath(homeDir: string): string {
  const preferred = path.join(homeDir, 'driver.sock');
  if (Buffer.byteLength(preferred) <= SOCKET_PATH_LIMIT) return preferred;
  const tag = createHash('sha256').update(homeDir).digest('hex').slice(0, 12);
  return path.join(tmpdir(), `aegis-cu-${tag}`, 'driver.sock');
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type Running = {
  instance: number;
  daemon: ChildProcess;
  proxy: ChildProcess;
  socketPath: string;
  pending: Map<number, Pending>;
  nextId: number;
  alive: boolean;
  /** Settles when both processes are gone. */
  exited: Promise<void>;
  /** The one retirement of this pair, once it has begun. */
  retiring: Promise<void> | null;
};

/** Settles when the process is gone (or never came to be). */
function exitOf(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.once('error', () => {
      // A spawn that failed has no process; a later error leaves `exit` to say so.
      if (child.pid === undefined) resolve();
    });
  });
}

function kill(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

export class CuaDriverHost implements ComputerUseDriver {
  private running: Running | null = null;
  private starting: Promise<Running> | null = null;
  private instances = 0;
  /** Settles when every driver that was ever retired is gone. */
  private retired: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      /** The verified binary, or an error saying why there is none. */
      resolveBinary: () => string;
      /** Aegis's own folder for the driver's state, socket, policy and log. */
      homeDir: string;
      hostBundleId: string;
      env?: NodeJS.ProcessEnv;
      /** How long a driver gets to leave before it is killed. */
      exitWaitMs?: number;
    }
  ) {}

  isRunning(): boolean {
    return Boolean(this.running?.alive);
  }

  async start(signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) throw new Error(COMPUTER_USE_CANCELLED_MESSAGE);
    const running = await this.ensureStarted();
    // The start may have taken seconds: a call stopped meanwhile goes no further.
    if (signal?.aborted) throw new Error(COMPUTER_USE_CANCELLED_MESSAGE);
    return running.instance;
  }

  async call(tool: string, args: Record<string, unknown>, options: DriverCallOptions = {}): Promise<DriverToolResult> {
    if (options.signal?.aborted) throw new Error(COMPUTER_USE_CANCELLED_MESSAGE);
    let running: Running;
    if (options.instance !== undefined) {
      // Meant for one driver process: never the reason another one starts.
      if (!this.running?.alive || this.running.instance !== options.instance) {
        throw new Error(COMPUTER_USE_DRIVER_RESTARTED_MESSAGE);
      }
      running = this.running;
    } else {
      running = await this.ensureStarted();
      if (options.signal?.aborted) throw new Error(COMPUTER_USE_CANCELLED_MESSAGE);
    }
    const raw = await this.request(running, 'tools/call', { name: tool, arguments: args }, options);
    return readToolResult(raw);
  }

  async stop(): Promise<void> {
    const starting = this.starting;
    const running = this.running ?? (starting ? await starting.catch(() => null) : null);
    if (running) void this.retire(running, 'Computer use was turned off.');
    // Also a driver that was already on its way out (a call that timed out,
    // a proxy that died): stopped means gone, not merely told to go.
    await this.retired;
  }

  /** For app quit: no time to wait. The daemon also exits by itself when this process is gone. */
  stopSync(): void {
    const running = this.running;
    this.starting = null;
    if (!running) return;
    void this.retire(running, 'Aegis is quitting.');
    kill(running.proxy, 'SIGKILL');
    kill(running.daemon, 'SIGKILL');
  }

  private ensureStarted(): Promise<Running> {
    if (this.running?.alive) return Promise.resolve(this.running);
    if (!this.starting) {
      const starting: Promise<Running> = this.launch().finally(() => {
        if (this.starting === starting) this.starting = null;
      });
      this.starting = starting;
    }
    return this.starting;
  }

  private logPath(): string {
    return path.join(this.options.homeDir, 'driver.log');
  }

  private async launch(): Promise<Running> {
    // One driver at a time: the one before this must be gone, not just told to go.
    await this.retired;
    const binary = this.options.resolveBinary();
    const { homeDir } = this.options;
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    const socketPath = cuaDriverSocketPath(homeDir);
    mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    // A socket left by a run that crashed: the daemon refuses to start over it.
    rmSync(socketPath, { force: true });
    const policyFile = path.join(homeDir, 'policy.yaml');
    writeFileSync(policyFile, buildCuaDriverPolicy(), { mode: 0o600 });
    try {
      chmodSync(policyFile, 0o600);
    } catch {
      // best effort
    }
    const env = buildCuaDriverEnv({
      base: this.options.env ?? process.env,
      homeDir,
      hostBundleId: this.options.hostBundleId,
      policyFile,
    });

    // stderr to a file, started over with each driver: a pipe to this process
    // would break the daemon's own exit when this process dies (see the top).
    const log = openSync(this.logPath(), 'w', 0o600);
    try {
      const daemon = spawn(binary, cuaDriverDaemonArgs(socketPath, this.options.hostBundleId), {
        env,
        // stdin stays open for as long as this process lives: the daemon's lifeline.
        stdio: ['pipe', 'ignore', log],
      });
      const daemonExited = exitOf(daemon);
      try {
        await this.waitForSocket(daemon, socketPath);
      } catch (error) {
        // A daemon that never came up still has to be gone before the next start.
        kill(daemon, 'SIGKILL');
        this.retired = Promise.all([this.retired, daemonExited]).then(() => undefined);
        await daemonExited;
        throw error;
      }
      const proxy = spawn(binary, ['mcp', '--embedded', '--socket', socketPath], {
        env,
        stdio: ['pipe', 'pipe', log],
      });
      const running: Running = {
        instance: ++this.instances,
        daemon,
        proxy,
        socketPath,
        pending: new Map(),
        nextId: 1,
        alive: true,
        exited: Promise.all([daemonExited, exitOf(proxy)]).then(() => undefined),
        retiring: null,
      };
      this.wire(running);
      try {
        await this.request(
          running,
          'initialize',
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'aegis-computer-use', version: '1' },
          },
          { timeoutMs: START_TIMEOUT_MS }
        );
        this.send(running, { jsonrpc: '2.0', method: 'notifications/initialized' });
      } catch (error) {
        await this.retire(running, 'Computer use could not start.');
        throw new Error(`Computer use could not start: ${errorText(error)}${this.logSuffix()}`);
      }
      // Retired while it was starting (a stop, a process that died): not handed out.
      if (!running.alive) {
        await running.retiring;
        throw new Error(COMPUTER_USE_DRIVER_STOPPED_MESSAGE);
      }
      this.running = running;
      return running;
    } finally {
      closeSync(log);
    }
  }

  private waitForSocket(daemon: ChildProcess, socketPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        daemon.off('exit', onExit);
        daemon.off('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const onExit = (code: number | null) =>
        finish(new Error(`Computer use could not start: the driver exited (${code ?? 'signal'}).${this.logSuffix()}`));
      const onError = (error: Error) => finish(new Error(`Computer use could not start: ${error.message}`));
      daemon.once('exit', onExit);
      daemon.once('error', onError);
      const poll = setInterval(() => {
        if (existsSync(socketPath)) return finish();
        if (Date.now() - startedAt > START_TIMEOUT_MS) {
          finish(new Error(`Computer use could not start: the driver did not come up in time.${this.logSuffix()}`));
        }
      }, 50);
    });
  }

  private wire(running: Running): void {
    let buffer = '';
    running.proxy.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof message.id !== 'number') continue;
        const pending = running.pending.get(message.id);
        if (!pending) continue;
        running.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'The driver refused the call.'));
        } else {
          pending.resolve(message.result);
        }
      }
    });
    // Either process going away ends the pair: the other is taken down too,
    // calls in flight fail once both are gone (an action is never replayed),
    // and the next call starts a fresh driver.
    const onGone = () => {
      void this.retire(running, COMPUTER_USE_DRIVER_STOPPED_MESSAGE);
    };
    running.daemon.once('exit', onGone);
    running.proxy.once('exit', onGone);
    running.daemon.once('error', onGone);
    running.proxy.once('error', onGone);
    // A pipe closing under a write must not take the main process down.
    running.proxy.stdin?.on('error', () => undefined);
    running.daemon.stdin?.on('error', () => undefined);
  }

  private send(running: Running, message: Record<string, unknown>): void {
    running.proxy.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private request(
    running: Running,
    method: string,
    params: Record<string, unknown>,
    options: DriverCallOptions = {}
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!running.alive) return reject(new Error(COMPUTER_USE_DRIVER_STOPPED_MESSAGE));
      const id = running.nextId++;
      const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        running.pending.delete(id);
      };
      // The request is with the driver and cannot be called back: the driver
      // is retired, and the caller hears why once it is really gone.
      const giveUp = (reason: string) => {
        cleanup();
        void this.retire(running, COMPUTER_USE_DRIVER_STOPPED_MESSAGE).then(() => reject(new Error(reason)));
      };
      const onAbort = () => giveUp(COMPUTER_USE_CANCELLED_MESSAGE);
      // A driver that stopped answering is not trusted with the next call, and
      // whatever it was doing has to be over before anybody is told it failed.
      const timer = setTimeout(
        () => giveUp(`Computer use timed out after ${Math.round(timeoutMs / 1000)}s.`),
        timeoutMs
      );
      running.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        // The pair was retired under this call (a process died, a stop):
        // said once both processes are gone, like every other way out.
        reject: (error) => {
          cleanup();
          void (running.retiring ?? Promise.resolve()).then(() => reject(error));
        },
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.send(running, { jsonrpc: '2.0', id, method, params });
    });
  }

  /**
   * The one way a driver pair ends. Both processes are told to go, killed if
   * they have not gone after a moment, and waited for. Resolves when both
   * are gone; called again for the same pair, it is the same wait.
   */
  private retire(running: Running, reason: string): Promise<void> {
    if (running.retiring) return running.retiring;
    running.alive = false;
    if (this.running === running) this.running = null;
    const lateKill = setTimeout(() => {
      kill(running.daemon, 'SIGKILL');
      kill(running.proxy, 'SIGKILL');
    }, this.options.exitWaitMs ?? EXIT_WAIT_MS);
    const retiring = running.exited.then(() => {
      clearTimeout(lateKill);
      try {
        rmSync(running.socketPath, { force: true });
      } catch {
        // the daemon may have removed it already
      }
    });
    running.retiring = retiring;
    this.retired = Promise.all([this.retired, retiring]).then(() => undefined);
    for (const pending of [...running.pending.values()]) pending.reject(new Error(reason));
    running.pending.clear();
    // Three ways of saying "go": the proxy's stdin and the daemon's lifeline
    // close, and both get SIGTERM. SIGKILL follows for whichever stays.
    for (const child of [running.proxy, running.daemon]) {
      try {
        child.stdin?.end();
      } catch {
        // already closed
      }
      kill(child, 'SIGTERM');
    }
    return retiring;
  }

  /** The last lines the driver wrote, for an error message. */
  private logSuffix(): string {
    try {
      // eslint-disable-next-line no-control-regex
      const text = readFileSync(this.logPath(), 'utf8').slice(-2_000).replace(/\u001b\[[0-9;]*m/g, '').trim();
      return text ? ` ${text.split('\n').slice(-3).join(' ')}` : '';
    } catch {
      return '';
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readToolResult(raw: unknown): DriverToolResult {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const content = Array.isArray(record.content) ? record.content : [];
  const texts: string[] = [];
  const images: DriverToolResult['images'] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const block = part as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    if (block.type === 'image' && typeof block.data === 'string') {
      images.push({ mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png', data: block.data });
    }
  }
  const structured =
    record.structuredContent && typeof record.structuredContent === 'object' && !Array.isArray(record.structuredContent)
      ? (record.structuredContent as Record<string, unknown>)
      : null;
  return { isError: record.isError === true, text: texts.join('\n').trim(), structured, images };
}
