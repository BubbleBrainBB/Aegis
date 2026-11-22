import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, mkdirSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import type {
  AntigravityModelConfig,
  AntigravityRuntimeStatus,
  AntigravityThoughtLevels,
} from '../../shared/types';
import { AcpJsonRpcClient, AcpJsonRpcError } from './provider/acp-json-rpc-client';
import { parseDevinAcpModelOptions, parseDevinThoughtLevels } from './devin-cli';

/**
 * Google Antigravity CLI (`agy`). Aegis only ever launches the unmodified
 * binary as `agy acp` and talks ACP to it over stdio:
 * - Sign-in is agy's own flow (`agy acp --login`); the credentials stay in
 *   agy's storage. Nothing here reads, copies or stores them, and the
 *   environment is passed through untouched.
 * - Whether agy is signed in, its models, thinking levels and modes are all
 *   read from an ACP session agy opens for us, never from agy's files.
 */

const IS_WINDOWS = process.platform === 'win32';

// Where Google's installer puts the launcher.
export const ANTIGRAVITY_DEFAULT_BINARY_PATH = IS_WINDOWS
  ? path.join(process.env.LOCALAPPDATA?.trim() || path.join(homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
  : path.join(homedir(), '.local', 'bin', 'agy');
export const ANTIGRAVITY_INSTALL_COMMAND = IS_WINDOWS
  ? 'irm https://antigravity.google/cli/install.ps1 | iex'
  : 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
export const ANTIGRAVITY_DOCS_URL = 'https://antigravity.google/docs/cli';

const EXEC_TIMEOUT_MS = 5000;

// ── Executable ─────────────────────────────────────────────────────────────

/**
 * The user's executable override (Settings → Agents → Antigravity). The host
 * supplies it, so this module stays free of Electron and runs under tests.
 */
let readCliPathOverride: () => string = () => '';

export function setAntigravityCliPathSource(read: () => string): void {
  readCliPathOverride = read;
  invalidateAntigravityCaches();
}

function cliPathOverride(): string {
  try {
    return (process.env.ANTIGRAVITY_CLI_PATH?.trim() || readCliPathOverride() || '').trim();
  } catch {
    return '';
  }
}

function isFile(filePath: string | undefined | null): filePath is string {
  if (!filePath?.trim()) return false;
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Why an executable override cannot be used; null when it can (or is unset). */
export function describeAntigravityCliPathProblem(candidate: string): string | null {
  const value = candidate.trim();
  if (!value) return null;
  if (!path.isAbsolute(value)) return 'Enter the full path of the agy executable.';
  if (!existsSync(value)) return 'No file exists at this path.';
  if (!isFile(value)) return 'This path is not a file.';
  return null;
}

function execFileText(command: string, args: string[], timeout = EXEC_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout, env: buildAntigravityEnv(command), maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { output: `${stdout || ''}${stderr || ''}` }));
          return;
        }
        resolve(`${stdout || ''}${stderr || ''}`.trim());
      }
    );
  });
}

