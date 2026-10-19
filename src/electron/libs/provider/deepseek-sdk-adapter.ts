import { CompactionTracker } from './compaction-tracker';
import { buildDeepseekPromptBlocks, deepseekImageBlocks, deepseekToolImages, resolveDeepseekAttachmentHome } from './deepseek-images';
import { deepseekImageInputError } from '../../../shared/deepseek-images';
import { getSessionReaderHttpConfig, SESSION_MCP_SERVER_NAME } from '../session-http-server';
import { getSessionProjectSources } from '../session-store';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import {
  buildDeepseekEnv,
  formatDeepseekProfileMissingMessage,
  getDeepseekModelConfig,
  resolveDeepseekProfileDir,
  resolveDeepseekRuntimeEntry,
  resolveDeepseekSessionRoot,
} from '../deepseek-cli';
import { listDeepseekSkills } from '../deepseek-skills';
import { DEEPSEEK_COST_ACCOUNTING, estimateDeepseekUsageCost } from '../deepseek-pricing';
import {
  createDeepseekMcpRuntimeConfig,
  getDeepseekMcpServers,
} from '../deepseek-mcp-settings';
import {
  BROWSER_USE_TOKEN_ENV_VAR,
  createBrowserUseSessionMcpDescriptor,
} from '../browser-use-http-server';
import { BROWSER_USE_SERVER_NAME, finishBrowserUseTurn } from '../browser-use';
import { isBrowserUseEnabled } from '../browser-use-permissions';
import { setBrowserUseSessionFullAccess } from '../browser-use-consent';
import { browserManager } from '../../browserManager';
import { normalizeDeepseekAgentPreset } from '../../../shared/deepseek-agent-preset';
import {
  createDeepseekSubagentRuntime,
  isDeepseekSubagentToolName,
  namespaceDeepseekToolId,
  registerDeepseekChildHint,
  registerDeepseekSpawn,
  registerDeepseekStarted,
  spawnFromToolInput,
  type DeepseekSubagentRuntime,
} from './deepseek-subagent-trace';
import {
  loadDeepseekSdk,
  type DshContentBlock,
  type DshHarness,
  type DshHarnessNotification,
  type DshHarnessSession,
  type DshNotificationSubscription,
  type DshSessionEvent,
} from './deepseek-sdk-loader';
import type {
  ProviderAdapter,
  ProviderAdapterCapabilities,
  ProviderKind,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderSessionStatus,
} from './types';
import type {
  DeepseekAgentPreset,
  DeepseekPermissionMode,
  DeepseekReasoningEffort,
  PermissionResult,
  ProviderComposerCapabilities,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  StreamMessage,
} from '../../../shared/types';
import { WidgetDraftTracker } from '../widget-draft';

/**
 * DeepSeek Harness SDK adapter.
 *
 * Drives a per-thread DSH runtime from the bundled, installed, or source profile
 * through @deepseek-ai/dsh-sdk-client. Unlike the trimmed ACP surface, the
 * SDK wire streams the FULL durable session log — tool calls and results,
 * per-request usage and context window — which this adapter maps onto the same
 * stream shapes the Grok adapter emits. Durable events carry no live deltas,
 * so the profile's runtime-stream-shim forwards text/reasoning deltas as
 * `aegis.assistant.stream` notifications on the same subscription.
 *
 * Contract notes (pre-release wire, pinned 0.2.0-rc.2):
 * - No mid-turn cancel on the wire: stop = close the runtime (EOF → SIGTERM →
 *   SIGKILL ladder inside the SDK client). The JSON-RPC server still omits its
 *   core agents.resume() path, so the Aegis runtime bin installs a narrow
 *   create-or-resume shim before boot. Same-cwd restarts restore the complete
 *   persisted DSH log; missing or wrong-cwd logs fail loudly instead of
 *   silently creating a context-disconnected replacement.
 * - No approval channel: sandbox escalations fail closed (profile pins
 *   approval policy `never`); no permission_request events are ever emitted.
 * - Model, sandbox mode and reasoning effort are fixed per spawned runtime
 *   (initialize + env); a switch respawns via the ipc config-drift path.
 * - Child-session traces nest under the spawning `subagent` tool_use via
 *   parentToolUseId. Pairing is fail-closed (unique spawn only) because the
 *   SDK started payload has no parentToolCallId. Background delegation is
 *   disabled in the profile for this mapping.
 */

/** Live text/reasoning deltas; see dev-fixtures/deepseek-harness/runtime-stream-shim.mjs. */
const DEEPSEEK_ASSISTANT_STREAM_METHOD = 'aegis.assistant.stream';

interface TurnState {
  /** Block-index counter for the renderer's delta coalescer. */
  nextBlockIndex: number;
  currentThinking?: { blockIndex: number };
  currentText?: { blockIndex: number };
  usage: { input: number; output: number; cacheRead: number; reasoning: number };
  /** The SDK emits the same sample as a usage chunk and committed message. */
  usageByStep: Map<string, { input: number; output: number; cacheRead: number; reasoning: number; atMs: number }>;
  latestUsageKey?: string;
  endReason?: { kind: string; message?: string };
  startedAt: number;
  /**
   * Steers ride the inbox, and the runtime may accept one only after the
   * primary run() went idle; it then starts activity no run() owns. The turn
   * stays open until every steer is accepted and the session went idle after
   * its inbox receipt.
   */
  steers: {
    /** client.prompt calls the runtime has not answered yet. */
    submitting: number;
    /** Accepted steer message ids still owed an idle after their receipt. */
    owed: Set<string>;
    /** Root inbox message ids seen this turn; true once an idle followed. */
    received: Map<string, boolean>;
  };
  /** Set once the primary run() settled; the turn may end from then on. */
  runSettled?: boolean;
  /** The turn's activity is over: new sends must start their own turn. */
  closing?: boolean;
  /** Wakes runTurn once the late steer activity settles (or the runtime fails). */
  onSettled?: { resolve: () => void; reject: (error: unknown) => void };
}

