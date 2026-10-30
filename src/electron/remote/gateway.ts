import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from "crypto";
import { listProjectDir, readProjectFile, searchProjectFiles } from "./project-files";
import { hostname, networkInterfaces } from "os";
import { join } from "path";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import { RemoteJournal } from "./journal";
import { PLAN_LIMIT, planOf, promptFields, remotePrompt, resolvePrompt, type RemoteResolution } from "./prompts";
import { defaultRelay, hostProof, identityKeys, pushRequest, relayHttpOrigin, roomFor } from "./relay-auth";
import {
  EMPTY_HISTORY,
  EVENTS_FEATURE,
  REMOTE_PROTOCOL,
  historyTailSchema,
  requestSchema,
  type HistoryTail,
  type RemoteEvent,
  type RemoteLan,
  type RemoteMessage,
  type RemotePermission,
  type RemoteSession,
  type RemoteProject,
  type RemoteState,
  type CommandResult,
  type Pairing,
  type RemoteEnvironment,
  type RemoteAgentOptions,
  type RemoteAttachment,
  type RemoteTaskSettings,
  type RemoteCapabilities,
  type RemoteProvider,
  providerSchema,
} from "../../shared/remote/protocol";
import type { ServerEvent, PermissionRequestPayload, Attachment, StreamMessage } from "../../shared/types";
import { getMessageContentBlocks, normalizeToolUseBlock } from "../../ui/utils/message-content";

/** Settings a phone may attach to a new task or a follow-up. */
export interface RemoteTaskExtras {
  settings?: RemoteTaskSettings;
  worktree?: boolean;
  attachments?: Attachment[];
}
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_TTL = 10 * 60 * 1000;
/** Pushed events are coalesced at most this long; older phones get `changed` at the old pace. */
const EVENT_INTERVAL = 50;
const CHANGED_INTERVAL = 180;
/** A session's projected history is reused this long unless one of its events invalidates it. */
const HISTORY_TTL = 3000;
/** Bursts of commits re-read one session's history at most this often. */
const HISTORY_MIN_INTERVAL = 150;
const PAGE_MESSAGES = 100;
const PAGE_BYTES = 512 * 1024;
const MAX_LAN_SOCKETS = 8;