async function resolveOnPath(command: string): Promise<string | null> {
  try {
    const output = await execFileText(IS_WINDOWS ? 'where' : 'which', [command], 2500);
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

/**
 * The override when one is set (a broken override is reported, not silently
 * replaced by another agy), else Google's install location, else PATH.
 */
export async function resolveAntigravityBinary(): Promise<string | null> {
  const override = cliPathOverride();
  if (override) {
    return describeAntigravityCliPathProblem(override) ? null : override;
  }
  if (isFile(ANTIGRAVITY_DEFAULT_BINARY_PATH)) {
    return ANTIGRAVITY_DEFAULT_BINARY_PATH;
  }
  return resolveOnPath('agy');
}

/** The user's environment as is, with the executable's own folder on PATH. */
export function buildAntigravityEnv(binaryPath?: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const binDir = binaryPath && path.isAbsolute(binaryPath) ? path.dirname(binaryPath) : path.dirname(ANTIGRAVITY_DEFAULT_BINARY_PATH);
  const parts = (env.PATH || '').split(path.delimiter).filter(Boolean);
  env.PATH = [...parts.filter((part) => part !== binDir), binDir].join(path.delimiter);
  return env;
}

function quoteForShell(value: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** agy's own terminal sign-in: it opens the browser and keeps the credentials itself. */
export function buildAntigravityLoginCommand(binaryPath: string | null): string {
  return `${binaryPath ? quoteForShell(binaryPath) : 'agy'} acp --login`;
}

// ── Sign-in state (as ACP reports it) ──────────────────────────────────────

type AuthState = AntigravityRuntimeStatus['authState'];

/** What the last ACP session open said about sign-in. */
let lastAuth: { state: AuthState; detail: string | null } = { state: 'unknown', detail: null };

/** ACP's auth_required error (-32000), or an error that names a missing sign-in. */
export function isAntigravityAuthError(error: unknown): boolean {
  if (error instanceof AcpJsonRpcError) {
    if (error.code === -32000) return true;
    return /auth(entication)?[ _-]?required|not (logged|signed) in|log ?in required|sign ?in required|unauthenticated/i.test(
      `${error.rpcMessage} ${typeof error.data === 'string' ? error.data : JSON.stringify(error.data ?? '')}`
    );
  }
  return false;
}

/** Called by whoever opens an ACP session: the probe here and the adapter. */
export function noteAntigravityAuthState(state: 'ready' | 'login_required', detail: string | null = null): void {
  const changed = lastAuth.state !== state;
  lastAuth = { state, detail };
  if (changed) {
    statusCache = null;
    // A sign-in or sign-out changes which models the account offers.
    if (state === 'login_required') catalogCache = null;
  }
}

// ── Runtime status ─────────────────────────────────────────────────────────

const STATUS_CACHE_TTL_MS = 10_000;
/** How long an ordinary status read waits for the sign-in check before answering "unknown". */
const STATUS_PROBE_WAIT_MS = 1_200;
let statusCache: { status: AntigravityRuntimeStatus; fetchedAt: number; override: string } | null = null;
let statusInflight: Promise<AntigravityRuntimeStatus> | null = null;

export function invalidateAntigravityCaches(): void {
  statusCache = null;
  catalogCache = null;
  catalogFailure = null;
  thoughtLevelsCache.clear();
  lastAuth = { state: 'unknown', detail: null };
  probeSession.reset();
}

/**
 * Shared and briefly cached: the picker, settings and every turn gate ask at
 * once. `refresh` re-reads everything, which is what Settings' re-detect and
 * a finished sign-in need.
 */
export async function getAntigravityRuntimeStatus(refresh = false): Promise<AntigravityRuntimeStatus> {
  if (refresh) invalidateAntigravityCaches();
  const override = cliPathOverride();
  if (statusCache && statusCache.override === override && Date.now() - statusCache.fetchedAt < STATUS_CACHE_TTL_MS) {
    return statusCache.status;
  }
  if (statusInflight) {
    return statusInflight;
  }
  statusInflight = computeAntigravityRuntimeStatus(override, refresh)
    .then((status) => {
      // A sign-in check still running will replace an "unknown" answer.
      if (status.authState !== 'unknown' || !catalogInflight) statusCache = { status, fetchedAt: Date.now(), override };
      return status;
    })
    .finally(() => {
      statusInflight = null;
    });
  return statusInflight;
}

async function computeAntigravityRuntimeStatus(override: string, definitive: boolean): Promise<AntigravityRuntimeStatus> {
  const checkedAt = Date.now();
  const base = {
    cliPathOverride: override || null,
    installCommand: ANTIGRAVITY_INSTALL_COMMAND,
    docsUrl: ANTIGRAVITY_DOCS_URL,
    checkedAt,
  };
  const overrideProblem = describeAntigravityCliPathProblem(override);
  const cliPath = overrideProblem ? null : await resolveAntigravityBinary();
  if (!cliPath) {
    return {
      ...base,
      ready: false,
      cliAvailable: false,
      cliPath: null,
      cliVersion: null,
      acpAvailable: false,
      authState: 'unknown',
      loginCommand: buildAntigravityLoginCommand(null),
      summary: overrideProblem ? 'The Antigravity executable path is not usable.' : 'Antigravity CLI (agy) was not found.',
      detail: overrideProblem
        ? `${overrideProblem} Fix the path or clear it to detect agy automatically.`
        : `Install it with \`${ANTIGRAVITY_INSTALL_COMMAND}\`, or set the path of the agy executable.`,
    };
  }

  const [cliVersion, acpAvailable] = await Promise.all([
    execFileText(cliPath, ['--version'])
      .then((output) => output.match(/\d+\.\d+\.\d+/)?.[0] || output.split(/\r?\n/)[0] || null)
      .catch(() => null),
    execFileText(cliPath, ['acp', '--help'])
      .then((output) => /Agent Client Protocol|\bACP\b/.test(output))
      .catch((error) => /Agent Client Protocol|\bACP\b/.test(String((error as { output?: unknown }).output || ''))),
  ]);
  const loginCommand = buildAntigravityLoginCommand(cliPath);
  if (!acpAvailable) {
    return {
      ...base,
      ready: false,
      cliAvailable: true,
      cliPath,
      cliVersion,
      acpAvailable: false,
      authState: 'error',
      loginCommand,
      summary: 'Antigravity CLI is installed but `agy acp` is unavailable.',
      detail: 'Update the Antigravity CLI (`agy update`) to a version that ships the acp command.',
    };
  }

  // Opening an ACP session is the sign-in check: agy answers with its catalog
  // or with an authentication error. Booting agy takes seconds, and this
  // status is part of the report on every agent, so only a caller that asked
  // for a fresh answer (Settings) waits it out; the others get what is known
  // so far and the definitive answer on a later read.
  const probe = getAntigravityModelConfig().catch(() => null);
  if (definitive) {
    await probe;
  } else if (lastAuth.state === 'unknown') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      probe,
      new Promise((resolve) => {
        timer = setTimeout(resolve, STATUS_PROBE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
  const authState: AuthState = lastAuth.state;
  // Only a definitive sign-out blocks the provider; an inconclusive probe
  // leaves it usable and lets the real failure surface at turn time.
  const ready = authState !== 'login_required';
  return {
    ...base,
    ready,
    cliAvailable: true,
    cliPath,
    cliVersion,
    acpAvailable: true,
    authState,
    loginCommand,
    summary: ready ? 'Antigravity ACP is ready.' : 'Antigravity needs sign-in.',
    detail: ready
      ? authState === 'ready'
        ? 'Aegis can start Antigravity sessions through `agy acp`.'
        : catalogInflight
          ? 'Checking that agy is signed in.'
          : `Aegis could not confirm the sign-in${lastAuth.detail ? ` (${lastAuth.detail})` : ''}. If a session fails, run ${loginCommand}.`
      : `Run ${loginCommand} in a terminal to sign in with Google. agy keeps the credentials; Aegis never sees them.`,
  };
}

export function formatAntigravityRuntimeBlockingMessage(status: AntigravityRuntimeStatus): string {
  if (status.authState === 'login_required') {
    return `Antigravity sign-in required. Run: ${status.loginCommand || 'agy acp --login'}`;
  }
  if (!status.cliAvailable) {
    return status.cliPathOverride
      ? `Antigravity CLI was not found at ${status.cliPathOverride}. Fix the path in Settings → Agents → Antigravity.`
      : `Antigravity CLI (agy) is not installed or was not found. Install it with: ${ANTIGRAVITY_INSTALL_COMMAND}`;
  }
  if (!status.acpAvailable) {
    return 'Antigravity ACP is not available from the detected agy executable. Run `agy update`.';
  }
  return status.detail || 'Antigravity ACP is not ready.';
}

// ── Catalog (models, thinking levels, modes) over ACP ──────────────────────

const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;
/** A failed read is remembered this long so status checks do not respawn agy each time. */
const CATALOG_FAILURE_TTL_MS = 15_000;
const PROBE_OPERATION_TIMEOUT_MS = 30_000;
const PROBE_IDLE_MS = 45_000;
const PROBE_CLOSE_MS = 2_000;

const EMPTY_CATALOG: AntigravityModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
  modes: [],
  defaultMode: null,
  authMethods: [],
  imagePrompts: false,
  agentVersion: null,
};

let catalogCache: { config: AntigravityModelConfig; fetchedAt: number } | null = null;
let catalogFailure: { at: number } | null = null;
let catalogInflight: Promise<AntigravityModelConfig> | null = null;
const thoughtLevelsCache = new Map<string, Pick<AntigravityThoughtLevels, 'levels' | 'defaultLevel'> & { fetchedAt: number }>();

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Session modes of an ACP `session/new` result (`modes.availableModes`). */
export function parseAntigravityModes(modes: unknown): Pick<AntigravityModelConfig, 'modes' | 'defaultMode'> {
  const record = getRecord(modes);
  const parsed: AntigravityModelConfig['modes'] = [];
  for (const entry of Array.isArray(record?.availableModes) ? record.availableModes : []) {
    const mode = getRecord(entry);
    const id = getString(mode?.id);
    if (!id || parsed.some((existing) => existing.id === id)) continue;
    const description = getString(mode?.description);
    parsed.push({ id, label: getString(mode?.name) || id, ...(description ? { description } : {}) });
  }
  const current = getString(record?.currentModeId);
  return { modes: parsed, defaultMode: parsed.some((mode) => mode.id === current) ? current : null };
}

/** Sign-in methods of an ACP `initialize` result (`authMethods`). */
export function parseAntigravityAuthMethods(authMethods: unknown): AntigravityModelConfig['authMethods'] {
  const parsed: AntigravityModelConfig['authMethods'] = [];
  for (const entry of Array.isArray(authMethods) ? authMethods : []) {
    const method = getRecord(entry);
    const id = getString(method?.id);
    if (!id || parsed.some((existing) => existing.id === id)) continue;
    const description = getString(method?.description);
    parsed.push({ id, label: getString(method?.name) || id, ...(description ? { description } : {}) });
  }
  return parsed;
}

interface ProbeHandle {
  rpc: AcpJsonRpcClient;
  sessionId: string;
  initialized: Record<string, unknown> | null;
  session: Record<string, unknown> | null;
}

/**
 * A throwaway ACP session in an empty folder, used only to read what agy
 * offers this account: models, thinking levels per model (one
 * set_config_option round trip each) and modes. It is never prompted, and
 * agy keeps no record of a session that was never prompted. Kept briefly for
 * follow-up reads, then closed.
 */
export class AntigravityProbeSession {
  private handle: Promise<ProbeHandle> | null = null;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** The timeout is a parameter so tests can hit it without waiting 30s. */
  constructor(private readonly operationTimeoutMs = PROBE_OPERATION_TIMEOUT_MS) {}

  run<T>(operation: (probe: ProbeHandle) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => operation(await this.open()))(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Antigravity ACP probe timed out.')), this.operationTimeoutMs);
          }),
        ]);
      } catch (error) {
        this.close();
        throw error;
      } finally {
        clearTimeout(timer);
        if (this.proc) {
          this.idleTimer = setTimeout(() => this.close(), PROBE_IDLE_MS);
          this.idleTimer.unref?.();
        }
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Drop the session now (the executable or the account changed). */
  reset(): void {
    this.close();
  }

  private open(): Promise<ProbeHandle> {
    this.handle ??= (async () => {
      const binary = await resolveAntigravityBinary();
      if (!binary) throw new Error('Antigravity CLI (agy) was not found.');
      const cwd = path.join(tmpdir(), 'aegis-antigravity-probe');
      mkdirSync(cwd, { recursive: true });
      const proc = spawn(binary, ['acp'], { cwd, env: buildAntigravityEnv(binary), stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      proc.stderr.resume();
      proc.stdin.on('error', () => undefined);
      proc.once('exit', () => {
        if (this.proc === proc) {
          this.proc = null;
          this.handle = null;
        }
      });
      const rpc = new AcpJsonRpcClient(
        proc,
        () => {},
        (request) => rpc.respond(request.id, undefined, { code: -32601, message: 'Aegis capability probe does not service requests.' }),
        () => {}
      );
      const initialized = getRecord(
        await rpc.request('initialize', {
          protocolVersion: 1,
          clientInfo: ANTIGRAVITY_ACP_CLIENT_INFO,
          clientCapabilities: {},
        })
      );
      const session = getRecord(await rpc.request('session/new', { cwd, mcpServers: [] }));
      const sessionId = getString(session?.sessionId);
      if (!sessionId) throw new Error('Antigravity ACP did not return a sessionId.');
      return { rpc, sessionId, initialized, session };
    })();
    return this.handle;
  }

  private close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const proc = this.proc;
    const handle = this.handle;
    this.proc = null;
    this.handle = null;
    if (!proc) return;
    // A probe stuck in initialize or session/new never settles its handle, so
    // shutdown must not wait on it: close the session if one is up, let agy
    // exit on end of input, and kill it once the bound passes.
    void Promise.race([
      (handle ?? Promise.reject(new Error('no probe'))).then(({ rpc, sessionId }) => rpc.request('session/close', { sessionId })),
      new Promise((resolve) => setTimeout(resolve, PROBE_CLOSE_MS / 2)),
    ])
      .catch(() => undefined)
      .finally(() => {
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        try {
          proc.stdin.end();
        } catch {
          // already closed
        }
        const killTimer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
        }, PROBE_CLOSE_MS / 2);
        killTimer.unref?.();
        proc.once('exit', () => clearTimeout(killTimer));
      });
  }
}

/** How Aegis introduces itself to agy. It never claims to be another client. */
export const ANTIGRAVITY_ACP_CLIENT_INFO = { name: 'aegis', title: 'Aegis', version: '1' } as const;

const probeSession = new AntigravityProbeSession();

async function fetchAntigravityModelConfig(): Promise<AntigravityModelConfig> {
  try {
    const config = await probeSession.run(async ({ initialized, session }) => {
      const models = parseDevinAcpModelOptions(session?.configOptions);
      if (models.defaultModel) {
        thoughtLevelsCache.set(models.defaultModel, { ...parseDevinThoughtLevels(session?.configOptions), fetchedAt: Date.now() });
      }
      const capabilities = getRecord(initialized?.agentCapabilities);
      return {
        ...models,
        options: models.availableModels.map((model) => model.id),
        ...parseAntigravityModes(session?.modes),
        authMethods: parseAntigravityAuthMethods(initialized?.authMethods),
        imagePrompts: getRecord(capabilities?.promptCapabilities)?.image === true,
        agentVersion: getString(getRecord(initialized?.agentInfo)?.version) || null,
      };
    });
    noteAntigravityAuthState('ready');
    return config;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAntigravityAuthError(error)) noteAntigravityAuthState('login_required', message);
    else lastAuth = { state: lastAuth.state === 'login_required' ? 'login_required' : 'unknown', detail: message };
    console.warn('[Antigravity] failed to read the ACP catalog:', message);
    return EMPTY_CATALOG;
  }
}

