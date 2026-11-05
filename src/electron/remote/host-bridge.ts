// Shows sessions from other Macs in this app's existing chat UI: their messages and
// approvals become ordinary ServerEvents under a namespaced session id, and the
// ClientEvents that act on those ids go back as commands to the Mac that owns them.
import { createHash, randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { machineName } from "./relay-auth";
import { ATTACHMENT_CHUNK_BYTES, environmentLabel, parsePairing, type Pairing, type RemoteEnvironment, type RemoteLan, type RemoteMessage, type RemoteAgentOptions, type RemotePermission, type RemoteTaskSettings, type RemoteSession, type RemoteState } from "../../shared/remote/protocol";
import type { Attachment, ClientEvent, PermissionResult, ServerEvent, SessionInfo, SessionStartPayload, StreamMessage } from "../../shared/types";
import { parseRemoteProjectPath, remoteProjectPath } from "../../shared/remote/remote-path";
import { agentCatalog } from "../../shared/remote/agent-catalog";
import { RemoteHostClient, type HostClientOptions, type HostStatus } from "./host-client";

const REMOTE_ID = /^rh-([a-f0-9]{12})-(.+)$/;
export const isRemoteSessionId = (id: unknown): id is string => typeof id === "string" && REMOTE_ID.test(id);
const hostKeyOf = (pairing: Pairing) => createHash("sha256").update(pairing.hostPeerId).digest("hex").slice(0, 12);

export interface SavedHosts {
  identity?: string;
  /** This Mac's device id, shown so the other Mac's prompt can be checked against it. */
  peerId?: string;
  hosts: Array<Pairing & { lan?: RemoteLan }>;
}
export interface HostBridgeOptions {
  load(): SavedHosts;
  save(saved: SavedHosts): void;
  createIdentity(): Promise<{ privateKey: string; peerId: string }>;
  environment: RemoteEnvironment;
  emit(event: ServerEvent): void;
  /** The merged session list changed; the app re-sends it. */
  listChanged(): void;
  crypto?: HostClientOptions["crypto"];
  name?: string;
}
export interface HostView {
  id: string;
  name: string;
  status: HostStatus;
  transport?: "relay" | "direct";
  projects: Array<{ path: string; name: string; isRepo?: boolean }>;
}
interface Host {
  key: string;
  name: string;
  pairing: Pairing;
  client: RemoteHostClient;
  statuses: Map<string, RemoteSession["status"]>;
  /** Approvals already shown here, by the id the UI answers with. */
  shown: Map<string, RemotePermission>;
  cursors: Map<string, number>;
  /** Prompts sent into a running turn that the agent hasn't read yet, per session. */
  steers: Map<string, Array<{ promptId: string; prompt: string; effective: string }>>;
  /** When the connection last dropped. Short gaps don't count as offline. */
  downSince?: number;
}
const OFFLINE_AFTER = 30000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const PLAN_APPROVE = "Approve and execute";

function toMessage(message: RemoteMessage): StreamMessage {
  if (message.raw) return message.raw as StreamMessage;
  return message.role === "user"
    ? { type: "user_prompt", prompt: message.text, createdAt: message.at ?? Date.now() }
    : ({ type: "assistant", uuid: message.id, createdAt: message.at, message: { role: "assistant", content: [{ type: "text", text: message.text }] } } as unknown as StreamMessage);
}

/** Drops unset fields: the host's schema is strict, and undefined still counts as set before JSON. */
function cleanSettings(settings: RemoteTaskSettings): RemoteTaskSettings {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined && value !== null && value !== "")) as RemoteTaskSettings;
}

/** The card's result, as the fields the host's permission command takes. */
export function permissionAnswer(permission: RemotePermission, result: PermissionResult) {
  const selections = Object.values(result.questionAnswers ?? {});
  // A plan's card answers with one of its options; only "approve" goes ahead.
  if (permission.plan) {
    const approved = result.behavior === "allow" && selections.some((answer) => answer.selected.includes(PLAN_APPROVE));
    return { decision: approved ? ("allow" as const) : ("deny" as const) };
  }
  if (permission.questions && result.behavior === "allow")
    return { decision: "allow" as const, answers: result.questionAnswers ?? {} };
  return {
    decision: result.behavior,
    ...(result.behavior === "allow" && result.scope === "session" ? { scope: "session" as const } : {}),
  };
}

