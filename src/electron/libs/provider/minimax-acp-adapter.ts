import { splitJoinedAnswer } from '../../../shared/question-answers';
import { getWorkflowSessionPolicy } from '../workflow/session-hooks';
import { getSessionReaderHttpConfig, SESSION_MCP_SERVER_NAME } from '../session-http-server';
import { createBrowserUseSessionMcpDescriptor } from '../browser-use-http-server';
import { BROWSER_USE_SERVER_NAME, finishBrowserUseTurn } from '../browser-use';
import { isBrowserUseEnabled } from '../browser-use-permissions';
import { setBrowserUseSessionFullAccess } from '../browser-use-consent';
import { browserManager } from '../../browserManager';
import { createGrokAcpHttpMcpServer } from './grok-acp-mcp';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { buildMinimaxEnv, minimaxDataDir, resolveMinimaxBinary } from '../minimax-cli';
import { addAgentCost, costFields, emptyCostDetails } from '../agent-cost';
import { AcpJsonRpcClient, type AcpJsonRpcIncomingRequest } from './acp-json-rpc-client';
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
  AskUserQuestionInput,
  Attachment,
  MinimaxPermissionMode,
  PermissionResult,
  PlanStepStatus,
  ProviderComposerCapabilities,
  ProviderCostDetails,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  QuestionAnswerSelection,
} from '../../../shared/types';

/**
 * MiniMax Code over ACP (`mcode acp`, JSON-RPC on stdio). Verified against
 * mcode 0.6.12:
 * - The client advertises no fs/terminal capabilities, so mcode reads, edits
 *   and runs commands itself and reports each call as tool_call updates
 *   (followed by a burst of empty updates while the input streams).
 * - Model, thinking effort and permission mode are session config options;
 *   plan is the `plan` session mode. All apply live, without a respawn. The
 *   permission mode is process-scoped, which is one session here.
 * - session/resume reattaches without replaying the transcript.
 * - A tool approval's toolCall carries its own id (`perm_…`), not the id of
 *   the tool_call it gates; its name, title and rawInput are self-contained.
 * - Questions (and plan-mode plan reviews) arrive as form elicitations.
 * - Steering a running turn is the `mcode/session/steer` extension (text only).
 * - Prompt results carry no usage: per-turn tokens are summed from the
 *   session's messages.jsonl; usage_update only reports context occupancy.
 */

type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

type MinimaxSessionUpdate = Record<string, unknown> & { sessionUpdate?: unknown };

interface MinimaxToolCall {
  name: string;
  title: string;
  input: Record<string, unknown>;
  createdAt: number;
  output: string;
  settled: boolean;
}

interface MinimaxTurn {
  startedAt: number;
  /** Size of the session's messages.jsonl when the prompt went out: the turn's records follow it. */
  logOffset: number;
  /** A stop already counted this turn's logged usage as unreported. */
  accounted?: boolean;
  /** Set once session/prompt is written; only then can mcode take a steer. */
  promptSent: boolean;
  refused: boolean;
  error?: Error;
  done: Promise<void>;
  resolveDone: () => void;
}

interface ActiveMinimaxSession {
  threadId: string;
  providerSessionId: string;
  status: ProviderSessionStatus;
  cwd: string;
  model?: string;
  /** Model values this session's config select offers (empty until known). */
  modelIds: Set<string>;
  /** Last requested model the session rejected; not retried every turn. */
  rejectedModel?: string;
  /** Current `thinkingEffort` and the efforts the current model offers. */
  effort?: string;
  effortIds: Set<string>;
  /** Effort the composer asked for; reconciled before every turn. */
  requestedEffort?: string;
  /** Session mode (`default` | `plan`) and permission config mcode last reported. */
  currentMode?: string;
  currentPermission?: string;
  /** Mode the composer asked for; reconciled before every turn. */
  permissionMode?: MinimaxPermissionMode;
  imagePrompts: boolean;
  proc: ChildProcessWithoutNullStreams;
  rpc: AcpJsonRpcClient;
  disposeMcp: () => void;
  currentAssistant?: { uuid: string; text: string; createdAt: number; blockIndex: number };
  currentThinking?: { uuid: string; thinking: string; createdAt: number; blockIndex: number };
  nextBlockIndex: number;
  lastCommandsSignature?: string;
  toolCalls: Map<string, MinimaxToolCall>;
  turn?: MinimaxTurn;
  /** Settles when the latest queued turn has ended; turns never overlap. */
  turnChain: Promise<void>;
  /** A plan_update arrived: the next elicitation is that plan's review. */
  pendingPlan?: string;
  /** Last plan shown in the transcript; mcode may resend it unchanged. */
  lastPlan?: string;
  /** Resolved messages.jsonl of this session (usage source). */
  messagesFile?: string;
  /** mcode exited outside a stop; the next turn reconnects and resumes. */
  dead?: boolean;
  /** Sends waiting behind the running turn (not steered into it). */
  queued: number;
  /** Steer requests awaiting mcode's answer; a rejected one queues a turn. */
  steering: number;
  /** An ended turn whose usage is still being read: a stop accounts for it. */
  finalizing?: MinimaxTurn;
  /** The process a reconnect is starting, so a stop can kill it mid-start. */
  connectingProc?: ChildProcessWithoutNullStreams;
  /**
   * The batch of turns not yet reported: each ending turn adds its own usage,
   * and the batch's one result goes out once no turn runs, is queued or may
   * still queue (a steer awaiting mcode). The session never reads idle while
   * a queued turn runs.
   */
  carry?: { startedAt: number; refused: boolean; error?: Error; usage: MinimaxTurnUsage | null };
}

/** An in-flight startSession; stop/dispose cancel it and kill its process. */
interface PendingStart {
  cancelled: boolean;
  proc?: ChildProcessWithoutNullStreams;
}

interface MinimaxConnection {
  proc: ChildProcessWithoutNullStreams;
  rpc: AcpJsonRpcClient;
  binding: SessionBinding;
  disposeMcp: () => void;
  imagePrompts: boolean;
  providerSessionId: string;
  sessionRecord: Record<string, unknown> | null;
}

/** Startup state that arrives before the session is bound, applied once it is. */
interface SessionBinding {
  session?: ActiveMinimaxSession;
  commands?: MinimaxSessionUpdate;
  usage?: MinimaxSessionUpdate;
}

const CAPABILITIES: ProviderAdapterCapabilities = {
  sessionModelSwitch: true,
  skillDiscovery: false,
  pluginDiscovery: false,
  mcpServers: false,
  imageAttachments: true,
  forkThread: false,
  compactThread: false,
  planMode: true,
};

const MINIMAX_PERMISSION_MODES: ReadonlyArray<MinimaxPermissionMode> = ['default', 'auto', 'bypassPermissions', 'plan'];

/**
 * mcode's builtin tools mapped to the Claude-shaped names the transcript
 * renders richly; their arguments are adapted in minimaxToolInput.
 */
const MINIMAX_TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  todowrite: 'TodoWrite',
  task: 'Task',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
};

/** Fallback by ACP tool kind for tools mcode names differently. */
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

/** Open set: valid efforts differ per model and come from mcode itself. */
export function normalizeMinimaxThinkingEffort(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9_-]{1,32}$/i.test(value.trim()) ? value.trim() : undefined;
}

