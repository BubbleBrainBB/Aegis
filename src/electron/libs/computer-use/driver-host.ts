// Runs cua-driver for the Computer use gateway.
//
// Two child processes of the main process, started on first use and never
// while the switch is off:
//   cua-driver serve --embedded --socket S   the daemon that acts on the desktop
//   cua-driver mcp   --embedded --socket S   a stdio MCP proxy the gateway talks to
// The daemon must be spawned directly by the app that holds the macOS
// Accessibility and Screen Recording grants (no `open`, no shell in between),
// or macOS attributes its checks to something else. Embedded, it never shows
// a system prompt of its own and exits when this process does.
//
// Providers never see either process: only the gateway holds the pipe.

import { spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildCuaDriverPolicy } from './policy';

export interface DriverToolResult {
  isError: boolean;
  text: string;
  structured: Record<string, unknown> | null;
  images: Array<{ mimeType: string; data: string }>;
}

export interface DriverCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** What the gateway needs from a driver; the tests pass a scripted one. */
export interface ComputerUseDriver {
  call(tool: string, args: Record<string, unknown>, options?: DriverCallOptions): Promise<DriverToolResult>;
  isRunning(): boolean;
  stop(): Promise<void>;
  stopSync(): void;
}

export const COMPUTER_USE_DRIVER_STOPPED_MESSAGE = 'Computer use stopped unexpectedly. Try again.';

const START_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;
const MCP_PROTOCOL_VERSION = '2025-06-18';
/** macOS limits a unix socket path to 104 bytes including the terminator. */
const SOCKET_PATH_LIMIT = 100;

/**
 * The environment the driver starts with: embedded in this app, no telemetry,
 * no update check, its state under Aegis's own folder (never the folder of a
 * cua-driver the user installed themselves), and the gateway's policy file.
 */
export function buildCuaDriverEnv(input: {
  base: NodeJS.ProcessEnv;
  homeDir: string;
  hostBundleId: string;
  policyFile: string;
}): NodeJS.ProcessEnv {
  return {
    ...input.base,
    CUA_DRIVER_EMBEDDED: '1',
    CUA_DRIVER_HOST_BUNDLE_ID: input.hostBundleId,
    CUA_DRIVER_RS_HOME: input.homeDir,
    CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
    CUA_TELEMETRY_ENABLED: 'false',
    CUA_DRIVER_RS_UPDATE_CHECK: 'false',
    CUA_DRIVER_POLICY_FILE: input.policyFile,
  };
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
  daemon: ChildProcess;
  proxy: ChildProcess;
  socketPath: string;
  pending: Map<number, Pending>;
  nextId: number;
  alive: boolean;
};

export class CuaDriverHost implements ComputerUseDriver {
  private running: Running | null = null;
  private starting: Promise<Running> | null = null;
  private stderrTail = '';

  constructor(
    private readonly options: {
      /** The verified binary, or an error saying why there is none. */
      resolveBinary: () => string;
      /** Aegis's own folder for the driver's state, socket and policy. */
      homeDir: string;
      hostBundleId: string;
      env?: NodeJS.ProcessEnv;
    }
  ) {}

  isRunning(): boolean {
    return Boolean(this.running?.alive);
  }

  async call(tool: string, args: Record<string, unknown>, options: DriverCallOptions = {}): Promise<DriverToolResult> {
    if (options.signal?.aborted) throw new Error('Computer use was cancelled.');
    const running = await this.ensureStarted();
    const raw = await this.request(running, 'tools/call', { name: tool, arguments: args }, options);
    return readToolResult(raw);
  }

  async stop(): Promise<void> {
    const running = this.running ?? (this.starting ? await this.starting.catch(() => null) : null);
    this.starting = null;
    if (!running) return;
    this.teardown(running, 'Computer use was turned off.');
    await new Promise<void>((resolve) => {
      if (running.daemon.exitCode !== null || running.daemon.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        running.daemon.kill('SIGKILL');
        resolve();
      }, 2_000);
      timer.unref?.();
      running.daemon.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** For app quit: no time to wait, and the daemon exits with its parent anyway. */
  stopSync(): void {
    if (this.running) this.teardown(this.running, 'Aegis is quitting.');
    this.starting = null;
  }

  private ensureStarted(): Promise<Running> {
    if (this.running?.alive) return Promise.resolve(this.running);
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<Running> {
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
    this.stderrTail = '';

    const daemon = spawn(
      binary,
      ['serve', '--embedded', '--socket', socketPath, '--host-bundle-id', this.options.hostBundleId],
      // stdin stays open: the daemon reads its end to notice this process dying.
      { env, stdio: ['pipe', 'ignore', 'pipe'] }
    );
    daemon.stderr?.on('data', (chunk: Buffer) => this.noteStderr(chunk));
    await this.waitForSocket(daemon, socketPath);

    const proxy = spawn(binary, ['mcp', '--embedded', '--socket', socketPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proxy.stderr?.on('data', (chunk: Buffer) => this.noteStderr(chunk));
    const running: Running = { daemon, proxy, socketPath, pending: new Map(), nextId: 1, alive: true };
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
      this.teardown(running, 'Computer use could not start.');
      throw new Error(`Computer use could not start: ${errorText(error)}${this.stderrSuffix()}`);
    }
    this.running = running;
    return running;
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
        if (error) {
          daemon.kill('SIGKILL');
          reject(error);
        } else {
          resolve();
        }
      };
      const onExit = (code: number | null) =>
        finish(new Error(`Computer use could not start: the driver exited (${code ?? 'signal'}).${this.stderrSuffix()}`));
      const onError = (error: Error) => finish(new Error(`Computer use could not start: ${error.message}`));
      daemon.once('exit', onExit);
      daemon.once('error', onError);
      const poll = setInterval(() => {
        if (existsSync(socketPath)) return finish();
        if (Date.now() - startedAt > START_TIMEOUT_MS) {
          finish(new Error(`Computer use could not start: the driver did not come up in time.${this.stderrSuffix()}`));
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
    // Either process going away ends the pair: calls in flight fail (an action
    // is never replayed), and the next call starts a fresh driver.
    const onGone = () => {
      if (!running.alive) return;
      this.teardown(running, COMPUTER_USE_DRIVER_STOPPED_MESSAGE);
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
      const onAbort = () => {
        cleanup();
        this.send(running, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
        reject(new Error('Computer use was cancelled.'));
      };
      const timer = setTimeout(() => {
        cleanup();
        // A driver that stopped answering is not trusted with the next call.
        this.teardown(running, COMPUTER_USE_DRIVER_STOPPED_MESSAGE);
        reject(new Error(`Computer use timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      timer.unref?.();
      running.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.send(running, { jsonrpc: '2.0', id, method, params });
    });
  }

  private teardown(running: Running, reason: string): void {
    running.alive = false;
    if (this.running === running) this.running = null;
    for (const pending of [...running.pending.values()]) pending.reject(new Error(reason));
    running.pending.clear();
    try {
      running.proxy.stdin?.end();
    } catch {
      // already closed
    }
    running.proxy.kill('SIGTERM');
    running.daemon.kill('SIGTERM');
    try {
      rmSync(running.socketPath, { force: true });
    } catch {
      // the daemon may have removed it already
    }
  }

  private noteStderr(chunk: Buffer): void {
    this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-2_000);
  }

  private stderrSuffix(): string {
    // eslint-disable-next-line no-control-regex
    const text = this.stderrTail.replace(/\u001b\[[0-9;]*m/g, '').trim();
    return text ? ` ${text.split('\n').slice(-3).join(' ')}` : '';
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