export class RemoteHostBridge {
  private hosts = new Map<string, Host>();
  private saved: SavedHosts;
  constructor(private options: HostBridgeOptions) {
    this.saved = options.load();
  }
  start() {
    for (const pairing of this.saved.hosts) this.attach({ ...pairing, invite: undefined, expiresAt: undefined });
  }
  close() {
    for (const host of this.hosts.values()) host.client.close();
  }
  list(): HostView[] {
    return [...this.hosts.values()].map((host) => this.view(host));
  }
  private view(host: Host): HostView {
    return {
      id: host.key,
      name: host.name,
      status: host.client.status,
      transport: host.client.transport,
      projects: (host.client.state?.projects ?? []).map((project) => ({
        path: remoteProjectPath(host.key, project.id, project.name),
        name: project.name,
        isRepo: project.isRepo,
      })),
    };
  }
  /** The agents that Mac has set up, for starting a task there. */
  async agents(key: string) {
    const host = this.hosts.get(key);
    if (!host) throw new Error("This device is no longer connected.");
    return agentCatalog((await host.client.request({ method: "options" })) as RemoteAgentOptions);
  }
  async add(link: string): Promise<HostView & { deviceId: string }> {
    let pairing: Pairing;
    try {
      pairing = parsePairing(link);
    } catch (error) {
      if (error instanceof Error && error.message.includes("expired")) throw error;
      throw new Error("That isn’t a pairing link.");
    }
    if (!pairing.invite) throw new Error("This pairing link has expired. Create a new one.");
    if (pairing.environment !== this.options.environment)
      throw new Error(`This link is from ${environmentLabel(pairing.environment)}. Create one in ${environmentLabel(this.options.environment)}.`);
    if (!this.saved.identity) {
      const { privateKey, peerId } = await this.options.createIdentity();
      this.saved = { ...this.saved, identity: privateKey, peerId };
      this.options.save(this.saved);
    }
    const key = hostKeyOf(pairing);
    this.hosts.get(key)?.client.close();
    const host = this.attach(pairing);
    const { invite: _invite, expiresAt: _expiresAt, ...kept } = pairing;
    this.saved = { ...this.saved, hosts: [...this.saved.hosts.filter((h) => hostKeyOf(h) !== key), kept] };
    this.options.save(this.saved);
    return { ...this.view(host), deviceId: this.saved.peerId ?? "" };
  }
  remove(key: string) {
    const host = this.hosts.get(key);
    if (!host) return;
    host.client.close();
    this.hosts.delete(key);
    this.saved = { ...this.saved, hosts: this.saved.hosts.filter((h) => hostKeyOf(h) !== key) };
    this.options.save(this.saved);
    this.options.listChanged();
  }
  private attach({ lan, ...pairing }: Pairing & { lan?: RemoteLan }): Host {
    const key = hostKeyOf(pairing);
    const host: Host = {
      key,
      name: pairing.name,
      pairing,
      statuses: new Map(),
      shown: new Map(),
      steers: new Map(),
      cursors: new Map(),
      client: new RemoteHostClient({
        pairing,
        identity: this.saved.identity!,
        name: this.options.name ?? machineName(),
        crypto: this.options.crypto,
        lan,
        events: {
          status: (status) => {
            if (status === "connected") host.downSince = undefined;
            else if (host.downSince === undefined) {
              host.downSince = Date.now();
              setTimeout(() => this.options.listChanged(), OFFLINE_AFTER + 50);
            }
            this.options.listChanged();
          },
          lan: (next) => {
            this.saved = { ...this.saved, hosts: this.saved.hosts.map((h) => (hostKeyOf(h) === key ? { ...h, lan: next } : h)) };
            this.options.save(this.saved);
          },
          state: (state, machineName) => this.onState(host, state, machineName),
          history: (sessionId, messages, change) => this.onHistory(host, sessionId, messages, change),
          live: (sessionId, change) => this.onLive(host, sessionId, change),
        },
      }),
    };
    this.hosts.set(key, host);
    host.client.connect();
    return host;
  }
  private localId = (host: Host, sessionId: string) => `rh-${host.key}-${sessionId}`;
  private resolve(id: string) {
    const match = REMOTE_ID.exec(id);
    const host = match ? this.hosts.get(match[1]) : undefined;
    return host && match ? { host, sessionId: match[2] } : undefined;
  }
  /** What the sidebar lists from other Macs. Paths are placeholders: files stay on that Mac. */
  sessions(): SessionInfo[] {
    const result: SessionInfo[] = [];
    for (const host of this.hosts.values()) {
      const state = host.client.state;
      if (!state) continue;
      for (const session of state.sessions) {
        const project = state.projects.find((p) => p.id === session.projectId);
        const cwd = remoteProjectPath(host.key, session.projectId, project?.name ?? "project");
        result.push({
          id: this.localId(host, session.id),
          title: session.title,
          status: session.status as SessionInfo["status"],
          provider: session.provider as SessionInfo["provider"],
          model: session.settings?.model,
          cwd,
          projectCwd: cwd,
          scope: "project",
          pinned: session.pinned,
          device: {
            id: host.key,
            name: host.name,
            online: host.client.status === "connected",
            ...(this.reconnecting(host) ? { reconnecting: true } : {}),
          },
          ...this.settingsOf(session),
          remoteSettings: session.settings,
          createdAt: session.updatedAt,
          updatedAt: session.updatedAt,
        });
      }
    }
    return result;
  }
  private reconnecting(host: Host) {
    const { status } = host.client;
    if (status === "connected" || status === "revoked" || status === "rejected") return false;
    return host.downSince === undefined || Date.now() - host.downSince < OFFLINE_AFTER;
  }
  /** What that Mac has set for the session, so this one shows the same. */
  private settingsOf(session: RemoteSession): Partial<SessionInfo> {
    const { effort, permissionMode, fast, plan } = session.settings ?? {};
    if (session.provider === "claude")
      return {
        claudeReasoningEffort: effort as SessionInfo["claudeReasoningEffort"],
        claudeAccessMode: permissionMode as SessionInfo["claudeAccessMode"],
        ...(plan ? { claudeExecutionMode: "plan" as SessionInfo["claudeExecutionMode"] } : {}),
      };
    if (session.provider === "codex")
      return {
        codexReasoningEffort: effort as SessionInfo["codexReasoningEffort"],
        codexPermissionMode: permissionMode as SessionInfo["codexPermissionMode"],
        codexFastMode: fast,
        ...(plan ? { codexExecutionMode: "plan" as SessionInfo["codexExecutionMode"] } : {}),
      };
    return {};
  }
  retry(key: string) {
    this.hosts.get(key)?.client.connect();
    this.options.listChanged();
  }
  private onState(host: Host, state: RemoteState, machineName?: string) {
    if (machineName) host.name = machineName;
    this.options.listChanged();
    for (const session of state.sessions) {
      const before = host.statuses.get(session.id);
      host.statuses.set(session.id, session.status);
      if (before && before !== session.status)
        this.options.emit({ type: "session.status", payload: { sessionId: this.localId(host, session.id), status: session.status as SessionInfo["status"] } });
    }
    // Approvals: show the new ones, drop the ones answered or abandoned over there.
    const current = new Map(state.permissions.map((p) => [p.requestId, p]));
    for (const [requestId, permission] of host.shown) {
      if (current.has(requestId)) continue;
      host.shown.delete(requestId);
      this.options.emit({ type: "permission.dismissed", payload: { sessionId: this.localId(host, permission.sessionId), toolUseId: requestId } });
    }
    for (const [requestId, permission] of current) {
      if (host.shown.has(requestId)) continue;
      host.shown.set(requestId, permission);
      this.options.emit({
        type: "permission.request",
        payload: {
          sessionId: this.localId(host, permission.sessionId),
          toolUseId: requestId,
          toolName: permission.toolName,
          // Too large to send whole: the questions, or the command text, still draw the card.
          input: (permission.input ?? (permission.questions ? { questions: permission.questions } : { command: permission.detail })) as never,
        },
      });
    }
  }
  private onHistory(host: Host, sessionId: string, messages: RemoteMessage[], change: { replace: boolean; before?: number | null }) {
    const id = this.localId(host, sessionId);
    if (change.replace) {
      if (change.before != null) host.cursors.set(sessionId, change.before);
      else host.cursors.delete(sessionId);
      const session = host.client.state?.sessions.find((s) => s.id === sessionId);
      this.options.emit({
        type: "session.history",
        payload: {
          sessionId: id,
          status: (session?.status ?? "idle") as SessionInfo["status"],
          messages: messages.map(toMessage),
          cursor: change.before != null ? String(change.before) : null,
          hasMore: change.before != null,
        },
      });
      return;
    }
    for (const message of messages) {
      const raw = toMessage(message);
      if (raw.type === "user_prompt") {
        // A prompt sent into the running turn, now read by the agent: it takes its place from where it waited.
        const waiting = host.steers.get(sessionId);
        const index = waiting?.findIndex((entry) => entry.effective === raw.prompt || entry.prompt === raw.prompt) ?? -1;
        if (waiting && index >= 0) {
          const [{ promptId }] = waiting.splice(index, 1);
          this.options.emit({ type: "stream.prompt_started", payload: { sessionId: id, promptId, steer: raw.steer === true, startedAt: raw.createdAt ?? Date.now() } });
        } else
          this.options.emit({ type: "stream.user_prompt", payload: { sessionId: id, prompt: raw.prompt, attachments: raw.attachments, createdAt: raw.createdAt, ...(raw.steer ? { steer: true } : {}) } });
      } else this.options.emit({ type: "stream.message", payload: { sessionId: id, message: raw } });
    }
  }
  private onLive(host: Host, sessionId: string, change: { append?: string; text?: string | null }) {
    const id = this.localId(host, sessionId);
    const delta = (text: string) =>
      this.options.emit({
        type: "stream.message",
        payload: { sessionId: id, message: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } } as never },
      });
    if (change.append !== undefined) return delta(change.append);
    // A replacement restarts the streaming buffer before writing the whole text.
    this.options.emit({
      type: "stream.message",
      payload: { sessionId: id, message: { type: "stream_event", event: { type: "content_block_stop" } } as never },
    });
    if (change.text) delta(change.text);
  }
  async older(id: string, cursor: string) {
    const target = this.resolve(id);
    if (!target) throw new Error("Unknown session");
    const page = await target.host.client.older(target.sessionId, Number(cursor));
    return { messages: page.messages.map(toMessage), cursor: page.before != null ? String(page.before) : null, hasMore: page.before != null };
  }
  /** Sends files to that Mac in chunks; a message can then refer to them by id. */
  private async upload(host: Host, attachments: Attachment[] | undefined): Promise<string[]> {
    const ids: string[] = [];
    for (const attachment of attachments ?? []) {
      const data = await readFile(attachment.path);
      if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("ATTACHMENT_TOO_LARGE");
      const uploadId = randomUUID();
      const total = Math.max(1, Math.ceil(data.byteLength / ATTACHMENT_CHUNK_BYTES));
      for (let index = 0; index < total; index++) {
        const part = data.subarray(index * ATTACHMENT_CHUNK_BYTES, (index + 1) * ATTACHMENT_CHUNK_BYTES);
        const result = (await host.client.request({
          method: "attachment.chunk",
          uploadId,
          name: attachment.name,
          index,
          total,
          data: part.toString("base64"),
        })) as { attachmentId?: string };
        if (index === total - 1) {
          if (!result.attachmentId) throw new Error("UPLOAD_EXPIRED");
          ids.push(result.attachmentId);
        }
      }
    }
    return ids;
  }
  /** A composer start for a project on another Mac. True when it was one. */
  private startTask(payload: SessionStartPayload): boolean {
    const target = parseRemoteProjectPath(payload.cwd);
    if (!target) return false;
    const fail = (message: string) =>
      this.options.emit({ type: "runner.error", payload: { message, startId: payload.startId } });
    const host = this.hosts.get(target.hostId);
    if (!host) {
      fail("This device is no longer connected.");
      return true;
    }
    // Starting is deliberate; don't leave the composer waiting on a Mac that isn't there.
    if (host.client.status !== "connected") {
      fail(`Can’t reach ${host.name}. Your message is still in the composer.`);
      return true;
    }
    void this.upload(host, payload.attachments)
      .then((attachmentIds) =>
        host.client.command("create", {
          projectId: target.projectId,
          provider: payload.provider,
          prompt: payload.effectivePrompt ?? payload.prompt,
          worktree: payload.createIsolatedWorkspace || undefined,
          ...(payload.remoteSettings ? { settings: cleanSettings(payload.remoteSettings) } : {}),
          ...(attachmentIds.length ? { attachmentIds } : {}),
        }),
      )
      .then(async (result) => {
        if (result.state !== "completed" || !result.sessionId) {
          const code = result.error;
          return fail(
            code === "INVALID_REQUEST"
              ? `${host.name} can’t run this agent for remote tasks.`
              : code === "START_FAILED"
                ? `${host.name} couldn’t start this task.`
                : code || `${host.name} didn’t confirm the task. Check there before trying again.`,
          );
        }
        const id = this.localId(host, result.sessionId);
        this.options.emit({
          type: "session.status",
          payload: {
            sessionId: id,
            status: "running",
            startId: payload.startId,
            draftSessionId: payload.draftSessionId,
            title: payload.title,
            cwd: payload.cwd,
            projectCwd: payload.cwd,
            provider: payload.provider,
            device: { id: host.key, name: host.name, online: host.client.status === "connected" },
          },
        });
        await host.client.subscribe(result.sessionId);
      })
      .catch((error: Error) => fail(`Couldn’t send that to ${host.name}: ${error.message}`));
    return true;
  }
  /** True when the event was about a session on another Mac. */
  handleClientEvent(event: ClientEvent): boolean {
    if (event.type === "session.start") return this.startTask(event.payload);
    const payload = (event as { payload?: { sessionId?: unknown } }).payload;
    if (!isRemoteSessionId(payload?.sessionId)) return false;
    const target = this.resolve(payload.sessionId);
    const fail = (message: string) =>
      this.options.emit({ type: "runner.error", payload: { message, sessionId: payload.sessionId as string } });
    if (!target) {
      fail("This device is no longer connected.");
      return true;
    }
    const { host, sessionId } = target;
    const explain = (code?: string) => {
      switch (code) {
        case "DESKTOP_REQUIRED": return `This has to be done on ${host.name}.`;
        case "SESSION_BUSY": return `${host.name} is still working. Send this when it finishes.`;
        case "ATTACHMENT_TOO_LARGE": return `That attachment is too large to send to ${host.name}.`;
        case "ATTACHMENT_EXPIRED":
        case "UPLOAD_EXPIRED":
        case "UPLOAD_OUT_OF_ORDER": return `The attachment didn’t reach ${host.name}. Try again.`;
        case "PERMISSION_EXPIRED": return "This request is no longer waiting.";
        case "INVALID_ANSWER": return "That answer doesn’t fit this question. Check it and try again.";
        case "STALE_RUN": return "That turn has already ended.";
        case "SCOPE_DENIED": return `This session is no longer on ${host.name}.`;
        case "INVALID_REQUEST": return `${host.name} needs a newer version of Aegis for this.`;
        default: return code || `${host.name} didn’t accept that.`;
      }
    };
    const report = (result: { state: string; error?: string }) => {
      if (result.state === "rejected" || result.state === "unknown") fail(explain(result.error));
    };
    if (event.type === "session.history") void host.client.subscribe(sessionId);
    else if (event.type === "session.continue") {
      const session = host.client.state?.sessions.find((s) => s.id === sessionId);
      const running = session?.status === "running";
      const prompt = event.payload.effectivePrompt ?? event.payload.prompt;
      // Into a running turn the host echoes the prompt when the agent reads it, so it waits here until then.
      if (running) {
        const promptId = randomUUID();
        const waiting = host.steers.get(sessionId) ?? [];
        waiting.push({ promptId, prompt: event.payload.prompt, effective: prompt });
        host.steers.set(sessionId, waiting);
        this.options.emit({ type: "stream.user_prompt", payload: { sessionId: payload.sessionId, prompt: event.payload.prompt, promptId, deferred: true, createdAt: Date.now() } });
      }
      void this.upload(host, event.payload.attachments)
        .then((attachmentIds) =>
          host.client.command("send", {
            sessionId,
            prompt,
            // Always said in full: the host reads a missing mode as its default, not as "keep".
            settings: cleanSettings(event.payload.remoteSettings ?? session?.settings ?? {}),
            ...(attachmentIds.length ? { attachmentIds } : {}),
            ...(running ? { steer: true } : {}),
          }),
        )
        .then(report, (error: Error) => fail(explain(error.message)));
    }
    else if (event.type === "session.stop") {
      const runId = host.client.state?.sessions.find((s) => s.id === sessionId)?.runId;
      if (runId) void host.client.command("stop", { sessionId, runId }).then(report);
    } else if (event.type === "permission.response") {
      const permission = host.shown.get(event.payload.toolUseId);
      if (!permission) fail("This request is no longer waiting.");
      else
        void host.client
          .command("permission", {
            sessionId,
            runId: permission.runId,
            requestId: permission.requestId,
            ...permissionAnswer(permission, event.payload.result),
          })
          .then((result) => {
            report(result);
            // The card closed when it was answered. If that didn't land, bring it back.
            if (result.state !== "rejected" || !host.shown.delete(permission.requestId)) return;
            if (host.client.state) this.onState(host, host.client.state);
          });
    } else if (event.type !== "runner.prewarm") fail(`This isn’t available for sessions on ${host.name} yet.`);
    return true;
  }
}