interface Project extends RemoteProject {
  path: string;
}
const permissionDetail = (p: PermissionRequestPayload) => JSON.stringify(p.input, null, 2) ?? "";
const canApproveRemotely = (p: PermissionRequestPayload) =>
  !/question|plan|computer/i.test(p.toolName) && permissionDetail(p).length <= 24000;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const sameSecret = (a: unknown, b: string) => {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
/**
 * What a phone proves on a direct connection. Derived from the route token, so the
 * relay credential itself never travels over plain ws:// on a network that may not be ours.
 */
export const lanToken = (routeToken: string) => createHmac("sha256", routeToken).update("aegis.lan/1").digest("hex");
export interface RemoteRuntime {
  environment?: RemoteEnvironment;
  /** Interface for the direct same-network listener (default all); false turns it off. */
  lan?: { host: string } | false;
  projects(): Project[];
  sessions(): RemoteSession[];
  history(id: string): RemoteMessage[];
  start(
    project: Project,
    provider: "claude" | "codex" | "bubble" | "devin" | "mimo" | "minimax",
    prompt: string,
    extras?: RemoteTaskExtras,
  ): Promise<string | null>;
  send(id: string, prompt: string, extras?: RemoteTaskExtras): Promise<boolean>;
  /** Agent catalog for the phone's pickers; must not include secrets. */
  options?(): Promise<RemoteAgentOptions>;
  /** Slash commands and skills for a provider in a project (and session, if any). */
  capabilities?(provider: RemoteProvider, cwd: string, sessionId?: string): Promise<RemoteCapabilities>;
  /** Stores uploaded bytes as a desktop attachment (type and size validated). */
  attach?(name: string, data: Uint8Array): Promise<Attachment>;
  stop(id: string): void;
  /** `resolution`, when given, is the whole result (a question's answers, a plan's choice). */
  permission(
    request: PermissionRequestPayload,
    decision: "allow" | "deny",
    resolution?: RemoteResolution,
  ): boolean;
  hasPermission(id: string, toolUseId: string): boolean;
  confirm(name: string, peerId: string): Promise<boolean>;
}
type Channel = Awaited<ReturnType<typeof import("../../shared/remote/secure-channel").secureChannel>>;
/** One authenticated phone connection, through the relay or directly. */
interface Link {
  channel: Channel;
  peerId: string;
  transport: "relay" | "lan";
  /** The phone takes pushed events; otherwise it gets `changed` and polls. */
  events: boolean;
  /** The phone's app is off screen (switched away or locked). */
  away: boolean;
  seq: number;
  /** What this phone already has, so events carry only the difference. */
  subscribed?: string;
  state?: string;
  history?: { sessionId: string; count: number; hash: string };
  live?: { sessionId: string; id: number; total: number };
}
/** A session's projected history with a hash chain over it (chain[i] covers messages 0…i). */
interface History {
  at: number;
  messages: RemoteMessage[];
  chain: string[];
  sizes: number[];
}
/** The last `max` UTF-16 units, without a split surrogate pair at the front. */
function lastChars(text: string, max: number) {
  if (text.length <= max) return text;
  const tail = text.slice(-max);
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}
/** Private IPv4 addresses of this Mac a phone on the same network can reach. */
function lanAddresses(host: string): string[] {
  if (host !== "0.0.0.0") return [host];
  const result: string[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const entry of list ?? []) {
      if ((entry.family !== "IPv4" && (entry.family as unknown) !== 4) || entry.internal) continue;
      const [a, b] = entry.address.split(".").map(Number);
      const reachable =
        a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128);
      if (reachable && !result.includes(entry.address)) result.push(entry.address);
    }
  // Home networks first; carrier-grade NAT space (Tailscale and the like) last.
  return result.sort((x, y) => Number(x.startsWith("100.")) - Number(y.startsWith("100."))).slice(0, 6);
}
export class RemoteGateway {
  readonly hostBootId = randomUUID();
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setTimeout>;
  private eventTimer?: ReturnType<typeof setTimeout>;
  private lastFlush = 0;
  /** Bumps when the gateway closes or is reconfigured; connections from before end. */
  private generation = 0;
  /** Bumps per relay attempt; a stale socket's close must not schedule a retry. */
  private relayAttempt = 0;
  private relayStatus = "disabled";
  private invite?: { value: string; expiresAt: number; claimed: boolean };
  private runIds = new Map<string, string>();
  private permissions = new Map<string, PermissionRequestPayload>();
  /** Per session, the plan from its latest ExitPlanMode call (Claude asks without it). */
  private plans = new Map<string, string>();
  private live = new Map<string, { id: number; text: string; total: number }>();
  private liveIds = 0;
  private histories = new Map<string, History>();
  private historyReadAt = new Map<string, number>();
  private links = new Set<Link>();
  /** Per phone, its newest connection: the one that gets events. */
  private current = new Map<string, Link>();
  private stateDirty = false;
  private historyDirty = new Set<string>();
  private liveDirty = new Set<string>();
  private lanServer?: WebSocket.Server;
  private lanHeartbeat?: ReturnType<typeof setInterval>;
  private pendingCommands = new Set<string>();
  private uploads = new Map<string, { peer: string; name: string; total: number; parts: Buffer[]; bytes: number; at: number }>();
  private uploaded = new Map<string, { peer: string; attachment: Attachment; at: number }>();
  private attempt = 0;
  private relayError?: string;
  private running = new Set<string>();
  private notified = new Map<string, number>();
  constructor(
    readonly journal: RemoteJournal,
    private runtime: RemoteRuntime,
  ) {}
  /** A phone connected either way counts as connected; otherwise the relay's state. */
  get status() {
    return this.relayStatus !== "disabled" && this.links.size ? "connected" : this.relayStatus;
  }
  private crypto(): typeof import("../../shared/remote/secure-channel") {
    return require(join(__dirname, "secure-channel.cjs"));
  }
  describe() {
    return {
      status: this.status,
      enabled: this.journal.state.config?.enabled ?? false,
      environment: this.runtime.environment ?? "development",
      relay: this.journal.state.config?.relay ?? "",
      defaultRelay: defaultRelay(),
      relayError: this.relayError,
      projects: this.runtime.projects().map(({ id, name }) => ({ id, name })),
      devices: this.journal.state.devices,
    };
  }
  /** An empty relay means the public Aegis relay; the token is only for self-hosted relays. */
  async configure(relay: string | undefined, registrationToken: string | undefined) {
    const url = new URL(relay?.trim() || defaultRelay());
    if (
      url.protocol !== "wss:" &&
      !(
        url.protocol === "ws:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      )
    )
      throw new Error("Use WSS for remote connections");
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Relay URL must not contain credentials");
    registrationToken = registrationToken?.trim() || undefined;
    if (registrationToken && (registrationToken.length < 32 || registrationToken.length > 128))
      throw new Error("Invalid relay registration token");
    this.close();
    const identity = await this.crypto().createIdentity();
    this.journal.update((s) => {
      s.config = {
        relay: url.toString(),
        ...(registrationToken ? { registrationToken } : {}),
        room: roomFor(identityKeys(identity.privateKey).publicKey),
        routeToken: randomBytes(32).toString("hex"),
        identity: identity.privateKey,
        peerId: identity.peerId,
        enabled: true,
      };
      s.devices = [];
    });
    this.connect();
    return this.describe();
  }
  pairing(): Pairing {
    const config = this.journal.state.config;
    // Pairing always goes through the relay: the phone knows no other way to reach this Mac yet.
    if (!config?.enabled || this.relayStatus !== "waiting")
      throw new Error("Wait for the relay connection");
    this.invite = {
      value: randomBytes(32).toString("hex"),
      expiresAt: Date.now() + 120000,
      claimed: false,
    };
    return {
      version: 1,
      environment: this.runtime.environment ?? "development",
      relay: config.relay,
      room: config.room,
      routeToken: config.routeToken,
      hostPeerId: config.peerId,
      name: hostname(),
      invite: this.invite.value,
      expiresAt: this.invite.expiresAt,
    };
  }
  revoke(peerId: string) {
    this.journal.update((s) => {
      s.devices = s.devices.filter((d) => d.peerId !== peerId);
    });
    this.invite = undefined;
    for (const link of this.links) {
      if (link.peerId !== peerId) continue;
      try {
        link.channel.send({ type: "revoked" });
      } catch {}
      setTimeout(() => link.channel.close(), 100);
    }
    return this.describe();
  }
  disable() {
    this.journal.update((s) => {
      if (s.config) s.config.enabled = false;
    });
    this.close();
    return this.describe();
  }
  close() {
    this.generation++;
    this.relayAttempt++;
    clearTimeout(this.retry);
    clearTimeout(this.timer);
    clearTimeout(this.eventTimer);
    this.timer = undefined;
    this.eventTimer = undefined;
    this.invite = undefined;
    for (const link of this.links) link.channel.close();
    this.links.clear();
    this.current.clear();
    this.socket?.close();
    this.socket = undefined;
    this.stopLan();
    this.relayStatus = "disabled";
  }
  connect() {
    let config = this.journal.state.config;
    if (!config?.enabled) return;
    const keys = identityKeys(config.identity);
    const room = roomFor(keys.publicKey);
    if (config.room !== room) {
      // Rooms used to be random; they now follow the host key. Phones re-pair once.
      this.journal.update((s) => {
        s.config!.room = room;
      });
      config = this.journal.state.config!;
    }
    this.startLan();
    const attempt = ++this.relayAttempt;
    const generation = this.generation;
    clearTimeout(this.retry);
    this.relayStatus = "connecting";
    const socket = new WebSocket(config.relay, {
      maxPayload: 256 * 1024,
      perMessageDeflate: false,
    });
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    // A lossy or stalled path can leave the socket open but silent. The relay
    // answers pings, so a quiet 10 s means reconnect instead of waiting on TCP.
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 10000);
    socket.on("pong", () => {
      alive = true;
    });
    socket.on("message", () => {
      alive = true;
    });
    socket.on("close", () => clearInterval(heartbeat));
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          role: "host",
          room,
          token: config.routeToken,
          publicKey: keys.publicKey,
          ...(config.registrationToken ? { registrationToken: config.registrationToken } : {}),
        }),
      ),
    );
    const control = (event: any) => {
      if (typeof event.data !== "string") {
        socket.close();
        return;
      }
      let message: { type?: string; nonce?: string };
      try {
        message = JSON.parse(event.data);
      } catch {
        socket.close();
        return;
      }
      const type = message.type;
      if (type === "challenge" && typeof message.nonce === "string" && /^[a-f0-9]{64}$/.test(message.nonce))
        socket.send(JSON.stringify({ type: "proof", signature: keys.sign(hostProof(message.nonce, room)).toString("base64") }));
      else if (type === "registered") {
        this.relayStatus = "waiting";
        this.attempt = 0;
        this.relayError = undefined;
      } else if (type === "peer") {
        socket.removeEventListener("message", control);
        void this.accept(socket, "relay", generation).catch(() => socket.close());
      } else socket.close();
    };
    socket.addEventListener("message", control);
    socket.on("error", () => {
      if (attempt === this.relayAttempt) this.relayStatus = "offline";
    });
    socket.on("close", (code: number, reason: Buffer) => {
      if (attempt !== this.relayAttempt) return;
      // 1008 is the relay refusing this Mac; retrying fast would not change that.
      const rejected = code === 1008;
      this.relayStatus = rejected ? "rejected" : "offline";
      if (rejected) this.relayError = reason.toString().slice(0, 120) || "Connection rejected";
      // The relay drops this Mac's socket whenever its phone leaves; come straight back.
      const base = rejected ? 60000 : code === 1012 && this.attempt === 0 ? 100 : Math.min(60000, 1500 * 2 ** this.attempt++);
      this.retry = setTimeout(() => this.connect(), base * (0.8 + Math.random() * 0.4));
    });
  }
  /** Listens on this Mac's own networks so a phone nearby can skip the relay. */
  private startLan() {
    const config = this.journal.state.config;
    const lan = this.runtime.lan ?? { host: "0.0.0.0" };
    if (this.lanServer || !config?.enabled || lan === false) return;
    const server = new WebSocket.Server({
      host: lan.host,
      port: config.lanPort ?? 0,
      maxPayload: 256 * 1024,
      perMessageDeflate: false,
    });
    this.lanServer = server;
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (this.lanServer !== server) return;
      this.stopLan();
      // The saved port is taken now: take any free one; phones learn it on their next connection.
      if (error.code === "EADDRINUSE" && this.journal.state.config?.lanPort) {
        this.journal.update((s) => {
          if (s.config) delete s.config.lanPort;
        });
        this.startLan();
      }
    });
    server.on("listening", () => {
      const port = (server.address() as AddressInfo).port;
      if (this.journal.state.config && this.journal.state.config.lanPort !== port)
        this.journal.update((s) => {
          if (s.config) s.config.lanPort = port;
        });
    });
    const alive = new WeakSet<WebSocket>();
    server.on("connection", (socket) => {
      if (server.clients.size > MAX_LAN_SOCKETS) {
        socket.terminate();
        return;
      }
      alive.add(socket);
      socket.on("pong", () => alive.add(socket));
      this.acceptLan(socket);
    });
    // A phone that left the network leaves a silent socket; drop it so pushes resume.
    this.lanHeartbeat = setInterval(() => {
      for (const socket of server.clients) {
        if (!alive.has(socket)) {
          socket.terminate();
          continue;
        }
        alive.delete(socket);
        socket.ping();
      }
    }, 10000);
  }
  private stopLan() {
    clearInterval(this.lanHeartbeat);
    const server = this.lanServer;
    this.lanServer = undefined;
    if (!server) return;
    for (const socket of server.clients) socket.terminate();
    server.close();
  }
  private lanInfo(): RemoteLan | undefined {
    const address = this.lanServer?.address();
    const lan = this.runtime.lan ?? { host: "0.0.0.0" };
    if (!address || typeof address === "string" || lan === false) return undefined;
    const addresses = lanAddresses(lan.host);
    return addresses.length ? { port: address.port, addresses } : undefined;
  }
  /** A direct connection says which pairing it belongs to, like it would to the relay. */
  private acceptLan(socket: WebSocket) {
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => socket.terminate(), 5000);
    socket.once("close", () => clearTimeout(timer));
    socket.once("message", (data: WebSocket.RawData, binary: boolean) => {
      clearTimeout(timer);
      const config = this.journal.state.config;
      try {
        // binaryType is already "arraybuffer" for the Noise frames that follow.
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        if (binary || bytes.length > 4096) throw new Error();
        const hello = JSON.parse(bytes.toString());
        if (
          !config?.enabled ||
          !hello ||
          typeof hello !== "object" ||
          hello.role !== "phone" ||
          !sameSecret(hello.token, lanToken(config.routeToken))
        )
          throw new Error();
      } catch {
        socket.terminate();
        return;
      }
      socket.send(JSON.stringify({ type: "peer" }));
      void this.accept(socket, "lan", this.generation).catch(() => socket.close());
    });
  }
  private async accept(socket: WebSocket, transport: Link["transport"], generation: number) {
    const config = this.journal.state.config!;
    const channel = await this.crypto().secureChannel(
      socket as any,
      config.identity,
      false,
    );
    const authTimeout = setTimeout(() => channel.close(), 15000);
    let link: Link | undefined;
    try {
      const first = await channel.messages.next();
      const auth = first.value as any;
      if (
        auth?.type !== "auth" ||
        auth.protocol !== REMOTE_PROTOCOL ||
        auth.environment !== (this.runtime.environment ?? "development") ||
        typeof auth.name !== "string" ||
        auth.name.length > 80
      )
        throw new Error("Invalid auth");
      let device = this.journal.state.devices.find(
        (d) => d.peerId === channel.peerId,
      );
      if (!device) {
        // New phones pair through the relay; a direct connection is only for paired ones.
        if (transport !== "relay") throw new Error("Not paired");
        const invite = this.invite;
        if (
          !invite ||
          invite.claimed ||
          invite.expiresAt < Date.now() ||
          typeof auth.invite !== "string" ||
          auth.invite.length !== invite.value.length ||
          !timingSafeEqual(Buffer.from(auth.invite), Buffer.from(invite.value))
        )
          throw new Error("Pairing expired");
        invite.claimed = true;
        clearTimeout(authTimeout);
        const approved = await this.runtime.confirm(auth.name, channel.peerId);
        if (
          !approved ||
          generation !== this.generation ||
          this.invite !== invite ||
          invite.expiresAt < Date.now()
        )
          throw new Error("Pairing rejected");
        device = {
          peerId: channel.peerId,
          name: auth.name,
          pairedAt: Date.now(),
        };
        this.journal.update((s) => s.devices.push(device!));
        this.invite = undefined;
      }
      clearTimeout(authTimeout);
      if (generation !== this.generation) throw new Error("Stale connection");
      const features: unknown[] = Array.isArray(auth.features) ? auth.features.slice(0, 16) : [];
      link = {
        channel,
        peerId: device.peerId,
        transport,
        events: features.includes(EVENTS_FEATURE),
        away: false,
        seq: 0,
      };
      this.links.add(link);
      this.current.set(link.peerId, link);
      // An event phone gets its first snapshot with the answer: one round trip less per connection.
      let snapshot: ReturnType<RemoteGateway["snapshot"]> | undefined;
      if (link.events) {
        const tail = historyTailSchema.safeParse(auth.tail);
        const sessionId = typeof auth.sessionId === "string" && auth.sessionId.length <= 160 ? auth.sessionId : undefined;
        try {
          snapshot = this.snapshot(sessionId, undefined, undefined, link, tail.success ? tail.data : undefined);
        } catch {
          snapshot = this.snapshot(undefined, undefined, undefined, link);
        }
      }
      const lan = this.lanInfo();
      channel.send({
        type: "authenticated",
        environment: this.runtime.environment ?? "development",
        protocol: REMOTE_PROTOCOL,
        hostBootId: this.hostBootId,
        serverTime: Date.now(),
        ...(lan ? { lan } : {}),
        ...(snapshot ? { snapshot } : {}),
      });
      for await (const data of channel.messages) {
        if (
          generation !== this.generation ||
          !this.journal.state.devices.some((d) => d.peerId === channel.peerId)
        )
          throw new Error("Revoked");
        // Controls remain responsive while a provider starts or handles a prompt.
        // Too many at once is answered per request; it must not read as a revoked pairing.
        if (this.pendingCommands.size >= 32) {
          const id = typeof (data as any)?.id === "string" ? (data as any).id.slice(0, 160) : "";
          channel.send({ type: "response", id, error: "TOO_MANY_REQUESTS" });
          continue;
        }
        const from = link;
        void this.dispatch(data, channel.peerId, from)
          .then((result) => {
            if (generation === this.generation) channel.send(result);
          })
          .catch(() => channel.close());
      }
    } catch {
      try {
        channel.send({ type: "auth-rejected" });
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      clearTimeout(authTimeout);
      channel.close();
      if (link) this.drop(link);
    }
  }
  private drop(link: Link) {
    this.links.delete(link);
    if (this.current.get(link.peerId) !== link) return;
    // Another connection of the same phone (the relay while a direct one ended) takes over.
    const next = [...this.links].reverse().find((l) => l.peerId === link.peerId);
    if (!next) {
      this.current.delete(link.peerId);
      return;
    }
    this.current.set(link.peerId, next);
    // It missed what changed meanwhile; its baselines make the next flush send exactly that.
    this.stateDirty = true;
    if (next.subscribed) {
      this.historyDirty.add(next.subscribed);
      this.liveDirty.add(next.subscribed);
    }
    this.schedule();
  }
  /** Paired phones see every project and session the desktop sidebar lists. */
  private allowedSession(sessionId: string, sessions = this.runtime.sessions()) {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error("SCOPE_DENIED");
    return session;
  }
  private runId(id: string, sessions = this.runtime.sessions()) {
    const session = sessions.find((s) => s.id === id);
    if (!session || !["running", "stopping"].includes(session.status))
      return null;
    if (!this.runIds.has(id)) this.runIds.set(id, randomUUID());
    return this.runIds.get(id)!;
  }
  /** Projects, sessions and pending approvals: everything but a session's messages. */
  private state(): RemoteState {
    const listed = this.runtime.sessions();
    const sessions = listed.map((s) => ({ ...s, runId: this.runId(s.id, listed) }));
    const visible = new Set(sessions.map((s) => s.id));
    const permissions: RemotePermission[] = [];
    for (const [requestId, p] of this.permissions) {
      const runId = this.runId(p.sessionId, listed);
      if (
        visible.has(p.sessionId) &&
        runId &&
        this.runtime.hasPermission(p.sessionId, p.toolUseId)
      ) {
        const detail = permissionDetail(p);
        const prompt = remotePrompt(p);
        permissions.push({
          requestId,
          sessionId: p.sessionId,
          runId,
          toolName: p.toolName,
          detail: detail.length > 24000
            ? detail.slice(0, 24000) + "\n… Too long to show here. Review the full request on your Mac."
            : detail,
          canApprove: canApproveRemotely(p),
          ...promptFields(p, prompt, this.plans.get(p.sessionId)),
        });
      }
    }
    return {
      projects: this.runtime
        .projects()
        .map(({ id, name, isRepo }) => ({ id, name, isRepo })),
      sessions,
      permissions,
    };
  }
  /** Reads and projects a session's history once until its events or the TTL say otherwise. */
  private historyOf(sessionId: string): History {
    const cached = this.histories.get(sessionId);
    if (cached && Date.now() - cached.at < HISTORY_TTL) return cached;
    const messages = [...new Map(this.runtime.history(sessionId).map((m) => [m.id, m])).values()];
    const chain: string[] = [];
    const sizes: number[] = [];
    let hash = "";
    for (const message of messages) {
      const json = JSON.stringify(message);
      sizes.push(Buffer.byteLength(json));
      hash = createHash("sha256").update(hash).update(json).digest("hex");
      chain.push(hash);
    }
    const entry = { at: Date.now(), messages, chain, sizes };
    this.historyReadAt.set(sessionId, entry.at);
    this.histories.delete(sessionId);
    this.histories.set(sessionId, entry);
    while (this.histories.size > 16) this.histories.delete(this.histories.keys().next().value!);
    while (this.historyReadAt.size > 64) this.historyReadAt.delete(this.historyReadAt.keys().next().value!);
    return entry;
  }
  private headOf(history: History) {
    const count = history.messages.length;
    return { count, hash: count ? history.chain[count - 1] : EMPTY_HISTORY };
  }
  /** The phone's `tail` is still a prefix of the history (nothing before it changed). */
  private extends(history: History, tail: HistoryTail) {
    if (tail.count > history.messages.length) return false;
    return tail.count === 0 ? tail.hash === EMPTY_HISTORY : history.chain[tail.count - 1] === tail.hash;
  }
  private liveMessage(sessionId: string): RemoteMessage | undefined {
    const live = this.live.get(sessionId);
    return live && { id: sessionId + ":live", role: "assistant", text: live.text, streaming: true };
  }
  /** The newest messages ending at `end` that fit one page, plus the cursor for older ones. */
  private page(history: History, live: RemoteMessage | undefined, end: number) {
    const all = live ? [...history.messages, live] : history.messages;
    end = Math.min(end, all.length);
    let start = end;
    let bytes = 0;
    while (start > 0 && end - start < PAGE_MESSAGES) {
      const size = history.sizes[start - 1] ?? Buffer.byteLength(JSON.stringify(all[start - 1]));
      if (bytes + size > PAGE_BYTES) break;
      bytes += size;
      start--;
    }
    return { messages: all.slice(start, end), before: start > 0 ? start : null };
  }
  /** Committed messages after `from`, when they fit one page. */
  private after(history: History, from: number) {
    const count = history.messages.length - from;
    if (count > PAGE_MESSAGES) return undefined;
    let bytes = 0;
    for (let i = from; i < history.messages.length; i++) bytes += history.sizes[i];
    return bytes > PAGE_BYTES ? undefined : history.messages.slice(from);
  }
  snapshot(
    sessionId?: string,
    before?: number,
    expectedHistoryRevision?: string,
    link?: Link,
    tail?: HistoryTail,
  ) {
    const base = this.state();
    const events = link?.events === true;
    let messages: RemoteMessage[] | undefined;
    let historyRevision: string | undefined;
    let historyCount: number | undefined;
    let appendFrom: number | undefined;
    let cursor: number | null = null;
    let liveEntry: { id: number; total: number } | undefined;
    if (sessionId) {
      this.allowedSession(sessionId, base.sessions);
      const history = this.historyOf(sessionId);
      const live = this.liveMessage(sessionId);
      liveEntry = this.live.get(sessionId);
      if (events) {
        // Over committed messages only, so streamed text doesn't invalidate the phone's pages.
        const head = this.headOf(history);
        historyRevision = head.hash;
        historyCount = head.count;
      } else
        historyRevision = sha256(JSON.stringify(live ? [...history.messages, live] : history.messages));
      if (before !== undefined) {
        const intact = tail ? this.extends(history, tail) : expectedHistoryRevision === historyRevision;
        if (!intact) throw new Error("HISTORY_CHANGED");
        ({ messages, before: cursor } = this.page(history, live, before));
      } else {
        const appended = tail && this.extends(history, tail) ? this.after(history, tail.count) : undefined;
        if (appended && tail) {
          messages = live ? [...appended, live] : appended;
          appendFrom = tail.count;
        } else ({ messages, before: cursor } = this.page(history, live, Infinity));
      }
    }
    const state = {
      ...base,
      sessionId,
      messages,
      before: cursor,
      historyRevision,
    };
    if (link?.events && before === undefined) {
      // Events after this build on exactly what this snapshot holds.
      link.subscribed = sessionId;
      link.state = sha256(JSON.stringify(base));
      link.history = sessionId && historyCount !== undefined ? { sessionId, count: historyCount, hash: historyRevision! } : undefined;
      link.live = sessionId && liveEntry ? { sessionId, id: liveEntry.id, total: liveEntry.total } : undefined;
    }
    return {
      ...state,
      ...(events ? { historyCount, appendFrom, seq: link!.seq } : {}),
      protocol: REMOTE_PROTOCOL,
      hostBootId: this.hostBootId,
      machineName: hostname(),
      environment: this.runtime.environment ?? "development",
      serverTime: Date.now(),
      revision: sha256(JSON.stringify(state)),
    };
  }
  async dispatch(data: unknown, peerId: string, link?: Link): Promise<unknown> {
    const parsed = requestSchema.safeParse(data);
    const requestId =
      typeof (data as any)?.id === "string"
        ? (data as any).id.slice(0, 160)
        : "";
    if (!parsed.success)
      return { type: "response", id: requestId, error: "INVALID_REQUEST" };
    const request = parsed.data;
    try {
      if (
        !this.journal.state.devices.some((d) => d.peerId === peerId) ||
        !this.journal.state.config?.enabled
      )
        throw new Error("UNAUTHORIZED");
      if (request.method === "ping")
        return {
          type: "response",
          id: request.id,
          result: { serverTime: Date.now() },
        };
      if (request.method === "presence") {
        // Every connection of this phone: one it is leaving may linger until its heartbeat ends it.
        for (const each of this.links) if (each.peerId === peerId) each.away = request.background;
        return { type: "response", id: request.id, result: { ok: true } };
      }
      if (request.method === "snapshot") {
        const result = this.snapshot(
          request.sessionId,
          request.before,
          request.historyRevision,
          link,
          request.tail,
        );
        // Polls repeat every few seconds; an unchanged snapshot is not worth resending.
        return {
          type: "response",
          id: request.id,
          result:
            request.knownRevision && request.knownRevision === result.revision && request.before === undefined
              ? { unchanged: true, revision: result.revision, serverTime: result.serverTime }
              : result,
        };
      }
      if (request.method === "push.register") {
        const { deviceToken, topic, environment } = request;
        this.journal.update((s) => {
          for (const device of s.devices) {
            // A token belongs to one phone; drop it from any other device record.
            if (device.peerId === peerId) device.push = { deviceToken, topic, environment };
            else if (device.push?.deviceToken === deviceToken) delete device.push;
          }
        });
        return { type: "response", id: request.id, result: { ok: true } };
      }
      if (request.method === "options")
        return {
          type: "response",
          id: request.id,
          result: (await this.runtime.options?.()) ?? {},
        };
      if (request.method === "capabilities") {
        // A session answers for its own agent and folder; a new task for the project's.
        const session = request.sessionId ? this.allowedSession(request.sessionId) : undefined;
        const projectId = session?.projectId ?? request.projectId;
        const project = this.runtime.projects().find((p) => p.id === projectId);
        if (!project) throw new Error("SCOPE_DENIED");
        const provider = providerSchema.safeParse(session?.provider ?? request.provider);
        if (!provider.success) return { type: "response", id: request.id, result: { commands: [], skills: [] } };
        return {
          type: "response",
          id: request.id,
          result: (await this.runtime.capabilities?.(provider.data, project.path, session?.id)) ?? { commands: [], skills: [] },
        };
      }
      if (
        request.method === "files.list" ||
        request.method === "files.search" ||
        request.method === "files.read"
      ) {
        const project = this.runtime.projects().find((p) => p.id === request.projectId);
        if (!project) throw new Error("SCOPE_DENIED");
        let result;
        try {
          result =
            request.method === "files.list"
              ? await listProjectDir(project.path, request.path)
              : request.method === "files.search"
                ? await searchProjectFiles(project.path, request.query)
                : await readProjectFile(project.path, request.path);
        } catch (error) {
          // Only our own codes go back; fs messages would leak absolute paths.
          const code = error instanceof Error ? error.message : "";
          throw new Error(/^[A-Z_]+$/.test(code) ? code : "FILE_UNAVAILABLE");
        }
        return { type: "response", id: request.id, result };
      }
      if (request.method === "attachment.chunk")
        return {
          type: "response",
          id: request.id,
          result: await this.receiveChunk(request, peerId),
        };
      const key = peerId + ":" + request.commandId;
      if (request.method === "command.get")
        return {
          type: "response",
          id: request.id,
          result: this.journal.state.commands[key]?.result ?? null,
        };
      const { id: _id, ...payload } = request;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex");
      const existing = this.journal.state.commands[key];
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new Error("COMMAND_MISMATCH");
        return {
          type: "response",
          id: request.id,
          result: structuredClone(existing.result),
        };
      }
      if (
        request.expiresAt < Date.now() ||
        request.expiresAt > Date.now() + 305000
      )
        throw new Error("COMMAND_EXPIRED");
      const attachments =
        "attachmentIds" in request && request.attachmentIds?.length
          ? request.attachmentIds.map((attachmentId) => {
              const entry = this.uploaded.get(attachmentId);
              if (!entry || entry.peer !== peerId) throw new Error("ATTACHMENT_EXPIRED");
              return entry.attachment;
            })
          : undefined;
      if ("sessionId" in request) {
        const session = this.allowedSession(request.sessionId);
        if (!["claude", "codex", "bubble", "devin", "mimo", "minimax"].includes(session.provider))
          throw new Error("DESKTOP_REQUIRED");
      }
      if (
        request.method === "create" &&
        !this.runtime.projects().some((p) => p.id === request.projectId)
      )
        throw new Error("SCOPE_DENIED");
      if ("runId" in request && request.runId !== this.runId(request.sessionId))
        throw new Error("STALE_RUN");
      if (
        request.method === "send" &&
        (this.runId(request.sessionId) ||
          this.pendingCommands.has("session:" + request.sessionId))
      )
        throw new Error("SESSION_BUSY");
      if (request.method === "permission") {
        const permission = this.permissions.get(request.requestId);
        if (
          !permission ||
          permission.sessionId !== request.sessionId ||
          !this.runtime.hasPermission(
            permission.sessionId,
            permission.toolUseId,
          )
        )
          throw new Error("PERMISSION_EXPIRED");
        this.resolution(permission, request.decision, request.answers);
      }
      const result: CommandResult = {
        commandId: request.commandId,
        state: "accepted",
        ...("sessionId" in request ? { sessionId: request.sessionId } : {}),
      };
      this.journal.update((s) => {
        for (const [id, entry] of Object.entries(s.commands))
          if (entry.expiresAt < Date.now() - 30 * 86400000)
            delete s.commands[id];
        s.commands[key] = { fingerprint, result, expiresAt: request.expiresAt };
      });
      this.pendingCommands.add(key);
      if (request.method === "send")
        this.pendingCommands.add("session:" + request.sessionId);
      try {
        if (request.method === "create") {
          const project = this.runtime
            .projects()
            .find((p) => p.id === request.projectId);
          if (!project) throw new Error("SCOPE_DENIED");
          const id = await this.runtime.start(
            project,
            request.provider,
            request.prompt,
            { settings: request.settings, worktree: request.worktree, attachments },
          );
          if (!id) throw new Error("START_FAILED");
          result.sessionId = id;
        } else if (request.method === "send") {
          if (
            !(await this.runtime.send(request.sessionId, request.prompt, {
              settings: request.settings,
              attachments,
            }))
          )
            throw new Error("SEND_FAILED");
        } else if (request.method === "stop")
          this.runtime.stop(request.sessionId);
        else if (request.method === "permission") {
          const permission = this.permissions.get(request.requestId);
          if (
            !permission ||
            permission.sessionId !== request.sessionId ||
            !this.runtime.hasPermission(
              permission.sessionId,
              permission.toolUseId,
            )
          )
            throw new Error("PERMISSION_EXPIRED");
          const resolution = this.resolution(permission, request.decision, request.answers);
          if (!this.runtime.permission(permission, request.decision, resolution))
            throw new Error("PERMISSION_EXPIRED");
          this.permissions.delete(request.requestId);
        }
        result.state = "completed";
      } catch {
        result.state = "unknown";
        result.error = "Check the result on your Mac before sending this again.";
      } finally {
        this.pendingCommands.delete(key);
        if (request.method === "send")
          this.pendingCommands.delete("session:" + request.sessionId);
      }
      this.journal.update((s) => {
        s.commands[key].result = result;
      });
      this.invalidate();
      return { type: "response", id: request.id, result };
    } catch (error) {
      return {
        type: "response",
        id: request.id,
        error: error instanceof Error ? error.message : "REQUEST_FAILED",
      };
    }
  }
  /** What a phone's decision resolves to; throws when the phone may not make it. */
  private resolution(
    permission: PermissionRequestPayload,
    decision: "allow" | "deny",
    answers?: Parameters<typeof resolvePrompt>[3],
  ): RemoteResolution | undefined {
    const prompt = remotePrompt(permission);
    if (!prompt) {
      if (answers) throw new Error("INVALID_ANSWER");
      if (decision === "allow" && !canApproveRemotely(permission)) throw new Error("DESKTOP_REQUIRED");
      return undefined;
    }
    // A plan approved from the phone must be one the phone could read in full.
    if (prompt.kind === "plan" && decision === "allow" && planOf(permission, this.plans.get(permission.sessionId)).length > PLAN_LIMIT)
      throw new Error("DESKTOP_REQUIRED");
    return resolvePrompt(permission, prompt, decision, answers);
  }
  private async receiveChunk(
    request: { uploadId: string; name: string; index: number; total: number; data: string },
    peer: string,
  ): Promise<RemoteAttachment | { received: number }> {
    if (!this.runtime.attach) throw new Error("UNSUPPORTED");
    const now = Date.now();
    for (const [key, upload] of this.uploads) if (now - upload.at > UPLOAD_TTL) this.uploads.delete(key);
    for (const [key, entry] of this.uploaded) if (now - entry.at > UPLOAD_TTL * 6) this.uploaded.delete(key);
    let upload = this.uploads.get(request.uploadId);
    if (!upload) {
      if (request.index !== 0) throw new Error("UPLOAD_EXPIRED");
      if ([...this.uploads.values()].filter((u) => u.peer === peer).length >= 4) throw new Error("TOO_MANY_UPLOADS");
      upload = { peer, name: request.name, total: request.total, parts: [], bytes: 0, at: now };
      this.uploads.set(request.uploadId, upload);
    }
    if (upload.peer !== peer || upload.total !== request.total || request.index !== upload.parts.length)
      throw new Error("UPLOAD_OUT_OF_ORDER");
    const part = Buffer.from(request.data, "base64");
    upload.bytes += part.length;
    if (upload.bytes > MAX_UPLOAD_BYTES) {
      this.uploads.delete(request.uploadId);
      throw new Error("ATTACHMENT_TOO_LARGE");
    }
    upload.parts.push(part);
    upload.at = now;
    if (upload.parts.length < upload.total) return { received: upload.parts.length };
    this.uploads.delete(request.uploadId);
    const attachment = await this.runtime.attach(upload.name, new Uint8Array(Buffer.concat(upload.parts)));
    const attachmentId = randomUUID();
    this.uploaded.set(attachmentId, { peer, attachment, at: now });
    return {
      attachmentId,
      name: attachment.name,
      size: attachment.size,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
    };
  }
  capture(event: ServerEvent) {
    const p = event.payload as any;
    const id = p.sessionId as string | undefined;
    let textDelta = false;
    // A steer joins the live turn: its run, live text and approvals carry on.
    // One that came too late opens its own turn after all.
    if (id && ((event.type === "stream.user_prompt" && !p.steer) || event.type === "stream.prompt_opened_turn")) {
      this.runIds.set(id, randomUUID());
      this.live.delete(id);
      for (const [key, value] of this.permissions)
        if (value.sessionId === id) this.permissions.delete(key);
      this.plans.delete(id);
    }
    if (event.type === "stream.message" && id) {
      const message = p.message;
      if (
        message.type === "stream_event" &&
        message.event?.delta?.type === "text_delta" &&
        typeof message.event.delta.text === "string"
      ) {
        textDelta = true;
        const live = this.live.get(id) ?? { id: ++this.liveIds, text: "", total: 0 };
        live.text = lastChars(live.text + message.event.delta.text, 64000);
        live.total += message.event.delta.text.length;
        this.live.set(id, live);
      } else if (message.type === "assistant" && !message.streaming)
        this.live.delete(id);
      if (message.type === "assistant" && !message.parentToolUseId && Array.isArray(message.message?.content))
        for (const block of getMessageContentBlocks(message as StreamMessage)) {
          const tool = normalizeToolUseBlock(block);
          if (tool?.name === "ExitPlanMode" && typeof tool.input.plan === "string") this.plans.set(id, tool.input.plan);
        }
    }
    if (event.type === "permission.request" && id) this.notify("approval", id);
    if (event.type === "session.status" && id) {
      if (["running", "stopping"].includes(p.status)) this.running.add(id);
      else if (this.running.delete(id)) this.notify(p.status === "error" ? "failed" : "finished", id);
    }
    if (event.type === "permission.request")
      this.permissions.set(
        this.hostBootId + ":" + p.sessionId + ":" + p.toolUseId,
        event.payload,
      );
    if (event.type === "permission.dismissed")
      this.permissions.delete(
        this.hostBootId + ":" + p.sessionId + ":" + p.toolUseId,
      );
    if (
      event.type === "session.status" &&
      id &&
      !["running", "stopping"].includes(p.status)
    ) {
      this.runIds.delete(id);
      this.live.delete(id);
      this.plans.delete(id);
    }
    if (
      event.type.startsWith("session.") ||
      event.type.startsWith("stream.") ||
      event.type.startsWith("permission.")
    ) {
      if (event.type === "stream.tool_output_delta") {
        // Live tool output is never stored and the phone doesn't show it.
        this.changed();
      } else if (textDelta && id) {
        this.liveDirty.add(id);
        this.changed();
        this.schedule();
      } else if (
        !(
          event.type === "stream.message" &&
          // Deltas and in-progress assistant messages are never stored; the history didn't change.
          (p.message?.type === "stream_event" || (p.message?.type === "assistant" && p.message?.streaming === true))
        )
      ) {
        // Anything else may have written the session's history or changed the list.
        if (id) {
          this.histories.delete(id);
          this.historyDirty.add(id);
          this.liveDirty.add(id);
        }
        this.invalidate();
      } else this.changed();
    }
  }
  /** Tells paired phones through APNs, only while none is connected to see it live. */
  private notify(kind: "approval" | "finished" | "failed", sessionId: string) {
    const config = this.journal.state.config;
    // A phone that is connected and on screen sees it live; one that is off screen still gets the push.
    // Pushes go out through the relay, so this Mac must be registered there.
    if (!config?.enabled || this.relayStatus !== "waiting") return;
    if ([...this.current.values()].some((link) => !link.away)) return;
    const session = this.runtime.sessions().find((s) => s.id === sessionId);
    if (!session) return;
    const key = kind + ":" + sessionId;
    const now = Date.now();
    if (now - (this.notified.get(key) ?? 0) < 60000) return;
    this.notified.set(key, now);
    for (const [k, at] of this.notified) if (now - at > 600000) this.notified.delete(k);
    for (const device of this.journal.state.devices) {
      const push = device.push;
      if (!push) continue;
      void this.deliver(config.relay, config.identity, device.peerId, { ...push, kind, sessionId, machineName: hostname().slice(0, 100) });
    }
  }
  private async deliver(
    relay: string,
    identity: string,
    peerId: string,
    fields: Parameters<typeof pushRequest>[1],
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Re-sign every attempt: the relay rejects reused nonces.
        const { body, signature } = pushRequest(identity, fields);
        const res = await fetch(relayHttpOrigin(relay) + "/v1/push", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Aegis-Signature": signature },
          body,
          signal: AbortSignal.timeout(15000),
        });
        const result = (await res.json().catch(() => ({}))) as { unregistered?: boolean };
        if (result.unregistered)
          this.journal.update((s) => {
            const device = s.devices.find((d) => d.peerId === peerId);
            if (device?.push?.deviceToken === fields.deviceToken) delete device.push;
          });
        // Only network trouble and relay/APNs hiccups are worth another try.
        if (res.status < 500 || res.status === 503) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 2000 * 4 ** attempt));
    }
  }
  /** The desktop changed the list without a session event (archiving, for one). */
  listChanged() {
    this.invalidate();
  }
  /** The session list or a history may have changed. */
  private invalidate() {
    this.stateDirty = true;
    this.changed();
    this.schedule();
  }
  /** Phones without events refetch the snapshot when told something changed. */
  private changed() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const link of this.current.values())
        if (!link.events)
          try {
            link.channel.send({ type: "changed" });
          } catch {}
    }, CHANGED_INTERVAL);
  }
  /** The first change after a quiet spell goes out at once; a stream then at most every EVENT_INTERVAL. */
  private schedule(delay?: number) {
    if (this.eventTimer) return;
    const wait = delay ?? Math.max(0, EVENT_INTERVAL - (Date.now() - this.lastFlush));
    this.eventTimer = setTimeout(() => this.flush(), wait);
  }
  /** Sends each event phone what changed since what it last got, in one event. */
  private flush() {
    this.eventTimer = undefined;
    this.lastFlush = Date.now();
    const stateDirty = this.stateDirty;
    const historyDirty = this.historyDirty;
    const liveDirty = this.liveDirty;
    this.stateDirty = false;
    this.historyDirty = new Set();
    this.liveDirty = new Set();
    const links = [...this.current.values()].filter((link) => link.events);
    if (!links.length) return;
    let state: { value: RemoteState; hash: string } | undefined;
    for (const link of links) {
      const event: Omit<RemoteEvent, "seq"> = { type: "event" };
      if (stateDirty) {
        if (!state) {
          const value = this.state();
          state = { value, hash: sha256(JSON.stringify(value)) };
        }
        if (state.hash !== link.state) {
          event.state = state.value;
          link.state = state.hash;
        }
      }
      const sessionId = link.subscribed;
      // Just read: wait a moment rather than read it again per commit. Its live text
      // waits too, so a reply never vanishes from the stream before it lands in the history.
      const wait = sessionId && historyDirty.has(sessionId) && !this.histories.has(sessionId)
        ? HISTORY_MIN_INTERVAL - (Date.now() - (this.historyReadAt.get(sessionId) ?? 0))
        : 0;
      if (sessionId && wait > 0) {
        this.historyDirty.add(sessionId);
        if (liveDirty.has(sessionId)) this.liveDirty.add(sessionId);
        this.schedule(wait);
      } else if (sessionId && historyDirty.has(sessionId) && !this.visible(sessionId, state?.value)) {
        // Archived, hidden or deleted since: stop sending it (the state part drops it).
        link.subscribed = undefined;
        link.history = undefined;
        link.live = undefined;
      } else if (sessionId && historyDirty.has(sessionId)) {
        const history = this.historyOf(sessionId);
        const head = this.headOf(history);
        const sent = link.history;
        if (!sent || sent.sessionId !== sessionId || sent.hash !== head.hash) {
          const appended = sent?.sessionId === sessionId && this.extends(history, sent) ? this.after(history, sent.count) : undefined;
          if (appended && sent)
            event.history = { sessionId, messages: appended, appendFrom: sent.count, count: head.count, revision: head.hash };
          else {
            const page = this.page(history, undefined, Infinity);
            event.history = { sessionId, messages: page.messages, before: page.before, count: head.count, revision: head.hash };
          }
          link.history = { sessionId, count: head.count, hash: head.hash };
        }
      }
      if (link.subscribed && sessionId && wait <= 0 && liveDirty.has(sessionId)) {
        const live = this.live.get(sessionId);
        const sent = link.live?.sessionId === sessionId ? link.live : undefined;
        if (!live) {
          if (sent) event.live = { sessionId, text: null };
          link.live = undefined;
        } else if (!sent || sent.id !== live.id || live.total - sent.total > live.text.length) {
          event.live = { sessionId, text: live.text };
          link.live = { sessionId, id: live.id, total: live.total };
        } else if (live.total > sent.total) {
          event.live = { sessionId, append: live.text.slice(live.text.length - (live.total - sent.total)) };
          link.live = { sessionId, id: live.id, total: live.total };
        }
      }
      if (!event.state && !event.history && !event.live) continue;
      try {
        link.channel.send({ ...event, seq: ++link.seq });
      } catch {
        // A phone too far behind: its baselines no longer match what it has, so start over.
        link.channel.close();
      }
    }
  }
  private visible(sessionId: string, state?: RemoteState) {
    return (state?.sessions ?? this.runtime.sessions()).some((s) => s.id === sessionId);
  }
}
