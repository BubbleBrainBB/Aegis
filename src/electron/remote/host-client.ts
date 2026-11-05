// The controlling side of aegis.remote.v1: this Mac reaching another Mac's gateway.
// Sessions stay on that Mac; this class only holds what is on screen here.
import WebSocket from "ws";
import { randomUUID } from "crypto";
import { join } from "path";
import {
  DESKTOP_FEATURE,
  EVENTS_FEATURE,
  REMOTE_PROTOCOL,
  type CommandResult,
  type HistoryTail,
  type Pairing,
  type RemoteEvent,
  type RemoteLan,
  type RemoteMessage,
  type RemoteSnapshot,
  type RemoteState,
} from "../../shared/remote/protocol";

import { lanToken } from "./relay-auth";

export type HostStatus = "connecting" | "confirming" | "connected" | "offline" | "revoked" | "rejected";
type Channel = Awaited<ReturnType<typeof import("../../shared/remote/secure-channel").secureChannel>>;
type CommandFields = Record<string, unknown>;

export interface HostClientEvents {
  status(status: HostStatus): void;
  /** Where this Mac can be reached without the relay; worth keeping for next time. */
  lan?(lan: RemoteLan): void;
  state(state: RemoteState, machineName?: string): void;
  /** `before` is the cursor for older messages; only a replacement carries one. */
  history(sessionId: string, messages: RemoteMessage[], change: { replace: boolean; before?: number | null }): void;
  /** Streamed text not yet committed: append, or replace (null clears). */
  live(sessionId: string, change: { append?: string; text?: string | null }): void;
}
export interface HostClientOptions {
  pairing: Pairing;
  identity: string;
  name: string;
  events: HostClientEvents;
  /** Addresses learned on an earlier connection. */
  lan?: RemoteLan;
  /** Tests load the channel from their own build; the app from next to this file. */
  crypto?: typeof import("../../shared/remote/secure-channel");
}

const REQUEST_TIMEOUT = 30000;
const PAIRING_TIMEOUT = 125000;
const COMMAND_TTL = 300000;
const SILENCE_LIMIT = 15000;
const DIRECT_TIMEOUT = 1500;
const UPGRADE_INTERVAL = 60000;

export class RemoteHostClient {
  status: HostStatus = "offline";
  transport?: "relay" | "direct";
  private socket?: WebSocket;
  private channel?: Channel;
  private generation = 0;
  private attempt = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private upgrade?: ReturnType<typeof setInterval>;
  private lan?: RemoteLan;
  private heardAt = 0;
  private nextId = 0;
  private closed = true;
  private invite?: string;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  /** Sent or waiting to send. Kept across connections: the host answers a repeat from its journal. */
  private commands = new Map<string, { request: CommandFields; resolve(result: CommandResult): void }>();
  private subscribed?: string;
  private tail?: HistoryTail;
  private seq = 0;
  private held?: RemoteEvent[];
  state?: RemoteState;

