import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import {
  ANTIGRAVITY_ACP_CLIENT_INFO,
  buildAntigravityEnv,
  buildAntigravityLoginCommand,
  isAntigravityAuthError,
  noteAntigravityAuthState,
  resolveAntigravityBinary,
} from '../antigravity-cli';
import { costFields, emptyCostDetails } from '../agent-cost';
import { AcpJsonRpcClient, AcpJsonRpcError, type AcpJsonRpcIncomingRequest } from './acp-json-rpc-client';
import { trimCommonLines } from '../../../shared/unified-diff';
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
  AcpPermissionInput,
  AcpPermissionOption,
  Attachment,
  PermissionResult,
  PlanStepStatus,
  ProviderComposerCapabilities,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
} from '../../../shared/types';

/**
 * Google Antigravity over ACP (`agy acp`, JSON-RPC on stdio), the way an
 * editor drives it: Aegis starts the unmodified binary in the project folder
 * and a person types every prompt. Verified against agy 1.5.14:
 * - ACP v1. The client advertises no fs/terminal capabilities, so agy reads,
 *   edits and runs commands itself and reports each call as tool_call updates.
 * - Model and thinking level are session config options (`model`,
 *   `thought_level`); the approval mode is the ACP session mode (`default`,
 *   `accept-edits`, `auto`, `plan`). All apply live, and all are offered by
 *   agy per session: nothing here names a model or a mode.
 * - session/resume reattaches a session in a new process without replaying
 *   it, but on agy's default model, so the composer's choice is applied again.
 * - A tool approval's toolCall carries the tool call's own id, and a `diff`
 *   content entry for edits. Options are allow / deny.
 * - The prompt response carries the turn's token usage. agy reports no cost.
 * - A command that outlives its wait goes on in the background: the prompt
 *   turn ends with its call still open, and when the command is done agy goes
 *   on by itself, sending thoughts, text and tool calls outside any prompt.
 *   ACP has no word for such a turn, so its start and end are read off the
 *   updates (see openSelfTurn). Every model step ends with a `usage_update`;
 *   a step that calls tools sends the first call within 60 ms of it.
 * - agy exits by itself when its input closes.
 *
 * Usage boundary (Antigravity Additional Terms, and Google's answer in
 * google-antigravity/antigravity-cli#1493): with a personal Google sign-in,
 * agy may be driven by an interactive client whose session a person drives
 * directly, and may not be a backend worker for another agent, a loop or a
 * queue. So this adapter has no one-shot entry point, attaches no Aegis
 * tools to the session, reads nothing of agy's but this ACP connection, and
 * the host refuses every prompt a person did not type (antigravity-policy).
 */

type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

type AntigravitySessionUpdate = Record<string, unknown> & { sessionUpdate?: unknown };

interface AntigravityToolCall {
  name: string;
  title: string;
  /**
   * What agy sent for the call so far, without its `content`: a diff there
   * holds the whole file twice, and is read once (see `edit`) and not kept.
   */
  source: Record<string, unknown>;
  /** The edit read off the call's diff. */
  edit?: { oldText: string; newText: string };
  input: Record<string, unknown>;
  createdAt: number;
  output: string;
  settled: boolean;
  /** Settled only because its turn ended: the command may still report back. */
  placeholder?: boolean;
  resultAt?: number;
}

export interface AntigravityTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

interface AntigravityTurn {
  startedAt: number;
  /** Set once session/prompt is written: only then can agy have used tokens. */
  promptSent: boolean;
  refused: boolean;
  error?: Error;
  usage: AntigravityTurnUsage | null;
  done: Promise<void>;
  resolveDone: () => void;
}

interface SelfStartedTurn {
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  /** The model's last step is over (a usage_update), and it has not spoken or called a tool since. */
  stepEnded: boolean;
  /** Calls the current step made that have not finished: the model waits for them. */
  waitingFor: Set<string>;
}

interface ActiveAntigravitySession {
  threadId: string;
  providerSessionId: string;
  status: ProviderSessionStatus;
  cwd: string;
  model?: string;
  /** The model the session opened on: what an empty (Default) request returns to. */
  defaultModel?: string;
  /** Models, thinking levels and modes this session offers, with agy's names. */
  modelLabels: Map<string, string>;
  thoughtLevel?: string;
  thoughtLevelLabels: Map<string, string>;
  modeIds: Set<string>;
  currentMode?: string;
  /** Last requested values agy rejected; not retried every turn. */
  rejectedModel?: string;
  rejectedMode?: string;
  /** What the composer asked for; reconciled before every turn. */
  requestedThoughtLevel?: string;
  requestedMode?: string;
  /** A set_mode of ours is in flight: its current_mode_update is not agy's own switch. */
  settingMode?: boolean;
  imagePrompts: boolean;
  proc: ChildProcessWithoutNullStreams;
  rpc: AcpJsonRpcClient;
  stderrTail: string[];
  currentAssistant?: { uuid: string; text: string; createdAt: number; blockIndex: number };
  currentThinking?: { uuid: string; thinking: string; createdAt: number; blockIndex: number };
  nextBlockIndex: number;
  lastCommandsSignature?: string;
  lastTitle?: string;
  toolCalls: Map<string, AntigravityToolCall>;
  turn?: AntigravityTurn;
  /** A turn agy started by itself, between prompts. */
  selfTurn?: SelfStartedTurn;
  /** The host said a prompt is coming: until then (or this time) nothing agy sends opens a turn. */
  promptDueBy?: number;
  /** Settles when the latest queued turn has ended; turns never overlap. */
  turnChain: Promise<void>;
  /** agy exited outside a stop; the next turn reconnects and resumes. */
  dead?: { code: number | null; signal: NodeJS.Signals | null };
  /** Sends waiting behind the running turn. */
  queued: number;
  /** A stop is waiting for the cancelled turn's usage; nothing more is reported as a result. */
  stopping?: boolean;
  /** The process a reconnect is starting, so a stop can end it mid-start. */
  connectingProc?: ChildProcessWithoutNullStreams;
  /**
   * The batch of turns not yet reported: sends that queued behind a running
   * turn end in one result, so the session never reads idle between them.
   */
  carry?: { startedAt: number; refused: boolean; error?: Error; usage: AntigravityTurnUsage | null };
}

/** An in-flight startSession; stop/dispose cancel it and end its process. */
interface PendingStart {
  cancelled: boolean;
  proc?: ChildProcessWithoutNullStreams;
}

interface AntigravityConnection {
  proc: ChildProcessWithoutNullStreams;
  rpc: AcpJsonRpcClient;
  binding: SessionBinding;
  imagePrompts: boolean;
  providerSessionId: string;
  sessionRecord: Record<string, unknown> | null;
  stderrTail: string[];
}

/** Startup state that arrives before the session is bound, applied once it is. */
interface SessionBinding {
  /** The process this connection reads: a session listens to its current one only. */
  proc: ChildProcessWithoutNullStreams;
  session?: ActiveAntigravitySession;
  commands?: AntigravitySessionUpdate;
  usage?: AntigravitySessionUpdate;
  /** session/load replays the transcript as updates; Aegis already has it. */
  replaying?: boolean;
}

const CAPABILITIES: ProviderAdapterCapabilities = {
  // agy switches model, thinking level and mode on a live session.
  sessionModelSwitch: true,
  // Skills arrive as slash commands over ACP; there is no skill library to list.
  skillDiscovery: false,
  pluginDiscovery: false,
  // agy does not advertise HTTP MCP servers over ACP, and Aegis attaches none.
  mcpServers: false,
  imageAttachments: true,
  forkThread: false,
  compactThread: false,
  planMode: true,
};

/** How long a stop waits for the cancelled turn to report what it used. */
const STOP_GRACE_MS = 1500;
/**
 * A turn agy started by itself is over when a model step has ended and no
 * tool call followed. agy sends the call within 60 ms of the step's
 * `usage_update`; this waits much longer than that before calling it the end.
 */
const SELF_TURN_SETTLE_MS = 2000;
/** With no step running a tool, this long without a word from agy ends such a turn too. */
const SELF_TURN_IDLE_MS = 120_000;
/** How long agy's own work stays turnless after the host announced a prompt that then never came. */
const PROMPT_HANDOVER_MS = 30_000;
/** Calls kept because they may still report back after their turn (background commands). */
const MAX_KEPT_CALLS = 32;
const STDERR_TAIL_LINES = 12;

