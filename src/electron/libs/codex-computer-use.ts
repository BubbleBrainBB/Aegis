import { createHash } from 'crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import {
  AEGIS_COMPUTER_USE_SERVER_NAME,
  COMPUTER_USE_READ_ONLY_TOOLS,
  COMPUTER_USE_TOOLS,
  CODEX_COMPUTER_USE_SERVER_NAME,
  NODE_REPL_SERVER_NAME,
  type ComputerUseMediaRef,
} from '../../shared/computer-use';

export {
  environmentHasComputerUseSection,
  hydrateComputerUseFramesFromMessages,
  mergeHydratedComputerUseFrames,
} from '../../shared/computer-use';

export type ComputerUseSpawnPolicy = 'read-only' | 'mutating';

/**
 * Computer Use click/type tools stay available in Default, Auto, and Full
 * Access. Plan mode is the only read-only exception — it is an execution
 * mode that must not operate the desktop.
 */
export function resolveComputerUseSpawnPolicy(input: {
  permissionMode?: string | null;
  executionMode?: string | null;
}): ComputerUseSpawnPolicy {
  return input.executionMode === 'plan' ? 'read-only' : 'mutating';
}

const CLIENT_RELATIVE_PATH =
  'Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient';

export function resolveComputerUseClientPath(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const override = env.AEGIS_COMPUTER_USE_CLIENT_PATH?.trim();
  if (override && existsSync(override)) return override;

  const candidates = [
    join(home, '.codex', 'computer-use', CLIENT_RELATIVE_PATH),
    join(
      '/Applications/Codex.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky',
      CLIENT_RELATIVE_PATH
    ),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveComputerUseArtifactRoot(
  userDataDir: string,
  sessionId: string
): string {
  return join(userDataDir, 'computer-use-artifacts', sessionId);
}

function escapeOverrideString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function serializeTomlArray(values: readonly string[]): string {
  return `[${values.map((value) => `"${escapeOverrideString(value)}"`).join(', ')}]`;
}

/**
 * What Codex is told for Full Access once Aegis injects its Computer use
 * server: nothing asks, as with `never`, except that tool approvals of MCP
 * servers reach the client. Aegis answers those itself, at once, after the
 * check every Computer use call gets (one session has the desktop at a time).
 *
 * With `never` Codex approves such calls on its own and Aegis never hears of
 * them (measured on codex-cli 0.166.0), so a Full Access session would read
 * and act on the desktop while another session holds it. Every category but
 * `mcp_elicitations` stays off, which is what `never` does with them: a
 * command that would need approval is refused, not asked about.
 */
export const CODEX_FULL_ACCESS_WITH_COMPUTER_USE_APPROVAL = {
  granular: {
    sandbox_approval: false,
    rules: false,
    skill_approval: false,
    request_permissions: false,
    mcp_elicitations: true,
  },
} as const;

/** `never`, or the policy above when this process was given Aegis's Computer use server. */
export function codexFullAccessApprovalPolicy(
  computerUseInjected: boolean
): 'never' | typeof CODEX_FULL_ACCESS_WITH_COMPUTER_USE_APPROVAL {
  return computerUseInjected ? CODEX_FULL_ACCESS_WITH_COMPUTER_USE_APPROVAL : 'never';
}

/**
 * Who answers a turn's approvals: Aegis ('user') or Codex's own reviewer. The
 * reviewer answers only in Auto, and not in Plan, which the user answers
 * whatever the permission mode. (The manager's permission options say the
 * same; verify-codex-app-server holds the two together.)
 */
export function codexApprovalsReviewer(
  permissionMode: string | null | undefined,
  executionMode: string | null | undefined
): 'user' | 'auto_review' {
  return permissionMode === 'auto' && executionMode !== 'plan' ? 'auto_review' : 'user';
}

/**
 * Whether Computer use's read tools ask Aegis before they run, for a turn in
 * these modes: whenever Aegis answers the turn's approvals. Not where Codex's
 * own reviewer does: a read that asked would wait for a review each time
 * (seconds, measured on codex-cli 0.166.0) and Aegis would still not be asked.
 */
export function computerUseReadsAskAegis(
  permissionMode: string | null | undefined,
  executionMode: string | null | undefined
): boolean {
  return codexApprovalsReviewer(permissionMode, executionMode) === 'user';
}

/**
 * Whether a Codex process whose read tools were started asking (or not) can
 * run a turn in these modes. Whether a read asks is fixed when the process
 * starts, and who answers is decided per turn: a process started for the
 * other answer has to be replaced before the turn. `undefined` is a process
 * nothing is known about, and without the Computer use client there is no
 * such tool to hold: both fit any turn.
 */
export function codexProcessFitsComputerUse(
  spawnedReadsAsk: boolean | undefined,
  permissionMode: string | null | undefined,
  executionMode: string | null | undefined,
  clientInstalled: boolean = resolveComputerUseClientPath() !== null
): boolean {
  if (spawnedReadsAsk === undefined || !clientInstalled) return true;
  return spawnedReadsAsk === computerUseReadsAskAegis(permissionMode, executionMode);
}

/** Said when a turn would run on a process whose looks at the desktop Aegis could not check. */
export const CODEX_COMPUTER_USE_PROCESS_MESSAGE =
  'Codex has to restart for this permission mode before it can continue. Send the message again.';

/** Whether these spawn arguments give the process Aegis's Computer use server. */
export function injectsComputerUseServer(args: readonly string[]): boolean {
  return args.some((arg) => arg.startsWith(`mcp_servers.${AEGIS_COMPUTER_USE_SERVER_NAME}.command=`));
}

export function buildComputerUseMcpOverrideArgs(input: {
  clientPath: string | null;
  policy: ComputerUseSpawnPolicy;
  hasNodeRepl: boolean;
  /**
   * Whether the two read tools ask before they run (default: they do). They
   * then reach Aegis like the tools that act, so that a session cannot look
   * at the desktop while another holds it; Aegis lets them through without
   * a card. Off in Auto mode, where Codex's own reviewer would answer
   * instead of Aegis (seconds per look, and no check).
   */
  readsAsk?: boolean;
}): string[] {
  const args: string[] = [];
  const push = (assignment: string) => {
    args.push('-c', assignment);
  };

  // The bundled plugin also registers `computer-use`. Keep that name disabled
  // so Aegis can own a non-colliding structured server. Codex 0.162+ rejects
  // the whole config when an entry has no transport, which a bare `enabled`
  // override is when the plugin is not installed, so the disabled entry
  // carries an inert command of its own.
  push(`mcp_servers.${CODEX_COMPUTER_USE_SERVER_NAME}.enabled=false`);
  push(`mcp_servers.${CODEX_COMPUTER_USE_SERVER_NAME}.command="true"`);

  if (input.clientPath) {
    const prefix = `mcp_servers.${AEGIS_COMPUTER_USE_SERVER_NAME}`;
    const tools =
      input.policy === 'mutating' ? COMPUTER_USE_TOOLS : COMPUTER_USE_READ_ONLY_TOOLS;
    push(`${prefix}.command="${escapeOverrideString(input.clientPath)}"`);
    push(`${prefix}.args=["mcp"]`);
    push(`${prefix}.enabled=true`);
    push(`${prefix}.startup_timeout_sec=60`);
    push(`${prefix}.tool_timeout_sec=120`);
    push(`${prefix}.default_tools_approval_mode="writes"`);
    push(`${prefix}.enabled_tools=${serializeTomlArray(tools)}`);
    if (input.readsAsk !== false) {
      // Per tool, not as the server's default: the tools that act keep "writes".
      for (const tool of COMPUTER_USE_READ_ONLY_TOOLS) {
        push(`${prefix}.tools.${tool}.approval_mode="prompt"`);
      }
    }
  }

  if (input.hasNodeRepl) {
    const prefix = `mcp_servers.${NODE_REPL_SERVER_NAME}`;
    push(`${prefix}.default_tools_approval_mode="writes"`);
    if (input.policy === 'mutating') {
      push(`${prefix}.disabled_tools=${serializeTomlArray(['js_add_node_module_dir'])}`);
    } else {
      push(`${prefix}.disabled_tools=${serializeTomlArray(['js', 'js_add_node_module_dir'])}`);
    }
  }

  return args;
}

/**
 * One session uses the desktop at a time. The lease is held per action: each
 * action a session is allowed to start adds its id, and the desktop stays
 * that session's while it holds any. Dropping one action (a declined
 * approval) leaves the others, so a session that has already acted keeps the
 * desktop until its turn ends (`releaseThread`).
 */
export class ComputerUseLease {
  private owner: { threadId: string; toolUseIds: string[] } | null = null;

  tryAcquire(threadId: string, toolUseId: string): boolean {
    if (this.owner && this.owner.threadId !== threadId) {
      return false;
    }
    if (!this.owner) this.owner = { threadId, toolUseIds: [] };
    if (!this.owner.toolUseIds.includes(toolUseId)) this.owner.toolUseIds.push(toolUseId);
    return true;
  }

  /** Drops one action, or with no id every action of the session. */
  release(threadId: string, toolUseId?: string): void {
    if (!this.owner || this.owner.threadId !== threadId) return;
    if (!toolUseId) {
      this.owner = null;
      return;
    }
    this.owner.toolUseIds = this.owner.toolUseIds.filter((id) => id !== toolUseId);
    if (this.owner.toolUseIds.length === 0) this.owner = null;
  }

  releaseThread(threadId: string): void {
    if (this.owner?.threadId === threadId) {
      this.owner = null;
    }
  }

  /** Whether this session holds the desktop for this action. */
  holds(threadId: string, toolUseId: string): boolean {
    return this.owner?.threadId === threadId && this.owner.toolUseIds.includes(toolUseId);
  }

  /** The actions a session holds the desktop for. */
  actionsOf(threadId: string): string[] {
    return this.owner?.threadId === threadId ? [...this.owner.toolUseIds] : [];
  }

  /** Whether another session holds the desktop. */
  heldByAnother(threadId: string): boolean {
    return Boolean(this.owner && this.owner.threadId !== threadId);
  }

  /** The session holding the desktop and the action it took it for last. */
  currentOwner(): { threadId: string; toolUseId: string } | null {
    if (!this.owner) return null;
    return { threadId: this.owner.threadId, toolUseId: this.owner.toolUseIds[this.owner.toolUseIds.length - 1] };
  }
}

export const computerUseLease = new ComputerUseLease();

function decodeDataUrl(value: string): { mimeType: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value.trim());
  if (!match) return null;
  try {
    return { mimeType: match[1], bytes: Buffer.from(match[2], 'base64') };
  } catch {
    return null;
  }
}

function collectImagePayloads(value: unknown, into: Array<{ mimeType: string; bytes: Buffer }>): void {
  if (typeof value === 'string') {
    const decoded = decodeDataUrl(value);
    if (decoded) into.push(decoded);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImagePayloads(item, into);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (record.type === 'image' && typeof record.data === 'string') {
    try {
      into.push({
        mimeType: typeof record.mimeType === 'string' ? record.mimeType : 'image/jpeg',
        bytes: Buffer.from(record.data, 'base64'),
      });
    } catch {
      // ignore malformed payloads
    }
    return;
  }
  if (record.type === 'input_image' && typeof record.image_url === 'string') {
    collectImagePayloads(record.image_url, into);
    return;
  }
  for (const nested of Object.values(record)) {
    collectImagePayloads(nested, into);
  }
}

export function persistComputerUseMedia(input: {
  userDataDir: string;
  sessionId: string;
  payload: unknown;
}): { text: string; mediaRefs: ComputerUseMediaRef[] } {
  const images: Array<{ mimeType: string; bytes: Buffer }> = [];
  collectImagePayloads(input.payload, images);
  const text = extractComputerUseText(input.payload);
  if (images.length === 0) {
    return { text, mediaRefs: [] };
  }

  const root = openComputerUseArtifactDir(input.userDataDir, input.sessionId, true);
  if (!root) return { text, mediaRefs: [] };
  const mediaRefs: ComputerUseMediaRef[] = [];
  const seen = new Set<string>();

  for (const image of images) {
    const sha256 = createHash('sha256').update(image.bytes).digest('hex');
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    const extension = image.mimeType.includes('png') ? 'png' : 'jpg';
    try {
      // Created, never opened: a file or link already under this name is
      // left as it is (a read checks its bytes against the hash anyway).
      writeFileSync(join(root, `${sha256}.${extension}`), image.bytes, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    mediaRefs.push({
      sessionId: input.sessionId,
      mimeType: image.mimeType,
      sha256,
      sizeBytes: image.bytes.length,
    });
  }

  return { text, mediaRefs };
}

function extractComputerUseText(payload: unknown): string {
  if (typeof payload === 'string') {
    if (payload.startsWith('data:image/')) return '';
    return payload;
  }
  if (Array.isArray(payload)) {
    return payload
      .map((item) => {
        if (item && typeof item === 'object' && 'type' in item && (item as { type?: unknown }).type === 'text') {
          return typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : '';
        }
        if (typeof item === 'string' && !item.startsWith('data:image/')) return item;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.text === 'string' && !record.text.startsWith('data:image/')) {
      return record.text;
    }
    if (typeof record.output === 'string' && !record.output.startsWith('data:image/')) {
      return record.output;
    }
    return '';
  }
  return '';
}

const SHA256_RE = /^[a-f0-9]{64}$/;
/** One path segment that is a name: no separators, and not `.` or `..`. */
const SESSION_ID_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

export function isPathWithinRoot(root: string, target: string): boolean {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}/`) || targetPath.startsWith(`${rootPath}\\`);
}

const ARTIFACTS_FOLDER = 'computer-use-artifacts';

/** A real folder under this exact path: there, a directory, and not a link to one. */
function isPlainFolder(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path;
  } catch {
    return false;
  }
}

function makeFolder(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    // Something is already there under that name; what it is gets checked next.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/**
 * A session's screenshot folder, as a real path that is known to sit
 * directly inside the one artifact folder of this profile.
 *
 * The profile folder is where the app keeps its data and is taken as it is.
 * From there down, every step is checked each time, for reading and for
 * writing: the artifact folder and the session folder must each be a real
 * directory under exactly that name. A link at either place (to a folder
 * outside the profile, or anywhere else) is refused, never followed.
 */
function openComputerUseArtifactDir(userDataDir: string, sessionId: string, create: boolean): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  try {
    if (create) mkdirSync(userDataDir, { recursive: true });
    const profile = realpathSync(userDataDir);
    const base = join(profile, ARTIFACTS_FOLDER);
    if (create) makeFolder(base);
    if (!isPlainFolder(base)) return null;
    const dir = join(base, sessionId);
    if (create) makeFolder(dir);
    return isPlainFolder(dir) ? dir : null;
  } catch {
    return null;
  }
}

export function resolveComputerUseArtifact(
  userDataDir: string,
  sessionId: string,
  sha256: string
): { mimeType: string; bytes: Buffer; path: string } | null {
  if (!SHA256_RE.test(sha256)) return null;
  const root = openComputerUseArtifactDir(userDataDir, sessionId, false);
  if (!root) return null;
  const candidates = [join(root, `${sha256}.jpg`), join(root, `${sha256}.png`)];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    let realFile: string;
    try {
      realFile = realpathSync(candidate);
    } catch {
      return null;
    }
    // The file itself, not a link out of the folder.
    if (realFile !== candidate) return null;
    const bytes = readFileSync(realFile);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== sha256) return null;
    return {
      path: realFile,
      bytes,
      mimeType: candidate.endsWith('.png') ? 'image/png' : 'image/jpeg',
    };
  }
  return null;
}

export const COMPUTER_USE_DENIED_TARGET_MESSAGE =
  'Aegis blocked Computer Use from targeting the Aegis app itself.';

export const COMPUTER_USE_LEASE_MESSAGE =
  'Another Aegis thread is already using Computer Use. Stop that turn before starting another.';