  constructor(private options: HostClientOptions) {
    this.invite = options.pairing.invite;
    this.lan = options.lan;
  }
  private crypto() {
    return this.options.crypto ?? (require(join(__dirname, "secure-channel.cjs")) as typeof import("../../shared/remote/secure-channel"));
  }
  private setStatus(status: HostStatus) {
    if (this.status === status) return;
    this.status = status;
    this.options.events.status(status);
  }
  connect() {
    this.closed = false;
    const generation = ++this.generation;
    clearTimeout(this.retry);
    this.setStatus("connecting");
    // Pairing goes through the relay; after that a direct path is tried first.
    void this.direct(generation).then((socket) => {
      if (generation !== this.generation) return socket?.close();
      if (socket) return this.adopt(socket, "direct", generation);
      this.dialRelay(generation);
    });
  }
  private dialRelay(generation: number) {
    const { relay, room, routeToken } = this.options.pairing;
    const socket = new WebSocket(relay, { maxPayload: 256 * 1024, perMessageDeflate: false });
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    this.watch(socket, generation);
    socket.on("open", () => socket.send(JSON.stringify({ role: "phone", room, token: routeToken })));
    socket.addEventListener("message", this.waitForPeer(socket, generation, "relay") as never);
  }
  private waitForPeer(socket: WebSocket, generation: number, transport: "relay" | "direct") {
    const control = (event: { data: unknown }) => {
      socket.removeEventListener("message", control as never);
      let type: string | undefined;
      try {
        if (typeof event.data === "string") type = JSON.parse(event.data).type;
      } catch {}
      if (type !== "peer") return socket.close();
      this.transport = transport;
      void this.open(socket, generation).catch(() => socket.close());
    };
    return control;
  }
  /** The first of this Mac's addresses to answer, with the peer message already read. */
  private direct(generation: number): Promise<WebSocket | undefined> {
    const lan = this.lan;
    if (!lan?.addresses.length || this.invite) return Promise.resolve(undefined);
    const token = lanToken(this.options.pairing.routeToken);
    return new Promise((resolve) => {
      let left = lan.addresses.length;
      let settled = false;
      const sockets: WebSocket[] = [];
      const finish = (winner?: WebSocket) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const socket of sockets) if (socket !== winner) socket.terminate();
        resolve(generation === this.generation ? winner : undefined);
      };
      const timer = setTimeout(() => finish(), DIRECT_TIMEOUT);
      for (const address of lan.addresses) {
        const socket = new WebSocket(`ws://${address}:${lan.port}`, { maxPayload: 256 * 1024, perMessageDeflate: false });
        sockets.push(socket);
        socket.binaryType = "arraybuffer";
        const failed = () => {
          if (--left === 0) finish();
        };
        socket.once("error", failed);
        socket.once("open", () => socket.send(JSON.stringify({ role: "phone", token })));
        socket.once("message", (_data, binary) => {
          socket.off("error", failed);
          socket.on("error", () => {});
          if (binary) return failed();
          finish(socket);
        });
      }
    });
  }
  private adopt(socket: WebSocket, transport: "relay" | "direct", generation: number) {
    this.socket = socket;
    this.transport = transport;
    this.watch(socket, generation);
    void this.open(socket, generation).catch(() => socket.close());
  }
  private watch(socket: WebSocket, generation: number) {
    socket.on("error", () => {});
    socket.on("close", () => {
      if (generation !== this.generation || this.closed) return;
      this.lost();
      if (this.status === "revoked" || this.status === "rejected") return;
      this.setStatus("offline");
      const wait = Math.min(30000, 1000 * 2 ** this.attempt++) * (0.8 + Math.random() * 0.4);
      this.retry = setTimeout(() => this.connect(), wait);
    });
  }
  /** On the relay with a direct path known: move over when it answers. */
  private async tryUpgrade() {
    if (this.transport !== "relay" || !this.channel) return;
    const generation = this.generation;
    const socket = await this.direct(generation);
    if (!socket) return;
    if (generation !== this.generation || this.transport !== "relay" || !this.channel) return socket.close();
    const next = ++this.generation;
    const old = this.socket;
    this.lost();
    old?.close();
    this.adopt(socket, "direct", next);
  }
  close() {
    this.closed = true;
    this.generation++;
    clearTimeout(this.retry);
    this.lost();
    this.socket?.close();
    this.socket = undefined;
    this.transport = undefined;
    this.setStatus("offline");
  }
  /** Requests in flight have no answer now; commands stay and go again on the next connection. */
  private lost() {
    clearInterval(this.watchdog);
    clearInterval(this.upgrade);
    this.channel?.close();
    this.channel = undefined;
    this.held = undefined;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("DISCONNECTED"));
    }
    this.pending.clear();
  }
  private async open(socket: WebSocket, generation: number) {
    const { pairing, identity, name } = this.options;
    const channel = await this.crypto().secureChannel(socket as never, identity, true, pairing.hostPeerId);
    if (generation !== this.generation) return channel.close();
    if (this.invite) this.setStatus("confirming");
    channel.send({
      type: "auth",
      protocol: REMOTE_PROTOCOL,
      environment: pairing.environment,
      name,
      features: [EVENTS_FEATURE, DESKTOP_FEATURE],
      ...(this.invite ? { invite: this.invite } : {}),
      ...(this.subscribed ? { sessionId: this.subscribed, ...(this.tail ? { tail: this.tail } : {}) } : {}),
    });
    const giveUp = setTimeout(() => channel.close(), PAIRING_TIMEOUT);
    const first = await channel.messages.next();
    clearTimeout(giveUp);
    const hello = first.value as { type?: string; snapshot?: RemoteSnapshot; lan?: RemoteLan };
    if (hello?.type !== "authenticated") {
      if (this.invite || hello?.type === "auth-rejected") this.setStatus("rejected");
      return channel.close();
    }
    this.invite = undefined;
    this.attempt = 0;
    this.channel = channel;
    this.seq = 0;
    this.heardAt = Date.now();
    this.setStatus("connected");
    if (hello.lan) {
      this.lan = hello.lan;
      this.options.events.lan?.(hello.lan);
    }
    if (this.transport === "relay" && this.lan) {
      void this.tryUpgrade();
      this.upgrade = setInterval(() => void this.tryUpgrade(), UPGRADE_INTERVAL);
    }
    this.watchdog = setInterval(() => {
      if (Date.now() - this.heardAt > SILENCE_LIMIT) return void (socket as WebSocket).terminate();
      void this.request({ method: "ping" }).catch(() => {});
    }, SILENCE_LIMIT / 3);
    if (hello.snapshot) this.applySnapshot(hello.snapshot);
    else void this.refresh();
    for (const id of this.commands.keys()) void this.sendCommand(id);
    for await (const data of channel.messages) {
      this.heardAt = Date.now();
      this.receive(data as never);
    }
  }
  private receive(data: { type?: string; id?: string; result?: unknown; error?: string }) {
    if (data.type === "response" && data.id) {
      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.error) entry.reject(new Error(data.error));
      else entry.resolve(data.result);
    } else if (data.type === "event") {
      if (this.held) this.held.push(data as unknown as RemoteEvent);
      else this.applyEvent(data as unknown as RemoteEvent);
    } else if (data.type === "revoked") {
      this.setStatus("revoked");
      this.close();
      this.status = "revoked";
    }
  }
  private applyEvent(event: RemoteEvent) {
    // A gap means something was missed; a snapshot holds it all.
    if (event.seq !== this.seq + 1) return void this.refresh();
    this.seq = event.seq;
    if (event.state) {
      this.state = event.state;
      this.options.events.state(event.state);
    }
    if (event.history) {
      const { sessionId, messages, appendFrom, before, count, revision } = event.history;
      if (sessionId === this.subscribed) {
        this.tail = { count, hash: revision };
        this.options.events.history(sessionId, messages, { replace: appendFrom === undefined, before });
      }
    }
    if (event.live && event.live.sessionId === this.subscribed)
      this.options.events.live(event.live.sessionId, event.live);
  }
  private applySnapshot(snapshot: RemoteSnapshot) {
    this.seq = snapshot.seq ?? this.seq;
    const state = { projects: snapshot.projects, sessions: snapshot.sessions, permissions: snapshot.permissions };
    this.state = state;
    this.options.events.state(state, snapshot.machineName);
    if (snapshot.sessionId && snapshot.sessionId === this.subscribed && snapshot.messages) {
      const committed = snapshot.messages.filter((m) => !m.streaming);
      const live = snapshot.messages.find((m) => m.streaming);
      if (snapshot.historyCount !== undefined && snapshot.historyRevision)
        this.tail = { count: snapshot.historyCount, hash: snapshot.historyRevision };
      this.options.events.history(snapshot.sessionId, committed, {
        replace: snapshot.appendFrom === undefined,
        before: snapshot.before,
      });
      this.options.events.live(snapshot.sessionId, { text: live ? live.text : null });
    }
  }
  /** Fetches the state, and the open session if any, then replays what arrived meanwhile. */
  private async refresh() {
    if (!this.channel || this.held) return;
    const held: RemoteEvent[] = [];
    this.held = held;
    try {
      const snapshot = (await this.request({
        method: "snapshot",
        ...(this.subscribed ? { sessionId: this.subscribed, ...(this.tail ? { tail: this.tail } : {}) } : {}),
      })) as RemoteSnapshot;
      this.applySnapshot(snapshot);
    } catch {
      // The connection ended, or the session is gone; the next connection starts over.
    }
    if (this.held !== held) return;
    this.held = undefined;
    for (const event of held) if (event.seq > this.seq) this.applyEvent(event);
  }
  /** Shows this session: its history now and its changes as events. One at a time per connection. */
  subscribe(sessionId: string) {
    if (this.subscribed !== sessionId) this.tail = undefined;
    this.subscribed = sessionId;
    return this.refresh();
  }
  async older(sessionId: string, before: number) {
    const snapshot = (await this.request({
      method: "snapshot",
      sessionId,
      before,
      ...(this.subscribed === sessionId && this.tail ? { tail: this.tail } : {}),
    })) as RemoteSnapshot;
    return { messages: snapshot.messages ?? [], before: snapshot.before ?? null };
  }
  request(fields: CommandFields, timeout = REQUEST_TIMEOUT): Promise<unknown> {
    const channel = this.channel;
    if (!channel) return Promise.reject(new Error("DISCONNECTED"));
    const id = `c${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("TIMEOUT"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        channel.send({ ...fields, id });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  }
  /**
   * Sends a command until the host answers for it. A lost answer is not a failure:
   * the same command id goes again and the host replies from its journal without
   * running it twice. Past its expiry the outcome is unknown, never assumed.
   */
  command(method: string, fields: CommandFields): Promise<CommandResult> {
    const commandId = randomUUID();
    const request = { method, commandId, expiresAt: Date.now() + COMMAND_TTL, ...fields };
    return new Promise((resolve) => {
      this.commands.set(commandId, { request, resolve });
      setTimeout(() => this.expire(commandId), COMMAND_TTL + 1000);
      void this.sendCommand(commandId);
    });
  }
  private expire(commandId: string) {
    const entry = this.commands.get(commandId);
    if (!entry) return;
    this.commands.delete(commandId);
    entry.resolve({ commandId, state: "unknown", error: "Couldn’t confirm delivery" });
  }
  private async sendCommand(commandId: string) {
    const entry = this.commands.get(commandId);
    if (!entry || !this.channel) return;
    try {
      const result = (await this.request(entry.request)) as CommandResult;
      this.commands.delete(commandId);
      entry.resolve(result);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      // No answer: it may have run. The next connection asks again under the same id.
      if (code === "DISCONNECTED" || code === "TIMEOUT" || code === "Connection closed") return;
      this.commands.delete(commandId);
      entry.resolve({ commandId, state: "rejected", error: code });
    }
  }
}
