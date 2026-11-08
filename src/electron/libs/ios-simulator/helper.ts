// Client for aegis-sim-helper, the native process behind the simulator
// pane (native/ios-sim-helper). One helper serves every device: it holds a
// HID connection per device, so input lands in milliseconds, and streams
// each screen as H.264 straight from the simulator's framebuffer.
//
// Wire format (helper → Aegis): u8 kind | u32 BE length | payload.
//   kind 1: JSON (replies by id, and events)
//   kind 2: video: u8 udid length | udid | u8 flags | u16 width | u16 height | Annex B
// Aegis → helper: one JSON request per line on stdin.

import { spawn, type ChildProcess } from 'child_process';
import { accessSync, constants } from 'fs';
import { join } from 'path';

export interface HelperVideoFrame {
  udid: string;
  keyFrame: boolean;
  width: number;
  height: number;
  data: Buffer;
}

export interface HelperScreen {
  name: string;
  /** The screen as streamed (physical portrait framebuffer). */
  pixelWidth: number;
  pixelHeight: number;
  scale: number;
  pointWidth: number;
  pointHeight: number;
  /** The space HID touches are given in (the device type's main screen;
   * a foldable streams another display when unfolded). */
  hidWidth: number;
  hidHeight: number;
  /** UIInterfaceOrientation: 1 portrait, 2 upside down, 3 and 4 landscape. */
  uiOrientation: number;
  /** The shown screen (a foldable has several): touches target it, and
   * Xcode's outline and mask for it. */
  screenID?: number;
  chromeIdentifier?: string;
  maskIdentifier?: string;
}

/** A display change while streaming: rotation, posture, Device Hub. */
export interface HelperDisplayEvent extends HelperScreen {
  event: 'display';
  udid: string;
}

const KIND_JSON = 1;
const KIND_VIDEO = 2;
const REQUEST_TIMEOUT_MS = 60_000;

/** Splits the helper's stdout into messages. */
export class HelperMessageParser {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(
    private readonly onJson: (message: Record<string, unknown>) => void,
    private readonly onVideo: (frame: HelperVideoFrame) => void
  ) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let offset = 0;
    while (this.buffer.length - offset >= 5) {
      const kind = this.buffer[offset];
      const length = this.buffer.readUInt32BE(offset + 1);
      if (this.buffer.length - offset - 5 < length) break;
      const payload = this.buffer.subarray(offset + 5, offset + 5 + length);
      offset += 5 + length;
      if (kind === KIND_JSON) {
        try {
          this.onJson(JSON.parse(payload.toString('utf8')) as Record<string, unknown>);
        } catch {
          // A malformed message is skipped, not fatal.
        }
      } else if (kind === KIND_VIDEO) {
        const udidLength = payload[0];
        const udid = payload.subarray(1, 1 + udidLength).toString('utf8');
        const at = 1 + udidLength;
        this.onVideo({
          udid,
          keyFrame: (payload[at] & 1) === 1,
          width: payload.readUInt16BE(at + 1),
          height: payload.readUInt16BE(at + 3),
          // Copied: the parser buffer is reused.
          data: Buffer.from(payload.subarray(at + 5)),
        });
      }
    }
    this.buffer = offset >= this.buffer.length ? Buffer.alloc(0) : this.buffer.subarray(offset);
  }
}

/** Where the helper binary is: an override, the packaged app, or a dev build. */
export function findHelper(): string | null {
  const candidates = [
    process.env.AEGIS_SIM_HELPER_PATH,
    process.resourcesPath ? join(process.resourcesPath, 'ios-sim-helper', 'aegis-sim-helper') : undefined,
    // A checkout: npm run build:ios-sim-helper.
    join(__dirname, '..', '..', '..', '..', 'native', 'ios-sim-helper', 'dist', 'aegis-sim-helper'),
    join(process.cwd(), 'native', 'ios-sim-helper', 'dist', 'aegis-sim-helper'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class SimHelper {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderrTail = '';

  constructor(
    private readonly path: string,
    private readonly onVideo: (frame: HelperVideoFrame) => void,
    private readonly onExit: (reason: string) => void,
    private readonly onEvent: (event: Record<string, unknown>) => void = () => {}
  ) {}

  get running(): boolean {
    return this.child !== null;
  }

  /** Start the helper and wait for it to load the simulator frameworks. */
  start(): Promise<void> {
    if (this.child) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const child = spawn(this.path, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      let ready = false;
      const parser = new HelperMessageParser(
        (message) => {
          if (message.event === 'ready') {
            ready = true;
            resolve();
            return;
          }
          if (message.event === 'fatal') {
            reject(new Error(String(message.error)));
            return;
          }
          if (typeof message.event === 'string') {
            this.onEvent(message);
            return;
          }
          this.settle(message);
        },
        (frame) => this.onVideo(frame)
      );
      child.stdout?.on('data', (chunk: Buffer) => parser.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-8_000);
      });
      child.once('error', (error) => {
        if (!ready) reject(error);
      });
      child.once('exit', (code, signal) => {
        this.child = null;
        const reason = `aegis-sim-helper exited (${signal ?? code})`;
        for (const [id, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error(reason));
          this.pending.delete(id);
        }
        if (!ready) reject(new Error(`${reason}: ${this.stderrTail.slice(-600)}`));
        this.onExit(reason);
      });
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private settle(message: Record<string, unknown>): void {
    const id = typeof message.id === 'number' ? message.id : null;
    if (id === null) return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(String(message.error ?? 'aegis-sim-helper request failed')));
  }

  /** A request that gets a reply. */
  async request<T = unknown>(command: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    await this.start();
    const child = this.child;
    if (!child?.stdin) throw new Error('aegis-sim-helper is not running');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`aegis-sim-helper did not answer ${String(command.cmd)} in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      child.stdin!.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  /** A request without a reply (live touches): sent and forgotten. */
  send(command: Record<string, unknown>): void {
    const child = this.child;
    if (!child?.stdin) return;
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    child.stdin?.end();
    // Closing stdin ends the helper; make sure it goes.
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGTERM');
    }, 1_000).unref();
  }
}