interface ActiveDeepseekSession {
  threadId: string;
  providerSessionId: string;
  status: ProviderSessionStatus;
  cwd: string;
  model?: string;
  permissionMode: DeepseekPermissionMode;
  agentPreset: DeepseekAgentPreset;
  reasoningEffort: DeepseekReasoningEffort;
  harness: DshHarness;
  session: DshHarnessSession;
  /**
   * Persistent session-tree subscription — the ONE event source for this
   * thread. Events must not ride the per-run onNotification observer: a
   * steer enqueued at the idle boundary can start a turn AFTER the primary
   * run settled, and only a run-independent subscription still sees it.
   */
  subscription: DshNotificationSubscription;
  disposeRuntimeConfig: () => void;
  contextWindow?: number;
  turn?: TurnState;
  /** show_widget calls drawn while their arguments stream (top level only). */
  widgetDrafts?: WidgetDraftTracker;
  /** Child-session → spawning tool_use attribution for nested traces. */
  subagent: DeepseekSubagentRuntime;
  /** Child session.event frames held until a unique parent tool_use exists. */
  subagentBuffers: Map<string, DshHarnessNotification[]>;
  /** Same-step tool_use blocks coalesced onto one assistant uuid. */
  toolBatches: Map<
    string,
    {
      uuid: string;
      blocks: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>;
      createdAt: number;
      parentToolUseId: string | null;
    }
  >;
  /**
   * True while a turn owns the activity — from runTurn until its result,
   * including steer activity after run() settled — so sends steer instead.
   */
  turnInFlight?: boolean;
  /** Settles when the current turn emitted its result; sends wait on it. */
  turnEnded?: Promise<void>;
  /** Set when the subscription failed (runtime death) while the thread was open. */
  subscriptionError?: unknown;
  /**
   * Settles once the primary run's prompt is in the runtime inbox (its
   * inbox splice) or the run settled. Steers wait on it so none can overtake
   * a primary prompt that is still preparing images or not yet submitted.
   */
  primaryAdmission?: Promise<void>;
  admitPrimary?: () => void;
  /**
   * Tail of the submission queue every send joins in call order, so sends
   * reach the runtime in the order the user made them.
   */
  sendQueue?: Promise<void>;
  /** Set by stopSession/disposeSession so a rejected in-flight run stays silent. */
  closed?: boolean;
  attachmentHome?: string;
  pendingImageResults?: Set<Promise<void>>;
}

const CAPABILITIES: ProviderAdapterCapabilities = {
  sessionModelSwitch: false,
  skillDiscovery: true,
  pluginDiscovery: false,
  mcpServers: true,
  imageAttachments: true,
  forkThread: false,
  compactThread: false,
  planMode: false,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return isObject(value) ? value : null;
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeDeepseekPermissionMode(value: unknown): DeepseekPermissionMode {
  return value === 'danger-full-access' ? 'danger-full-access' : 'workspace-write';
}

function normalizeDeepseekReasoningEffort(value: unknown): DeepseekReasoningEffort {
  return value === 'off' || value === 'low' || value === 'high' || value === 'max' ? value : 'max';
}


/** An inbox splice that inserted messages — the SDK's own prompt receipt. */
function isInboxInsertion(value: unknown): boolean {
  const event = getRecord(value);
  if (event?.type !== 'agent/inbox/spliced') return false;
  return getArray(getRecord(event.data)?.inserted).length > 0;
}

function extractUserMessageText(data: Record<string, unknown>): string {
  const message = getRecord(data.message) || data;
  const parts: string[] = [];
  for (const block of getArray(message.content)) {
    const record = getRecord(block);
    if (record && typeof record.text === 'string' && record.text.trim()) {
      parts.push(record.text.trim());
    }
  }
  return parts.join('\n');
}

function parseToolCallInput(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments || '{}') as unknown;
    return getRecord(parsed) || {};
  } catch {
    return { arguments: rawArguments };
  }
}

function extractToolResultText(content: unknown): string {
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    for (const item of getArray(value)) {
      const record = getRecord(item);
      if (!record) continue;
      if (typeof record.text === 'string') {
        parts.push(record.text);
      } else if (record.content !== undefined) {
        walk(record.content);
      }
    }
  };
  walk(content);
  return parts.join('\n');
}