export function normalizeMinimaxPermissionMode(value: unknown): MinimaxPermissionMode | undefined {
  return typeof value === 'string' && MINIMAX_PERMISSION_MODES.includes(value as MinimaxPermissionMode)
    ? (value as MinimaxPermissionMode)
    : undefined;
}

function findConfigOption(configOptions: unknown, id: string, category: string): Record<string, unknown> | null {
  for (const option of getArray(configOptions)) {
    const record = getRecord(option);
    if (record && (getString(record.id) === id || getString(record.category) === category)) return record;
  }
  return null;
}

function extractConfigValue(configOptions: unknown, id: string, category = id): string | undefined {
  return getString(findConfigOption(configOptions, id, category)?.currentValue) || undefined;
}

function extractOptionValues(option: Record<string, unknown> | null): Set<string> {
  const ids = new Set<string>();
  const visit = (entries: unknown): void => {
    for (const entry of getArray(entries)) {
      const record = getRecord(entry);
      if (!record) continue;
      if (Array.isArray(record.options)) visit(record.options);
      else if (getString(record.value)) ids.add(getString(record.value));
    }
  };
  visit(option?.options);
  return ids;
}

function extractModelIds(configOptions: unknown): Set<string> {
  return extractOptionValues(findConfigOption(configOptions, 'model', 'model'));
}

/** `found: false` in a full option list means the model has no effort control. */
function extractEfforts(configOptions: unknown): { found: boolean; current?: string; ids: Set<string> } {
  const option = findConfigOption(configOptions, 'thinkingEffort', 'thought_level');
  if (!option) return { found: false, ids: new Set() };
  return { found: true, current: getString(option.currentValue) || undefined, ids: extractOptionValues(option) };
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  const record = getRecord(content);
  if (!record) return '';
  if (typeof record.text === 'string') return record.text;
  const nested = getRecord(record.content);
  return typeof nested?.text === 'string' ? nested.text : '';
}

/**
 * Tool output: rawOutput.content is what the tool returned. ACP `content`
 * holds previews instead (a write's file text), so it is only a fallback.
 */
