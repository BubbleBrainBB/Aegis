import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
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

export function buildComputerUseMcpOverrideArgs(input: {
  clientPath: string | null;
  policy: ComputerUseSpawnPolicy;
  hasNodeRepl: boolean;
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

/**
 * A session's screenshot folder, as a real path that is known to sit
 * directly inside the one artifact folder of this profile. The trusted root
 * is that fixed folder, not whatever the session's own path resolves to: a
 * session folder that is a link to somewhere else is refused, for reading
 * and for writing.
 */
function openComputerUseArtifactDir(userDataDir: string, sessionId: string, create: boolean): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const base = join(userDataDir, 'computer-use-artifacts');
  const dir = join(base, sessionId);
  try {
    if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const realBase = realpathSync(base);
    const realDir = realpathSync(dir);
    return realDir === join(realBase, sessionId) ? realDir : null;
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