/** agy tools seen on the wire, mapped to the Claude-shaped names the transcript renders richly. */
const ANTIGRAVITY_TOOL_NAMES: Record<string, string> = {
  run_command: 'Bash',
  write_file: 'Write',
};

/** Every other tool is named by its ACP tool kind. */
const ACP_KIND_TOOL_NAMES: Record<string, string> = {
  execute: 'Bash',
  read: 'Read',
  edit: 'Edit',
  search: 'Grep',
  fetch: 'WebFetch',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return isObject(value) ? value : null;
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Open sets: the valid ids come from agy itself, per session. */
function normalizeOptionId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value.trim()) ? value.trim() : undefined;
}

export function normalizeAntigravityThoughtLevel(value: unknown): string | undefined {
  return normalizeOptionId(value);
}

export function normalizeAntigravityPermissionMode(value: unknown): string | undefined {
  return normalizeOptionId(value);
}

function findConfigOption(configOptions: unknown, id: string): Record<string, unknown> | null {
  for (const option of getArray(configOptions)) {
    const record = getRecord(option);
    if (record && (getString(record.id) === id || getString(record.category) === id)) return record;
  }
  return null;
}

/** value → name of a select option, flat or grouped. */
function optionLabels(option: Record<string, unknown> | null): Map<string, string> {
  const labels = new Map<string, string>();
  const visit = (entries: unknown): void => {
    for (const entry of getArray(entries)) {
      const record = getRecord(entry);
      if (!record) continue;
      if (Array.isArray(record.options)) visit(record.options);
      else if (getString(record.value)) labels.set(getString(record.value), getString(record.name) || getString(record.value));
    }
  };
  visit(option?.options);
  return labels;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  const record = getRecord(content);
  if (!record) return '';
  if (typeof record.text === 'string') return record.text;
  const nested = getRecord(record.content);
  return typeof nested?.text === 'string' ? nested.text : '';
}

function findDiff(content: unknown): { path: string; oldText: string | null; newText: string } | null {
  for (const item of getArray(content)) {
    const record = getRecord(item);
    if (record?.type !== 'diff') continue;
    return {
      path: getString(record.path),
      oldText: typeof record.oldText === 'string' ? record.oldText : null,
      newText: getString(record.newText),
    };
  }
  return null;
}

/**
 * The passage an edit replaced and what replaced it. agy's `diff` entry holds
 * the whole file before and after the edit (two 536 KB texts for a one-line
 * change to a 14,000-line file), which no card, stored row or approval should
 * carry. So the passage is the one agy names in its arguments (`Target` →
 * `Replacement`) when that one replacement is the whole edit, which is so
 * when it turns the diff's old text into its new text. An edit that changed
 * more (a second occurrence, another passage) is the diff cut down to the
 * lines that changed.
 */
function antigravityEdit(
  raw: Record<string, unknown>,
  diff: ReturnType<typeof findDiff>
): { oldText: string; newText: string } | null {
  const target = raw.Target;
  const replacement = raw.Replacement;
  if (typeof target === 'string' && typeof replacement === 'string') {
    if (!diff) return { oldText: target, newText: replacement };
    const at = target && diff.oldText !== null ? diff.oldText.indexOf(target) : -1;
    if (
      at >= 0 &&
      diff.oldText !== null &&
      diff.oldText.length - target.length + replacement.length === diff.newText.length &&
      diff.oldText.slice(0, at) + replacement + diff.oldText.slice(at + target.length) === diff.newText
    ) {
      return { oldText: target, newText: replacement };
    }
  }
  return diff ? trimCommonLines(diff.oldText ?? '', diff.newText) : null;
}

/**
 * An update folded into what is known of a call. The diff an update carries
 * is read here and not kept: the call remembers the edit it stands for, where
 * the file is, and a written file's text when only the diff has it.
 */
function mergeToolCall(
  existing: Pick<AntigravityToolCall, 'name' | 'source' | 'edit'> | undefined,
  update: Record<string, unknown>
): Pick<AntigravityToolCall, 'name' | 'source' | 'edit' | 'input'> {
  const name = existing?.name || antigravityToolName(update);
  const { content, ...fields } = update;
  const source: Record<string, unknown> = { ...existing?.source, ...fields };
  const raw = getRecord(source.rawInput) ?? getRecord(source.args) ?? {};
  const diff = findDiff(content);
  let edit = existing?.edit;
  if (diff) {
    if (name === 'Edit') edit = antigravityEdit(raw, diff) ?? edit;
    const writes = name === 'Write' && typeof raw.Content !== 'string';
    source.content = [{ type: 'diff', path: diff.path, ...(writes ? { newText: diff.newText } : {}) }];
  }
  return { name, source, edit, input: antigravityToolInput(name, source, edit) };
}

/** ACP `content` with each diff entry cut down to the lines that changed. */
function trimDiffContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((item) => {
    const record = getRecord(item);
    if (record?.type !== 'diff' || typeof record.oldText !== 'string' || typeof record.newText !== 'string') return item;
    return { ...record, ...trimCommonLines(record.oldText, record.newText) };
  });
}