export class DeepseekSdkAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'deepseek';
  readonly displayName = 'DeepSeek Harness';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  private readonly compactions = new CompactionTracker(event => this.emit(event));

  private sessions = new Map<string, ActiveDeepseekSession>();

  getComposerCapabilities(): ProviderComposerCapabilities {
    return {
      provider: 'deepseek',
      supportsSkillMentions: false,
      supportsSkillDiscovery: true,
      supportsNativeSlashCommandDiscovery: true,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: false,
    };
  }

  async listSkills(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult> {
    return {
      skills: listDeepseekSkills(input.cwd),
      source: 'deepseek-harness',
      cached: false,
    };
  }

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const modelConfig = getDeepseekModelConfig();
    const permissionMode = normalizeDeepseekPermissionMode(input.deepseekPermissionMode);
    const agentPreset = normalizeDeepseekAgentPreset(input.deepseekAgentPreset);
    const reasoningEffort = modelConfig.availableModels?.[0]?.reasoningEfforts.length === 1
      ? 'off' : normalizeDeepseekReasoningEffort(input.deepseekReasoningEffort);
    const model = input.model?.trim() || modelConfig.defaultModel || undefined;
    const imageError = deepseekImageInputError(input.attachments, model, modelConfig);
    if (imageError) throw new Error(imageError);
    setBrowserUseSessionFullAccess(input.threadId, permissionMode === 'danger-full-access');
    let launched: Awaited<ReturnType<DeepseekSdkAdapter['spawnHarness']>>;
    try {
      launched = await this.spawnHarness(
        input.threadId,
        input.cwd,
        model,
        permissionMode,
        agentPreset,
        reasoningEffort,
        input.resumeSessionId
      );
    } catch (error) {
      setBrowserUseSessionFullAccess(input.threadId, false);
      throw error;
    }
    const { harness, disposeRuntimeConfig } = launched;

    // session(id) is only a client-side handle; the Aegis runtime shim decides
    // on the first prompt whether that durable identity must be resumed or a
    // new identity created. Without a stored id the SDK mints a fresh session.
    const session = harness.session(input.resumeSessionId);
    const subscription = harness.client.subscribeSessionTree(session.id);

    const active: ActiveDeepseekSession = {
      threadId: input.threadId,
      providerSessionId: session.id,
      attachmentHome: resolveDeepseekAttachmentHome(),
      status: 'running',
      cwd: input.cwd,
      model,
      // Native resume retains request/context and only emits it if it changes.
      // Seed from the effective profile so a new adapter can publish fresh
      // usage immediately; any runtime context event still takes precedence.
      contextWindow: modelConfig.availableModels?.find((entry) => entry.id === model)?.contextWindow,
      permissionMode,
      agentPreset,
      reasoningEffort,
      harness,
      session,
      subscription,
      disposeRuntimeConfig,
      subagent: createDeepseekSubagentRuntime(),
      subagentBuffers: new Map(),
      toolBatches: new Map(),
    };
    // Never orphan a previous session for the same thread — an undisposed
    // predecessor would leak its runtime subprocess.
    this.disposeSession(input.threadId);
    this.sessions.set(input.threadId, active);
    this.pumpSubscription(active);

    this.emit({
      type: 'system_init',
      threadId: input.threadId,
      sessionId: session.id,
      model,
    });

    // Start the first turn without awaiting it: agent-loop chains every later
    // send off startSession, so awaiting the whole run() here would hold a
    // steer sent during the first turn until it ends and replay it as a
    // separate turn instead of folding it in via the steer path.
    if (input.prompt || input.attachments?.length) {
      void this.sendTurn({
        threadId: input.threadId,
        prompt: input.prompt,
        attachments: input.attachments,
        model,
      }).catch((error) => {
        if (this.sessions.get(input.threadId) !== active || active.closed) return;
        this.emit({
          type: 'error',
          threadId: input.threadId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    }

    return {
      threadId: input.threadId,
      provider: 'deepseek',
      providerSessionId: active.providerSessionId,
      status: 'running',
      model,
    };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const active = this.sessions.get(input.threadId);
    if (!active) {
      throw new Error(`No DeepSeek Harness session found for thread "${input.threadId}"`);
    }

    const imageError = deepseekImageInputError(input.attachments, active.model, getDeepseekModelConfig());
    if (imageError) throw new Error(imageError);

    // Every send joins one submission queue, in call order and synchronously
    // (startSession's first turn included), before its first await. Image
    // preparation still runs concurrently, but a send reaches the runtime only
    // after the send before it was submitted. Whether it becomes a turn of its
    // own or a steer is decided at that point, not when it was made.
    const previous = active.sendQueue;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    active.sendQueue = slot;
    let blocks: DshContentBlock[] = [];
    let prepareError: unknown;
    try {
      blocks = await buildDeepseekPromptBlocks(input.prompt, input.attachments);
    } catch (error) {
      prepareError = error;
    }

    try {
      // A failed preparation waits too, so it cannot let a later send
      // overtake an earlier one.
      await previous;
      for (;;) {
        if (this.sessions.get(input.threadId) !== active || active.closed) return;
        if (!active.turnInFlight) {
          // No turn owns the activity (idle, or the turn this send was meant
          // to steer ended first): it becomes a turn of its own.
          await this.runTurn(active, input, blocks, prepareError, release);
          return;
        }
        // Wait until the running turn's prompt is in the inbox: a steer must
        // not overtake a primary prompt that is still being submitted.
        if (active.admitPrimary) await active.primaryAdmission;
        // A turn whose activity is over is only emitting its result: this
        // send starts the next turn instead of steering into a finished one.
        else if (active.turn?.closing) await active.turnEnded;
        else break;
      }
      // Steer: while a turn owns the activity, a follow-up send rides the
      // runtime's inbox instead of a second run(). The spine splices it and
      // consumes it before going idle (verified live: the queued instruction
      // shaped the same activity's final answer). If the runtime accepts it
      // only after run() settled, it starts new activity; the turn stays
      // open until that goes idle too, so one result covers both.
      const turn = active.turn!;
      try {
        if (prepareError) throw prepareError;
        turn.steers.submitting += 1;
        let messageId: string | undefined;
        try {
          messageId = await active.harness.client.prompt(active.providerSessionId, blocks);
        } finally {
          turn.steers.submitting -= 1;
          if (messageId && turn.steers.received.get(messageId) !== true) turn.steers.owed.add(messageId);
          this.settleTurnIfIdle(active, turn);
        }
      } catch (error) {
        if (this.sessions.get(input.threadId) !== active || active.closed) {
          return;
        }
        this.emit({
          type: 'error',
          threadId: input.threadId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    } finally {
      release();
      if (active.sendQueue === slot) active.sendQueue = undefined;
    }
  }

  /** A send that starts its own run(); `release` lets the next send submit. */
  private async runTurn(
    active: ActiveDeepseekSession,
    input: ProviderSendTurnInput,
    blocks: DshContentBlock[],
    prepareError: unknown,
    release: () => void
  ): Promise<void> {
    active.status = 'running';
    active.turnInFlight = true;
    let admitPrimary!: () => void;
    active.primaryAdmission = new Promise<void>((resolve) => { admitPrimary = resolve; });
    active.admitPrimary = admitPrimary;
    let endTurn!: () => void;
    active.turnEnded = new Promise<void>((resolve) => { endTurn = resolve; });
    const turn: TurnState = {
      nextBlockIndex: 0,
      usage: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
      usageByStep: new Map(),
      startedAt: Date.now(),
      steers: { submitting: 0, owed: new Set(), received: new Map() },
    };
    active.turn = turn;
    this.emit({ type: 'status_change', threadId: input.threadId, status: 'running' });
    // The turn is in flight: the next send may submit now as a steer, and
    // waits on this turn's admission gate before reaching the inbox.
    release();

    try {
      if (prepareError) throw prepareError;
      await active.session.run(blocks);
      // A stop/replace that landed while run() was settling already tried to
      // wake a waiter that does not exist yet, and no idle will arrive after
      // teardown: end the turn silently instead of installing one.
      if (this.sessions.get(input.threadId) !== active || active.closed) return;
      turn.runSettled = true;
      this.settleTurnIfIdle(active, turn);
      if (!turn.closing) {
        // A steer is still being accepted, or was accepted after run() went
        // idle and started activity no run() owns: wait until it is idle.
        await new Promise<void>((resolve, reject) => {
          turn.onSettled = { resolve, reject };
          if (active.subscriptionError !== undefined) reject(active.subscriptionError);
        });
      }
      while (active.pendingImageResults?.size) await Promise.all(active.pendingImageResults);
      if (this.sessions.get(input.threadId) !== active || active.closed) {
        return;
      }
      const failed = turn.endReason?.kind === 'error';
      this.emitTokenUsage(active);
      active.status = failed ? 'error' : 'completed';
      this.emit({
        type: 'message',
        threadId: input.threadId,
        message: {
          type: 'result',
          subtype: failed ? 'error' : 'success',
          duration_ms: turn ? Date.now() - turn.startedAt : 0,
          total_cost_usd: this.turnCost(active).usd ?? 0,
          costEstimate: this.turnCost(active),
          costAccounting: DEEPSEEK_COST_ACCOUNTING,
          usage: {
            input_tokens: turn?.usage.input ?? 0,
            output_tokens: turn?.usage.output ?? 0,
            cache_read_input_tokens: turn?.usage.cacheRead ?? 0,
            reasoning_output_tokens: turn?.usage.reasoning ?? 0,
          },
          model: active.model,
          usageAccounting: 'deepseek-step-last-wins-v1',
        },
      });
      if (failed) {
        this.emit({
          type: 'error',
          threadId: input.threadId,
          error: new Error(turn?.endReason?.message || 'DeepSeek Harness turn ended with an error.'),
        });
      }
      this.emit({
        type: 'status_change',
        threadId: input.threadId,
        status: failed ? 'error' : 'completed',
      });
    } catch (error) {
      // A stop/dispose closes the runtime, which rejects this turn's run() —
      // that rejection must stay silent: the thread was stopped on purpose,
      // or a replacement session now owns it.
      if (this.sessions.get(input.threadId) !== active || active.closed) {
        return;
      }
      active.status = 'error';
      this.emit({
        type: 'message',
        threadId: input.threadId,
        message: {
          type: 'result',
          subtype: 'error',
          duration_ms: active.turn ? Date.now() - active.turn.startedAt : 0,
          total_cost_usd: this.turnCost(active).usd ?? 0,
          costEstimate: this.turnCost(active),
          costAccounting: DEEPSEEK_COST_ACCOUNTING,
          model: active.model,
          usage: {
            input_tokens: active.turn?.usage.input ?? 0,
            output_tokens: active.turn?.usage.output ?? 0,
            cache_read_input_tokens: active.turn?.usage.cacheRead ?? 0,
            reasoning_output_tokens: active.turn?.usage.reasoning ?? 0,
          },
          usageAccounting: 'deepseek-step-last-wins-v1',
        },
      });
      this.emit({
        type: 'error',
        threadId: input.threadId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      this.emit({ type: 'status_change', threadId: input.threadId, status: 'error' });
    } finally {
      turn.closing = true;
      active.turnInFlight = false;
      admitPrimary();
      if (active.admitPrimary === admitPrimary) active.admitPrimary = undefined;
      endTurn();
      finishBrowserUseTurn(browserManager, input.threadId);
    }
  }

  /**
   * End the turn's activity once its run() settled, every steer was accepted,
   * and the session went idle after each accepted steer's inbox receipt.
   */
  private settleTurnIfIdle(active: ActiveDeepseekSession, turn: TurnState): void {
    if (active.turn !== turn || turn.closing || !turn.runSettled) return;
    if (turn.steers.submitting > 0 || turn.steers.owed.size > 0) return;
    turn.closing = true;
    turn.onSettled?.resolve();
  }

  /** Root inbox insertions this turn; a steer's activity is owed until an idle follows. */
  private noteRootInsertion(active: ActiveDeepseekSession, event: unknown): void {
    const turn = active.turn;
    if (!turn || turn.closing) return;
    for (const message of getArray(getRecord(getRecord(event)?.data)?.inserted)) {
      const id = getString(getRecord(message)?.id);
      if (id) turn.steers.received.set(id, false);
    }
  }

  private noteRootIdle(active: ActiveDeepseekSession): void {
    const turn = active.turn;
    if (!turn || turn.closing) return;
    for (const id of turn.steers.received.keys()) turn.steers.received.set(id, true);
    for (const id of turn.steers.owed) {
      if (turn.steers.received.get(id)) turn.steers.owed.delete(id);
    }
    this.settleTurnIfIdle(active, turn);
  }

  /**
   * Drain the session-tree subscription for this thread's lifetime. The
   * iterator rejects on subscription close or runtime death — both are
   * ordinary teardown here.
   */
  private pumpSubscription(active: ActiveDeepseekSession): void {
    void (async () => {
      try {
        for await (const notification of active.subscription) {
          this.handleNotification(active, notification);
        }
      } catch (error) {
        // A closed subscription is ordinary teardown. A dead runtime while the
        // thread is open fails a turn still waiting on its steer activity.
        if (this.sessions.get(active.threadId) !== active || active.closed) return;
        active.subscriptionError = error;
        active.turn?.onSettled?.reject(error);
      }
    })();
  }

  async stopSession(threadId: string): Promise<void> {
    finishBrowserUseTurn(browserManager, threadId);
    setBrowserUseSessionFullAccess(threadId, false);
    const active = this.sessions.get(threadId);
    if (!active) return;
    active.status = 'stopped';
    active.closed = true;
    this.sessions.delete(threadId);
    active.turn?.onSettled?.resolve();
    try {
      active.subscription.close();
    } catch {
      // already detached
    }
    // No wire-level cancel exists: closing the runtime IS the interrupt
    // (shutdown request, then EOF → SIGTERM → SIGKILL inside the client).
    // Do not synthesize interrupted tool_result blocks for open subagent
    // calls — the workstream freezes unresolved tools once the session
    // is no longer running.
    try {
      await active.harness.close();
    } catch {
      // The process may already be gone.
    } finally {
      active.disposeRuntimeConfig();
    }
  }

  disposeSession(threadId: string): boolean {
    finishBrowserUseTurn(browserManager, threadId);
    setBrowserUseSessionFullAccess(threadId, false);
    const active = this.sessions.get(threadId);
    if (!active) {
      return false;
    }
    active.closed = true;
    this.sessions.delete(threadId);
    active.turn?.onSettled?.resolve();
    try {
      active.subscription.close();
    } catch (error) {
      console.warn('[DeepseekSdkAdapter] subscription cleanup failed:', error);
    }
    // Quiet, synchronous contract: fire and forget the async close ladder.
    // Runtime-config cleanup must not depend on subscription teardown.
    void active.harness.close().catch(() => {}).finally(active.disposeRuntimeConfig);
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.sessions.keys()).map((threadId) => this.stopSession(threadId)));
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values()).map((active) => ({
      threadId: active.threadId,
      provider: 'deepseek',
      providerSessionId: active.providerSessionId,
      status: active.status,
      model: active.model,
    }));
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  async respondToRequest(
    _threadId: string,
    _requestId: string,
    _decision: PermissionResult
  ): Promise<void> {
    // The SDK wire has no approval channel (dead capability upstream), so no
    // permission_request is ever emitted and there is nothing to answer.
  }

  /** One-shot round trip: boot a runtime, run once, reap it. */
  async runOneShot(
    input: ProviderSessionStartInput
  ): Promise<{ text: string; sessionId?: string; model?: string }> {
    const permissionMode = normalizeDeepseekPermissionMode(input.deepseekPermissionMode);
    const agentPreset = normalizeDeepseekAgentPreset(input.deepseekAgentPreset);
    const reasoningEffort = getDeepseekModelConfig().availableModels?.[0]?.reasoningEfforts.length === 1
      ? 'off' : normalizeDeepseekReasoningEffort(input.deepseekReasoningEffort);
    const model = input.model?.trim() || getDeepseekModelConfig().defaultModel || undefined;
    const imageError = deepseekImageInputError(input.attachments, model, getDeepseekModelConfig());
    if (imageError) throw new Error(imageError);
    setBrowserUseSessionFullAccess(input.threadId, permissionMode === 'danger-full-access');
    const { harness, disposeRuntimeConfig } = await this.spawnHarness(
      input.threadId,
      input.cwd,
      model,
      permissionMode,
      agentPreset,
      reasoningEffort
    );
    try {
      const result = await harness.run(await buildDeepseekPromptBlocks(input.prompt, input.attachments));
      return { text: result.finalResponse, sessionId: result.sessionId, model };
    } finally {
      finishBrowserUseTurn(browserManager, input.threadId);
      setBrowserUseSessionFullAccess(input.threadId, false);
      void harness.close().catch(() => {}).finally(disposeRuntimeConfig);
    }
  }

  // ── Runtime management ─────────────────────────────────────────────────────

  private async spawnHarness(
    threadId: string,
    cwd: string,
    model: string | undefined,
    permissionMode: DeepseekPermissionMode,
    agentPreset: DeepseekAgentPreset,
    reasoningEffort: DeepseekReasoningEffort,
    resumeSessionId?: string
  ): Promise<{ harness: DshHarness; disposeRuntimeConfig: () => void }> {
    const profileDir = resolveDeepseekProfileDir();
    if (!profileDir) {
      throw new Error(formatDeepseekProfileMissingMessage());
    }
    const entry = resolveDeepseekRuntimeEntry(profileDir);
    let disposeBrowserDescriptor = () => {};
    const servers = getDeepseekMcpServers(cwd);
    servers[SESSION_MCP_SERVER_NAME] = await getSessionReaderHttpConfig({ sessionId: threadId });
    delete servers[BROWSER_USE_SERVER_NAME];
    if (isBrowserUseEnabled()) {
      const descriptor = await createBrowserUseSessionMcpDescriptor(threadId);
      disposeBrowserDescriptor = descriptor.dispose;
      servers[BROWSER_USE_SERVER_NAME] = {
        type: 'http',
        url: descriptor.url,
        headers: descriptor.headers,
      };
    }
    const runtimeConfig = createDeepseekMcpRuntimeConfig(profileDir, cwd, servers);
    let runtimeDisposed = false;
    const disposeRuntimeConfig = () => {
      if (runtimeDisposed) return;
      runtimeDisposed = true;
      runtimeConfig.dispose();
      disposeBrowserDescriptor();
    };
    try {
      const sdk = await loadDeepseekSdk();
      const runtimeEnv = buildDeepseekEnv({ cwd, permissionMode, agentPreset, reasoningEffort });
      // Codex uses the process-level bearer env var; DeepSeek uses the scoped
      // temporary config and must not inherit the global bearer token.
      delete runtimeEnv[BROWSER_USE_TOKEN_ENV_VAR];
      const harness = new sdk.DeepSeekHarness({
        dshBin: entry.binPath,
        profile: 'sdk',
        patches: [runtimeConfig.configPath],
        processCwd: profileDir,
        // Stop rides the close ladder (shutdown -> EOF -> SIGTERM -> SIGKILL);
        // the SDK defaults sum to ~10s worst case, far too slow for the stop
        // button. A mid-turn runtime holds no state worth a long quiesce —
        // sessions persist per event — so cut each rung short (~3.5s worst).
        shutdownTimeoutMs: 500,
        disposeEofGraceMs: 1500,
        disposeGraceMs: 1500,
        env: {
          ...runtimeEnv,
          // Electron's process.execPath is Electron itself; run as plain node.
          ELECTRON_RUN_AS_NODE: '1',
          DSH_SESSION_ROOT: resolveDeepseekSessionRoot(profileDir),
          AEGIS_DSH_ATTACHMENT_HOME: resolveDeepseekAttachmentHome(),
          AEGIS_DSH_PROJECT_ROOTS: JSON.stringify(getSessionProjectSources(threadId, cwd)),
          ...(resumeSessionId ? { AEGIS_DSH_RESUME_SESSION_ID: resumeSessionId } : {}),
        },
        cwd,
        provider: 'deepseek-official',
        reasoningEffort,
        ...(model ? { model } : {}),
      });
      await harness.start();
      return { harness, disposeRuntimeConfig };
    } catch (error) {
      disposeRuntimeConfig();
      throw error;
    }
  }

  // ── Notification routing ───────────────────────────────────────────────────

  private ensureSubagentState(active: ActiveDeepseekSession): DeepseekSubagentRuntime {
    if (!active.subagent) {
      active.subagent = createDeepseekSubagentRuntime();
    }
    if (!active.subagentBuffers) {
      active.subagentBuffers = new Map();
    }
    if (!active.toolBatches) {
      active.toolBatches = new Map();
    }
    return active.subagent;
  }

  private handleNotification(
    active: ActiveDeepseekSession,
    notification: DshHarnessNotification
  ): void {
    if (this.sessions.get(active.threadId) !== active) {
      return;
    }
    this.ensureSubagentState(active);
    if (notification.method === 'subagent.started') {
      this.handleSubagentStarted(active, notification.params);
      return;
    }
    if (notification.method === DEEPSEEK_ASSISTANT_STREAM_METHOD) {
      // Live deltas are rendered for the top-level agent only; subagent
      // output reaches its workstream when each step commits.
      if (getString(notification.params.sessionId) === active.providerSessionId) {
        this.handleAssistantStream(active, notification.params);
      }
      return;
    }
    if (notification.method === 'session.status') {
      if (getString(notification.params.sessionId) === active.providerSessionId &&
          notification.params.status === 'idle') {
        this.noteRootIdle(active);
      }
      return;
    }
    if (notification.method !== 'session.event') {
      return;
    }

    const sessionId = getString(notification.params.sessionId);
    const parentToolUseId = active.subagent.parents.get(sessionId) || null;
    const isRoot = sessionId === active.providerSessionId;
    if (isRoot && isInboxInsertion(notification.params.event)) {
      this.noteRootInsertion(active, notification.params.event);
    }
    if (isRoot && active.admitPrimary && isInboxInsertion(notification.params.event)) {
      // Steers wait behind the primary gate, so the first root insertion
      // while it is open is the primary prompt entering the inbox.
      active.admitPrimary();
      active.admitPrimary = undefined;
    }
    if (!isRoot && !parentToolUseId) {
      this.bufferUnboundChildEvent(active, sessionId, notification);
      this.absorbChildBindingHints(active, sessionId, notification);
      const boundId = active.subagent.parents.get(sessionId);
      if (!boundId) return;
      this.flushSubagentBuffer(active, sessionId);
      return;
    }

    this.dispatchSessionEvent(active, sessionId, notification, parentToolUseId);
  }

  private handleSubagentStarted(
    active: ActiveDeepseekSession,
    params: Record<string, unknown>
  ): void {
    const parentSessionId = getString(params.parentSessionId);
    const childSessionId = getString(params.childSessionId);
    const boundId = registerDeepseekStarted(active.subagent, parentSessionId, childSessionId);
    if (boundId) {
      this.flushSubagentBuffer(active, childSessionId);
    }
  }

  private bufferUnboundChildEvent(
    active: ActiveDeepseekSession,
    sessionId: string,
    notification: DshHarnessNotification
  ): void {
    if (!sessionId) return;
    const buffer = active.subagentBuffers.get(sessionId) ?? [];
    buffer.push(notification);
    active.subagentBuffers.set(sessionId, buffer);
  }

  private absorbChildBindingHints(
    active: ActiveDeepseekSession,
    sessionId: string,
    notification: DshHarnessNotification
  ): void {
    const event = getRecord(notification.params.event) as DshSessionEvent | null;
    if (!event) return;
    const data = getRecord(event.data) || {};
    if (event.type === 'subagent/descriptor') {
      registerDeepseekChildHint(active.subagent, sessionId, { label: getString(data.label) });
      return;
    }
    if (event.type === 'user/message') {
      registerDeepseekChildHint(active.subagent, sessionId, {
        prompt: extractUserMessageText(data),
      });
    }
  }

  private flushSubagentBuffer(active: ActiveDeepseekSession, childSessionId: string): void {
    const buffered = active.subagentBuffers.get(childSessionId);
    if (!buffered?.length) return;
    active.subagentBuffers.delete(childSessionId);
    const parentToolUseId = active.subagent.parents.get(childSessionId) || null;
    for (const notification of buffered) {
      this.dispatchSessionEvent(active, childSessionId, notification, parentToolUseId);
    }
  }

  private dispatchSessionEvent(
    active: ActiveDeepseekSession,
    sessionId: string,
    notification: DshHarnessNotification,
    parentToolUseId: string | null
  ): void {
    const event = getRecord(notification.params.event) as DshSessionEvent | null;
    if (!event || typeof event.type !== 'string') {
      return;
    }
    const data = getRecord(event.data) || {};
    const createdAt = getNumber(event.time) || Date.now();
    const isRoot = !parentToolUseId;

    if (!isRoot && event.type === 'subagent/descriptor') {
      registerDeepseekChildHint(active.subagent, sessionId, { label: getString(data.label) });
      return;
    }
    if (!isRoot && event.type === 'user/message') {
      registerDeepseekChildHint(active.subagent, sessionId, {
        prompt: extractUserMessageText(data),
      });
      return;
    }

    switch (event.type) {
      case 'compaction/start':
        if (isRoot) this.compactions.start(active, {
          id: getString(data.compactionId), createdAt,
          trigger: data.sourceCommandId != null || data.turn === null ? 'manual' : 'auto',
        });
        break;
      case 'compaction/end':
        if (isRoot) {
          if (data.error) this.compactions.interrupt(active, getString(data.compactionId));
          else this.compactions.complete(active, {
            id: getString(data.compactionId), createdAt,
            trigger: data.sourceCommandId != null || data.turn === null ? 'manual' : 'auto',
          });
        }
        break;
      case 'assistant/chunk':
        if (isRoot) this.handleAssistantChunk(active, data);
        break;
      case 'assistant/message':
        this.handleAssistantMessage(active, data, parentToolUseId, createdAt);
        break;
      case 'tool/call':
        this.handleToolCall(active, sessionId, data, parentToolUseId, createdAt);
        break;
      case 'tool/result':
        this.handleToolResult(active, sessionId, data, parentToolUseId, createdAt);
        break;
      case 'tool/ptc-dispatch-start':
      case 'tool/ptc-dispatch': {
        // PTC keeps image content in its native nested dispatch log. The
        // deferred user context is for the model, not a second user upload.
        const blocks = getArray(data.content);
        if (data.name !== 'read_image' && deepseekImageBlocks(blocks).length === 0) break;
        const callId = getString(data.subCallId);
        if (!callId) break;
        this.handleToolCall(active, sessionId, {
          callId, name: data.name,
          arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments || {}),
        }, parentToolUseId, createdAt, `ptc:${callId}`);
        if (event.type === 'tool/ptc-dispatch') {
          this.handleToolResult(active, sessionId, {
            isError: data.isError,
            message: { source: { callId }, content: blocks },
          }, parentToolUseId, createdAt);
        }
        break;
      }
      case 'request/context':
        if (isRoot) {
          active.contextWindow = getNumber(data.contextWindow) || active.contextWindow;
        }
        break;
      case 'turn/end': {
        if (!isRoot) break;
        const reason = getRecord(data.reason);
        const error = getRecord(reason?.error);
        if (active.turn && reason) {
          active.turn.endReason = {
            kind: getString(reason.kind) || 'completed',
            message: getString(error?.message) || undefined,
          };
        }
        break;
      }
      default:
        break;
    }
  }

  // ── Streaming deltas ───────────────────────────────────────────────────────

  /** One `aegis.assistant.stream` frame from the profile's runtime-stream-shim. */
  private handleAssistantStream(
    active: ActiveDeepseekSession,
    params: Record<string, unknown>
  ): void {
    switch (params.type) {
      case 'chunk':
        this.handleAssistantChunk(active, { chunk: params.chunk });
        break;
      case 'start':
        // A retry after a failed attempt starts over; drop its partial.
        this.discardStreamedPartial(active);
        active.widgetDrafts?.reset();
        break;
      case 'end':
        // A committed attempt is replaced by its assistant/message; an
        // abandoned one (cancelled or failed) leaves nothing to keep.
        if (params.outcome === 'abandoned') {
          this.discardStreamedPartial(active);
          active.widgetDrafts?.reset();
        } else {
          active.widgetDrafts?.endAll();
        }
        break;
      default:
        break;
    }
  }

  private discardStreamedPartial(active: ActiveDeepseekSession): void {
    const turn = active.turn;
    if (!turn || (!turn.currentThinking && !turn.currentText)) return;
    turn.currentThinking = undefined;
    turn.currentText = undefined;
    this.emit({
      type: 'message',
      threadId: active.threadId,
      message: {
        type: 'stream_event',
        parentToolUseId: null,
        event: { type: 'content_block_stop', index: turn.nextBlockIndex },
      },
    });
  }

  private handleAssistantChunk(
    active: ActiveDeepseekSession,
    data: Record<string, unknown>
  ): void {
    const turn = active.turn;
    if (!turn) return;
    const chunk = getRecord(data.chunk) || {};
    switch (chunk.type) {
      case 'reasoning-delta': {
        const text = getString(chunk.text) || getString(chunk.delta);
        if (!text) return;
        if (!turn.currentThinking) {
          turn.currentThinking = { blockIndex: turn.nextBlockIndex++ };
        }
        this.emitStreamDelta(active, turn.currentThinking.blockIndex, {
          type: 'thinking_delta',
          thinking: text,
        });
        break;
      }
      case 'text-delta': {
        const text = getString(chunk.text) || getString(chunk.delta);
        if (!text) return;
        if (!turn.currentText) {
          turn.currentText = { blockIndex: turn.nextBlockIndex++ };
        }
        this.emitStreamDelta(active, turn.currentText.blockIndex, {
          type: 'text_delta',
          text,
        });
        break;
      }
      case 'usage':
        this.setUsageSample(active, data, getRecord(chunk.usage) || chunk);
        break;
      case 'tool-call-delta': {
        // The shim forwards only show_widget calls; the widget is drawn as
        // its markup arrives, and the tool/call event carries the real call.
        const callId = getString(chunk.id);
        if (!callId) return;
        active.widgetDrafts ??= new WidgetDraftTracker((draft) => {
          this.emit({ type: 'message', threadId: active.threadId, message: draft });
        });
        active.widgetDrafts.append(
          namespaceDeepseekToolId(active.providerSessionId, callId),
          getString(chunk.argumentsDelta),
          getString(chunk.name) || undefined
        );
        break;
      }
      default:
        // block-start/block-end/finish: the committed assistant/message and
        // tool/call events carry the durable content.
        break;
    }
  }

  private emitStreamDelta(
    active: ActiveDeepseekSession,
    index: number,
    delta: { type: string; text?: string; thinking?: string }
  ): void {
    this.emit({
      type: 'message',
      threadId: active.threadId,
      message: {
        type: 'stream_event',
        parentToolUseId: null,
        event: { type: 'content_block_delta', index, delta },
      },
    });
  }

  // ── Committed messages / tools ─────────────────────────────────────────────

  private handleAssistantMessage(
    active: ActiveDeepseekSession,
    data: Record<string, unknown>,
    parentToolUseId: string | null,
    createdAt: number
  ): void {
    const message = getRecord(data.message);
    if (!message) return;
    if (!parentToolUseId) {
      this.setUsageSample(active, data, getRecord(data.usage));
    }

    const content: Array<{ type: 'thinking'; thinking: string } | { type: 'text'; text: string }> = [];
    for (const block of getArray(message.content)) {
      const record = getRecord(block);
      if (!record) continue;
      if (record.type === 'reasoning' && getString(record.text)) {
        content.push({ type: 'thinking', thinking: getString(record.text) });
      } else if (record.type === 'text' && getString(record.text)) {
        content.push({ type: 'text', text: getString(record.text) });
      }
      // tool-call blocks are rendered from the tool/call event instead.
    }
    if (content.length === 0) return;

    if (!parentToolUseId && active.turn) {
      active.turn.currentThinking = undefined;
      active.turn.currentText = undefined;
    }

    const uuid = `deepseek-assistant:${active.threadId}:${getString(message.id) || uuidv4()}`;
    const streamMessage: StreamMessage = {
      type: 'assistant',
      uuid,
      createdAt,
      ...(parentToolUseId ? { parentToolUseId } : {}),
      message: { content },
    };
    this.emit({ type: 'message', threadId: active.threadId, message: streamMessage });
  }

  private handleToolCall(
    active: ActiveDeepseekSession,
    sessionId: string,
    data: Record<string, unknown>,
    parentToolUseId: string | null,
    createdAt: number,
    batchId?: string
  ): void {
    const rawCallId = getString(data.callId);
    if (!rawCallId || !sessionId) return;
    const name = getString(data.name) || 'Tool';
    const parsedInput = parseToolCallInput(getString(data.arguments));
    const displayId = namespaceDeepseekToolId(sessionId, rawCallId);
    active.widgetDrafts?.end(displayId);

    if (isDeepseekSubagentToolName(name)) {
      const boundId = registerDeepseekSpawn(
        active.subagent,
        spawnFromToolInput(sessionId, rawCallId, parsedInput)
      );
      if (boundId) {
        const childId = [...active.subagent.parents.entries()].find(
          ([, toolId]) => toolId === boundId
        )?.[0];
        if (childId) this.flushSubagentBuffer(active, childId);
      }
    }

    const turn = getNumber(data.turn);
    const step = getNumber(data.step);
    const batchKey = `${sessionId}:${batchId ?? `${turn}:${step}`}`;
    const existing = active.toolBatches.get(batchKey);
    const block = { type: 'tool_use' as const, id: displayId, name, input: parsedInput };
    if (existing && existing.parentToolUseId === parentToolUseId) {
      if (existing.blocks.some((item) => item.id === displayId)) return;
      existing.blocks.push(block);
      this.emit({
        type: 'message',
        threadId: active.threadId,
        message: {
          type: 'assistant',
          uuid: existing.uuid,
          createdAt: existing.createdAt,
          ...(parentToolUseId ? { parentToolUseId } : {}),
          message: { content: existing.blocks },
        },
      });
      return;
    }

    const uuid = `deepseek-tools:${active.threadId}:${batchKey}`;
    const blocks = [block];
    active.toolBatches.set(batchKey, {
      uuid,
      blocks,
      createdAt,
      parentToolUseId,
    });
    this.emit({
      type: 'message',
      threadId: active.threadId,
      message: {
        type: 'assistant',
        uuid,
        createdAt,
        ...(parentToolUseId ? { parentToolUseId } : {}),
        message: { content: blocks },
      },
    });
  }

  private handleToolResult(
    active: ActiveDeepseekSession,
    sessionId: string,
    data: Record<string, unknown>,
    parentToolUseId: string | null,
    createdAt: number
  ): void {
    const message = getRecord(data.message);
    const source = getRecord(message?.source);
    const rawCallId = getString(source?.callId);
    if (!rawCallId || !sessionId) return;
    const displayId = namespaceDeepseekToolId(sessionId, rawCallId);
    const blocks = getArray(message?.content);
    const isError = data.isError === true || blocks.some((block) => getRecord(block)?.isError === true);
    const text = extractToolResultText(blocks) || 'Done';
    const streamMessage: StreamMessage = {
      type: 'assistant',
      uuid: `deepseek-tool-result:${active.threadId}:${displayId}`,
      createdAt,
      ...(parentToolUseId ? { parentToolUseId } : {}),
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: displayId,
            content: text,
            is_error: isError,
          },
        ],
      },
    };
    if (deepseekImageBlocks(blocks).length > 0) {
      const pending = active.pendingImageResults ??= new Set();
      const task = (async () => {
        const resultBlock = streamMessage.message.content[0];
        if (resultBlock.type !== 'tool_result') return;
        try {
          resultBlock.images = await deepseekToolImages(blocks, active.attachmentHome || resolveDeepseekAttachmentHome());
        } catch (error) {
          resultBlock.content += `\nImage preview unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (this.sessions.get(active.threadId) === active && !active.closed) {
          this.emit({ type: 'message', threadId: active.threadId, message: streamMessage });
        }
      })();
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
    } else {
      this.emit({ type: 'message', threadId: active.threadId, message: streamMessage });
    }
  }

  // ── Usage / context ring ───────────────────────────────────────────────────

  private setUsageSample(
    active: ActiveDeepseekSession,
    data: Record<string, unknown>,
    usage: Record<string, unknown> | null
  ): void {
    const turn = active.turn;
    if (!turn || !usage) return;
    const eventTurn = getNumber(data.turn);
    const eventStep = getNumber(data.step);
    const key = `${eventTurn}:${eventStep}`;
    const previous = turn.usageByStep.get(key);
    const next = {
      atMs: previous?.atMs ?? Date.now(),
      input: getNumber(usage.inputTokens),
      output: getNumber(usage.outputTokens),
      cacheRead: getNumber(usage.cacheReadTokens),
      reasoning: getNumber(usage.reasoningTokens),
    };
    if (previous) {
      turn.usage.input -= previous.input;
      turn.usage.output -= previous.output;
      turn.usage.cacheRead -= previous.cacheRead;
      turn.usage.reasoning -= previous.reasoning;
    }
    turn.usageByStep.set(key, next);
    if (!previous) turn.latestUsageKey = key;
    turn.usage.input += next.input;
    turn.usage.output += next.output;
    turn.usage.cacheRead += next.cacheRead;
    turn.usage.reasoning += next.reasoning;
    this.emitTokenUsage(active);
  }

  private turnCost(active: ActiveDeepseekSession): { usd: number | null } {
    const turn = active.turn;
    if (!turn?.usageByStep.size) {
      return { usd: estimateDeepseekUsageCost(active.model, { inputTokens: 0, outputTokens: 0 }) };
    }
    let usd = 0;
    for (const usage of turn.usageByStep.values()) {
      const estimate = estimateDeepseekUsageCost(active.model, {
        inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead,
      }, usage.atMs);
      if (estimate === null) return { usd: null };
      usd += estimate;
    }
    return { usd };
  }

  /**
   * Codex-style context ring. Occupancy approximates the last request's
   * prompt footprint (fresh input + cache hits); the window comes from the
   * effective profile until request/context provides the routed model's limit.
   */
  private emitTokenUsage(active: ActiveDeepseekSession): void {
    const turn = active.turn;
    if (!turn || !active.contextWindow || active.contextWindow <= 0) {
      return;
    }
    // reasoningTokens is a subdivision of outputTokens in the Harness usage
    // contract, so adding it again would overstate both occupancy and cost.
    const latest = turn.latestUsageKey ? turn.usageByStep.get(turn.latestUsageKey) : undefined;
    if (!latest) return;
    const contextTokens = latest.input + latest.cacheRead + latest.output;
    this.emit({
      type: 'message',
      threadId: active.threadId,
      message: {
        type: 'system',
        subtype: 'token_usage',
        uuid: 'deepseek-token-usage:' + active.threadId + ':' + Date.now(),
        session_id: active.threadId,
        provider: 'deepseek',
        usage: {
          inputTokens: latest.input,
          cachedInputTokens: latest.cacheRead,
          outputTokens: latest.output,
          reasoningOutputTokens: latest.reasoning,
          totalTokens: contextTokens,
          contextWindow: active.contextWindow,
          turnCostEstimate: this.turnCost(active),
        },
      },
    });
  }

  private emit(event: ProviderRuntimeEvent): void {
    if (event.type === 'error' ||
        (event.type === 'status_change' && ['completed', 'stopped', 'error'].includes(event.status)) ||
        (event.type === 'message' && event.message.type === 'result')) {
      const session = this.sessions.get(event.threadId);
      if (session) this.compactions.interrupt(session);
    }
    this.events.emit('event', event);
  }
}
