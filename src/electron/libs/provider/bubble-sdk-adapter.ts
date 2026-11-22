import { questionAnswerValues, resolveQuestionAnswer } from '../../../shared/question-answers';
import { CompactionTracker } from './compaction-tracker';
import { addAgentCost, costFields, emptyCostDetails } from '../agent-cost';
import { assertBubbleSessionReader, bubbleHostTools, bubbleRoleOptions } from '../bubble-session-reader';
import { bubbleComputerUseToolNames, isBubbleComputerUseApproval } from '../bubble-computer-use-tool';
import { getComputerUseGateway } from '../computer-use';
import { computerUseGatewayTool } from '../../../shared/computer-use';
import { isProjectFileApproval } from './project-access';
import { WidgetDraftTracker } from '../widget-draft';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import type {
  AcpPermissionInput,
  AskUserQuestionInput,
  Attachment,
  BubblePermissionMode,
  ContentBlock,
  PermissionResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  StreamMessage,
  Usage,
} from '../../../shared/types';
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
import {
  getBubbleSdk,
  getBubbleSessionManager,
  loadBubbleContextEstimator,
  type BubbleAgentEvent,
  type BubbleApprovalDecision,
  type BubbleApprovalRequest,
  type BubbleContentPart,
  type BubbleQuestionPrompt,
  type BubbleQuestionRequest,
  type BubbleProjectTrustRequest,
  type BubbleRunTurnOptions,
  type BubbleSdkInstance,
  type BubbleSessionHandle,
  type BubbleSteerOutcome,
  type BubbleSubagentUpdate,
  type BubbleTokenUsage,
} from './bubble-sdk-loader';
import type { ProviderRewindAnchor, ProviderRewindResult } from './types';

const ONE_SHOT_TIMEOUT_MS = 120_000;

const CAPABILITIES: ProviderAdapterCapabilities = {
  sessionModelSwitch: true,
  skillDiscovery: true,
  pluginDiscovery: false,
  mcpServers: true,
  imageAttachments: true,
  forkThread: false,
  compactThread: true,
  planMode: true,
};

type PendingBubbleRequest =
  | { kind: 'approval'; resolve: (decision: BubbleApprovalDecision) => void }
  | {
      kind: 'question';
      questions: BubbleQuestionPrompt[];
      resolve: (answers: string[][] | null) => void;
    }
  | { kind: 'project_trust'; resolve: (trusted: boolean) => void }
  | { kind: 'plan'; resolve: (approved: boolean) => void };

type BubbleAssistantAccumulator = {
  uuid: string;
  text: string;
  thinking: string;
  createdAt: number;
};

/** What a turn runs with. A missing field leaves the SDK's own default. */
type BubbleTurnConfig = {
  model?: string;
  permissionMode?: BubblePermissionMode;
  planExitMode?: 'default' | 'bypassPermissions';
  thinkingLevel?: string;
};

/**
 * One Aegis turn. Its prompt opens a turn in the SDK; a message sent while it
 * runs joins it instead of starting another — steered into the running SDK
 * turn, or run as an SDK turn queued behind it — and one result reports all
 * of it.
 */
type BubbleBatch = {
  /** True once the opening turn holds the session slot, so a message can join; false if none ever can. */
  ready: Promise<boolean>;
  markReady: (joinable: boolean) => void;
  /** Settles once the batch is over, however it ended. */
  done: Promise<void>;
  markDone: () => void;
  /** Work still owed: the opening turn, and each joined message not yet answered. */
  open: number;
  /**
   * Settles when the last joined message has been handed to the SDK. The next
   * one is handed over after it, so messages reach the SDK in the order they
   * were sent however long each takes to prepare (reading an image, say).
   */
  handedOver: Promise<void>;
  /**
   * Steers the SDK has not placed yet: read by the running turn, or given a
   * turn of their own. A turn queued after them waits for that, or it would
   * get ahead of the turn the SDK may still start for one of them.
   */
  placing: Set<Promise<unknown>>;
  sdk?: BubbleSdkInstance;
  /** Cancels the turns this adapter started for the batch. */
  abortController: AbortController;
  /** Session logs read for turns the SDK started itself (see followTurn). */
  handles: Set<BubbleSessionHandle>;
};

type ActiveBubbleSession = {
  /** show_widget calls drawn while their arguments stream. */
  widgetDrafts?: WidgetDraftTracker;
  threadId: string;
  providerSessionId: string;
  status: ProviderSessionStatus;
  cwd: string;
  model?: string;
  permissionMode?: BubblePermissionMode;
  planExitMode?: 'default' | 'bypassPermissions';
  /**
   * The turn whose own mode changes are the session's: the newest one started
   * or queued, since the session is set to what that turn was given. A plan
   * approved in a turn before it concerns that turn alone. Null once a message
   * that joined the running turn named another mode: that choice is for what
   * comes next, and no turn running now may replace it.
   */
  modeOwner?: symbol | null;
  /** The turn the SDK runs: the one a steer joins, and whose options the SDK reuses for a steer left unread. */
  runningTurn?: symbol;
  contextTokens?: number;
  nativeContextWindow?: number;
  contextProviderId?: string;
  /** Composer-selected thinking level (open set); undefined = SDK/model default. */
  thinkingLevel?: string;
  /** Registry fallback until the native context event supplies a window. */
  contextWindow?: number | null;
  /** The turn now running, with whatever joined it; none between turns. */
  batch?: BubbleBatch | null;
  /**
   * Set from the moment a `/compact` is sent until it has run, whether it
   * runs at once or first waits for the running turn to end. What is sent
   * meanwhile waits behind it, in the order it was sent: the compaction keeps
   * its place, and a stream of messages cannot put it off for ever.
   */
  compactBarrier?: Promise<void> | null;
  abortController: AbortController | null;
  pendingRequests: Map<string, PendingBubbleRequest>;
  currentAssistant: BubbleAssistantAccumulator | null;
  emittedToolCallIds: Set<string>;
  emittedToolResultIds: Set<string>;
  usage: Usage;
  costDetails: ReturnType<typeof emptyCostDetails>;
  durationStartMs: number;
  durationEndMs?: number;
  /** Subagent streams keyed by the SPAWNING tool_call id (the UI's nesting
   * key). Mirrors the Kimi adapter's subagentStreams/subagentParents pair. */
  subagentStreams: Map<string, BubbleSubagentStream>;
  /** tool_call id -> first-seen timestamp; anchors duration for finished lanes. */
  subagentStartedAt: Map<string, number>;
  /** tool_call id -> tool name, so spawn results can be identified later. */
  toolNames: Map<string, string>;
  /** spawn_agent/run_workflow results held back until the lane's terminal
   * subagent_update — these tools are fire-and-forget (the SDK returns
   * "Spawned X (queued)" immediately), so emitting the tool_result right
   * away would flip the UI lane to Done while the child is still running. */
  heldSpawnResults: Map<string, { content?: string; isError?: boolean }>;
};

/** Accumulated child narration under one spawn lane (nested transcript). */
type BubbleSubagentStream = {
  text: string;
  thinking: string;
  toolCallIds: Set<string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeToolName(toolName: string): string {
  const normalized = toolName.trim();
  if (!normalized) {
    return 'Tool';
  }
  const compact = normalized.replace(/[_\-\s]/g, '').toLowerCase();
  if (compact === 'bash' || compact === 'shell') return 'Bash';
  if (compact === 'read') return 'Read';
  if (compact === 'write') return 'Write';
  if (compact === 'edit') return 'Edit';
  if (compact === 'grep') return 'Grep';
  if (compact === 'glob') return 'Glob';
  if (compact === 'ls') return 'LS';
  if (compact === 'todowrite') return 'TodoWrite';
  if (compact === 'webfetch') return 'WebFetch';
  if (compact === 'websearch') return 'WebSearch';
  if (compact === 'question') return 'AskUserQuestion';
  if (compact === 'exitplanmode') return 'ExitPlanMode';
  return normalized;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw };
  }
}

function usageFromBubble(
  usage: BubbleTokenUsage | undefined,
  contextWindow?: number | null
): Usage | null {
  if (!usage) {
    return null;
  }
  const input = Math.max(0, Math.round(getNumber(usage.promptTokens) || 0));
  const output = Math.max(0, Math.round(getNumber(usage.completionTokens) || 0));
  const cacheRead = Math.max(0, Math.round(getNumber(usage.promptCacheHitTokens) || 0));
  const cacheWrite = Math.max(0, Math.round(getNumber(usage.cacheCreationTokens) || 0));
  const total = getNumber(usage.totalTokens);
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    total_tokens: total !== undefined ? Math.round(total) : input + output + cacheRead + cacheWrite,
    context_window: contextWindow || null,
  };
}

function addUsage(target: Usage, usage: Usage | null): void {
  if (!usage) {
    return;
  }
  target.input_tokens += usage.input_tokens || 0;
  target.output_tokens += usage.output_tokens || 0;
  target.cache_read_input_tokens =
    (target.cache_read_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  target.cache_creation_input_tokens =
    (target.cache_creation_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  target.total_tokens = (target.total_tokens || 0) + (usage.total_tokens || 0);
  if (usage.context_window) {
    target.context_window = usage.context_window;
  }
}

function createEmptyUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_tokens: 0,
    context_window: null,
  };
}