function extractToolOutput(update: MinimaxSessionUpdate): string {
  const raw = getArray(getRecord(update.rawOutput)?.content)
    .map((item) => extractTextContent(item))
    .filter(Boolean)
    .join('\n');
  if (raw) return raw;
  return getArray(update.content)
    .map((item) => {
      const record = getRecord(item);
      return record?.type === 'content' ? extractTextContent(record.content) : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function minimaxToolName(update: Record<string, unknown>): string {
  const name = getString(update.name).trim();
  if (name) return MINIMAX_TOOL_NAMES[name] || name;
  return ACP_KIND_TOOL_NAMES[getString(update.kind)] || getString(update.title) || 'MiniMaxTool';
}

/**
 * mcode's arguments → the field names the Claude-shaped cards read. Files are
 * `path` (cards read file_path); an edit is `{ path, edits: [{ oldText, newText }] }`,
 * whose single-replacement form also gets old_string/new_string.
 */
export function minimaxToolInput(name: string, rawInput: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { ...rawInput };
  if ((name === 'Read' || name === 'Write' || name === 'Edit') && typeof input.path === 'string' && input.file_path === undefined) {
    input.file_path = input.path;
  }
  if (name === 'Edit' && Array.isArray(input.edits) && input.edits.length === 1) {
    const edit = getRecord(input.edits[0]);
    if (edit && typeof edit.oldText === 'string' && typeof edit.newText === 'string') {
      input.old_string = edit.oldText;
      input.new_string = edit.newText;
    }
  }
  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    input.todos = input.todos.map((todo) => {
      const record = getRecord(todo);
      if (!record) return todo;
      // Claude's statuses have no "cancelled"; a dropped task reads as done.
      const status = getString(record.status) === 'cancelled' ? 'completed' : record.status;
      return { ...record, status, activeForm: record.activeForm ?? record.content };
    });
  }
  return input;
}

// ── Elicitation (questionnaire / plan review) ──────────────────────────────

interface MinimaxElicitationQuestion {
  /** Property key in requestedSchema — the reply's content key. */
  key: string;
  /** Unique within the request: the card returns answers keyed by it. */
  question: string;
  header?: string;
  /** label = what the card shows; value = the option id sent back (schema const). */
  options: Array<{ label: string; value: string; description?: string }>;
  multiSelect: boolean;
  /** `<key>__other` free-text field accompanying a choice question. */
  otherKey?: string;
  valueType: 'string' | 'boolean' | 'number';
}

export interface MinimaxElicitation {
  message: string;
  questions: MinimaxElicitationQuestion[];
}

function schemaChoices(schema: Record<string, unknown> | null): MinimaxElicitationQuestion['options'] {
  const listed = getArray(schema?.oneOf).length ? getArray(schema?.oneOf) : getArray(schema?.anyOf);
  const choices = listed
    .map((entry) => {
      const record = getRecord(entry);
      const value = record && record.const !== undefined ? String(record.const) : '';
      if (!value) return null;
      const label = getString(record?.title).trim() || value;
      const description = getString(record?.description).trim();
      return { label, value, ...(description ? { description } : {}) };
    })
    .filter((choice): choice is MinimaxElicitationQuestion['options'][number] => Boolean(choice));
  if (choices.length > 0) return choices;
  return getArray(schema?.enum).map((value) => ({ label: String(value), value: String(value) }));
}

/**
 * ACP form elicitation → card questions. mcode sends one property per step:
 * single choice as a string with oneOf (const = option id, title = label),
 * multi-select as an array whose items list anyOf, free text as a bare
 * string, and a choice that also takes free text gets a `<key>__other` field.
 */
export function parseMinimaxElicitation(params: unknown): MinimaxElicitation | null {
  const record = getRecord(params);
  if (!record || (record.mode !== undefined && record.mode !== 'form')) return null;
  const properties = getRecord(getRecord(record.requestedSchema)?.properties);
  if (!properties) return null;
  const message = getString(record.message).trim();
  const keys = Object.keys(properties);
  // mcode names it `<key>__other`, padded with `_` if that key is taken.
  const baseOf = (key: string) => /^(.+?)__other_*$/.exec(key)?.[1];
  const otherKeys = new Set(keys.filter((key) => {
    const base = baseOf(key);
    return base !== undefined && keys.includes(base);
  }));
  const used = new Set<string>();
  const questions: MinimaxElicitationQuestion[] = [];
  for (const key of keys) {
    if (otherKeys.has(key)) continue;
    const schema = getRecord(properties[key]);
    if (!schema) continue;
    const type = getString(schema.type);
    const title = getString(schema.title).trim();
    let question = title || getString(schema.description).trim() || message || key;
    if (used.has(question)) question = `${question} (${key})`;
    used.add(question);
    const multiSelect = type === 'array';
    const options =
      type === 'boolean'
        ? [{ label: 'Yes', value: 'true' }, { label: 'No', value: 'false' }]
        : schemaChoices(multiSelect ? getRecord(schema.items) : schema);
    const otherKey = keys.find((candidate) => otherKeys.has(candidate) && baseOf(candidate) === key);
    questions.push({
      key,
      question,
      ...(title && message && message !== title ? { header: message } : {}),
      options,
      multiSelect,
      ...(otherKey ? { otherKey } : {}),
      valueType: type === 'boolean' ? 'boolean' : type === 'number' || type === 'integer' ? 'number' : 'string',
    });
  }
  return questions.length > 0 ? { message, questions } : null;
}

/**
 * Card answers (keyed by question text; multi-select and "Other" text
 * comma-joined) → the reply's typed content. Option labels map back to their
 * ids; what remains is the user's own text, which goes to the question's
 * `__other` field when it has one.
 */
/**
 * Card answers → the reply's typed content. `structured` (the card's
 * questionAnswers) carries the exact option labels and the "Other" text, so
 * either may contain commas; without it, the comma-joined `answers` string is
 * split back (splitJoinedAnswer).
 */
export function buildMinimaxElicitationContent(
  elicitation: MinimaxElicitation,
  answers: Record<string, string>,
  structured?: Record<string, QuestionAnswerSelection>
): Record<string, string | string[] | boolean | number> {
  const content: Record<string, string | string[] | boolean | number> = {};
  for (const question of elicitation.questions) {
    const picked = structured?.[question.question];
    const raw = picked
      ? [...picked.selected, ...(picked.other ? [picked.other] : [])].join(',').trim()
      : (answers[question.question] || '').trim();
    if (!raw) continue;
    if (question.valueType === 'boolean') {
      content[question.key] = /^(yes|true)$/i.test(picked ? picked.selected[0] ?? picked.other ?? '' : raw);
      continue;
    }
    if (question.options.length === 0) {
      const text = picked ? (picked.other ?? picked.selected.join(',')).trim() : raw;
      const asNumber = Number(text);
      content[question.key] = question.valueType === 'number' && Number.isFinite(asNumber) ? asNumber : text;
      continue;
    }
    const byLabel = new Map(question.options.map((option) => [option.label, option.value]));
    const answer = picked
      ? { selected: picked.selected.filter((label) => byLabel.has(label)), other: picked.other?.trim() || '' }
      : splitJoinedAnswer(raw, [...byLabel.keys()]);
    const selected = answer.selected.map((label) => byLabel.get(label) as string);
    const custom = answer.other;
    if (question.multiSelect) {
      content[question.key] = selected;
    } else if (selected[0]) {
      content[question.key] = selected[0];
    }
    if (custom) {
      if (question.otherKey) content[question.otherKey] = custom;
      else if (!question.multiSelect && content[question.key] === undefined) content[question.key] = custom;
    }
  }
  return content;
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

/** A steer is text only: attachments ride along as their on-disk paths. */
function buildSteerText(prompt: string, attachments?: Attachment[]): string {
  return [prompt.trim(), ...(attachments || []).map(attachmentText)].filter(Boolean).join('\n\n');
}

/** mcode stores a session under `<date>/<time>-session_<base64url(sessionId)>/`. */
export function findMinimaxMessagesFile(sessionId: string, root = path.join(minimaxDataDir(), 'v2', 'sessions')): string | null {
  const suffix = `-session_${Buffer.from(sessionId).toString('base64url')}`;
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const year of list(root)) {
    for (const month of list(path.join(root, year))) {
      for (const day of list(path.join(root, year, month))) {
        const dayDir = path.join(root, year, month, day);
        const match = list(dayDir).find((name) => name.endsWith(suffix));
        if (match) return path.join(dayDir, match, 'messages.jsonl');
      }
    }
  }
  return null;
}

export interface MinimaxTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: ProviderCostDetails;
  model?: string;
  /** The last logged request ended the turn (not a tool-use step). */
  settled: boolean;
}

/**
 * Sums every assistant message of the turn (those stamped at or after its
 * start). Each message is one model request and is priced on its own, so
 * M3's per-request 512K tier applies correctly. mcode prices requests from
 * its local model config, which carries no rates for MiniMax's own models
 * (`cost.total` is 0), so only a positive cost counts as reported; the rest
 * is estimated from MiniMax's list price. Models served by a custom provider
 * are never priced as MiniMax's.
 */
export function sumMinimaxTurnUsage(jsonl: string, since: number): MinimaxTurnUsage | null {
  const usage: MinimaxTurnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: emptyCostDetails(),
    settled: false,
  };
  let found = false;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let message: Record<string, unknown> | null = null;
    try {
      message = getRecord(getRecord(JSON.parse(line))?.message);
    } catch {
      continue;
    }
    if (!message || message.role !== 'assistant' || getNumber(message.timestamp) < since) continue;
    const reported = getRecord(message.usage);
    if (!reported) continue;
    found = true;
    usage.inputTokens += getNumber(reported.input);
    usage.outputTokens += getNumber(reported.output);
    usage.cacheReadTokens += getNumber(reported.cacheRead);
    usage.cacheWriteTokens += getNumber(reported.cacheWrite);
    usage.totalTokens +=
      getNumber(reported.totalTokens) ||
      getNumber(reported.input) + getNumber(reported.output) + getNumber(reported.cacheRead) + getNumber(reported.cacheWrite);
    const reportedCost = getNumber(getRecord(reported.cost)?.total);
    const official = /^minimax/i.test(getString(message.provider));
    addAgentCost(usage.cost, 'minimax', official ? getString(message.model) : '', {
      input_tokens: getNumber(reported.input),
      output_tokens: getNumber(reported.output),
      cache_read_input_tokens: getNumber(reported.cacheRead),
      cache_creation_input_tokens: getNumber(reported.cacheWrite),
    }, reportedCost > 0 ? reportedCost : undefined, getNumber(message.timestamp), true);
    if (getString(message.model)) usage.model = getString(message.model);
    usage.settled = !/^tool/i.test(getString(message.stopReason));
  }
  return found ? usage : null;
}

/** Sums two turns' usage (either may be absent) into the batch's. */
export function addMinimaxTurnUsage(total: MinimaxTurnUsage | null, turn: MinimaxTurnUsage | null): MinimaxTurnUsage | null {
  if (!turn) return total;
  if (!total) return { ...turn, cost: { ...turn.cost } };
  return {
    inputTokens: total.inputTokens + turn.inputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
    cacheReadTokens: total.cacheReadTokens + turn.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + turn.cacheWriteTokens,
    totalTokens: total.totalTokens + turn.totalTokens,
    cost: {
      reportedUsd: total.cost.reportedUsd + turn.cost.reportedUsd,
      estimatedUsd: total.cost.estimatedUsd + turn.cost.estimatedUsd,
      reportedCount: total.cost.reportedCount + turn.cost.reportedCount,
      estimatedCount: total.cost.estimatedCount + turn.cost.estimatedCount,
      unpricedCount: total.cost.unpricedCount + turn.cost.unpricedCount,
    },
    model: turn.model ?? total.model,
    settled: turn.settled,
  };
}