/**
 * What agy offers this account, as an ACP session reports it. Per-account and
 * slow-changing, but reading it boots agy: cached, and an empty (failed) read
 * is only remembered for a few seconds.
 */
export async function getAntigravityModelConfig(): Promise<AntigravityModelConfig> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return catalogCache.config;
  }
  if (catalogFailure && Date.now() - catalogFailure.at < CATALOG_FAILURE_TTL_MS) {
    return EMPTY_CATALOG;
  }
  if (catalogInflight) {
    return catalogInflight;
  }
  catalogInflight = fetchAntigravityModelConfig()
    .then((config) => {
      if (config.availableModels.length > 0 || config.modes.length > 0) {
        catalogCache = { config, fetchedAt: Date.now() };
        catalogFailure = null;
      } else {
        catalogFailure = { at: Date.now() };
      }
      return config;
    })
    .finally(() => {
      catalogInflight = null;
    });
  return catalogInflight;
}

/**
 * Thinking levels for one model (null/'' = the account default model). An
 * empty list means the model has no thinking control, unless `failed` is set.
 */
export async function getAntigravityThoughtLevels(model: string | null | undefined): Promise<AntigravityThoughtLevels> {
  const config = await getAntigravityModelConfig();
  const resolved = model?.trim() || config.defaultModel;
  if (!resolved) return { model: null, levels: [], defaultLevel: null, ...(config.availableModels.length === 0 ? { failed: true } : {}) };
  const cached = thoughtLevelsCache.get(resolved);
  if (cached && Date.now() - cached.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return { model: resolved, levels: cached.levels, defaultLevel: cached.defaultLevel };
  }
  if (!config.availableModels.some((entry) => entry.id === resolved)) {
    // Not a model this account is offered: nothing to ask agy about.
    return { model: resolved, levels: [], defaultLevel: null, failed: true };
  }
  try {
    const parsed = await probeSession.run(async ({ rpc, sessionId }) =>
      parseDevinThoughtLevels(
        getRecord(await rpc.request('session/set_config_option', { sessionId, configId: 'model', value: resolved }))
          ?.configOptions
      )
    );
    thoughtLevelsCache.set(resolved, { ...parsed, fetchedAt: Date.now() });
    return { model: resolved, ...parsed };
  } catch (error) {
    console.warn('[Antigravity] failed to read thinking levels:', error instanceof Error ? error.message : error);
    // Not "no thinking control": callers must not cache a failed read.
    return { model: resolved, levels: [], defaultLevel: null, failed: true };
  }
}