function buildPromptText(prompt: string, attachments: Attachment[] | undefined): string {
  const lines = prompt ? [prompt] : [];
  const fileAttachments = attachments?.filter((attachment) => attachment.kind !== 'image') || [];
  if (fileAttachments.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Attachments:');
    for (const attachment of fileAttachments) {
      lines.push(`- ${attachment.name}: ${attachment.path}`);
    }
  }
  return lines.join('\n');
}

// Bubble's ContentPart uses OpenAI-style image_url parts, so attachments are
// inlined as base64 data URLs.
async function buildPromptParts(
  text: string,
  attachments: Attachment[] | undefined
): Promise<string | BubbleContentPart[]> {
  const imageAttachments = attachments?.filter((attachment) => attachment.kind === 'image') || [];
  if (imageAttachments.length === 0) {
    return text;
  }
  const parts: BubbleContentPart[] = [];
  if (text.trim()) {
    parts.push({ type: 'text', text });
  }
  for (const attachment of imageAttachments) {
    const buffer = await readFile(attachment.path);
    const mimeType = attachment.mimeType || 'image/png';
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` },
    });
  }
  return parts;
}

function describeApproval(request: BubbleApprovalRequest): { toolName: string; question: string } {
  const type = getString(request.type);
  const path = getString(request.path);
  switch (type) {
    case 'bash': {
      const command = getString(request.command);
      return { toolName: 'Bash', question: command ? `Run command: ${command}` : 'Run a command' };
    }
    case 'edit':
      return { toolName: 'Edit', question: path ? `Edit ${path}` : 'Edit a file' };
    case 'write':
      return { toolName: 'Write', question: path ? `Write ${path}` : 'Write a file' };
    case 'patch': {
      const paths = Array.isArray(request.paths)
        ? request.paths.map((value) => getString(value)).filter(Boolean)
        : [];
      return {
        toolName: 'Edit',
        question: paths.length > 0 ? `Apply patch to ${paths.join(', ')}` : 'Apply a patch',
      };
    }
    case 'lsp':
      return {
        toolName: 'LSP',
        question: `Run LSP ${getString(request.operation) || 'operation'}${path ? ` on ${path}` : ''}`,
      };
    case 'agent_profile':
      return {
        toolName: 'AgentProfile',
        question: `Trust project agent profile "${getString(request.name) || 'unknown'}"`,
      };
    case 'external_tool':
      return {
        toolName: getString(request.title) || 'Tool',
        question: getString(request.title) || 'Run an external tool',
      };
    default:
      return { toolName: type || 'Tool', question: 'Bubble is requesting permission' };
  }
}

function buildApprovalInput(request: BubbleApprovalRequest): AcpPermissionInput {
  const { toolName, question } = describeApproval(request);
  return {
    kind: 'acp-permission',
    provider: 'bubble',
    question,
    title: question,
    toolName,
    options: [
      { optionId: 'approve', name: 'Approve', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    toolCall: request,
  };
}

function buildQuestionInput(request: BubbleQuestionRequest): AskUserQuestionInput {
  return {
    questions: request.questions.map((question) => ({
      question: question.question,
      ...(question.header?.trim() ? { header: question.header.trim() } : {}),
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description?.trim() ? { description: option.description.trim() } : {}),
      })),
      ...(question.multiple === true ? { multiSelect: true } : {}),
    })),
  };
}

/**
 * Per question: the picked option labels, then the user's own text. Labels
 * and that text may contain commas (resolveQuestionAnswer keeps them whole).
 */
export function buildQuestionAnswers(
  questions: BubbleQuestionPrompt[],
  decision: PermissionResult
): string[][] {
  return questions.map((question) =>
    questionAnswerValues(resolveQuestionAnswer(decision, question.question, question.options.map((option) => option.label)))
  );
}

export class BubbleSdkAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'bubble';
  readonly displayName = 'Bubble';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  private readonly compactions = new CompactionTracker(event => this.emit(event));

  private sessions = new Map<string, ActiveBubbleSession>();

  /**
   * Starts still waiting for the SDK to load, by thread. The session is not
   * registered until it has loaded, so a Stop in between finds no session:
   * it takes the entry away here instead, and the start gives up.
   */
  private starting = new Map<string, symbol>();

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const cwd = input.cwd || process.cwd();
    const attempt = Symbol(input.threadId);
    this.starting.set(input.threadId, attempt);
    let sdk: BubbleSdkInstance;
    try {
      sdk = await getBubbleSdk(cwd);
    } catch (error) {
      if (this.starting.get(input.threadId) === attempt) this.starting.delete(input.threadId);
      throw error;
    }
    // Stopped while the SDK loaded (or another start took the thread): this
    // start registers no session and runs no turn.
    if (this.starting.get(input.threadId) !== attempt) {
      throw new Error('Bubble session start was cancelled.');
    }
    this.starting.delete(input.threadId);
    this.assertConfigured(sdk);
    const providerSessionId = this.resolveSessionId(sdk, input.resumeSessionId, cwd);

    const session: ActiveBubbleSession = {
      threadId: input.threadId,
      providerSessionId,
      status: 'running',
      cwd,
      model: input.model?.trim() || undefined,
      permissionMode: input.bubblePermissionMode,
      planExitMode: input.bubblePlanExitMode ?? (input.bubblePermissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'default'),
      thinkingLevel: input.bubbleThinkingLevel?.trim() || undefined,
      batch: null,
      abortController: null,
      pendingRequests: new Map(),
      currentAssistant: null,
      emittedToolCallIds: new Set(),
      emittedToolResultIds: new Set(),
      usage: createEmptyUsage(),
      costDetails: emptyCostDetails(),
      durationStartMs: Date.now(),
      subagentStreams: new Map(),
      subagentStartedAt: new Map(),
      toolNames: new Map(),
      heldSpawnResults: new Map(),
    };
    // Never orphan a previous session for the same thread — an undisposed
    // predecessor would leak its abort handle and pending approval cards.
    this.disposeSession(input.threadId);
    this.sessions.set(input.threadId, session);

    this.emit({
      type: 'system_init',
      threadId: input.threadId,
      sessionId: providerSessionId,
      model: session.model,
    });

    if (input.prompt || input.attachments?.length) {
      await this.sendTurn({
        threadId: input.threadId,
        prompt: input.prompt,
        attachments: input.attachments,
        model: input.model,
        bubblePermissionMode: input.bubblePermissionMode,
        bubblePlanExitMode: input.bubblePlanExitMode,
        bubbleThinkingLevel: input.bubbleThinkingLevel,
      });
    }

    return {
      threadId: input.threadId,
      provider: 'bubble',
      providerSessionId,
      status: session.status,
      model: session.model,
    };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      throw new Error(`No Bubble session found for thread "${input.threadId}"`);
    }
    const trimmedPrompt = input.prompt.trim();
    // Manual `/compact` is handled locally (mirrors Claude Code): it compacts
    // the persisted session and emits a compact_boundary instead of a model
    // turn. Keep the native context snapshot separate from billing totals.
    const compact = !input.attachments?.length && trimmedPrompt.toLowerCase() === '/compact';

    // A compaction sent earlier has not finished (it runs, or still waits for
    // its turn): this message was sent after it, so it goes after it.
    while (session.compactBarrier) {
      await session.compactBarrier;
      if (!this.isLive(session)) return;
    }

    if (compact) {
      await this.compactInTurn(session, input);
      return;
    }

    const running = session.batch;
    // A turn is running: the message joins it instead of starting another.
    if (running) {
      const joinable = await running.ready;
      // Stopped meanwhile: there is no turn left to send it to.
      if (!this.isLive(session)) return;
      if (joinable && session.batch === running) {
        this.joinBatch(session, running, input);
        return;
      }
      // The turn takes no messages (it never started): this one goes after it.
      await running.done;
      if (!this.isLive(session)) return;
      return this.sendTurn(input);
    }

    // Opened before the first await below: a message sent right behind this
    // one finds the turn and joins it, instead of starting a second one.
    const batch = this.openBatch(session);
    this.adoptTurnConfig(session, this.resolveTurnConfig(session, input));
    // The session is set to what this turn was given: its mode changes are the session's.
    const turn = Symbol('turn');
    session.modeOwner = turn;

    let prompt: string | BubbleContentPart[];
    try {
      prompt = await buildPromptParts(buildPromptText(input.prompt, input.attachments), input.attachments);
    } catch (error) {
      this.dropBatch(session, batch);
      // Stopped while the attachment was read: the failure concerns nobody.
      if (!this.isLive(session)) return;
      throw error;
    }
    // Stopped (or replaced) while the attachment was read: the thread may
    // belong to another session by now, so this one says and starts nothing.
    if (!this.owns(session, batch) || (typeof prompt === 'string' && !prompt.trim())) {
      this.dropBatch(session, batch);
      return;
    }

    session.status = 'running';
    session.durationStartMs = Date.now();
    session.durationEndMs = undefined;
    session.usage = createEmptyUsage();
    session.costDetails = emptyCostDetails();
    session.currentAssistant = null;
    this.emit({ type: 'status_change', threadId: input.threadId, status: 'running' });

    // The turn loop consumes the runTurn generator for the whole turn; it
    // routes its own failures, so the floating promise never rejects.
    void this.runTurnLoop(session, prompt, session.model, turn);
  }

  /**
   * Run `/compact` as a turn of its own. Compaction rewrites the session, so
   * it cannot join a running turn: it waits for that turn to end first. From
   * now until it has run it is a barrier (see compactBarrier), also when it
   * runs at once: a message sent while it runs, and a second `/compact` sent
   * after that message, then keep the order they were sent in.
   */
  private async compactInTurn(session: ActiveBubbleSession, input: ProviderSendTurnInput): Promise<void> {
    let lift!: () => void;
    const barrier = new Promise<void>((resolve) => { lift = resolve; });
    session.compactBarrier = barrier;
    try {
      for (let batch = session.batch; batch; batch = session.batch) {
        await batch.done;
        if (!this.isLive(session)) return;
      }
      this.openBatch(session);
      this.adoptTurnConfig(session, this.resolveTurnConfig(session, input));
      await this.runCompact(session, session.contextTokens ?? 0);
    } finally {
      if (session.compactBarrier === barrier) session.compactBarrier = null;
      lift();
    }
  }

  /** The values a turn started for this send would run with. */
  private resolveTurnConfig(session: ActiveBubbleSession, input: ProviderSendTurnInput): BubbleTurnConfig {
    const permissionMode = input.bubblePermissionMode || session.permissionMode;
    return {
      model: input.model?.trim() || session.model,
      permissionMode,
      planExitMode: input.bubblePlanExitMode
        ?? (input.bubblePermissionMode && input.bubblePermissionMode !== 'plan'
          ? input.bubblePermissionMode
          : session.planExitMode),
      // Per-turn thinking level: a string switches it; undefined keeps the
      // session's current level (the warm envelope omits it for non-bubble
      // turns and when the composer has no selection — both mean "default").
      thinkingLevel: typeof input.bubbleThinkingLevel === 'string'
        ? input.bubbleThinkingLevel.trim() || undefined
        : session.thinkingLevel,
    };
  }

  /** The session now runs with these values. */
  private adoptTurnConfig(session: ActiveBubbleSession, config: BubbleTurnConfig): void {
    if (config.model && session.model !== config.model) {
      session.contextProviderId = undefined;
      session.nativeContextWindow = undefined;
      session.contextTokens = undefined;
      session.contextWindow = undefined;
      session.model = config.model;
    }
    session.permissionMode = config.permissionMode;
    session.planExitMode = config.planExitMode;
    session.thinkingLevel = config.thinkingLevel;
  }

  async stopSession(threadId: string): Promise<void> {
    // A start still loading the SDK has no session yet: cancel the start.
    this.starting.delete(threadId);
    const session = this.sessions.get(threadId);
    if (!session) {
      return;
    }
    session.status = 'stopped';
    let sdk: BubbleSdkInstance | null = null;
    try {
      sdk = await getBubbleSdk(session.cwd);
    } catch {
      // The SDK never loaded, so nothing runs in it.
    }
    // Replaced while the SDK loaded: the session that took the thread disposed
    // this one, and the thread, and what runs in the SDK by now, are its own.
    if (this.sessions.get(threadId) !== session) {
      return;
    }
    try {
      // Aborting is safe: the SDK auto-rejects pending approvals/questions of
      // the aborted turn, so no adapter-side settlement is required beyond
      // clearing the UI cards below. Turns queued behind the running one go
      // with it (the SDK would run them next otherwise), and steers it has
      // not read yet are dropped: Stop ends everything the turn was given.
      sdk?.stop(session.providerSessionId, { cancelQueued: true });
    } catch {
      // The turn was already idle.
    }
    session.abortController?.abort();
    this.closeBatchHandles(session);
    this.dismissAllRequests(session);
    this.sessions.delete(threadId);
    this.emit({ type: 'status_change', threadId, status: 'stopped' });
  }

  disposeSession(threadId: string): boolean {
    // A start still loading the SDK has no session yet: cancel the start.
    this.starting.delete(threadId);
    const session = this.sessions.get(threadId);
    if (!session) {
      return false;
    }
    // Map entry first so dispose stays idempotent even if teardown throws.
    this.sessions.delete(threadId);
    try {
      session.status = 'stopped';
      // The abort below ends the turns this adapter started. A turn the SDK
      // started for a steer answers to no signal of ours, and a steer still
      // unread could start one later: stop those in the SDK, or they would
      // run on with nobody watching.
      try {
        session.batch?.sdk?.stop(session.providerSessionId, { cancelQueued: true });
      } catch (error) {
        console.warn('[BubbleSdkAdapter] failed to stop the turns of a disposed session:', error);
      }
      session.abortController?.abort();
      this.closeBatchHandles(session);
      // Emits per-requestId permission_dismissed — the one emission dispose
      // allows (clears stranded cards; cannot be misread by stop gates).
      this.dismissAllRequests(session);
    } catch (error) {
      console.warn('[BubbleSdkAdapter] disposeSession cleanup failed:', error);
    }
    return true;
  }

  async stopAll(): Promise<void> {
    this.starting.clear();
    const threadIds = Array.from(this.sessions.keys());
    await Promise.all(threadIds.map((threadId) => this.stopSession(threadId)));
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values()).map((session) => ({
      threadId: session.threadId,
      provider: 'bubble',
      providerSessionId: session.providerSessionId,
      status: session.status,
      model: session.model,
    }));
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: PermissionResult
  ): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`No Bubble session found for thread "${threadId}"`);
    }
    const pending = session.pendingRequests.get(requestId);
    if (!pending) {
      // Stale card (already dismissed by stop/abort) — race-safe no-op.
      return;
    }
    session.pendingRequests.delete(requestId);

    if (pending.kind === 'project_trust') {
      pending.resolve(decision.behavior === 'allow');
      return;
    }
    if (pending.kind === 'approval') {
      pending.resolve(
        decision.behavior === 'allow'
          ? { action: 'approve', ...(decision.message ? { feedback: decision.message } : {}) }
          : { action: 'reject', feedback: decision.message?.trim() || 'Denied by user' }
      );
      return;
    }
    if (pending.kind === 'question') {
      pending.resolve(
        decision.behavior === 'allow' ? buildQuestionAnswers(pending.questions, decision) : null
      );
      return;
    }
    // Plan approval renders as a question card, so "Stay in plan mode" also
    // arrives as behavior:'allow' — only the explicit approve answer may exit
    // plan mode (mirrors the Claude runner's ExitPlanMode check).
    if (decision.behavior !== 'allow') {
      pending.resolve(false);
      return;
    }
    const answers = isRecord(decision.updatedInput?.answers)
      ? (decision.updatedInput.answers as Record<string, unknown>)
      : null;
    const selectedAnswer = answers
      ? Object.values(answers).find(
          (value): value is string => typeof value === 'string' && value.trim().length > 0
        ) || ''
      : '';
    pending.resolve(selectedAnswer === 'Approve and execute');
  }

  /**
   * One-off prompt (environment summaries etc.) on a throwaway session.
   * Bubble persists sessions lazily on the first message, so the temp session
   * is deleted afterwards — otherwise every one-shot would leave a junk
   * entry in the user's Bubble session/resume list.
   */
  async runOneShot(
    input: ProviderSessionStartInput
  ): Promise<{ text: string; sessionId?: string; model?: string }> {
    const cwd = input.cwd || process.cwd();
    const sdk = await getBubbleSdk(cwd);
    this.assertConfigured(sdk);
    const { id } = sdk.createSession({ cwd });
    let text = '';
    let model = input.model?.trim() || undefined;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), ONE_SHOT_TIMEOUT_MS);
    timer.unref?.();
    try {
      const promptText = buildPromptText(input.prompt, input.attachments);
      const prompt = await buildPromptParts(promptText, input.attachments);
      // No approval/question handlers on purpose: the SDK fail-safes them to
      // reject, so a one-shot can never block on an interactive card.
      const stream = sdk.runTurn(id, {
        prompt,
        hostTools: bubbleHostTools(),
        ...(model ? { model } : {}),
        signal: abortController.signal,
        onStart: (info) => {
          assertBubbleSessionReader(prompt, info.tools, id);
          model = info.model || model;
        },
      });
      for await (const event of stream) {
        if (event.type === 'text_delta') {
          text += getString((event as { content?: unknown }).content);
        }
      }
    } finally {
      clearTimeout(timer);
      try {
        await sdk.deleteSession(id);
      } catch (error) {
        console.warn('[BubbleSdkAdapter] failed to delete one-shot session:', error);
      }
    }
    return { text: text.trim(), sessionId: id, model };
  }

  async listSkills(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult> {
    const sdk = await getBubbleSdk(input.cwd);
    const skills = sdk.listSkills(input.cwd);
    return {
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description || undefined,
        path: skill.name,
        enabled: true,
        scope: skill.source || undefined,
      })),
      source: 'bubble-sdk',
    };
  }

  /**
   * User turns the persisted session can rewind to (oldest first). The entry
   * id also names the checkpoint turn, so it doubles as the `/rewind` anchor
   * passed back into `rewind()`.
   */
  async listRewindAnchors(threadId: string): Promise<ProviderRewindAnchor[]> {
    const session = this.sessions.get(threadId);
    if (!session) {
      return [];
    }
    try {
      const sdk = await getBubbleSdk(session.cwd);
      const manager = await getBubbleSessionManager(sdk, session.providerSessionId);
      return manager.listUserTurns().map((turn) => ({
        id: turn.id,
        preview: turn.preview,
        text: turn.text,
      }));
    } catch (error) {
      console.warn('[BubbleSdkAdapter] failed to list rewind anchors:', error);
      return [];
    }
  }

  /**
   * Restore files and/or truncate the persisted session to just before the
   * given anchor (a user-turn entry id). `dryRun` reports what a files rewind
   * would change without executing. The Aegis-side transcript truncation is
   * handled by the IPC layer; this only mutates the SDK's on-disk session.
   */
  async rewind(
    threadId: string,
    anchorId: string,
    scope: 'conversation' | 'files' | 'both',
    dryRun?: boolean
  ): Promise<ProviderRewindResult> {
    const session = this.sessions.get(threadId);
    if (!session) {
      return { ok: false, message: 'No Bubble session found for thread.', filesAvailable: false };
    }

    try {
      const sdk = await getBubbleSdk(session.cwd);
      const manager = await getBubbleSessionManager(sdk, session.providerSessionId);
      const checkpoints = manager.getCheckpoints();

      if (dryRun) {
        const filesChanged = checkpoints.filesTouchedSince?.(anchorId) ?? [];
        return {
          ok: true,
          filesAvailable: true,
          files: { canRewind: true, filesChanged },
          removedPrompt: null,
        };
      }

      let filesOutcome: ProviderRewindResult['files'] = null;
      if (scope === 'files' || scope === 'both') {
        const restored = await checkpoints.restoreTo(anchorId);
        filesOutcome = {
          canRewind: true,
          filesChanged: [...restored.restored, ...restored.deleted],
          ...(restored.failed.length > 0
            ? { error: `Failed to restore: ${restored.failed.join(', ')}` }
            : {}),
        };
      }

      let removedPrompt: string | null = null;
      if (scope === 'conversation' || scope === 'both') {
        const result = manager.rewindToEntry(anchorId);
        if (!result) {
          return {
            ok: false,
            message: 'The rewind anchor was not found in this Bubble session.',
            filesAvailable: true,
            files: filesOutcome,
          };
        }
        removedPrompt = result.targetText || null;
      }

      return { ok: true, filesAvailable: true, files: filesOutcome, removedPrompt };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        filesAvailable: false,
      };
    }
  }

  /**
   * Run manual `/compact` locally: compact the persisted session and emit the
   * same transcript markers Claude Code does (a compact_boundary, then a
   * result that finalizes the turn).
   */
  private async runCompact(session: ActiveBubbleSession, preTokens: number): Promise<void> {
    const batch = session.batch ?? this.openBatch(session);
    // Nothing joins a compaction: a message sent meanwhile runs after it.
    batch.markReady(false);
    session.status = 'running';
    session.durationStartMs = Date.now();
    session.durationEndMs = undefined;
    session.usage = createEmptyUsage();
    session.costDetails = emptyCostDetails();
    session.currentAssistant = null;
    this.emit({ type: 'status_change', threadId: session.threadId, status: 'running' });

    try {
      const sdk = await getBubbleSdk(session.cwd);
      const manager = await getBubbleSessionManager(sdk, session.providerSessionId);
      const estimate = await loadBubbleContextEstimator();
      const config = sdk.getModelConfig();
      const model = session.model || config.defaultModel;
      const providerId = session.contextProviderId
        || (model?.includes(':') ? model.split(':')[0] : config.defaultProviderId);
      if (!session.model && model) session.model = model;
      if (!session.nativeContextWindow && !session.contextWindow && providerId && model) {
        await this.resolveContextWindow(session, providerId, model);
      }
      // Stop can begin before the async SDK/catalog loading has finished.
      const current = this.sessions.get(session.threadId);
      if (current !== session || current.status === 'stopped') return;
      const beforeEstimate = estimate(manager.getMessages(), providerId);
      const plan = manager.getCompactionPlan();
      const compacted = plan ? manager.compact().compacted : false;

      if (compacted) {
        this.compactions.complete(session, { trigger: 'manual', preTokens: preTokens || beforeEstimate });
        const afterEstimate = estimate(manager.getMessages(), providerId);
        // Preserve observed system/tool overhead when a native snapshot exists.
        // This is an estimate until the next provider request reports usage.
        const overhead = Math.max(0, (session.contextTokens ?? beforeEstimate) - beforeEstimate);
        this.updateContextUsage(session, afterEstimate + overhead, undefined, true);
      } else {
        this.emitAssistantText(session, 'Session is already compact enough.');
      }

      this.finishTurn(session, null);
    } catch (error) {
      this.finishTurn(session, error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.dropBatch(session, batch);
    }
  }

  private emitAssistantText(session: ActiveBubbleSession, text: string): void {
    this.emitMessage(session, {
      type: 'assistant',
      uuid: `bubble-assistant:${session.threadId}:${uuidv4()}`,
      createdAt: Date.now(),
      message: { content: [{ type: 'text', text }] },
    });
  }

  // ── Turn loop ──────────────────────────────────────────────────────────

  private async runTurnLoop(
    session: ActiveBubbleSession,
    prompt: string | BubbleContentPart[],
    model: string | undefined,
    turn: symbol
  ): Promise<void> {
    const batch = session.batch ?? this.openBatch(session);
    try {
      const sdk = await getBubbleSdk(session.cwd);
      // Stopped while the SDK loaded: no turn is started for a dead session.
      if (!this.owns(session, batch)) {
        this.dropBatch(session, batch);
        return;
      }
      batch.sdk = sdk;
      const stream = sdk.runTurn(session.providerSessionId, this.turnOptions(session, batch, prompt, {
        model,
        permissionMode: session.permissionMode,
        planExitMode: session.planExitMode,
        thinkingLevel: session.thinkingLevel,
      }, turn));
      // The turn holds the session slot from here, so a steer reaches it.
      session.runningTurn = turn;
      batch.markReady(true);
      for await (const event of stream) {
        // What a stopped turn still sends while it winds down is dropped.
        if (!this.owns(session, batch)) break;
        this.handleBubbleEvent(session, event, turn);
      }
      this.settleBatchWork(session, batch);
    } catch (error) {
      this.failBatch(session, batch, error);
    }
    await batch.done;
  }

  /**
   * Options for a turn this adapter starts. The SDK starts turns of its own
   * with the same options (see steer): their handlers therefore reach this
   * session too, and onStart runs once more for each.
   */
  private turnOptions(
    session: ActiveBubbleSession,
    batch: BubbleBatch,
    prompt: string | BubbleContentPart[],
    config: BubbleTurnConfig,
    /** Names the turn, for telling whose the session's mode is (see modeOwner). */
    turn: symbol,
    /** A turn queued behind another: the session takes its config when it starts, not before. */
    adoptOnStart = false
  ): BubbleRunTurnOptions {
    let started = false;
    const options: BubbleRunTurnOptions = {
      prompt,
      hostTools: bubbleHostTools(session.threadId),
      ...bubbleRoleOptions(session.threadId),
      ...(config.model ? { model: config.model } : {}),
      ...(config.permissionMode ? { mode: config.permissionMode } : {}),
      planExitMode: config.planExitMode ?? 'default',
      onProjectTrust: (request) => this.requestProjectTrust(session, request),
      ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
      signal: batch.abortController.signal,
      onStart: (info) => {
        const own = !started;
        started = true;
        // Stopped as the turn was starting: it is being cancelled, and the
        // thread hears no more of it.
        if (!this.isLive(session)) return;
        if (own) {
          if (adoptOnStart) this.adoptTurnConfig(session, config);
          session.runningTurn = turn;
          assertBubbleSessionReader(prompt, info.tools, session.threadId);
        } else {
          // A turn the SDK started with these options. It runs in the mode
          // they name, even if the turn before it left that mode (an approved
          // plan), so the session says what the turn really runs in.
          this.noteMode(session, info.mode, turn);
        }
        session.model = info.model || session.model;
        session.contextProviderId = info.providerId;
        // Bubble's TokenUsage has no context window; resolve it from the
        // registry catalog so the composer context indicator has a ceiling.
        void this.resolveContextWindow(session, info.providerId, info.model);
        // Announced for a turn this adapter started. One the SDK started is
        // more of the turn before it, on that turn's model: announcing it
        // would put that model back over one picked in the composer since.
        if (!own) return;
        this.emit({
          type: 'system_init',
          threadId: session.threadId,
          sessionId: session.providerSessionId,
          model: session.model,
        });
      },
      onQuestion: (request) => this.requestQuestion(session, request),
      onPlanApproval: (planMarkdown) => this.requestPlanApproval(session, planMarkdown),
    };
    // The gateway's Computer use tools this very turn carries (the SDK reuses
    // these options, host tools included, for the turns it starts itself).
    const computerUseTools = bubbleComputerUseToolNames(options.hostTools ?? []);
    options.onApproval = (request) => this.requestApproval(session, request, computerUseTools);
    return options;
  }

  // ── Messages sent while a turn runs ────────────────────────────────────

  /** The session is still the thread's own and was not stopped. */
  private isLive(session: ActiveBubbleSession): boolean {
    return session.status !== 'stopped' && this.sessions.get(session.threadId) === session;
  }

  /**
   * The batch is still the live session's current one. Checked after every
   * wait: a session stopped or replaced meanwhile must not start anything in
   * the SDK, nor send the thread another event (the thread may have a new
   * session by then, which would take them for its own).
   */
  private owns(session: ActiveBubbleSession, batch: BubbleBatch): boolean {
    return session.batch === batch && this.isLive(session);
  }

  private openBatch(session: ActiveBubbleSession): BubbleBatch {
    let markReady!: (joinable: boolean) => void;
    let markDone!: () => void;
    const ready = new Promise<boolean>((resolve) => { markReady = resolve; });
    const done = new Promise<void>((resolve) => { markDone = resolve; });
    const batch: BubbleBatch = {
      ready, markReady, done, markDone,
      open: 1,
      handedOver: Promise.resolve(),
      placing: new Set(),
      abortController: new AbortController(),
      handles: new Set(),
    };
    session.batch = batch;
    session.abortController = batch.abortController;
    return batch;
  }

  /** Stop reading the session logs of a batch; the loops reading them end. */
  private closeBatchHandles(session: ActiveBubbleSession): void {
    const handles = session.batch?.handles;
    if (!handles) return;
    for (const handle of handles) handle.close();
    handles.clear();
  }

  /** Take the batch off the session. False when it was taken off already. */
  private detachBatch(session: ActiveBubbleSession, batch: BubbleBatch): boolean {
    if (session.batch !== batch) return false;
    this.closeBatchHandles(session);
    session.batch = null;
    if (session.abortController === batch.abortController) session.abortController = null;
    return true;
  }

  /** End a batch that reports nothing itself (no turn ran, or its caller reported). */
  private dropBatch(session: ActiveBubbleSession, batch: BubbleBatch): void {
    if (!this.detachBatch(session, batch)) return;
    batch.markReady(false);
    batch.markDone();
  }

  /** End the batch and report it: one result for everything it ran. */
  private endBatch(session: ActiveBubbleSession, batch: BubbleBatch, error: Error | null): void {
    if (!this.detachBatch(session, batch)) return;
    try {
      // A session stopped or replaced reports no result and no error: Stop
      // already cleared its cards, and whoever listens on the thread now is
      // not waiting for this turn.
      if (this.isLive(session)) {
        this.finishTurn(session, error);
        this.dismissAllRequests(session);
      }
    } finally {
      // Whatever a listener threw, a message waiting on this batch moves on.
      batch.markReady(false);
      batch.markDone();
    }
  }

  /**
   * One failure ends the batch. What is still queued behind the failed turn
   * is cancelled with it: its events would land after the error was reported.
   */
  private failBatch(session: ActiveBubbleSession, batch: BubbleBatch, error: unknown): void {
    if (session.batch !== batch) return;
    // Only while the session is the thread's own: once it was stopped or
    // replaced, Stop already did this, and the SDK session may by now run a
    // turn of the session that took its place.
    if (this.isLive(session)) {
      try {
        batch.sdk?.stop(session.providerSessionId, { cancelQueued: true });
      } catch (stopError) {
        console.warn('[BubbleSdkAdapter] failed to stop the turns of a failed batch:', stopError);
      }
    }
    batch.abortController.abort();
    this.endBatch(session, batch, error instanceof Error ? error : new Error(String(error)));
  }

  /** One piece of the batch's work is done; the last one ends the batch. */
  private settleBatchWork(session: ActiveBubbleSession, batch: BubbleBatch): void {
    if (session.batch !== batch) return;
    batch.open -= 1;
    if (batch.open > 0) return;
    // Every turn this batch knows of has ended, so the SDK should hold none.
    // If it does, nothing here reads that turn: stop it rather than report
    // the session idle while it works on unseen.
    if (batch.sdk && this.isLive(session)) {
      try {
        const state = batch.sdk.getSessionRunState(session.providerSessionId);
        if (state.active || state.queuedTurns > 0) {
          console.warn('[BubbleSdkAdapter] stopping Bubble turns left running after their batch ended:', state);
          batch.sdk.stop(session.providerSessionId, { cancelQueued: true });
        }
      } catch (error) {
        console.warn('[BubbleSdkAdapter] failed to read the Bubble session run state:', error);
      }
    }
    this.endBatch(session, batch, null);
  }

  /**
   * A message sent while the batch runs. It is owed an answer until that
   * settles. Messages are handed to the SDK one after another, in the order
   * they were sent; each then waits for its answer on its own.
   */
  private joinBatch(session: ActiveBubbleSession, batch: BubbleBatch, input: ProviderSendTurnInput): void {
    batch.open += 1;
    const handOver = batch.handedOver.then(() => this.handOver(session, batch, input));
    batch.handedOver = handOver.then(() => undefined, () => undefined);
    void handOver
      .then((answered) => answered?.())
      .then(
        () => this.settleBatchWork(session, batch),
        (error) => this.failBatch(session, batch, error)
      )
      .catch((error) => console.error('[BubbleSdkAdapter] failed to report the end of a turn:', error));
  }

  /**
   * Give a joined message to the SDK: steer it into the running turn, or
   * queue a turn for it. Returns how to wait for its answer (null: there was
   * nothing to send, or nobody left to send it to).
   */
  private async handOver(
    session: ActiveBubbleSession,
    batch: BubbleBatch,
    input: ProviderSendTurnInput
  ): Promise<(() => Promise<void>) | null> {
    const sdk = batch.sdk;
    if (!sdk || !this.owns(session, batch)) return null;
    const text = buildPromptText(input.prompt, input.attachments);
    const hasImages = input.attachments?.some((attachment) => attachment.kind === 'image') === true;
    // A steer is text, and reaches the model as written. Images need a turn
    // of their own, and so does "/skill task", which only runTurn rewrites
    // into the instruction to load that skill. And while a turn waits behind
    // the running one, a steer would be read before it: text sent after that
    // turn's message queues behind it instead.
    const steerable = !hasImages
      && !this.invokesSkill(sdk, session, text)
      && sdk.getSessionRunState(session.providerSessionId).queuedTurns === 0;
    if (steerable) {
      if (!text.trim()) return null;
      // It joins the running turn, which keeps its mode. Another mode it names
      // is for what comes next: from here no running turn's change replaces it.
      if (input.bubbleNamesAnotherMode) session.modeOwner = null;
      return this.steer(session, batch, sdk, text);
    }
    // A turn of its own behind the running one. The session is set to what it
    // was given from now on, so the turns before it no longer speak for the
    // session's mode: a plan approved in one of them is that turn's alone.
    const turn = Symbol('turn');
    session.modeOwner = turn;

    // An earlier steer the running turn does not read gets a turn of its own
    // from the SDK, at the end of the queue. Queue this one once the SDK has
    // placed them all, so it lands behind such a turn, not ahead of it.
    // (None is added meanwhile: the next message waits for this hand-over.)
    await Promise.all([...batch.placing]);
    if (!this.owns(session, batch)) return null;
    const prompt = await buildPromptParts(text, input.attachments);
    if (!this.owns(session, batch)) return null;
    if (typeof prompt === 'string' && !prompt.trim()) return null;
    // Queued in the SDK behind the running turn. Unlike a steer it runs with
    // what the composer said when it was sent, as any turn does.
    const stream = sdk.runTurn(
      session.providerSessionId,
      this.turnOptions(session, batch, prompt, this.resolveTurnConfig(session, input), turn, true)
    );
    return async () => {
      for await (const event of stream) {
        if (!this.owns(session, batch)) return;
        this.handleBubbleEvent(session, event, turn);
      }
    };
  }

  /**
   * Whether runTurn would read the text as "/skill task". The same reading as
   * the SDK's own (skills/invocation.js parseSkillInvocation): the name runs
   * to the first space, which need not follow the slash at once, and
   * something must come after it.
   */
  private invokesSkill(sdk: BubbleSdkInstance, session: ActiveBubbleSession, text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return false;
    const invocation = trimmed.slice(1).trim();
    const space = invocation.indexOf(' ');
    if (space === -1) return false;
    const name = invocation.slice(0, space).trim();
    if (!name || !invocation.slice(space + 1).trim()) return false;
    try {
      return sdk.listSkills(session.cwd).some((skill) => skill.name === name);
    } catch {
      return false;
    }
  }

  /**
   * Steer text into the running turn: the model reads it at its next model
   * call, on the model, mode and thinking level that turn started with. A
   * turn with no model call left cannot take it; the SDK then starts a turn
   * for it, with the running turn's options, which the returned wait follows.
   * The steer itself is given to the SDK before this returns.
   */
  private steer(session: ActiveBubbleSession, batch: BubbleBatch, sdk: BubbleSdkInstance, text: string): () => Promise<void> {
    const handle = sdk.openSession(session.providerSessionId);
    batch.handles.add(handle);
    // A turn the SDK starts for this text runs on the options of the turn it joined.
    const joined = session.runningTurn;
    const release = () => {
      batch.handles.delete(handle);
      handle.close();
    };
    let from: number;
    let placed: Promise<BubbleSteerOutcome>;
    try {
      // Read before steering: a turn started for this text logs after here.
      from = handle.latestSequence;
      const receipt = sdk.steer(session.providerSessionId, text);
      if (!receipt.accepted) {
        throw new Error(`Bubble did not take the message sent to the running turn (${receipt.reason}).`);
      }
      placed = receipt.outcome;
    } catch (error) {
      release();
      throw error;
    }
    batch.placing.add(placed);
    const unplace = () => { batch.placing.delete(placed); };
    placed.then(unplace, unplace);
    return async () => {
      try {
        const outcome = await placed;
        if (outcome.type === 'input_queued') {
          await this.followTurn(session, batch, handle, from, outcome.turnId, joined);
        } else if (outcome.type === 'input_rejected' && outcome.reason === 'no_continuation') {
          // The running turn ended without reading it and no turn could be
          // started for it. (A turn that failed or was stopped reports itself.)
          throw new Error('Bubble could not start a turn for the message sent to the running turn.');
        }
      } finally {
        release();
      }
    };
  }

  /**
   * Read one turn out of the session log: a turn the SDK started, which has
   * no iterator of its own. Its last record carries how it ended.
   */
  private async followTurn(
    session: ActiveBubbleSession,
    batch: BubbleBatch,
    handle: BubbleSessionHandle,
    from: number,
    turnId: string,
    /** The turn whose options the SDK started this one with. */
    turn: symbol | undefined
  ): Promise<void> {
    for await (const record of handle.eventsFrom(from)) {
      if (!this.owns(session, batch)) return;
      if (record.turnId !== turnId) continue;
      this.handleBubbleEvent(session, record.event, turn);
      if (!record.terminal) continue;
      if (record.terminal.kind === 'failed') {
        throw new Error(record.terminal.message || 'Bubble turn failed.');
      }
      return;
    }
  }

  /** The mode a turn runs in, when the session was not the one to choose it. */
  private noteMode(session: ActiveBubbleSession, mode: string, turn: symbol | undefined): void {
    if (mode !== 'default' && mode !== 'plan' && mode !== 'bypassPermissions') return;
    if ((session.permissionMode ?? 'default') === mode) return;
    session.permissionMode = mode;
    if (mode !== 'plan') session.planExitMode = mode;
    this.emit({ type: 'permission_mode_changed', threadId: session.threadId, provider: 'bubble', mode, ...this.modeSuperseded(session, turn) });
  }

  /**
   * Whether a mode change in `turn` is still the session's to follow (see
   * modeOwner). The turn runs in its new mode either way.
   */
  private modeSuperseded(session: ActiveBubbleSession, turn: symbol | undefined): { supersededBy?: 'turn' | 'message' } {
    if (session.modeOwner === undefined || session.modeOwner === turn) return {};
    return { supersededBy: session.modeOwner === null ? 'message' : 'turn' };
  }

  private handleBubbleEvent(session: ActiveBubbleSession, event: BubbleAgentEvent, turn?: symbol): void {
    switch (event.type) {
      case 'context_usage':
        this.updateContextUsage(session, getNumber(event.usedTokens), getNumber(event.contextWindow), event.estimated === true);
        return;
      case 'context_compaction': {
        const details = { id: getString(event.compactionId) || undefined, preTokens: getNumber(event.preTokens) };
        if (event.status === 'started') {
          this.flushAssistant(session, 'commentary');
          this.compactions.start(session, details);
        } else if (event.status === 'completed') {
          this.flushAssistant(session, 'commentary');
          this.compactions.complete(session, details);
          this.updateContextUsage(session, getNumber(event.postTokens), getNumber(event.contextWindow), true);
        } else if (event.status === 'failed') {
          this.compactions.interrupt(session, details.id);
        }
        return;
      }
      case 'text_delta':
      case 'reasoning_delta': {
        const delta = getString((event as { content?: unknown }).content);
        if (!delta) {
          return;
        }
        const accumulator = this.ensureCurrentAssistant(session);
        if (event.type === 'reasoning_delta') {
          accumulator.thinking += delta;
        } else {
          accumulator.text += delta;
        }
        this.emitMessage(session, {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta:
              event.type === 'reasoning_delta'
                ? { type: 'thinking_delta', thinking: delta }
                : { type: 'text_delta', text: delta },
          },
        });
        return;
      }
      case 'tool_call_delta': {
        const toolEvent = event as Extract<BubbleAgentEvent, { type: 'tool_call_delta' }>;
        session.widgetDrafts ??= new WidgetDraftTracker((draft) => this.emitMessage(session, draft));
        session.widgetDrafts.replace(toolEvent.id, toolEvent.arguments, toolEvent.name);
        return;
      }
      case 'tool_call_end': {
        const toolEvent = event as Extract<BubbleAgentEvent, { type: 'tool_call_end' }>;
        session.widgetDrafts?.end(toolEvent.id);
        this.handleToolUse(
          session,
          toolEvent.id,
          toolEvent.name,
          parseToolArguments(toolEvent.arguments)
        );
        return;
      }
      case 'tool_start': {
        const toolEvent = event as Extract<BubbleAgentEvent, { type: 'tool_start' }>;
        this.handleToolUse(session, toolEvent.id, toolEvent.name, toolEvent.args);
        return;
      }
      case 'tool_end': {
        const toolEvent = event as Extract<BubbleAgentEvent, { type: 'tool_end' }>;
        this.handleToolResult(session, toolEvent.id, toolEvent.result);
        return;
      }
      case 'turn_end': {
        const turnEvent = event as Extract<BubbleAgentEvent, { type: 'turn_end' }>;
        this.flushAssistant(session, turnEvent.willContinue === false ? 'final_answer'
          : turnEvent.willContinue === true ? 'commentary' : undefined);
        const usage = usageFromBubble(turnEvent.usage, session.nativeContextWindow ?? session.contextWindow);
        addUsage(session.usage, usage);
        // Per-step priced usage; hosts sum them. The unified result field is
        // USD-labelled, so non-USD costs are dropped rather than mislabelled.
        const cost = turnEvent.cost;
        addAgentCost(session.costDetails, 'bubble', session.model || '', usage,
          cost?.currency === 'USD' ? cost.cost : undefined);
        return;
      }
      case 'mode_changed': {
        // Plan approval restores the execution mode mid-turn; report it
        // so the composer's plan pill exits like Claude's does.
        const mode = getString((event as { mode?: unknown }).mode);
        if (mode === 'default' || mode === 'plan' || mode === 'bypassPermissions') {
          session.permissionMode = mode;
          if (mode !== 'plan') session.planExitMode = mode;
          this.emit({
            type: 'permission_mode_changed',
            threadId: session.threadId,
            provider: 'bubble',
            mode,
            ...this.modeSuperseded(session, turn),
          });
        }
        return;
      }
      // What became of a steer is read from its receipt (see steer); the
      // prompt itself is in the transcript since it was sent.
      case 'input_applied':
      case 'input_queued':
      case 'input_rejected':
      case 'input_pending_changed':
        return;
      case 'subagent_update': {
        // Flattened payload: the fields live at the event top level
        // (drainToolUpdates yields buildSubagentUpdate's return as-is).
        this.handleSubagentUpdate(session, event as unknown as BubbleSubagentUpdate);
        return;
      }
      case 'tool_update': {
        // Spawn/wait tool execution drains child progress as tool_update
        // frames — update carries the SAME flattened subagent payload.
        const toolEvent = event as Extract<BubbleAgentEvent, { type: 'tool_update' }>;
        const update = toolEvent.update as unknown as BubbleSubagentUpdate | undefined;
        if (update && typeof update.parentToolCallId === 'string') {
          this.handleSubagentUpdate(session, update);
        }
        return;
      }
      // Other event kinds (hooks / retries / future additions) have no UI
      // mapping yet and fall through untouched.
      default:
        return;
    }
  }

  /**
   * Nest one SDK subagent lifecycle frame under its spawning tool_use id so
   * the existing subagent board / SubagentPanel (Claude/Codex/Kimi parity)
   * picks it up without provider-specific UI. The child's own events arrive
   * re-keyed (their ids are unique per session), so we can emit them as
   * nested messages with `parentToolUseId` — same wire shape Kimi uses.
   */
  private handleSubagentUpdate(session: ActiveBubbleSession, update: BubbleSubagentUpdate): void {
    const parentToolCallId = getString(update.parentToolCallId);
    if (!parentToolCallId) return;
    if (!session.subagentStartedAt.has(parentToolCallId)) {
      session.subagentStartedAt.set(parentToolCallId, Date.now());
    }

    // The spawning tool_use card may not have landed yet (queued frames can
    // race the main-loop tool_call_end) — the standard handleToolUse emits it.
    const child = update.childEvent;
    if (child && (child.type === 'text_delta' || child.type === 'reasoning_delta')) {
      const delta = getString((child as { content?: unknown }).content);
      if (delta) {
        let stream = session.subagentStreams.get(parentToolCallId);
        if (!stream) {
          stream = { text: '', thinking: '', toolCallIds: new Set() };
          session.subagentStreams.set(parentToolCallId, stream);
        }
        if (child.type === 'reasoning_delta') stream.thinking += delta;
        else stream.text += delta;
      }
    } else if (child && (child.type === 'tool_start' || child.type === 'tool_call_end')) {
      // Flush narration buffered before the child's first tool card.
      this.flushSubagentStream(session, parentToolCallId);
      const childToolId = getString((child as { id?: unknown }).id);
      const childToolName = getString((child as { name?: unknown }).name);
      if (childToolId && childToolName) {
        // flush deleted the stream above — re-create it so subsequent frames
        // (and the matching tool_end) still have a lane. Without this the
        // tool_use card never emitted and tool_end produced an orphan result.
        let stream = session.subagentStreams.get(parentToolCallId);
        if (!stream) {
          stream = { text: '', thinking: '', toolCallIds: new Set() };
          session.subagentStreams.set(parentToolCallId, stream);
        }
        if (!stream.toolCallIds.has(childToolId)) {
          stream.toolCallIds.add(childToolId);
          this.emitMessage(session, {
            type: 'assistant',
            uuid: `bubble-sub-tool-use:${session.threadId}:${childToolId}`,
            parentToolUseId: parentToolCallId,
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: childToolId,
                  name: normalizeToolName(childToolName),
                  input: isRecord((child as { args?: unknown }).args)
                    ? ((child as { args?: unknown }).args as Record<string, unknown>)
                    : {},
                },
              ],
            },
          });
        }
      }
    } else if (child && child.type === 'tool_end') {
      const childToolId = getString((child as { id?: unknown }).id);
      const childResult = (child as { result?: { content?: unknown; isError?: boolean } }).result;
      if (childToolId) {
        this.emitMessage(session, {
          type: 'user',
          uuid: `bubble-sub-tool-result:${session.threadId}:${childToolId}:${uuidv4()}`,
          parentToolUseId: parentToolCallId,
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: childToolId,
                content: getString(childResult?.content),
                is_error: childResult?.isError === true,
              },
            ],
          },
        });
      }
    }

    // Terminal statuses commit the lane's buffered narration (the child's
    // final summary arrives as `message`/summaryDelta, not as text_delta) and
    // release the held spawn tool_result so the UI lane flips to done NOW,
    // not at spawn time.
    if (
      update.status === 'completed' ||
      update.status === 'failed' ||
      update.status === 'cancelled' ||
      update.status === 'blocked'
    ) {
      this.flushSubagentStream(session, parentToolCallId);
      const held = session.heldSpawnResults.get(parentToolCallId);
      if (held) {
        session.heldSpawnResults.delete(parentToolCallId);
        this.emitToolResult(session, parentToolCallId, held);
      }
    }
  }

  /** Commit a subagent lane's accumulated thinking/text as nested messages. */
  private flushSubagentStream(session: ActiveBubbleSession, parentToolCallId: string): void {
    const stream = session.subagentStreams.get(parentToolCallId);
    if (!stream) return;
    session.subagentStreams.delete(parentToolCallId);
    if (stream.thinking) {
      this.emitMessage(session, {
        type: 'assistant',
        uuid: `bubble-sub-thinking:${session.threadId}:${parentToolCallId}:${uuidv4()}`,
        parentToolUseId: parentToolCallId,
        message: { content: [{ type: 'thinking', thinking: stream.thinking }] },
      });
    }
    if (stream.text) {
      this.emitMessage(session, {
        type: 'assistant',
        uuid: `bubble-sub-assistant:${session.threadId}:${parentToolCallId}:${uuidv4()}`,
        parentToolUseId: parentToolCallId,
        message: { content: [{ type: 'text', text: stream.text }] },
      });
    }
  }

  private handleToolUse(
    session: ActiveBubbleSession,
    toolCallId: string,
    toolName: string,
    args: unknown
  ): void {
    if (!toolCallId || session.emittedToolCallIds.has(toolCallId)) {
      return;
    }
    // Ordering: the transcript expects the assistant text that preceded the
    // tool call to land before the tool_use card.
    this.flushAssistant(session);
    session.emittedToolCallIds.add(toolCallId);
    session.toolNames.set(toolCallId, toolName);
    this.emitMessage(session, {
      type: 'assistant',
      uuid: `bubble-tool-use:${session.threadId}:${toolCallId}`,
      message: {
        content: [
          {
            type: 'tool_use',
            id: toolCallId,
            name: normalizeToolName(toolName),
            input: isRecord(args) ? args : { value: args },
          },
        ],
      },
    });
  }

  private handleToolResult(
    session: ActiveBubbleSession,
    toolCallId: string,
    result: { content?: string; isError?: boolean }
  ): void {
    if (!toolCallId || session.emittedToolResultIds.has(toolCallId)) {
      return;
    }
    session.emittedToolResultIds.add(toolCallId);
    // Fire-and-forget spawn: hold the result until the lane's terminal
    // subagent_update so the UI lane stays pending/running while the child
    // works (Claude's Task resolves only when the child finishes; Bubble's
    // spawn_agent returns "Spawned X (queued)" immediately).
    const toolName = (session.toolNames.get(toolCallId) || '').toLowerCase();
    if (toolName === 'spawn_agent' || toolName === 'run_workflow') {
      session.heldSpawnResults.set(toolCallId, result);
      return;
    }
    this.emitToolResult(session, toolCallId, result);
  }

  /** Emit a (possibly held) tool_result — shared by the direct path and the
   * subagent terminal release. */
  private emitToolResult(
    session: ActiveBubbleSession,
    toolCallId: string,
    result: { content?: string; isError?: boolean }
  ): void {
    this.emitMessage(session, {
      type: 'user',
      uuid: `bubble-tool-result:${session.threadId}:${toolCallId}:${uuidv4()}`,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: getString(result?.content),
            is_error: result?.isError === true,
            ...this.computerUseMedia(session, toolCallId),
          },
        ],
      },
    });
  }

  /** The screenshots a Computer use call saved, so the transcript keeps them for the Environment strip. */
  private computerUseMedia(
    session: ActiveBubbleSession,
    toolCallId: string
  ): { mediaRefs?: import('../../../shared/computer-use').ComputerUseMediaRef[] } {
    if (!computerUseGatewayTool(session.toolNames.get(toolCallId))) return {};
    const mediaRefs = getComputerUseGateway()?.takeMediaRefs(session.threadId, toolCallId) || [];
    return mediaRefs.length > 0 ? { mediaRefs } : {};
  }

  private flushAssistant(session: ActiveBubbleSession, phase?: 'commentary' | 'final_answer'): void {
    const accumulator = session.currentAssistant;
    if (!accumulator) {
      return;
    }
    session.currentAssistant = null;
    const blocks: ContentBlock[] = [];
    if (accumulator.thinking) {
      blocks.push({ type: 'thinking', thinking: accumulator.thinking });
    }
    if (accumulator.text) {
      blocks.push({ type: 'text', text: accumulator.text });
    }
    if (blocks.length === 0) {
      return;
    }
    this.emitMessage(session, {
      type: 'assistant',
      uuid: accumulator.uuid,
      phase,
      createdAt: accumulator.createdAt,
      message: { content: blocks },
    });
  }

  private finishTurn(session: ActiveBubbleSession, error: Error | null): void {
    this.flushAssistant(session);
    session.widgetDrafts?.reset();
    // Safety net: commit any subagent lane that never saw its terminal frame
    // (interrupt, transport error) so its buffered narration isn't lost — and
    // release any spawn results still held (their child never reported a
    // terminal status; leaving them held would strand the UI lane pending).
    for (const parentToolCallId of [...session.subagentStreams.keys()]) {
      this.flushSubagentStream(session, parentToolCallId);
    }
    for (const [toolCallId, held] of [...session.heldSpawnResults.entries()]) {
      session.heldSpawnResults.delete(toolCallId);
      this.emitToolResult(session, toolCallId, held);
    }
    if (session.status === 'stopped') {
      return;
    }
    session.durationEndMs = Date.now();
    if (error) {
      session.status = 'error';
      this.emitResult(session, 'error');
      this.emit({ type: 'status_change', threadId: session.threadId, status: 'error' });
      this.emit({ type: 'error', threadId: session.threadId, error });
      return;
    }
    session.status = 'completed';
    this.emitResult(session);
    this.emit({ type: 'status_change', threadId: session.threadId, status: 'completed' });
  }

  private emitResult(session: ActiveBubbleSession, subtype = 'success'): void {
    this.emitMessage(session, {
      type: 'result',
      subtype,
      duration_ms: Math.max(0, (session.durationEndMs || Date.now()) - session.durationStartMs),
      ...costFields(session.costDetails),
      usage: session.usage,
      model: session.model,
    });
  }

  private ensureCurrentAssistant(session: ActiveBubbleSession): BubbleAssistantAccumulator {
    if (session.currentAssistant) {
      return session.currentAssistant;
    }
    session.currentAssistant = {
      uuid: `bubble-assistant:${session.threadId}:${uuidv4()}`,
      text: '',
      thinking: '',
      createdAt: Date.now(),
    };
    return session.currentAssistant;
  }

  // ── Approvals / questions / plan mode ──────────────────────────────────

  private requestApproval(
    session: ActiveBubbleSession,
    request: BubbleApprovalRequest,
    /** The gateway's Computer use tools registered in the turn that asks. */
    computerUseTools: ReadonlySet<string>
  ): Promise<BubbleApprovalDecision> {
    if (session.status === 'stopped' || this.sessions.get(session.threadId) !== session) {
      return Promise.resolve({ action: 'reject', feedback: 'Session is no longer active.' });
    }
    if (isProjectFileApproval(session.threadId, session.cwd, session.permissionMode, request)) {
      return Promise.resolve({ action: 'approve' });
    }
    // Computer use asks through its own card, in the gateway. Only for a
    // tool this turn registered: the same name in a turn without it is an
    // MCP server's tool, which the gateway never sees.
    if (isBubbleComputerUseApproval(request, computerUseTools)) {
      return Promise.resolve({ action: 'approve' });
    }
    const requestId = uuidv4();
    const input = buildApprovalInput(request);
    return new Promise<BubbleApprovalDecision>((resolve) => {
      session.pendingRequests.set(requestId, { kind: 'approval', resolve });
      this.emit({
        type: 'permission_request',
        threadId: session.threadId,
        requestId,
        toolName: input.toolName,
        input,
      });
    });
  }

  private requestQuestion(
    session: ActiveBubbleSession,
    request: BubbleQuestionRequest
  ): Promise<string[][] | null> {
    if (session.status === 'stopped' || this.sessions.get(session.threadId) !== session) {
      return Promise.resolve(null);
    }
    const requestId = request.id || uuidv4();
    const input = buildQuestionInput(request);
    if (input.questions.length === 0) {
      return Promise.resolve(null);
    }
    return new Promise<string[][] | null>((resolve) => {
      session.pendingRequests.set(requestId, {
        kind: 'question',
        questions: request.questions,
        resolve,
      });
      this.emit({
        type: 'permission_request',
        threadId: session.threadId,
        requestId,
        toolName: 'AskUserQuestion',
        input,
      });
    });
  }

  private requestProjectTrust(session: ActiveBubbleSession, request: BubbleProjectTrustRequest): Promise<boolean> {
    if (session.status === 'stopped' || this.sessions.get(session.threadId) !== session) return Promise.resolve(false);
    const requestId = uuidv4();
    const capabilities = [
      ...request.pending.allow.map(rule => `Permission rule: ${rule}`),
      ...request.pending.mcpServers.map(name => `MCP server: ${name}`),
      ...request.pending.lspServers.map(name => `LSP server: ${name}`),
    ];
    return new Promise(resolve => {
      session.pendingRequests.set(requestId, { kind: 'project_trust', resolve });
      this.emit({ type: 'permission_request', threadId: session.threadId, requestId,
        toolName: 'ProjectTrust', input: {
          kind: 'acp-permission', provider: 'bubble', toolName: 'ProjectTrust',
          title: 'Trust Bubble project configuration',
          question: `Trust the configuration in ${request.cwd}?\n${capabilities.join('\n')}\nApproval remembers this exact configuration; changes require trust again.`,
          options: [
            { optionId: 'approve', name: 'Trust configuration', kind: 'allow_once' },
            { optionId: 'reject', name: 'Keep disabled', kind: 'reject_once' },
          ],
          toolCall: request,
        },
      });
    });
  }

  private updateContextUsage(session: ActiveBubbleSession, usedTokens?: number, contextWindow?: number, estimated = false): void {
    if (contextWindow !== undefined && contextWindow > 0) session.nativeContextWindow = contextWindow;
    if (usedTokens === undefined || usedTokens < 0) return;
    session.contextTokens = Math.round(usedTokens);
    this.emitMessage(session, {
      type: 'system', subtype: 'token_usage', uuid: uuidv4(),
      session_id: session.providerSessionId, provider: 'bubble', model: session.model,
      usage: { estimated, inputTokens: session.contextTokens, outputTokens: 0, cachedInputTokens: 0,
        reasoningOutputTokens: 0, totalTokens: session.contextTokens,
        contextWindow: session.nativeContextWindow ?? session.contextWindow ?? 0 },
    });
  }

  private requestPlanApproval(session: ActiveBubbleSession, planMarkdown: string): Promise<boolean> {
    if (session.status === 'stopped' || this.sessions.get(session.threadId) !== session) {
      return Promise.resolve(false);
    }
    const requestId = uuidv4();
    return new Promise<boolean>((resolve) => {
      session.pendingRequests.set(requestId, { kind: 'plan', resolve });
      this.emit({
        type: 'permission_request',
        threadId: session.threadId,
        requestId,
        toolName: 'ExitPlanMode',
        input: {
          plan: planMarkdown,
          questions: [
            {
              header: 'Plan approval',
              question: 'Approve this plan and let Bubble start implementing it?',
              options: [
                {
                  label: 'Approve and execute',
                  description: 'Exit plan mode and continue with implementation.',
                },
                {
                  label: 'Stay in plan mode',
                  description: 'Keep planning without executing tools yet.',
                },
              ],
            },
          ],
        },
      });
    });
  }

  private dismissAllRequests(session: ActiveBubbleSession): void {
    for (const [requestId, pending] of session.pendingRequests) {
      this.emit({ type: 'permission_dismissed', threadId: session.threadId, requestId });
      if (pending.kind === 'approval') {
        pending.resolve({ action: 'reject', feedback: 'Session stopped.' });
      } else if (pending.kind === 'question') {
        pending.resolve(null);
      } else {
        pending.resolve(false);
      }
    }
    session.pendingRequests.clear();
  }

  // ── Context window resolution ──────────────────────────────────────────

  /** modelString → contextWindow (null = looked up, catalog has none). */
  private static contextWindowCache = new Map<string, number | null>();

  private async resolveContextWindow(
    session: ActiveBubbleSession,
    providerId: string,
    model: string
  ): Promise<void> {
    const key = `${providerId}:${model}`;
    const cached = BubbleSdkAdapter.contextWindowCache.get(key);
    if (cached !== undefined) {
      session.contextWindow = cached;
      return;
    }
    let contextWindow: number | null = null;
    try {
      const sdk = await getBubbleSdk(session.cwd);
      const profile = sdk.registry.getEnabled().find((entry) => entry.id === providerId);
      if (profile) {
        const models = (await sdk.registry.listModels(profile)) || [];
        const bareModel = model.startsWith(`${providerId}:`)
          ? model.slice(providerId.length + 1)
          : model;
        const match = models.find(
          (entry) => entry.id === model || entry.id === bareModel
        );
        contextWindow =
          typeof match?.contextWindow === 'number' && match.contextWindow > 0
            ? match.contextWindow
            : null;
      }
    } catch (error) {
      console.warn('[BubbleSdkAdapter] failed to resolve model context window:', error);
      return; // Leave uncached so a later turn can retry.
    }
    BubbleSdkAdapter.contextWindowCache.set(key, contextWindow);
    session.contextWindow = contextWindow;
  }

  // ── Session resolution ─────────────────────────────────────────────────

  /**
   * Bubble sessions persist lazily (nothing on disk before the first
   * message), so an unknown resume id just means "start fresh". A known id
   * resolves through the SDK's on-disk index regardless of host restarts.
   */
  private resolveSessionId(
    sdk: BubbleSdkInstance,
    resumeSessionId: string | undefined,
    cwd: string
  ): string {
    const normalized = resumeSessionId?.trim();
    if (normalized) {
      try {
        const match = sdk.listSessions().find((summary) => summary.name === normalized);
        if (match) {
          return normalized;
        }
        console.warn('[BubbleSdkAdapter] Bubble session not found on disk, creating a new one:', normalized);
      } catch (error) {
        console.warn('[BubbleSdkAdapter] failed to list Bubble sessions for resume:', error);
      }
    }
    return sdk.createSession({ cwd }).id;
  }

  private assertConfigured(sdk: BubbleSdkInstance): void {
    let configured = false;
    try {
      const config = sdk.getModelConfig();
      configured = config.providers.some((provider) => provider.hasApiKey);
    } catch (error) {
      throw new Error(
        `Bubble configuration could not be read: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!configured) {
      throw new Error(
        'Bubble has no configured provider credentials. Run `bubble` in a terminal once to configure a provider/API key.'
      );
    }
  }

  private emitMessage(session: ActiveBubbleSession, message: StreamMessage): void {
    this.emit({ type: 'message', threadId: session.threadId, message });
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