function terminateProcess(proc: ChildProcessWithoutNullStreams): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
    }
  }, 500);
  killTimer.unref?.();
  proc.once('exit', () => clearTimeout(killTimer));
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class MinimaxAcpAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'minimax';
  readonly displayName = 'MiniMax Code';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  private sessions = new Map<string, ActiveMinimaxSession>();
  /** Tool approvals and questions (elicitation/create) awaiting the UI. */
  private pendingPermissions = new Map<
    string,
    {
      threadId: string;
      rpc: AcpJsonRpcClient;
      request: AcpJsonRpcIncomingRequest;
    } & (
      | { kind: 'permission'; options: AcpPermissionOption[] }
      | { kind: 'elicitation'; elicitation: MinimaxElicitation }
    )
  >();

  private starting = new Map<string, PendingStart>();


  /**
   * Spawns `mcode acp`, initializes it and opens (or resumes) the ACP session.
   * `guard` runs after every await and throws once the start was cancelled;
   * every failure path kills the process it spawned.
   */
  private async connect(
    threadId: string,
    cwd: string,
    resumeSessionId: string | undefined,
    guard: (proc?: ChildProcessWithoutNullStreams) => void
  ): Promise<MinimaxConnection> {
    const binary = await resolveMinimaxBinary();
    guard();
    if (!binary) {
      throw new Error('MiniMax Code CLI was not found. Install MiniMax Code or set MINIMAX_CLI_PATH.');
    }

    const proc = spawn(binary, ['acp'], {
      cwd,
      env: buildMinimaxEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.warn('[MiniMax Code ACP]', text);
    });

    const binding: SessionBinding = {};
    let rpc!: AcpJsonRpcClient;
    rpc = new AcpJsonRpcClient(
      proc,
      (method, params) => this.handleNotification(binding, method, params),
      (request) => this.handleRequest(binding, rpc, request),
      (line, error) => {
        console.warn('[MiniMax Code ACP] failed to parse stdout line', { line, error: error.message });
      }
    );

    let disposeMcp = () => {};
    const fail = (error: unknown): never => {
      disposeMcp();
      terminateProcess(proc);
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
          clientInfo: { name: 'aegis', title: 'Aegis', version: '0.0.32' },
          // No fs/terminal: mcode runs its own file and shell tools. Form
          // elicitation carries its questions and plan reviews; `plan` makes
          // it send the plan markdown under review.
          clientCapabilities: { elicitation: { form: {} }, plan: {} },
        })
      )
    );
    const imagePrompts =
      getRecord(getRecord(getRecord(initialized?.agentCapabilities)?.promptCapabilities))?.image === true;

    // Aegis's session tools (read_session, start_workflow) and the built-in
    // browser for chat sessions; workflow members get none.
    const mcpServers: unknown[] = [];
    if (!getWorkflowSessionPolicy(threadId)) {
      mcpServers.push(
        createGrokAcpHttpMcpServer(SESSION_MCP_SERVER_NAME, await step(getSessionReaderHttpConfig({ sessionId: threadId })))
      );
      if (isBrowserUseEnabled()) {
        const descriptor = await createBrowserUseSessionMcpDescriptor(threadId).catch(fail);
        // Adopt it before the cancellation check, so a cancelled start disposes it.
        disposeMcp = descriptor.dispose;
        await step(Promise.resolve());
        mcpServers.push(createGrokAcpHttpMcpServer(BROWSER_USE_SERVER_NAME, descriptor));
      }
    }

    let sessionRecord: Record<string, unknown> | null = null;
    let providerSessionId = '';
    if (resumeSessionId) {
      try {
        sessionRecord = getRecord(await rpc.request('session/resume', { sessionId: resumeSessionId, cwd, mcpServers }));
        providerSessionId = resumeSessionId;
      } catch (error) {
        // A session mcode no longer has (deleted, other machine) must not
        // brick the thread: continue in a fresh session.
        console.warn('[MiniMax Code ACP] session/resume failed; starting a new session:', error instanceof Error ? error.message : error);
        binding.commands = undefined;
        binding.usage = undefined;
      }
      await step(Promise.resolve());
    }
    if (!providerSessionId) {
      sessionRecord = getRecord(await step(rpc.request('session/new', { cwd, mcpServers })));
      providerSessionId = getString(sessionRecord?.sessionId);
      if (!providerSessionId) {
        fail(new Error('MiniMax Code ACP did not return a sessionId.'));
      }
    }
    return { proc, rpc, binding, disposeMcp, imagePrompts, providerSessionId, sessionRecord };
  }

  /** Session config as the (re)opened ACP session reports it. */
  private adoptSessionRecord(session: ActiveMinimaxSession, record: Record<string, unknown> | null): void {
    const efforts = extractEfforts(record?.configOptions);
    session.model = extractConfigValue(record?.configOptions, 'model');
    session.modelIds = extractModelIds(record?.configOptions);
    session.rejectedModel = undefined;
    session.effort = efforts.current;
    session.effortIds = efforts.ids;
    session.currentMode = getString(getRecord(record?.modes)?.currentModeId) || undefined;
    session.currentPermission = extractConfigValue(record?.configOptions, 'permissionMode', '_permission');
  }

  /** Binds a connection to its session: routing, exit handling, startup state. */
  private bindConnection(session: ActiveMinimaxSession, connection: MinimaxConnection): void {
    const { proc, binding } = connection;
    session.proc = proc;
    session.rpc = connection.rpc;
    session.disposeMcp = connection.disposeMcp;
    session.imagePrompts = connection.imagePrompts;
    session.dead = false;
    binding.session = session;

    proc.on('exit', () => {
      if (this.sessions.get(session.threadId) !== session || session.proc !== proc) return;
      // Not a stop (that removes the session first): mcode exited on its own.
      // A running turn fails through its rejected RPC; the next send
      // reconnects and resumes rather than writing into a dead pipe.
      session.dead = true;
      session.disposeMcp();
      this.dismissPermissions(session.threadId);
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
      if (pending.cancelled) throw new Error('MiniMax Code session start was cancelled.');
    };

    let connection: MinimaxConnection;
    let active: ActiveMinimaxSession;
    try {
      connection = await this.connect(input.threadId, input.cwd, input.resumeSessionId, guard);
      active = {
        threadId: input.threadId,
        providerSessionId: connection.providerSessionId,
        status: 'running',
        cwd: input.cwd,
        modelIds: new Set(),
        effortIds: new Set(),
        requestedEffort: normalizeMinimaxThinkingEffort(input.minimaxThinkingEffort),
        permissionMode: normalizeMinimaxPermissionMode(input.minimaxPermissionMode),
        imagePrompts: connection.imagePrompts,
        proc: connection.proc,
        rpc: connection.rpc,
        disposeMcp: connection.disposeMcp,
        nextBlockIndex: 0,
        toolCalls: new Map(),
        turnChain: Promise.resolve(),
        queued: 0,
        steering: 0,
      };
      this.adoptSessionRecord(active, connection.sessionRecord);
      try {
        await this.applyModel(active, input.model);
        await this.applyEffort(active, active.requestedEffort);
        await this.applyPermissionMode(active, active.permissionMode);
        guard();
      } catch (error) {
        connection.disposeMcp();
        terminateProcess(connection.proc);
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
      // so waiting out the first turn here would hold a steer until it ends.
      void this.sendTurn({
        threadId: input.threadId,
        prompt: input.prompt,
        attachments: input.attachments,
        model: input.model,
        minimaxPermissionMode: active.permissionMode,
        minimaxThinkingEffort: active.requestedEffort,
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
      provider: 'minimax',
      providerSessionId: active.providerSessionId,
      status: 'running',
      model: active.model,
    };
  }

  /** mcode exited between turns: reopen the same session in a fresh process. */
  private async reconnect(session: ActiveMinimaxSession): Promise<void> {
    const owned = (proc?: ChildProcessWithoutNullStreams) => {
      if (proc) session.connectingProc = proc;
      if (this.sessions.get(session.threadId) !== session) throw new Error('MiniMax Code session was stopped.');
    };
    let connection: MinimaxConnection;
    try {
      connection = await this.connect(session.threadId, session.cwd, session.providerSessionId, owned);
    } finally {
      session.connectingProc = undefined;
    }
    const replaced = connection.providerSessionId !== session.providerSessionId;
    session.providerSessionId = connection.providerSessionId;
    session.messagesFile = undefined;
    this.adoptSessionRecord(session, connection.sessionRecord);
    // mcode no longer had the session and a fresh one replaced it: announce
    // it, since system_init is what stores the id the next cold start resumes.
    if (replaced) {
      this.emit({
        type: 'system_init',
        threadId: session.threadId,
        sessionId: session.providerSessionId,
        model: session.model,
      });
    }
    this.bindConnection(session, connection);
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      throw new Error(`No MiniMax Code session found for thread "${input.threadId}"`);
    }

    // Steer: fold the message into the running turn. Images cannot be
    // steered, and a turn that has not reached mcode yet cannot take one;
    // both queue as the next turn instead.
    const running = session.turn;
    const hasImages = Boolean(session.imagePrompts && input.attachments?.some((attachment) => attachment.kind === 'image'));
    // Counted while mcode decides: if the turn ends meanwhile, its result
    // waits, since a rejected steer becomes a queued turn of the same batch.
    let steering = false;
    if (running?.promptSent && !hasImages && !session.dead) {
      session.requestedEffort = normalizeMinimaxThinkingEffort(input.minimaxThinkingEffort) ?? session.requestedEffort;
      session.permissionMode = normalizeMinimaxPermissionMode(input.minimaxPermissionMode) ?? session.permissionMode;
      session.steering += 1;
      steering = true;
      try {
        await session.rpc.request('mcode/session/steer', {
          sessionId: session.providerSessionId,
          text: buildSteerText(input.prompt, input.attachments),
          clientRequestId: uuidv4(),
        });
        await running.done;
        session.steering -= 1;
        this.finishBatchIfIdle(session);
        return;
      } catch (error) {
        // The turn ended (or was not admitted) in between: run it as the next turn.
        console.warn('[MiniMax Code ACP] steer was not admitted; queuing as the next turn:', error instanceof Error ? error.message : error);
      }
    }

    const previous = session.turnChain;
    let release!: () => void;
    session.turnChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    session.queued += 1;
    // Queued before the steer stops counting: the batch never sees neither.
    if (steering) session.steering -= 1;
    let dequeued = false;
    try {
      await previous;
      session.queued -= 1;
      dequeued = true;
      // A stop/dispose kills the process, which rejects this turn's RPC — that
      // stale rejection must not land in whatever session now owns the thread.
      if (this.sessions.get(input.threadId) !== session) return;
      await this.runTurn(session, input);
    } finally {
      if (!dequeued) session.queued -= 1;
      release();
    }
  }

  private async runTurn(session: ActiveMinimaxSession, input: ProviderSendTurnInput): Promise<void> {
    let resolveDone!: () => void;
    const turn: MinimaxTurn = {
      startedAt: Date.now(),
      logOffset: 0,
      promptSent: false,
      refused: false,
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
      resolveDone: () => resolveDone(),
    };
    session.turn = turn;
    session.status = 'running';
    session.currentAssistant = undefined;
    session.currentThinking = undefined;
    this.emit({ type: 'status_change', threadId: session.threadId, status: 'running' });

    try {
      if (session.dead) await this.reconnect(session);
      await this.applyModel(session, input.model);
      await this.applyEffort(session, input.minimaxThinkingEffort);
      await this.applyPermissionMode(session, input.minimaxPermissionMode);
      setBrowserUseSessionFullAccess(session.threadId, session.permissionMode === 'bypassPermissions');
      turn.logOffset = this.messagesLogSize(session);
      const pending = session.rpc.request('session/prompt', {
        sessionId: session.providerSessionId,
        prompt: buildPromptBlocks(input.prompt, input.attachments, session.imagePrompts),
      });
      turn.promptSent = true;
      const promptResult = getRecord(await pending);
      if (getString(promptResult?.stopReason) === 'refusal') turn.refused = true;
    } catch (error) {
      turn.error = error instanceof Error ? error : new Error(String(error));
    }

    if (this.sessions.get(session.threadId) !== session) {
      turn.resolveDone();
      return;
    }
    this.finalizeStreaming(session);
    await this.endTurn(session, turn);
  }

  /**
   * Adds the turn to the session's batch: its own usage, read from its own
   * log slice (and own session file) while the next queued turn has not
   * started, then reports the batch if nothing else belongs to it.
   */
  private async endTurn(session: ActiveMinimaxSession, turn: MinimaxTurn): Promise<void> {
    session.turn = undefined;
    this.settleOpenToolCalls(session);
    // A prompt that never went out has no usage of its own; reading from
    // offset 0 would count the session's whole history. While the read
    // polls, the turn stays reachable so a stop can account for it at once.
    let usage: MinimaxTurnUsage | null = null;
    if (turn.promptSent) {
      session.finalizing = turn;
      try {
        usage = await this.readTurnUsage(session, turn.logOffset, turn.startedAt, !turn.error, () => Boolean(turn.accounted));
      } finally {
        if (session.finalizing === turn) session.finalizing = undefined;
      }
    }
    // Retired meanwhile: the stop already reported this turn's usage.
    if (this.sessions.get(session.threadId) !== session || turn.accounted) {
      turn.resolveDone();
      return;
    }
    const batch = session.carry ?? { startedAt: turn.startedAt, refused: false, usage: null };
    batch.usage = addMinimaxTurnUsage(batch.usage, usage);
    batch.refused ||= turn.refused;
    batch.error ??= turn.error;
    session.carry = batch;
    turn.resolveDone();
    this.finishBatchIfIdle(session);
  }

  /**
   * Reports the batch once no turn runs, none is queued and no steer may
   * still queue one. Synchronous from that check to the result, so a send
   * cannot slip in between.
   */
  private finishBatchIfIdle(session: ActiveMinimaxSession): void {
    const batch = session.carry;
    if (!batch || session.turn || session.queued > 0 || session.steering > 0) return;
    if (this.sessions.get(session.threadId) !== session) return;
    session.carry = undefined;
    finishBrowserUseTurn(browserManager, session.threadId);
    const { startedAt, refused, error, usage } = batch;
    session.status = error ? 'error' : 'completed';
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'result',
        subtype: error || refused ? 'error' : 'success',
        duration_ms: Date.now() - startedAt,
        // Estimated at MiniMax's list price unless mcode itself priced the request.
        ...costFields(usage?.cost ?? emptyCostDetails()),
        usage: {
          input_tokens: usage?.inputTokens ?? 0,
          output_tokens: usage?.outputTokens ?? 0,
          cache_read_input_tokens: usage?.cacheReadTokens ?? 0,
          cache_creation_input_tokens: usage?.cacheWriteTokens ?? 0,
          total_tokens: usage?.totalTokens ?? 0,
        },
        model: session.model,
      },
    });
    if (error) {
      this.emit({ type: 'error', threadId: session.threadId, error });
    } else {
      this.emit({ type: 'status_change', threadId: session.threadId, status: 'completed' });
    }
  }

  /** Current size of the session's message log (0 before mcode first writes it). */
  private messagesLogSize(session: ActiveMinimaxSession): number {
    try {
      session.messagesFile ??= findMinimaxMessagesFile(session.providerSessionId) ?? undefined;
      return session.messagesFile ? statSync(session.messagesFile).size : 0;
    } catch {
      return 0;
    }
  }

  /**
   * The turn's records are the lines appended after `logOffset`: a timestamp
   * cut-off cannot separate back-to-back turns that share a millisecond. If
   * the log shrank (rewritten), fall back to the turn's start time.
   */
  /** Usage logged after `logOffset` (or since `startedAt` if the log was rewritten smaller). */
  private readUsageSlice(session: ActiveMinimaxSession, logOffset: number, startedAt: number): MinimaxTurnUsage | null {
    try {
      session.messagesFile ??= findMinimaxMessagesFile(session.providerSessionId) ?? undefined;
      if (!session.messagesFile) return null;
      const log = readFileSync(session.messagesFile);
      return log.length >= logOffset
        ? sumMinimaxTurnUsage(log.subarray(logOffset).toString('utf8'), 0)
        : sumMinimaxTurnUsage(log.toString('utf8'), startedAt);
    } catch {
      return null;
    }
  }

  private async readTurnUsage(
    session: ActiveMinimaxSession,
    logOffset: number,
    startedAt: number,
    waitForFinal: boolean,
    abandoned: () => boolean
  ): Promise<MinimaxTurnUsage | null> {
    const read = () => this.readUsageSlice(session, logOffset, startedAt);
    // The log is appended as requests finish and may trail the prompt
    // response: wait (bounded) until the turn's last request is a final one,
    // not a tool-use step that a later request follows.
    // A failed turn may never log a final request: one late look only.
    let usage = read();
    // A stop accounts for the turn itself; polling on could only read a
    // successor's records into this turn.
    for (let attempt = 0; attempt < (waitForFinal ? 8 : 2) && !usage?.settled && !abandoned(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (abandoned()) return null;
      usage = read();
    }
    return usage;
  }

  async stopSession(threadId: string): Promise<void> {
    this.cancelPendingStart(threadId);
    const session = this.sessions.get(threadId);
    if (!session) return;
    session.status = 'stopped';
    try {
      session.rpc.notify('session/cancel', { sessionId: session.providerSessionId });
    } catch {
      // ignore shutdown cancellation errors
    }
    this.retireSession(threadId);
  }

  disposeSession(threadId: string): boolean {
    const cancelled = this.cancelPendingStart(threadId);
    return this.retireSession(threadId) || cancelled;
  }

  /** A start still connecting: mark it cancelled and kill what it spawned. */
  private cancelPendingStart(threadId: string): boolean {
    const pending = this.starting.get(threadId);
    if (!pending) return false;
    this.starting.delete(threadId);
    pending.cancelled = true;
    if (pending.proc) terminateProcess(pending.proc);
    return true;
  }

  /**
   * A stop retires the session after the runner stopped forwarding events, so
   * the usage the stopped batch already incurred (its completed turns and the
   * stopped turn's logged requests) goes out as a process-wide usage_record,
   * not a turn result. The host persists it at once.
   */
  private reportUnreportedUsage(session: ActiveMinimaxSession, usage: MinimaxTurnUsage, startedAt: number): void {
    this.emit({
      type: 'usage_unreported',
      threadId: session.threadId,
      provider: 'minimax',
      message: {
        type: 'usage_record',
        uuid: `minimax-usage:${session.threadId}:${uuidv4()}`,
        duration_ms: Math.max(0, Date.now() - startedAt),
        ...costFields(usage.cost),
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_input_tokens: usage.cacheReadTokens,
          cache_creation_input_tokens: usage.cacheWriteTokens,
          total_tokens: usage.totalTokens,
        },
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
      // Completed turns of an unfinished batch, plus what the stopped turn
      // already logged (mcode is killed below, so nothing more follows).
      // The running turn, or one that ended and is still reading its usage.
      const running = session.turn ?? session.finalizing;
      const stopped = running?.promptSent ? this.readUsageSlice(session, running.logOffset, running.startedAt) : null;
      if (running) running.accounted = true;
      const unreported = addMinimaxTurnUsage(session.carry?.usage ?? null, stopped);
      if (unreported) this.reportUnreportedUsage(session, unreported, session.carry?.startedAt ?? running?.startedAt ?? Date.now());
      session.carry = undefined;
      // Map entry first: the exit handler is identity-guarded, so the async
      // exit then emits nothing.
      this.sessions.delete(threadId);
      session.turn?.resolveDone();
      finishBrowserUseTurn(browserManager, threadId);
      setBrowserUseSessionFullAccess(threadId, false);
      session.disposeMcp();
      terminateProcess(session.proc);
      if (session.connectingProc) terminateProcess(session.connectingProc);
    } catch (error) {
      console.warn('[MinimaxAcpAdapter] session teardown failed:', error);
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
      provider: 'minimax',
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
    if (pending.kind === 'elicitation') {
      const answers = getRecord(decision.updatedInput?.answers);
      pending.rpc.respond(
        pending.request.id,
        decision.behavior === 'allow' && answers
          ? {
              action: 'accept',
              content: buildMinimaxElicitationContent(
                pending.elicitation,
                Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, getString(value)])),
                decision.questionAnswers
              ),
            }
          : { action: 'decline' }
      );
      return;
    }
    const optionId = this.resolveOptionId(decision, pending.options);
    pending.rpc.respond(pending.request.id, {
      outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
    });
  }

  /** mcode's skills reach the composer through its ACP command feed. */
  async listSkills(_input: ProviderListSkillsInput): Promise<ProviderListSkillsResult> {
    return { skills: [], source: 'minimax-acp', cached: false };
  }

  getComposerCapabilities(): ProviderComposerCapabilities {
    return {
      provider: 'minimax',
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      // mcode pushes available_commands_update (builtins + skills) after session/new.
      supportsNativeSlashCommandDiscovery: true,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: false,
    };
  }

  // ── Session config ───────────────────────────────────────────────────────

  private async setConfigOption(session: ActiveMinimaxSession, configId: string, value: string): Promise<unknown> {
    const result = getRecord(
      await session.rpc.request('session/set_config_option', {
        sessionId: session.providerSessionId,
        configId,
        value,
      })
    );
    this.applyConfigOptions(session, result?.configOptions);
    return result?.configOptions;
  }

  private applyConfigOptions(session: ActiveMinimaxSession, configOptions: unknown): void {
    if (getArray(configOptions).length === 0) return;
    session.model = extractConfigValue(configOptions, 'model') || session.model;
    const ids = extractModelIds(configOptions);
    if (ids.size > 0) session.modelIds = ids;
    // A model switch resets the effort to that model's own default (or drops it).
    const efforts = extractEfforts(configOptions);
    session.effort = efforts.current;
    session.effortIds = efforts.ids;
    session.currentPermission = extractConfigValue(configOptions, 'permissionMode', '_permission') || session.currentPermission;
  }

  private async applyModel(session: ActiveMinimaxSession, model: string | undefined): Promise<void> {
    const requested = model?.trim();
    if (!requested || requested === session.model || requested === session.rejectedModel) {
      return;
    }
    if (session.modelIds.size > 0 && !session.modelIds.has(requested)) {
      session.rejectedModel = requested;
      console.warn(`[MiniMax Code ACP] model "${requested}" is not offered by this session; keeping ${session.model}.`);
      return;
    }
    try {
      await this.setConfigOption(session, 'model', requested);
      session.model ||= requested;
      session.rejectedModel = undefined;
    } catch (error) {
      // A value mcode advertises but rejects, or one the account lost.
      session.rejectedModel = requested;
      console.warn('[MiniMax Code ACP] could not switch model:', error instanceof Error ? error.message : error);
    }
  }

  /**
   * Runs after applyModel: a model switch resets the effort, so the composer's
   * choice is re-applied whenever the model's efforts include it. An effort
   * the current model does not offer is left to its own default.
   */
  private async applyEffort(session: ActiveMinimaxSession, effort: string | undefined): Promise<void> {
    const requested = normalizeMinimaxThinkingEffort(effort) ?? session.requestedEffort;
    session.requestedEffort = requested;
    if (!requested || requested === session.effort || !session.effortIds.has(requested)) {
      return;
    }
    await this.setConfigOption(session, 'thinkingEffort', requested);
    session.effort ||= requested;
  }

  /**
   * Reconciled before every turn, even when the picker value is unchanged:
   * mcode can leave plan mode on its own (an approved plan review).
   */
  private async applyPermissionMode(
    session: ActiveMinimaxSession,
    mode: MinimaxPermissionMode | undefined
  ): Promise<void> {
    const permissionMode = normalizeMinimaxPermissionMode(mode) ?? session.permissionMode;
    if (!permissionMode) {
      return;
    }
    session.permissionMode = permissionMode;
    const targetMode = permissionMode === 'plan' ? 'plan' : 'default';
    if (session.currentMode !== targetMode) {
      await session.rpc.request('session/set_mode', {
        sessionId: session.providerSessionId,
        modeId: targetMode,
      });
      session.currentMode = targetMode;
    }
    // Plan keeps whichever permission mode was in force.
    if (permissionMode !== 'plan' && session.currentPermission !== permissionMode) {
      await this.setConfigOption(session, 'permissionMode', permissionMode);
      session.currentPermission = permissionMode;
    }
  }

  // ── ACP routing ──────────────────────────────────────────────────────────

  private handleNotification(binding: SessionBinding, method: string, params?: Record<string, unknown>): void {
    // `mcode/session/*` extension notifications are only sent to clients that
    // opt in, which Aegis does not.
    if (method !== 'session/update') {
      return;
    }
    const update = getRecord(params?.update) as MinimaxSessionUpdate | null;
    if (!update) return;

    const session = binding.session;
    if (!session || this.sessions.get(session.threadId) !== session) {
      if (session) return;
      // Pre-bind: startup state.
      if (update.sessionUpdate === 'available_commands_update') binding.commands = update;
      else if (update.sessionUpdate === 'usage_update') binding.usage = update;
      return;
    }
    this.handleSessionUpdate(session, update);
  }

  private handleRequest(binding: SessionBinding, rpc: AcpJsonRpcClient, request: AcpJsonRpcIncomingRequest): void {
    const session = binding.session;
    const live = Boolean(session && this.sessions.get(session.threadId) === session);
    if (request.method === 'session/request_permission') {
      if (live && session) this.handlePermissionRequest(session, rpc, request);
      else rpc.respond(request.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    if (request.method === 'elicitation/create') {
      if (live && session) this.handleElicitation(session, rpc, request);
      else rpc.respond(request.id, { action: 'cancel' });
      return;
    }
    // fs/* and terminal/* are not advertised, so mcode should never ask.
    rpc.respond(request.id, undefined, {
      code: -32601,
      message: `Unsupported MiniMax Code ACP reverse request: ${request.method}`,
    });
  }

  private handlePermissionRequest(
    session: ActiveMinimaxSession,
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
    // The request's toolCall is self-contained (its id is not the tool call's).
    const toolName = minimaxToolName(toolCall);
    const rawInput = getRecord(toolCall.rawInput);
    const command = toolName === 'Bash' ? getString(rawInput?.command) : '';
    const title = getString(toolCall.title) || command || 'MiniMax Code permission request';
    const requestId = `minimax-permission:${session.threadId}:${request.id}`;
    this.pendingPermissions.set(requestId, { kind: 'permission', threadId: session.threadId, rpc, request, options });
    const input: AcpPermissionInput = {
      kind: 'acp-permission',
      provider: 'minimax',
      question: command || title,
      title,
      toolName,
      options,
      toolCall: {
        ...toolCall,
        title,
        ...(rawInput ? { rawInput: minimaxToolInput(toolName, rawInput) } : {}),
      },
    };
    this.emit({
      type: 'permission_request',
      threadId: session.threadId,
      requestId,
      toolName,
      input,
    });
  }

  /**
   * Questions map onto the AskUserQuestion card. A plan review is the same
   * card: its plan is already in the transcript (plan_update → proposed_plan),
   * since the card itself renders only questions.
   */
  private handleElicitation(session: ActiveMinimaxSession, rpc: AcpJsonRpcClient, request: AcpJsonRpcIncomingRequest): void {
    const elicitation = parseMinimaxElicitation(request.params);
    if (!elicitation) {
      // Only form mode is advertised; anything else has no UI to land in.
      rpc.respond(request.id, { action: 'decline' });
      return;
    }
    const requestId = `minimax-elicitation:${session.threadId}:${request.id}`;
    this.pendingPermissions.set(requestId, { kind: 'elicitation', threadId: session.threadId, rpc, request, elicitation });
    const planReview = Boolean(session.pendingPlan);
    session.pendingPlan = undefined;
    const questions: AskUserQuestionInput['questions'] = elicitation.questions.map((question) => ({
      question: question.question,
      ...(question.header || planReview ? { header: question.header || 'Plan approval' } : {}),
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
      ...(question.multiSelect ? { multiSelect: true } : {}),
    }));
    this.emit({
      type: 'permission_request',
      threadId: session.threadId,
      requestId,
      toolName: 'AskUserQuestion',
      input: { questions } satisfies AskUserQuestionInput,
    });
  }

  private dismissPermissions(threadId: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.threadId !== threadId) continue;
      this.pendingPermissions.delete(requestId);
      this.emit({ type: 'permission_dismissed', threadId, requestId });
      try {
        pending.rpc.respond(
          pending.request.id,
          pending.kind === 'elicitation' ? { action: 'cancel' } : { outcome: { outcome: 'cancelled' } }
        );
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
    const isReject = (option: AcpPermissionOption) => `${option.kind || ''} ${option.optionId}`.toLowerCase().match(/reject|deny/);
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

  private handleSessionUpdate(session: ActiveMinimaxSession, update: MinimaxSessionUpdate): void {
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
      case 'plan_update': {
        const plan = getRecord(update.plan);
        const planMarkdown = getString(plan?.content).trim();
        if (getString(plan?.type) !== 'markdown' || !planMarkdown) break;
        session.pendingPlan = planMarkdown;
        // The plan card persists in the transcript, above the approval card
        // and inspectable after it resolves; an unchanged resend adds none.
        if (planMarkdown !== session.lastPlan) {
          session.lastPlan = planMarkdown;
          this.finalizeStreaming(session);
          this.emit({
            type: 'message',
            threadId: session.threadId,
            message: {
              type: 'proposed_plan',
              uuid: `minimax-proposed-plan:${session.threadId}:${uuidv4()}`,
              planMarkdown,
            },
          });
        }
        break;
      }
      case 'plan_removed':
        session.pendingPlan = undefined;
        break;
      case 'available_commands_update':
        this.emitAvailableCommands(session, update);
        break;
      case 'config_option_update':
        this.applyConfigOptions(session, update.configOptions);
        break;
      case 'current_mode_update':
        session.currentMode = getString(update.currentModeId) || session.currentMode;
        break;
      case 'usage_update':
        this.emitTokenUsage(session, update);
        break;
      default:
        // session_info_update (timestamps only), user_message_chunk (replay only).
        break;
    }
  }

  /**
   * Mid-turn text and reasoning ride Claude-shaped stream events carrying only
   * the increment, which the renderer's delta coalescer batches; the committed
   * message lands in finalizeStreaming.
   */
  private emitAssistantDelta(session: ActiveMinimaxSession, text: string): void {
    if (!text) return;
    if (!session.currentAssistant) {
      session.currentAssistant = {
        uuid: `minimax-assistant:${session.threadId}:${uuidv4()}`,
        text: '',
        createdAt: Date.now(),
        blockIndex: session.nextBlockIndex++,
      };
    }
    session.currentAssistant.text += text;
    this.emitStreamDelta(session, session.currentAssistant.blockIndex, { type: 'text_delta', text });
  }

  private emitThinkingDelta(session: ActiveMinimaxSession, thinking: string): void {
    if (!thinking) return;
    if (!session.currentThinking) {
      session.currentThinking = {
        uuid: `minimax-thinking:${session.threadId}:${uuidv4()}`,
        thinking: '',
        createdAt: Date.now(),
        blockIndex: session.nextBlockIndex++,
      };
    }
    session.currentThinking.thinking += thinking;
    this.emitStreamDelta(session, session.currentThinking.blockIndex, { type: 'thinking_delta', thinking });
  }

  private emitStreamDelta(
    session: ActiveMinimaxSession,
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

  private finalizeStreaming(session: ActiveMinimaxSession): void {
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

  private emitToolUseMessage(session: ActiveMinimaxSession, id: string, call: MinimaxToolCall): void {
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'assistant',
        uuid: `minimax-tool-use:${session.threadId}:${id}`,
        createdAt: call.createdAt,
        message: { content: [{ type: 'tool_use', id, name: call.name, input: call.input }] },
      },
    });
  }

  private handleToolCall(session: ActiveMinimaxSession, update: MinimaxSessionUpdate): void {
    const id = getString(update.toolCallId) || uuidv4();
    const existing = session.toolCalls.get(id);
    // A first-seen call closes the current prose block so narration between
    // calls keeps its own position; a repeat must not split mid-sentence.
    if (!existing) {
      this.finalizeStreaming(session);
    }
    const name = existing?.name || minimaxToolName(update);
    const rawInput = getRecord(update.rawInput);
    const call: MinimaxToolCall = {
      name,
      title: getString(update.title) || existing?.title || '',
      input: rawInput ? minimaxToolInput(name, rawInput) : existing?.input || {},
      createdAt: existing?.createdAt || Date.now(),
      output: existing?.output || '',
      settled: existing?.settled || false,
    };
    session.toolCalls.set(id, call);
    this.emitToolUseMessage(session, id, call);
  }

  private handleToolCallUpdate(session: ActiveMinimaxSession, update: MinimaxSessionUpdate): void {
    const id = getString(update.toolCallId);
    const call = id ? session.toolCalls.get(id) : undefined;
    // mcode follows each tool_call with empty updates while its input streams.
    if (!id || !call || Object.keys(update).length <= 2) return;

    const rawInput = getRecord(update.rawInput);
    const title = getString(update.title);
    const nextInput = rawInput ? minimaxToolInput(call.name, rawInput) : call.input;
    if ((rawInput && JSON.stringify(nextInput) !== JSON.stringify(call.input)) || (title && title !== call.title)) {
      call.input = nextInput;
      call.title = title || call.title;
      this.emitToolUseMessage(session, id, call);
    }

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

  private emitToolResult(session: ActiveMinimaxSession, id: string, call: MinimaxToolCall, isError: boolean): void {
    if (call.settled) return;
    call.settled = true;
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'assistant',
        uuid: `minimax-tool-result:${session.threadId}:${id}`,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              content: call.output || call.title || (isError ? 'Failed' : 'Done'),
              is_error: isError,
            },
          ],
        },
      },
    });
  }

  /** A turn that ends (or dies) with calls still open must not leave spinning cards. */
  private settleOpenToolCalls(session: ActiveMinimaxSession): void {
    for (const [id, call] of session.toolCalls) {
      if (!call.settled) this.emitToolResult(session, id, call, false);
    }
  }

  private emitPlan(session: ActiveMinimaxSession, update: MinimaxSessionUpdate): void {
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
        uuid: `minimax-plan:${session.threadId}:${uuidv4()}`,
        turnId: `minimax:${session.threadId}`,
        steps,
      },
    });
  }

  /** Context ring: mcode reports occupancy (`used`) and window (`size`) directly. */
  private emitTokenUsage(session: ActiveMinimaxSession, update: MinimaxSessionUpdate): void {
    const contextWindow = getNumber(update.size);
    if (contextWindow <= 0) return;
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'system',
        subtype: 'token_usage',
        uuid: `minimax-token-usage:${session.threadId}:${Date.now()}`,
        session_id: session.threadId,
        provider: 'minimax',
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

  private emitAvailableCommands(session: ActiveMinimaxSession, update: MinimaxSessionUpdate): void {
    const availableCommands = getArray(update.availableCommands)
      .map((command) => {
        const record = getRecord(command);
        const name = getString(record?.name).replace(/^\//, '').trim();
        if (!name) return null;
        const hint = getString(getRecord(record?.input)?.hint);
        return {
          name,
          description: getString(record?.description) || 'MiniMax Code slash command',
          ...(hint ? { input: { hint } } : {}),
        };
      })
      .filter((command): command is { name: string; description: string; input?: { hint: string } } =>
        Boolean(command)
      );
    // mcode re-pushes the list after every config change; skip identical repeats.
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