/** What the tool returned: agy's `rawOutput.output`, else the text in ACP `content`. */
function extractToolOutput(update: Record<string, unknown>): string {
  const raw = getString(getRecord(update.rawOutput)?.output);
  if (raw) return raw;
  return getArray(update.content)
    .map((item) => {
      const record = getRecord(item);
      return record?.type === 'content' ? extractTextContent(record.content) : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function antigravityToolName(update: Record<string, unknown>): string {
  const name = getString(update.name).trim();
  return (
    ANTIGRAVITY_TOOL_NAMES[name] ||
    ACP_KIND_TOOL_NAMES[getString(update.kind)] ||
    name ||
    getString(update.title) ||
    'AntigravityTool'
  );
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  }
  return '';
}

/**
 * agy's arguments → the field names the Claude-shaped cards read. agy names
 * its arguments in PascalCase (`CommandLine`, `Path`, `Content`); what it does
 * not put in the arguments comes from the standard ACP fields of the call:
 * the edited file from its `diff` entry or first location, the edit itself
 * from the diff's changed lines (see antigravityEdit). `knownEdit`: the edit
 * already read off a diff the call sent earlier.
 */
export function antigravityToolInput(
  name: string,
  update: Record<string, unknown>,
  knownEdit?: { oldText: string; newText: string }
): Record<string, unknown> {
  const raw = getRecord(update.rawInput) ?? getRecord(update.args) ?? {};
  const input: Record<string, unknown> = { ...raw };
  const diff = findDiff(update.content);
  if (name === 'Bash') {
    const command = firstString(raw, ['CommandLine', 'command']);
    if (command && input.command === undefined) input.command = command;
    if (typeof raw.toolSummary === 'string' && input.description === undefined) input.description = raw.toolSummary;
  }
  if (name === 'Read' || name === 'Write' || name === 'Edit') {
    const filePath =
      firstString(raw, ['Path', 'path', 'file_path']) ||
      diff?.path ||
      getString(getRecord(getArray(update.locations)[0])?.path);
    if (filePath && input.file_path === undefined) input.file_path = filePath;
  }
  if (name === 'Write' && input.content === undefined) {
    const content = typeof raw.Content === 'string' ? raw.Content : diff?.newText;
    if (content !== undefined) input.content = content;
  }
  if (name === 'Edit' && input.old_string === undefined && input.new_string === undefined) {
    const edit = knownEdit ?? antigravityEdit(raw, diff);
    if (edit) {
      input.old_string = edit.oldText;
      input.new_string = edit.newText;
    }
  }
  return input;
}

/** The usage of an ACP prompt response, when agy sent one. */
export function parseAntigravityUsage(value: unknown): AntigravityTurnUsage | null {
  const usage = getRecord(value);
  if (!usage) return null;
  const parsed: AntigravityTurnUsage = {
    inputTokens: getNumber(usage.inputTokens),
    outputTokens: getNumber(usage.outputTokens),
    cacheReadTokens: getNumber(usage.cachedReadTokens),
    cacheWriteTokens: getNumber(usage.cachedWriteTokens),
    totalTokens: getNumber(usage.totalTokens),
  };
  parsed.totalTokens ||= parsed.inputTokens + parsed.outputTokens + parsed.cacheReadTokens + parsed.cacheWriteTokens;
  return parsed.totalTokens > 0 ? parsed : null;
}

function addUsage(total: AntigravityTurnUsage | null, turn: AntigravityTurnUsage | null): AntigravityTurnUsage | null {
  if (!turn) return total;
  if (!total) return { ...turn };
  return {
    inputTokens: total.inputTokens + turn.inputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
    cacheReadTokens: total.cacheReadTokens + turn.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + turn.cacheWriteTokens,
    totalTokens: total.totalTokens + turn.totalTokens,
  };
}

function usageFields(usage: AntigravityTurnUsage | null) {
  return {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    cache_read_input_tokens: usage?.cacheReadTokens ?? 0,
    cache_creation_input_tokens: usage?.cacheWriteTokens ?? 0,
    total_tokens: usage?.totalTokens ?? 0,
  };
}

function attachmentText(attachment: Attachment): string {
  return attachment.previewText?.trim()
    ? `Attachment: ${attachment.name}\nPath: ${attachment.path}\n\n${attachment.previewText}`
    : `Attachment available on disk: ${attachment.path}`;
}

function buildPromptBlocks(prompt: string, attachments: Attachment[] | undefined, imagePrompts: boolean): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  if (prompt.trim()) {
    blocks.push({ type: 'text', text: prompt });
  }
  for (const attachment of attachments || []) {
    if (attachment.kind === 'image' && imagePrompts) {
      try {
        blocks.push({
          type: 'image',
          mimeType: attachment.mimeType || 'image/png',
          data: readFileSync(attachment.path).toString('base64'),
        });
      } catch {
        blocks.push({ type: 'text', text: `Image attachment could not be read: ${attachment.path}` });
      }
      continue;
    }
    blocks.push({ type: 'text', text: attachmentText(attachment) });
  }
  return blocks;
}

function hasExited(proc: ChildProcessWithoutNullStreams): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/**
 * Ends agy the way a closing editor does: close its input, which makes it
 * exit by itself, and only signal a process that stays.
 */
function shutdownProcess(proc: ChildProcessWithoutNullStreams): void {
  if (hasExited(proc)) return;
  try {
    proc.stdin.end();
  } catch {
    // already closed
  }
  const termTimer = setTimeout(() => {
    if (!hasExited(proc)) proc.kill('SIGTERM');
  }, 1000);
  const killTimer = setTimeout(() => {
    if (!hasExited(proc)) proc.kill('SIGKILL');
  }, 3000);
  termTimer.unref?.();
  killTimer.unref?.();
  proc.once('exit', () => {
    clearTimeout(termTimer);
    clearTimeout(killTimer);
  });
}

function signInRequiredError(binary: string | null): Error {
  return new Error(`Antigravity sign-in required. Run: ${buildAntigravityLoginCommand(binary)}`);
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class AntigravityAcpAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'antigravity';
  readonly displayName = 'Antigravity';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  private sessions = new Map<string, ActiveAntigravitySession>();
  private starting = new Map<string, PendingStart>();
  private readonly stopGraceMs: number;
  private readonly selfTurnSettleMs: number;
  private readonly selfTurnIdleMs: number;
  /** Tool approvals awaiting the user. */
  private pendingPermissions = new Map<
    string,
    { threadId: string; rpc: AcpJsonRpcClient; request: AcpJsonRpcIncomingRequest; options: AcpPermissionOption[] }
  >();

  /** The waits are parameters so tests need not sit them out. */
  constructor(options: { stopGraceMs?: number; selfTurnSettleMs?: number; selfTurnIdleMs?: number } = {}) {
    this.stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS;
    this.selfTurnSettleMs = options.selfTurnSettleMs ?? SELF_TURN_SETTLE_MS;
    this.selfTurnIdleMs = options.selfTurnIdleMs ?? SELF_TURN_IDLE_MS;
  }

  /**
   * Spawns `agy acp`, initializes it and opens (or resumes) the ACP session.
   * `guard` runs after every await and throws once the start was cancelled;
   * every failure path ends the process it spawned.
   */
  private async connect(
    cwd: string,
    resumeSessionId: string | undefined,
    guard: (proc?: ChildProcessWithoutNullStreams) => void
  ): Promise<AntigravityConnection> {
    const binary = await resolveAntigravityBinary();
    guard();
    if (!binary) {
      throw new Error('Antigravity CLI (agy) was not found. Install it or set its path in Settings → Agents → Antigravity.');
    }

    // The unmodified binary, its own `acp` command, the user's environment.
    const proc = spawn(binary, ['acp'], {
      cwd,
      env: buildAntigravityEnv(binary),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stderrTail: string[] = [];
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        stderrTail.push(line.trim());
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    });
    // A write after agy is gone must not take the app down with EPIPE.
    proc.stdin.on('error', () => undefined);

    const binding: SessionBinding = { proc };
    let rpc!: AcpJsonRpcClient;
    rpc = new AcpJsonRpcClient(
      proc,
      (method, params) => this.handleNotification(binding, method, params),
      (request) => this.handleRequest(binding, rpc, request),
      (line, error) => {
        console.warn('[Antigravity ACP] failed to parse stdout line', { line: line.slice(0, 200), error: error.message });
      },
      // A prompt's response ends its turn before what agy sent after it is
      // read, however the two were split into reads.
      { responsesFirst: true }
    );

    const fail = (error: unknown): never => {
      shutdownProcess(proc);
      // A cancelled start ends its process, which fails whatever it was
      // waiting for: the cancellation is the reason, not that failure.
      guard();
      if (isAntigravityAuthError(error)) {
        noteAntigravityAuthState('login_required', error instanceof Error ? error.message : null);
        throw signInRequiredError(binary);
      }
      if (hasExited(proc) && stderrTail.length > 0) {
        throw new Error(`Antigravity (agy acp) exited while starting: ${stderrTail.slice(-3).join(' ')}`);
      }
      throw error instanceof Error ? error : new Error(String(error));
    };
    const step = async <T>(work: Promise<T>): Promise<T> => {
      let value: T;
      try {
        value = await work;
      } catch (error) {
        return fail(error);
      }
      try {
        guard(proc);
      } catch (error) {
        return fail(error);
      }
      return value;
    };
    await step(Promise.resolve());

    const initialized = getRecord(
      await step(
        rpc.request('initialize', {
          protocolVersion: 1,
          clientInfo: ANTIGRAVITY_ACP_CLIENT_INFO,
          // No fs/terminal: agy runs its own file and shell tools.
          clientCapabilities: {},
        })
      )
    );
    const agentCapabilities = getRecord(initialized?.agentCapabilities);
    const imagePrompts = getRecord(agentCapabilities?.promptCapabilities)?.image === true;
    const sessionCapabilities = getRecord(agentCapabilities?.sessionCapabilities);
    const canResume = Boolean(getRecord(sessionCapabilities?.resume));
    const canLoad = agentCapabilities?.loadSession === true;

    let sessionRecord: Record<string, unknown> | null = null;
    let providerSessionId = '';
    if (resumeSessionId && (canResume || canLoad)) {
      try {
        if (canResume) {
          sessionRecord = getRecord(await rpc.request('session/resume', { sessionId: resumeSessionId, cwd, mcpServers: [] }));
        } else {
          binding.replaying = true;
          sessionRecord = getRecord(await rpc.request('session/load', { sessionId: resumeSessionId, cwd, mcpServers: [] }));
        }
        providerSessionId = resumeSessionId;
      } catch (error) {
        if (isAntigravityAuthError(error)) fail(error);
        // A session agy no longer has (deleted, other machine) must not brick
        // the thread: continue in a fresh session.
        console.warn('[Antigravity ACP] could not reopen the session; starting a new one:', error instanceof Error ? error.message : error);
        binding.commands = undefined;
        binding.usage = undefined;
      } finally {
        binding.replaying = false;
      }
      await step(Promise.resolve());
    }
    if (!providerSessionId) {
      sessionRecord = getRecord(await step(rpc.request('session/new', { cwd, mcpServers: [] })));
      providerSessionId = getString(sessionRecord?.sessionId);
      if (!providerSessionId) {
        fail(new Error('Antigravity ACP did not return a sessionId.'));
      }
    }
    noteAntigravityAuthState('ready');
    return { proc, rpc, binding, imagePrompts, providerSessionId, sessionRecord, stderrTail };
  }

  /** Session config as the (re)opened ACP session reports it. */
  private adoptSessionRecord(session: ActiveAntigravitySession, connection: AntigravityConnection): void {
    const record = connection.sessionRecord;
    session.model = undefined;
    session.thoughtLevel = undefined;
    session.thoughtLevelLabels = new Map();
    this.applyConfigOptions(session, record?.configOptions);
    // A reopened session is back on agy's default model.
    session.defaultModel = session.model;
    session.rejectedModel = undefined;
    session.rejectedMode = undefined;
    const modes = getRecord(record?.modes);
    session.modeIds = new Set(
      getArray(modes?.availableModes)
        .map((mode) => getString(getRecord(mode)?.id))
        .filter(Boolean)
    );
    session.currentMode = getString(modes?.currentModeId) || undefined;
  }

  /** Binds a connection to its session: routing, exit handling, startup state. */
  private bindConnection(session: ActiveAntigravitySession, connection: AntigravityConnection): void {
    const { proc, binding } = connection;
    session.proc = proc;
    session.rpc = connection.rpc;
    session.stderrTail = connection.stderrTail;
    session.imagePrompts = connection.imagePrompts;
    session.dead = undefined;
    binding.session = session;

    proc.on('exit', (code, signal) => {
      if (this.sessions.get(session.threadId) !== session || session.proc !== proc) return;
      // Not a stop (that removes the session first): agy exited on its own.
      // A running turn fails through its rejected RPC; the next send
      // reconnects and resumes rather than writing into a dead pipe.
      session.dead = { code, signal };
      this.dismissPermissions(session.threadId);
      // A turn agy was running by itself has no RPC to fail: end it here.
      if (session.selfTurn) {
        this.endSelfTurn(session, this.describeTurnError(session, new Error('ACP process exited')));
      }
    });

    if (binding.commands) {
      this.emitAvailableCommands(session, binding.commands);
    }
    if (binding.usage) {
      this.emitTokenUsage(session, binding.usage);
    }
    binding.commands = undefined;
    binding.usage = undefined;
  }

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    // A newer start for the thread supersedes one still connecting.
    this.cancelPendingStart(input.threadId);
    const pending: PendingStart = { cancelled: false };
    this.starting.set(input.threadId, pending);
    const guard = (proc?: ChildProcessWithoutNullStreams) => {
      if (proc) pending.proc = proc;
      if (pending.cancelled) throw new Error('Antigravity session start was cancelled.');
    };

    let connection: AntigravityConnection;
    let active: ActiveAntigravitySession;
    try {
      connection = await this.connect(input.cwd, input.resumeSessionId, guard);
      active = {
        threadId: input.threadId,
        providerSessionId: connection.providerSessionId,
        status: 'running',
        cwd: input.cwd,
        modelLabels: new Map(),
        thoughtLevelLabels: new Map(),
        modeIds: new Set(),
        requestedThoughtLevel: normalizeAntigravityThoughtLevel(input.antigravityThoughtLevel),
        requestedMode: normalizeAntigravityPermissionMode(input.antigravityPermissionMode),
        imagePrompts: connection.imagePrompts,
        proc: connection.proc,
        rpc: connection.rpc,
        stderrTail: connection.stderrTail,
        nextBlockIndex: 0,
        toolCalls: new Map(),
        turnChain: Promise.resolve(),
        queued: 0,
      };
      this.adoptSessionRecord(active, connection);
      try {
        await this.applyModel(active, input.model);
        await this.applyThoughtLevel(active, active.requestedThoughtLevel);
        await this.applyMode(active, active.requestedMode);
        guard();
      } catch (error) {
        shutdownProcess(connection.proc);
        throw error;
      }
    } finally {
      if (this.starting.get(input.threadId) === pending) this.starting.delete(input.threadId);
    }

    // Never orphan a predecessor for the same thread — it would leak its process.
    this.retireSession(input.threadId);
    this.sessions.set(input.threadId, active);
    this.emit({
      type: 'system_init',
      threadId: input.threadId,
      sessionId: active.providerSessionId,
      model: active.model,
    });
    this.bindConnection(active, connection);

    if (input.prompt || input.attachments?.length) {
      // Not awaited: the agent loop chains every later send off startSession,
      // so waiting out the first turn here would hold the next one back.
      void this.sendTurn({
        threadId: input.threadId,
        prompt: input.prompt,
        attachments: input.attachments,
        model: input.model,
        antigravityPermissionMode: active.requestedMode,
        antigravityThoughtLevel: active.requestedThoughtLevel,
      }).catch((error) => {
        this.emit({
          type: 'error',
          threadId: input.threadId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    }

    return {
      threadId: input.threadId,
      provider: 'antigravity',
      providerSessionId: active.providerSessionId,
      status: 'running',
      model: active.model,
    };
  }

  /** agy exited between turns: reopen the same session in a fresh process. */
  private async reconnect(session: ActiveAntigravitySession): Promise<void> {
    const owned = (proc?: ChildProcessWithoutNullStreams) => {
      if (proc) session.connectingProc = proc;
      if (this.sessions.get(session.threadId) !== session) throw new Error('Antigravity session was stopped.');
    };
    let connection: AntigravityConnection;
    try {
      connection = await this.connect(session.cwd, session.providerSessionId, owned);
    } finally {
      session.connectingProc = undefined;
    }
    const replaced = connection.providerSessionId !== session.providerSessionId;
    session.providerSessionId = connection.providerSessionId;
    this.adoptSessionRecord(session, connection);
    // agy no longer had the session and a fresh one replaced it: announce it,
    // since system_init is what stores the id the next cold start resumes.
    if (replaced) {
      this.emit({
        type: 'system_init',
        threadId: session.threadId,
        sessionId: session.providerSessionId,
        model: session.model,
      });
    }
    // Calls of the process that is gone will never report back.
    session.toolCalls.clear();
    this.bindConnection(session, connection);
  }

  /**
   * The host is about to send a prompt. What agy started by itself ends here,
   * before the prompt is shown: its words are committed above the prompt,
   * and no result of its own can land on the turn that follows. Until the
   * prompt arrives, nothing agy sends opens another turn.
   */
  yieldToPrompt(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session || session.stopping) return;
    this.closeSelfTurn(session);
    session.promptDueBy = Date.now() + PROMPT_HANDOVER_MS;
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      throw new Error(`No Antigravity session found for thread "${input.threadId}"`);
    }

    // agy takes one prompt at a time: a send during a turn waits its turn.
    const previous = session.turnChain;
    let release!: () => void;
    session.turnChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    session.queued += 1;
    let dequeued = false;
    try {
      await previous;
      session.queued -= 1;
      dequeued = true;
      // A stop/dispose ends the process, which rejects this turn's RPC — that
      // stale rejection must not land in whatever session now owns the thread.
      if (this.sessions.get(input.threadId) !== session || session.stopping) return;
      await this.runTurn(session, input);
    } finally {
      if (!dequeued) session.queued -= 1;
      release();
    }
  }

  private async runTurn(session: ActiveAntigravitySession, input: ProviderSendTurnInput): Promise<void> {
    let resolveDone!: () => void;
    const turn: AntigravityTurn = {
      startedAt: Date.now(),
      promptSent: false,
      refused: false,
      usage: null,
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
      resolveDone: () => resolveDone(),
    };
    session.turn = turn;
    session.status = 'running';
    session.promptDueBy = undefined;
    // A prompt sent while agy was working by itself takes that work over:
    // what it wrote is committed, and this turn's result ends both.
    this.dropSelfTurn(session);
    this.finalizeStreaming(session);
    this.settleOpenToolCalls(session);
    // The last turn's calls are settled. One settled only because its turn
    // ended may still be running in the background and report back: the
    // latest few of those are kept.
    const kept = [...session.toolCalls].filter(([, call]) => call.placeholder).slice(-MAX_KEPT_CALLS);
    session.toolCalls = new Map(kept);
    this.emit({ type: 'status_change', threadId: session.threadId, status: 'running' });

    try {
      if (session.dead) await this.reconnect(session);
      await this.applyModel(session, input.model);
      await this.applyThoughtLevel(session, input.antigravityThoughtLevel);
      await this.applyMode(session, input.antigravityPermissionMode);
      const pending = session.rpc.request('session/prompt', {
        sessionId: session.providerSessionId,
        prompt: buildPromptBlocks(input.prompt, input.attachments, session.imagePrompts),
      });
      turn.promptSent = true;
      const promptResult = getRecord(await pending);
      turn.usage = parseAntigravityUsage(promptResult?.usage);
      if (getString(promptResult?.stopReason) === 'refusal') turn.refused = true;
    } catch (error) {
      turn.error = this.describeTurnError(session, error);
    }

    // Retired, or a stop is collecting this turn's usage: report nothing.
    if (this.sessions.get(session.threadId) !== session || session.stopping) {
      turn.resolveDone();
      return;
    }
    this.finalizeStreaming(session);
    this.endTurn(session, turn);
  }

  /** A turn's failure in words a person can act on. */
  private describeTurnError(session: ActiveAntigravitySession, error: unknown): Error {
    if (isAntigravityAuthError(error)) {
      noteAntigravityAuthState('login_required', error instanceof Error ? error.message : null);
      return signInRequiredError(null);
    }
    if (session.dead) {
      const how = session.dead.signal ? `signal ${session.dead.signal}` : `code ${session.dead.code ?? 'unknown'}`;
      const tail = session.stderrTail.slice(-3).join(' ');
      return new Error(`Antigravity (agy acp) exited during the turn (${how}).${tail ? ` ${tail}` : ''}`, { cause: error });
    }
    if (error instanceof AcpJsonRpcError) {
      return new Error(`Antigravity: ${error.rpcMessage}`, { cause: error });
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /** Adds the turn to the session's batch and reports the batch if nothing else belongs to it. */
  private endTurn(session: ActiveAntigravitySession, turn: AntigravityTurn): void {
    session.turn = undefined;
    this.settleOpenToolCalls(session);
    const batch = session.carry ?? { startedAt: turn.startedAt, refused: false, usage: null };
    batch.usage = addUsage(batch.usage, turn.usage);
    batch.refused ||= turn.refused;
    batch.error ??= turn.error;
    session.carry = batch;
    turn.resolveDone();
    this.finishBatchIfIdle(session);
  }

  /**
   * Reports the batch once no turn runs and none is queued. Synchronous from
   * that check to the result, so a send cannot slip in between.
   */
  private finishBatchIfIdle(session: ActiveAntigravitySession): void {
    const batch = session.carry;
    if (!batch || session.turn || session.queued > 0) return;
    if (this.sessions.get(session.threadId) !== session) return;
    session.carry = undefined;
    const { startedAt, refused, error, usage } = batch;
    session.status = error ? 'error' : 'completed';
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'result',
        subtype: error || refused ? 'error' : 'success',
        duration_ms: Date.now() - startedAt,
        // agy reports tokens only; the turn is billed to the user's Google plan.
        ...costFields(emptyCostDetails()),
        usage: usageFields(usage),
        ...this.modelFields(session),
      },
    });
    if (error) {
      this.emit({ type: 'error', threadId: session.threadId, error });
    } else {
      this.emit({ type: 'status_change', threadId: session.threadId, status: 'completed' });
    }
  }

  /** The model and thinking level a turn ran at, under agy's ids and names. */
  private modelFields(session: ActiveAntigravitySession) {
    const modelLabel = session.model ? session.modelLabels.get(session.model) : undefined;
    const thoughtLevelLabel = session.thoughtLevel ? session.thoughtLevelLabels.get(session.thoughtLevel) : undefined;
    return {
      model: session.model,
      ...(modelLabel ? { modelLabel } : {}),
      ...(session.thoughtLevel ? { thoughtLevel: session.thoughtLevel, ...(thoughtLevelLabel ? { thoughtLevelLabel } : {}) } : {}),
    };
  }

  /**
   * Cancels the running turn the ACP way, gives agy a moment to answer the
   * cancelled prompt (its response carries what the turn used), then closes
   * the session's process. The next message reopens the session.
   */
  async stopSession(threadId: string): Promise<void> {
    this.cancelPendingStart(threadId);
    const session = this.sessions.get(threadId);
    if (!session) return;
    session.status = 'stopped';
    session.stopping = true;
    const running = session.turn;
    // session/cancel ends a prompt turn, or the work agy took up by itself;
    // with neither there is nothing to end.
    if ((running?.promptSent || session.selfTurn) && !session.dead) {
      try {
        session.rpc.notify('session/cancel', { sessionId: session.providerSessionId });
      } catch {
        // ignore shutdown cancellation errors
      }
    }
    this.dropSelfTurn(session);
    // ACP: a cancelled turn's pending approvals are answered `cancelled`.
    this.dismissPermissions(threadId);
    if (running?.promptSent && !session.dead && this.stopGraceMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        running.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.stopGraceMs);
        }),
      ]);
      clearTimeout(timer);
    }
    if (this.sessions.get(threadId) === session) this.retireSession(threadId);
  }

  disposeSession(threadId: string): boolean {
    const cancelled = this.cancelPendingStart(threadId);
    return this.retireSession(threadId) || cancelled;
  }

  /** A start still connecting: mark it cancelled and end what it spawned. */
  private cancelPendingStart(threadId: string): boolean {
    const pending = this.starting.get(threadId);
    if (!pending) return false;
    this.starting.delete(threadId);
    pending.cancelled = true;
    if (pending.proc) shutdownProcess(pending.proc);
    return true;
  }

  /**
   * A stop retires the session after the runner stopped forwarding events, so
   * the usage the stopped batch already incurred (its completed turns and
   * what the cancelled turn reported) goes out as a process-wide usage_record,
   * not a turn result. The host persists it at once.
   */
  private reportUnreportedUsage(session: ActiveAntigravitySession, usage: AntigravityTurnUsage, startedAt: number): void {
    this.emit({
      type: 'usage_unreported',
      threadId: session.threadId,
      provider: 'antigravity',
      message: {
        type: 'usage_record',
        uuid: `antigravity-usage:${session.threadId}:${uuidv4()}`,
        duration_ms: Math.max(0, Date.now() - startedAt),
        ...costFields(emptyCostDetails()),
        usage: usageFields(usage),
        model: session.model,
      },
    });
  }

  /** Tears down the thread's registered session, if any. */
  private retireSession(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    if (!session) {
      return false;
    }
    try {
      this.dismissPermissions(threadId);
      const running = session.turn;
      const unreported = addUsage(session.carry?.usage ?? null, running?.usage ?? null);
      if (unreported) this.reportUnreportedUsage(session, unreported, session.carry?.startedAt ?? running?.startedAt ?? Date.now());
      session.carry = undefined;
      // Map entry first: the exit handler is identity-guarded, so the exit
      // that follows emits nothing.
      this.sessions.delete(threadId);
      running?.resolveDone();
      const workingAlone = Boolean(session.selfTurn);
      this.dropSelfTurn(session);
      if (!session.dead) {
        // A turn still running is cancelled before the input closes.
        if ((running?.promptSent || workingAlone) && !session.stopping) {
          try {
            session.rpc.notify('session/cancel', { sessionId: session.providerSessionId });
          } catch {
            // the process may already be gone
          }
        }
        shutdownProcess(session.proc);
      }
      if (session.connectingProc) shutdownProcess(session.connectingProc);
    } catch (error) {
      console.warn('[AntigravityAcpAdapter] session teardown failed:', error);
    }
    return true;
  }

  async stopAll(): Promise<void> {
    for (const threadId of Array.from(this.starting.keys())) this.cancelPendingStart(threadId);
    await Promise.all(Array.from(this.sessions.keys()).map((threadId) => this.stopSession(threadId)));
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values()).map((session) => ({
      threadId: session.threadId,
      provider: 'antigravity',
      providerSessionId: session.providerSessionId,
      status: session.status,
      model: session.model,
    }));
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  async respondToRequest(threadId: string, requestId: string, decision: PermissionResult): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.threadId !== threadId) {
      return;
    }
    this.pendingPermissions.delete(requestId);
    const optionId = this.resolveOptionId(decision, pending.options);
    pending.rpc.respond(pending.request.id, {
      outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
    });
  }

  /** agy's skills reach the composer through its ACP command feed. */
  async listSkills(_input: ProviderListSkillsInput): Promise<ProviderListSkillsResult> {
    return { skills: [], source: 'antigravity-acp', cached: false };
  }

  getComposerCapabilities(): ProviderComposerCapabilities {
    return {
      provider: 'antigravity',
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      // agy pushes available_commands_update (builtins + skills) after session/new.
      supportsNativeSlashCommandDiscovery: true,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: false,
    };
  }

  // ── Session config ───────────────────────────────────────────────────────

  private async setConfigOption(session: ActiveAntigravitySession, configId: string, value: string): Promise<void> {
    const result = getRecord(
      await session.rpc.request('session/set_config_option', {
        sessionId: session.providerSessionId,
        configId,
        value,
      })
    );
    this.applyConfigOptions(session, result?.configOptions);
  }

  private applyConfigOptions(session: ActiveAntigravitySession, configOptions: unknown): void {
    if (getArray(configOptions).length === 0) return;
    const modelOption = findConfigOption(configOptions, 'model');
    if (modelOption) {
      session.model = getString(modelOption.currentValue) || session.model;
      const labels = optionLabels(modelOption);
      if (labels.size > 0) session.modelLabels = labels;
    }
    // A model switch resets the level to that model's own default, and a
    // model without thinking control has no such option at all.
    const levelOption = findConfigOption(configOptions, 'thought_level');
    session.thoughtLevel = getString(levelOption?.currentValue) || undefined;
    session.thoughtLevelLabels = optionLabels(levelOption);
  }

  private async applyModel(session: ActiveAntigravitySession, model: string | undefined): Promise<void> {
    // An empty request means Default: the model the session opened on.
    const requested = model?.trim() || session.defaultModel;
    if (!requested || requested === session.model || requested === session.rejectedModel) {
      return;
    }
    if (session.modelLabels.size > 0 && !session.modelLabels.has(requested)) {
      session.rejectedModel = requested;
      console.warn(`[Antigravity ACP] model "${requested}" is not offered by this session; keeping ${session.model}.`);
      return;
    }
    try {
      await this.setConfigOption(session, 'model', requested);
      session.model ||= requested;
      session.rejectedModel = undefined;
    } catch (error) {
      if (!(error instanceof AcpJsonRpcError)) throw error;
      // A model agy lists but will not take, or one the account lost.
      session.rejectedModel = requested;
      console.warn('[Antigravity ACP] could not switch model:', error.rpcMessage);
    }
  }

  /**
   * Runs after applyModel: a model switch resets the level, so the composer's
   * choice is applied again whenever the model offers it. A level the current
   * model does not offer is left to the model's own default.
   */
  private async applyThoughtLevel(session: ActiveAntigravitySession, level: string | undefined): Promise<void> {
    const requested = normalizeAntigravityThoughtLevel(level) ?? session.requestedThoughtLevel;
    session.requestedThoughtLevel = requested;
    if (!requested || requested === session.thoughtLevel || !session.thoughtLevelLabels.has(requested)) {
      return;
    }
    try {
      await this.setConfigOption(session, 'thought_level', requested);
    } catch (error) {
      if (!(error instanceof AcpJsonRpcError)) throw error;
      console.warn('[Antigravity ACP] could not set the thinking level:', error.rpcMessage);
    }
  }

  /**
   * Reconciled before every turn, even when the picker value is unchanged:
   * agy can change mode on its own (`/plan`, an approved plan).
   */
  private async applyMode(session: ActiveAntigravitySession, mode: string | undefined): Promise<void> {
    const requested = normalizeAntigravityPermissionMode(mode) ?? session.requestedMode;
    session.requestedMode = requested;
    if (!requested || requested === session.currentMode || requested === session.rejectedMode) {
      return;
    }
    // Only a mode agy offers for this session; anything else keeps its own.
    if (!session.modeIds.has(requested)) {
      session.rejectedMode = requested;
      console.warn(`[Antigravity ACP] mode "${requested}" is not offered by this session; keeping ${session.currentMode}.`);
      return;
    }
    session.settingMode = true;
    try {
      await session.rpc.request('session/set_mode', {
        sessionId: session.providerSessionId,
        modeId: requested,
      });
      session.currentMode = requested;
      session.rejectedMode = undefined;
    } catch (error) {
      if (!(error instanceof AcpJsonRpcError)) throw error;
      session.rejectedMode = requested;
      console.warn('[Antigravity ACP] could not set the mode:', error.rpcMessage);
    } finally {
      session.settingMode = false;
    }
  }

  // ── ACP routing ──────────────────────────────────────────────────────────

  private handleNotification(binding: SessionBinding, method: string, params?: Record<string, unknown>): void {
    if (method !== 'session/update' || binding.replaying) {
      return;
    }
    const update = getRecord(params?.update) as AntigravitySessionUpdate | null;
    if (!update) return;

    const session = binding.session;
    if (!session || this.sessions.get(session.threadId) !== session) {
      if (session) return;
      // Pre-bind: startup state.
      if (update.sessionUpdate === 'available_commands_update') binding.commands = update;
      else if (update.sessionUpdate === 'usage_update') binding.usage = update;
      return;
    }
    // What a process still had to say after it exited, or after the session
    // moved to another process, has no turn to belong to.
    if (session.dead || session.proc !== binding.proc) return;
    this.handleSessionUpdate(session, update);
  }

  private handleRequest(binding: SessionBinding, rpc: AcpJsonRpcClient, request: AcpJsonRpcIncomingRequest): void {
    const session = binding.session;
    const live = Boolean(
      session &&
        this.sessions.get(session.threadId) === session &&
        !session.stopping &&
        !session.dead &&
        session.proc === binding.proc
    );
    if (request.method === 'session/request_permission') {
      if (live && session) this.handlePermissionRequest(session, rpc, request);
      else rpc.respond(request.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    // fs/* and terminal/* are not advertised, so agy should never ask.
    rpc.respond(request.id, undefined, {
      code: -32601,
      message: `Unsupported Antigravity ACP reverse request: ${request.method}`,
    });
  }

  private handlePermissionRequest(
    session: ActiveAntigravitySession,
    rpc: AcpJsonRpcClient,
    request: AcpJsonRpcIncomingRequest
  ): void {
    const params = getRecord(request.params);
    const toolCall = getRecord(params?.toolCall) || {};
    const options = getArray(params?.options)
      .map((option): AcpPermissionOption | null => {
        const record = getRecord(option);
        const optionId = getString(record?.optionId);
        if (!optionId) return null;
        return {
          optionId,
          name: getString(record?.name) || optionId,
          kind: getString(record?.kind) || undefined,
          description: getString(record?.description) || undefined,
        };
      })
      .filter((option): option is AcpPermissionOption => Boolean(option));
    // The request repeats the tool call it gates, with the edit's diff.
    const known = session.toolCalls.get(getString(toolCall.toolCallId));
    const { name: toolName, input } = mergeToolCall(known, toolCall);
    const command = toolName === 'Bash' ? getString(input.command) : '';
    const title = getString(toolCall.title) || known?.title || command || 'Antigravity permission request';
    const requestId = `antigravity-permission:${session.threadId}:${request.id}`;
    this.pendingPermissions.set(requestId, { threadId: session.threadId, rpc, request, options });
    const permission: AcpPermissionInput = {
      kind: 'acp-permission',
      provider: 'antigravity',
      question: command || title,
      title,
      toolName,
      options,
      // The request's own diff holds the whole file twice: the card gets the changed lines.
      toolCall: { ...toolCall, content: trimDiffContent(toolCall.content), title, rawInput: input },
    };
    this.emit({
      type: 'permission_request',
      threadId: session.threadId,
      requestId,
      toolName,
      input: permission,
    });
  }

  private dismissPermissions(threadId: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.threadId !== threadId) continue;
      this.pendingPermissions.delete(requestId);
      this.emit({ type: 'permission_dismissed', threadId, requestId });
      try {
        pending.rpc.respond(pending.request.id, { outcome: { outcome: 'cancelled' } });
      } catch {
        // The process may already be gone.
      }
    }
  }

  private resolveOptionId(decision: PermissionResult, options: AcpPermissionOption[]): string | null {
    const explicit = decision.updatedInput?.optionId;
    if (typeof explicit === 'string' && options.some((option) => option.optionId === explicit)) {
      return explicit;
    }
    const isReject = (option: AcpPermissionOption) => /reject|deny/.test(`${option.kind || ''} ${option.optionId}`.toLowerCase());
    if (decision.behavior === 'allow') {
      return (
        options.find((option) => option.kind === 'allow_once')?.optionId ||
        options.find((option) => !isReject(option))?.optionId ||
        null
      );
    }
    return options.find((option) => isReject(option))?.optionId || null;
  }

  // ── Session updates ──────────────────────────────────────────────────────

  private handleSessionUpdate(session: ActiveAntigravitySession, update: AntigravitySessionUpdate): void {
    const kind = update.sessionUpdate;
    // Read before the update is applied: whether this is a call not seen before.
    const newCall = kind === 'tool_call' && !session.toolCalls.has(getString(update.toolCallId));
    const promptDue = session.promptDueBy !== undefined && Date.now() < session.promptDueBy;
    if (!session.turn && !session.selfTurn && !session.stopping && !promptDue && this.startsWork(update, newCall)) {
      this.openSelfTurn(session);
    }
    this.routeSessionUpdate(session, update);
    if (session.selfTurn) this.paceSelfTurn(session, update, newCall);
  }

  // ── Turns agy starts by itself ───────────────────────────────────────────

  /** Whether an update is agy at work: text, a thought, or a call not seen before. */
  private startsWork(update: AntigravitySessionUpdate, newCall: boolean): boolean {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
        return extractTextContent(update.content) !== '';
      case 'tool_call':
        return newCall;
      default:
        return false;
    }
  }

  /**
   * agy took up work with no prompt running (a background command finished,
   * say). To the host it is a turn like any other: it opens with an init
   * marked `selfStarted`, which sets the session running and gives the work
   * its own place in the transcript, and it ends with a result.
   */
  private openSelfTurn(session: ActiveAntigravitySession): void {
    session.selfTurn = { startedAt: Date.now(), stepEnded: false, waitingFor: new Set() };
    session.status = 'running';
    this.emit({ type: 'status_change', threadId: session.threadId, status: 'running' });
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'system',
        subtype: 'init',
        session_id: session.providerSessionId,
        model: session.model || '',
        permissionMode: '',
        cwd: session.cwd,
        tools: [],
        selfStarted: true,
      },
    });
  }

  /**
   * Follows where the turn stands and sets the deadline that ends it if agy
   * says nothing more. The turn is in one of three places:
   * - a model step has ended and nothing followed: a tool call comes at once
   *   or the turn is over (the short wait);
   * - the model waits for calls its step made: no deadline, they take as long
   *   as they take, approval included;
   * - otherwise the model is expected to speak: a long silence ends the turn.
   * The deadline is worked out from that state, not from the last update:
   * one call finishing says nothing while another the model waits for runs,
   * and an update that changes nothing (a new title, a call of an earlier
   * step reporting back) leaves the deadline as it is.
   */
  private paceSelfTurn(session: ActiveAntigravitySession, update: AntigravitySessionUpdate, newCall: boolean): void {
    const selfTurn = session.selfTurn;
    if (!selfTurn) return;
    switch (update.sessionUpdate) {
      case 'usage_update':
        // The step is over. Calls still open went on without the model (a
        // command sent to the background): it no longer waits for them.
        selfTurn.stepEnded = true;
        selfTurn.waitingFor.clear();
        break;
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
        if (!extractTextContent(update.content)) return;
        // The model speaks: every call it waited for has answered it.
        selfTurn.stepEnded = false;
        selfTurn.waitingFor.clear();
        break;
      case 'tool_call':
      case 'tool_call_update': {
        const id = getString(update.toolCallId);
        const status = getString(update.status);
        const finished = status === 'completed' || status === 'failed';
        if (newCall) {
          selfTurn.stepEnded = false;
          if (!finished) selfTurn.waitingFor.add(id);
        } else if (!finished || !selfTurn.waitingFor.delete(id)) {
          return;
        }
        break;
      }
      default:
        // Commands, modes, titles and plans say nothing about the turn.
        return;
    }
    clearTimeout(selfTurn.timer);
    selfTurn.timer = undefined;
    if (!selfTurn.stepEnded && selfTurn.waitingFor.size > 0) return;
    selfTurn.timer = setTimeout(
      () => {
        if (this.sessions.get(session.threadId) === session && session.selfTurn === selfTurn) this.endSelfTurn(session);
      },
      selfTurn.stepEnded ? this.selfTurnSettleMs : this.selfTurnIdleMs
    );
    selfTurn.timer.unref?.();
  }

  /** Commits what the turn wrote and settles its calls, without reporting an end. */
  private closeSelfTurn(session: ActiveAntigravitySession): boolean {
    const selfTurn = session.selfTurn;
    if (!selfTurn) return false;
    this.dropSelfTurn(session);
    this.finalizeStreaming(session);
    this.settleOpenToolCalls(session);
    return true;
  }

  /** Ends the turn agy started by itself: its last words, then its result. */
  private endSelfTurn(session: ActiveAntigravitySession, error?: Error): void {
    const startedAt = session.selfTurn?.startedAt;
    if (!this.closeSelfTurn(session) || startedAt === undefined) return;
    session.status = error ? 'error' : 'completed';
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'result',
        subtype: error ? 'error' : 'success',
        duration_ms: Date.now() - startedAt,
        // No prompt response reports what such a turn used.
        ...costFields(emptyCostDetails()),
        usage: usageFields(null),
        ...this.modelFields(session),
      },
    });
    if (error) {
      this.emit({ type: 'error', threadId: session.threadId, error });
    } else {
      this.emit({ type: 'status_change', threadId: session.threadId, status: 'completed' });
    }
  }

  private dropSelfTurn(session: ActiveAntigravitySession): void {
    clearTimeout(session.selfTurn?.timer);
    session.selfTurn = undefined;
  }

  private routeSessionUpdate(session: ActiveAntigravitySession, update: AntigravitySessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.emitAssistantDelta(session, extractTextContent(update.content));
        break;
      case 'agent_thought_chunk':
        this.emitThinkingDelta(session, extractTextContent(update.content));
        break;
      case 'tool_call':
        this.handleToolCall(session, update);
        break;
      case 'tool_call_update':
        this.handleToolCallUpdate(session, update);
        break;
      case 'plan':
        this.emitPlan(session, update);
        break;
      case 'available_commands_update':
        this.emitAvailableCommands(session, update);
        break;
      case 'config_option_update':
        this.applyConfigOptions(session, update.configOptions);
        break;
      case 'current_mode_update': {
        const mode = getString(update.currentModeId);
        if (!mode || mode === session.currentMode) break;
        session.currentMode = mode;
        // agy changed mode by itself: the composer follows, and the next
        // turn does not switch it back.
        if (!session.settingMode) {
          session.requestedMode = mode;
          this.emit({ type: 'permission_mode_changed', threadId: session.threadId, provider: 'antigravity', mode });
        }
        break;
      }
      case 'usage_update':
        this.emitTokenUsage(session, update);
        break;
      case 'session_info_update': {
        // agy names the session itself; no prompt of Aegis's asks for a title.
        const title = getString(update.title).trim();
        if (title && title !== session.lastTitle) {
          session.lastTitle = title;
          this.emit({ type: 'session_title', threadId: session.threadId, provider: 'antigravity', title });
        }
        break;
      }
      default:
        // user_message_chunk (replay only).
        break;
    }
  }

  /**
   * Mid-turn text and reasoning ride Claude-shaped stream events carrying only
   * the increment, which the renderer's delta coalescer batches; the committed
   * message lands in finalizeStreaming.
   */
  private emitAssistantDelta(session: ActiveAntigravitySession, text: string): void {
    if (!text) return;
    if (!session.currentAssistant) {
      session.currentAssistant = {
        uuid: `antigravity-assistant:${session.threadId}:${uuidv4()}`,
        text: '',
        createdAt: Date.now(),
        blockIndex: session.nextBlockIndex++,
      };
    }
    session.currentAssistant.text += text;
    this.emitStreamDelta(session, session.currentAssistant.blockIndex, { type: 'text_delta', text });
  }

  private emitThinkingDelta(session: ActiveAntigravitySession, thinking: string): void {
    if (!thinking) return;
    if (!session.currentThinking) {
      session.currentThinking = {
        uuid: `antigravity-thinking:${session.threadId}:${uuidv4()}`,
        thinking: '',
        createdAt: Date.now(),
        blockIndex: session.nextBlockIndex++,
      };
    }
    session.currentThinking.thinking += thinking;
    this.emitStreamDelta(session, session.currentThinking.blockIndex, { type: 'thinking_delta', thinking });
  }

  private emitStreamDelta(
    session: ActiveAntigravitySession,
    index: number,
    delta: { type: string; text?: string; thinking?: string }
  ): void {
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'stream_event',
        parentToolUseId: null,
        event: { type: 'content_block_delta', index, delta },
      },
    });
  }

  private finalizeStreaming(session: ActiveAntigravitySession): void {
    if (session.currentThinking) {
      this.emit({
        type: 'message',
        threadId: session.threadId,
        message: {
          type: 'assistant',
          uuid: session.currentThinking.uuid,
          createdAt: session.currentThinking.createdAt,
          message: { content: [{ type: 'thinking', thinking: session.currentThinking.thinking }] },
        },
      });
      session.currentThinking = undefined;
    }
    if (session.currentAssistant) {
      this.emit({
        type: 'message',
        threadId: session.threadId,
        message: {
          type: 'assistant',
          uuid: session.currentAssistant.uuid,
          createdAt: session.currentAssistant.createdAt,
          message: { content: [{ type: 'text', text: session.currentAssistant.text }] },
        },
      });
      session.currentAssistant = undefined;
    }
  }

  private emitToolUseMessage(session: ActiveAntigravitySession, id: string, call: AntigravityToolCall): void {
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'assistant',
        uuid: `antigravity-tool-use:${session.threadId}:${id}`,
        createdAt: call.createdAt,
        message: { content: [{ type: 'tool_use', id, name: call.name, input: call.input }] },
      },
    });
  }

  private handleToolCall(session: ActiveAntigravitySession, update: AntigravitySessionUpdate): void {
    const id = getString(update.toolCallId) || uuidv4();
    const existing = session.toolCalls.get(id);
    // A call that reported its outcome is done: nothing agy repeats changes it.
    if (existing?.settled && !existing.placeholder) return;
    // A first-seen call closes the current prose block so narration between
    // calls keeps its own position; a repeat must not split mid-sentence.
    if (!existing) {
      this.finalizeStreaming(session);
    }
    const call: AntigravityToolCall = {
      // A repeat keeps what the call already is: when it began, what it
      // printed, and a result that only stands in for the real one.
      ...existing,
      ...mergeToolCall(existing, update),
      title: getString(update.title) || existing?.title || '',
      createdAt: existing?.createdAt || Date.now(),
      output: existing?.output || '',
      settled: existing?.settled || false,
    };
    session.toolCalls.set(id, call);
    this.emitToolUseMessage(session, id, call);
    this.settleToolCall(session, id, call, update);
  }

  private handleToolCallUpdate(session: ActiveAntigravitySession, update: AntigravitySessionUpdate): void {
    const id = getString(update.toolCallId);
    const call = id ? session.toolCalls.get(id) : undefined;
    if (!id || !call || (call.settled && !call.placeholder)) return;

    // agy retitles a call as it moves between states (a relative path while
    // it runs); the card keeps its first title and follows the input only.
    const merged = mergeToolCall(call, update);
    call.source = merged.source;
    call.edit = merged.edit;
    if (JSON.stringify(merged.input) !== JSON.stringify(call.input)) {
      call.input = merged.input;
      this.emitToolUseMessage(session, id, call);
    }
    this.settleToolCall(session, id, call, update);
  }

  /** Output as it grows, and the result once the call completes or fails. */
  private settleToolCall(
    session: ActiveAntigravitySession,
    id: string,
    call: AntigravityToolCall,
    update: AntigravitySessionUpdate
  ): void {
    const status = getString(update.status);
    const output = extractToolOutput(update);
    if (output && output !== call.output) {
      // Growing output snapshots feed the live tool card; a settling
      // update's output rides the result.
      if (status === 'in_progress' && output.startsWith(call.output)) {
        const delta = output.slice(call.output.length);
        if (delta) this.emit({ type: 'tool_output_delta', threadId: session.threadId, toolUseId: id, delta });
      }
      call.output = output;
    }
    if (status === 'completed' || status === 'failed') {
      this.emitToolResult(session, id, call, status === 'failed');
    }
  }

  /**
   * `placeholder`: the call is settled because its turn ended, not because it
   * finished. Its real outcome, when agy reports one later, replaces that
   * result in place (same uuid, same time).
   */
  private emitToolResult(
    session: ActiveAntigravitySession,
    id: string,
    call: AntigravityToolCall,
    isError: boolean,
    placeholder = false
  ): void {
    if (call.settled && (placeholder || !call.placeholder)) return;
    call.settled = true;
    call.placeholder = placeholder || undefined;
    call.resultAt ??= Date.now();
    const content = call.output || call.title || (isError ? 'Failed' : 'Done');
    if (!placeholder) {
      // Done for good: the entry stays so a repeat is known as one, without
      // the arguments, file text and output it carried.
      call.source = {};
      call.input = {};
      call.output = '';
      call.edit = undefined;
    }
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'assistant',
        uuid: `antigravity-tool-result:${session.threadId}:${id}`,
        createdAt: call.resultAt,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              content,
              is_error: isError,
            },
          ],
        },
      },
    });
  }

  /** A turn that ends (or dies) with calls still open must not leave spinning cards. */
  private settleOpenToolCalls(session: ActiveAntigravitySession): void {
    for (const [id, call] of session.toolCalls) {
      if (!call.settled) this.emitToolResult(session, id, call, false, true);
    }
  }

  private emitPlan(session: ActiveAntigravitySession, update: AntigravitySessionUpdate): void {
    const steps = getArray(update.entries)
      .map((entry) => {
        const record = getRecord(entry);
        const status = getString(record?.status);
        const planStatus: PlanStepStatus =
          status === 'completed' ? 'completed' : status === 'in_progress' ? 'inProgress' : 'pending';
        return { step: getString(record?.content || record?.title), status: planStatus };
      })
      .filter((step) => step.step);
    if (steps.length === 0) return;
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'plan_update',
        uuid: `antigravity-plan:${session.threadId}:${uuidv4()}`,
        turnId: `antigravity:${session.threadId}`,
        steps,
      },
    });
  }

  /** Context ring: agy reports occupancy (`used`) and window (`size`) directly. */
  private emitTokenUsage(session: ActiveAntigravitySession, update: AntigravitySessionUpdate): void {
    const contextWindow = getNumber(update.size);
    if (contextWindow <= 0) return;
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'system',
        subtype: 'token_usage',
        uuid: `antigravity-token-usage:${session.threadId}:${Date.now()}`,
        session_id: session.threadId,
        provider: 'antigravity',
        usage: {
          inputTokens: getNumber(update.used),
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: getNumber(update.used),
          contextWindow,
        },
      },
    });
  }

  private emitAvailableCommands(session: ActiveAntigravitySession, update: AntigravitySessionUpdate): void {
    const availableCommands = getArray(update.availableCommands)
      .map((command) => {
        const record = getRecord(command);
        const name = getString(record?.name).replace(/^\//, '').trim();
        if (!name) return null;
        const hint = getString(getRecord(record?.input)?.hint);
        return {
          name,
          description: getString(record?.description) || 'Antigravity slash command',
          ...(hint ? { input: { hint } } : {}),
        };
      })
      .filter((command): command is { name: string; description: string; input?: { hint: string } } =>
        Boolean(command)
      );
    // agy pushes the list again after every config change; skip identical repeats.
    const signature = JSON.stringify(
      [...availableCommands].sort((left, right) => left.name.localeCompare(right.name))
    );
    if (session.lastCommandsSignature === signature) {
      return;
    }
    session.lastCommandsSignature = signature;
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'system',
        subtype: 'available_commands_update',
        session_id: session.providerSessionId,
        availableCommands,
      },
    });
  }

  private emit(event: ProviderRuntimeEvent): void {
    this.events.emit('event', event);
  }
}
