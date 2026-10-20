import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import type { MinimaxModelConfig, MinimaxRuntimeStatus, MinimaxThinkingEfforts } from '../../shared/types';
import { AcpJsonRpcClient } from './provider/acp-json-rpc-client';

// The official installer puts the launcher here (MCODE_INSTALL_DIR overrides
// the install root); npm installs land on PATH instead.
function minimaxInstallDir(): string {
  return process.env.MCODE_INSTALL_DIR?.trim() || path.join(homedir(), '.minimax-code');
}

export const MINIMAX_INSTALL_COMMAND = 'curl -fsSL https://filecdn.minimax.chat/public/install.sh | bash';
export const MINIMAX_DOCS_URL = 'https://agent.minimax.io/docs/cli/quick-start';

const EXEC_TIMEOUT_MS = 5000;

/** User data (auth, config.yaml, sessions); MINIMAX_DATA_DIR / MAVIS_DATA_DIR override it. */
export function minimaxDataDir(): string {
  return process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim() || path.join(homedir(), '.minimax');
}

function hasAuthFile(dir: string, depth: number): boolean {
  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'auth.json') return true;
    if (entry.isDirectory() && depth > 0 && hasAuthFile(path.join(dir, entry.name), depth - 1)) return true;
  }
  return false;
}

/**
 * Cheap "probably usable" hint: `mcode login` writes
 * auth/<env>/<region>/<client>/auth.json, and a BYOK setup (`mcode provider
 * add`) needs no login at all. A miss falls through to an ACP probe, so a
 * storage change costs one extra spawn rather than a wrong answer.
 */
export function hasMinimaxStoredCredentials(): boolean {
  const dataDir = minimaxDataDir();
  if (hasAuthFile(path.join(dataDir, 'auth'), 4)) return true;
  try {
    return /^\s*custom_provider\s*:/m.test(readFileSync(path.join(dataDir, 'config.yaml'), 'utf8'));
  } catch {
    return false;
  }
}

function isExecutableCandidate(filePath: string | undefined | null): filePath is string {
  return Boolean(filePath && filePath.trim() && existsSync(filePath));
}

function execFileText(command: string, args: string[], timeout = EXEC_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout, env: buildMinimaxEnv(), maxBuffer: 8 * 1024 * 1024 },
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
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const output = await execFileText(locator, [command], 2500);
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

export async function resolveMinimaxBinary(): Promise<string | null> {
  const envPath = process.env.MINIMAX_CLI_PATH?.trim();
  if (isExecutableCandidate(envPath)) {
    return envPath;
  }
  const installed = path.join(minimaxInstallDir(), 'bin', process.platform === 'win32' ? 'mcode.cmd' : 'mcode');
  if (isExecutableCandidate(installed)) {
    return installed;
  }
  return resolveOnPath('mcode');
}

export function buildMinimaxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const binDir = path.join(minimaxInstallDir(), 'bin');
  const parts = (env.PATH || '').split(path.delimiter).filter(Boolean);
  env.PATH = [binDir, ...parts.filter((part) => part !== binDir)].join(path.delimiter);
  return env;
}

export function buildMinimaxLoginCommand(binaryPath: string | null): string {
  return `${binaryPath || 'mcode'} login`;
}

const ACP_CLIENT_INFO = { name: 'aegis', title: 'Aegis', version: '0.0.32' };
/** JSON-RPC code of ACP's authRequired error (`mcode` throws it from session/new). */
const ACP_AUTH_REQUIRED = -32000;

function isAuthRequiredError(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown } | null;
  return record?.code === ACP_AUTH_REQUIRED || /mcode login/i.test(String(record?.message ?? ''));
}

// ── Runtime status ─────────────────────────────────────────────────────────

const STATUS_CACHE_TTL_MS = 10_000;
let statusCache: { status: MinimaxRuntimeStatus; fetchedAt: number } | null = null;
let statusInflight: Promise<MinimaxRuntimeStatus> | null = null;

/** No stored credentials: ask the agent itself, which refuses session/new until signed in. */
async function probeMinimaxAuth(): Promise<MinimaxRuntimeStatus['authState']> {
  try {
    await probeSession.run(async () => undefined);
    return 'ready';
  } catch (error) {
    return isAuthRequiredError(error) ? 'login_required' : 'unknown';
  }
}

/** Shared and briefly cached: the picker, settings and every turn gate ask at once. */
export async function getMinimaxRuntimeStatus(): Promise<MinimaxRuntimeStatus> {
  if (statusCache && Date.now() - statusCache.fetchedAt < STATUS_CACHE_TTL_MS) {
    return statusCache.status;
  }
  if (statusInflight) {
    return statusInflight;
  }
  statusInflight = computeMinimaxRuntimeStatus()
    .then((status) => {
      statusCache = { status, fetchedAt: Date.now() };
      return status;
    })
    .finally(() => {
      statusInflight = null;
    });
  return statusInflight;
}

async function computeMinimaxRuntimeStatus(): Promise<MinimaxRuntimeStatus> {
  const cliPath = await resolveMinimaxBinary();
  const checkedAt = Date.now();
  if (!cliPath) {
    return {
      ready: false,
      cliAvailable: false,
      cliPath: null,
      cliVersion: null,
      acpAvailable: false,
      authState: 'unknown',
      loginCommand: buildMinimaxLoginCommand(null),
      summary: 'MiniMax Code CLI was not found.',
      detail: `Install it with \`${MINIMAX_INSTALL_COMMAND}\` or set MINIMAX_CLI_PATH to the mcode executable.`,
      checkedAt,
    };
  }

  const [cliVersion, acpAvailable] = await Promise.all([
    execFileText(cliPath, ['--version'])
      .then((output) => output.match(/\d+\.\d+\.\d+/)?.[0] || output || null)
      .catch(() => null),
    execFileText(cliPath, ['acp', '--help'])
      .then((output) => output.includes('Agent Client Protocol'))
      .catch(() => false),
  ]);
  const authState: MinimaxRuntimeStatus['authState'] = !acpAvailable
    ? 'error'
    : hasMinimaxStoredCredentials()
      ? 'ready'
      : await probeMinimaxAuth();
  // Only a definitive sign-out blocks the provider; an inconclusive probe
  // leaves it usable and lets the real failure surface at turn time.
  const ready = acpAvailable && authState !== 'login_required';
  const loginCommand = buildMinimaxLoginCommand(cliPath);

  return {
    ready,
    cliAvailable: true,
    cliPath,
    cliVersion,
    acpAvailable,
    authState,
    loginCommand,
    summary: ready
      ? 'MiniMax Code ACP is ready.'
      : authState === 'login_required'
        ? 'MiniMax Code needs login.'
        : 'MiniMax Code CLI is installed but `mcode acp` is unavailable.',
    detail: ready
      ? 'Aegis can start MiniMax Code sessions through ACP.'
      : authState === 'login_required'
        ? `Run ${loginCommand} (add --region global for a Global account) to sign in.`
        : 'Update the MiniMax Code CLI (`mcode update`) to a version that ships the acp command.',
    checkedAt,
  };
}

export function formatMinimaxRuntimeBlockingMessage(status: MinimaxRuntimeStatus): string {
  if (status.authState === 'login_required') {
    return `MiniMax Code login required. Run: ${status.loginCommand || 'mcode login'}`;
  }
  if (!status.cliAvailable) {
    return 'MiniMax Code CLI is not installed or was not found. Install it, then restart Aegis.';
  }
  if (!status.acpAvailable) {
    return 'MiniMax Code ACP is not available from the detected mcode executable.';
  }
  return status.detail || 'MiniMax Code ACP is not ready.';
}

// ── Model catalog ──────────────────────────────────────────────────────────

const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
let modelsCache: { config: MinimaxModelConfig; fetchedAt: number } | null = null;
let modelsInflight: Promise<MinimaxModelConfig> | null = null;

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function findSelect(configOptions: unknown, id: string, category: string): Record<string, unknown> | null {
  return (
    (Array.isArray(configOptions) ? configOptions : [])
      .map(getRecord)
      .find((option) => option?.id === id || option?.category === category) ?? null
  );
}

/** The `model` select of an ACP session's configOptions (flat or grouped options). */
export function parseMinimaxAcpModelOptions(
  configOptions: unknown
): Pick<MinimaxModelConfig, 'defaultModel' | 'availableModels'> {
  const modelOption = findSelect(configOptions, 'model', 'model');
  const availableModels: MinimaxModelConfig['availableModels'] = [];
  const seen = new Set<string>();
  const visit = (entries: unknown): void => {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const record = getRecord(entry);
      if (!record) continue;
      if (Array.isArray(record.options)) {
        visit(record.options);
        continue;
      }
      const id = typeof record.value === 'string' ? record.value.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const label = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id;
      availableModels.push({ id, label });
    }
  };
  visit(modelOption?.options);
  const current = typeof modelOption?.currentValue === 'string' ? modelOption.currentValue.trim() : '';
  return { defaultModel: current || null, availableModels };
}

/**
 * The `thinkingEffort` select (category `thought_level`). Efforts, and whether
 * there are any, differ per model: mcode only offers it for models whose
 * thinking is always on.
 */
export function parseMinimaxThinkingEfforts(
  configOptions: unknown
): Pick<MinimaxThinkingEfforts, 'levels' | 'defaultLevel'> {
  const option = findSelect(configOptions, 'thinkingEffort', 'thought_level');
  const levels: MinimaxThinkingEfforts['levels'] = [];
  for (const entry of Array.isArray(option?.options) ? option.options : []) {
    const record = getRecord(entry);
    const id = typeof record?.value === 'string' ? record.value.trim() : '';
    if (!id || levels.some((level) => level.id === id)) continue;
    const label = typeof record?.name === 'string' && record.name.trim() ? record.name.trim() : id;
    levels.push({ id, label });
  }
  const current = typeof option?.currentValue === 'string' ? option.currentValue.trim() : '';
  return { levels, defaultLevel: levels.some((level) => level.id === current) ? current : null };
}

const PROBE_OPERATION_TIMEOUT_MS = 30_000;
const PROBE_IDLE_MS = 45_000;

interface ProbeHandle {
  rpc: AcpJsonRpcClient;
  sessionId: string;
  /** configOptions of the fresh session: the account's default model + its efforts. */
  initialConfig: unknown;
}

/**
 * The catalog and per-model efforts come from an ACP session itself: a
 * throwaway session in an empty directory, kept briefly for follow-up reads,
 * then closed. mcode 0.6.12 advertises model values it then rejects
 * (`Invalid model reasoning` for a thinking-only model's plain variant), so
 * every advertised value is tried here and only accepted ones are offered.
 */
class MinimaxProbeSession {
  private handle: Promise<ProbeHandle> | null = null;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  run<T>(operation: (probe: ProbeHandle) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => operation(await this.open()))(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('MiniMax Code ACP probe timed out.')), PROBE_OPERATION_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        this.close();
        throw error;
      } finally {
        clearTimeout(timer);
        this.idleTimer = setTimeout(() => this.close(), PROBE_IDLE_MS);
        this.idleTimer.unref?.();
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private open(): Promise<ProbeHandle> {
    this.handle ??= (async () => {
      const binary = await resolveMinimaxBinary();
      if (!binary) throw new Error('MiniMax Code CLI was not found.');
      const cwd = path.join(tmpdir(), 'aegis-minimax-model-probe');
      mkdirSync(cwd, { recursive: true });
      const proc = spawn(binary, ['acp'], { cwd, env: buildMinimaxEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      proc.stderr.resume();
      proc.once('exit', () => {
        if (this.proc === proc) {
          this.proc = null;
          this.handle = null;
        }
      });
      const rpc = new AcpJsonRpcClient(
        proc,
        () => {},
        (request) => rpc.respond(request.id, undefined, { code: -32601, message: 'Aegis model probe does not service requests.' }),
        () => {}
      );
      await rpc.request('initialize', { protocolVersion: 1, clientInfo: ACP_CLIENT_INFO, clientCapabilities: {} });
      const session = getRecord(await rpc.request('session/new', { cwd, mcpServers: [] }));
      const sessionId = typeof session?.sessionId === 'string' ? session.sessionId : '';
      if (!sessionId) throw new Error('MiniMax Code ACP did not return a sessionId.');
      return { rpc, sessionId, initialConfig: session?.configOptions };
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
    // A probe stuck in initialize or session/new never settles its handle,
    // so termination must not wait on it: close politely if a session is up,
    // and kill the process either way once the bound passes.
    void Promise.race([
      (handle ?? Promise.reject(new Error('no probe'))).then(({ rpc, sessionId }) =>
        rpc.request('session/close', { sessionId })
      ),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ])
      .catch(() => undefined)
      .finally(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
      });
  }
}

const probeSession = new MinimaxProbeSession();

const effortsCache = new Map<string, Pick<MinimaxThinkingEfforts, 'levels' | 'defaultLevel'> & { fetchedAt: number }>();

async function fetchMinimaxModelConfig(): Promise<MinimaxModelConfig> {
  const empty: MinimaxModelConfig = { defaultModel: null, options: [], availableModels: [] };
  try {
    return await probeSession.run(async ({ rpc, sessionId, initialConfig }) => {
      const parsed = parseMinimaxAcpModelOptions(initialConfig);
      const accepted: MinimaxModelConfig['availableModels'] = [];
      for (const model of parsed.availableModels) {
        try {
          const result = getRecord(
            await rpc.request('session/set_config_option', { sessionId, configId: 'model', value: model.id })
          );
          effortsCache.set(model.id, { ...parseMinimaxThinkingEfforts(result?.configOptions), fetchedAt: Date.now() });
          accepted.push(model);
        } catch {
          // Advertised but not selectable; leave it out of the picker.
        }
      }
      const defaultModel =
        parsed.defaultModel && accepted.some((model) => model.id === parsed.defaultModel)
          ? parsed.defaultModel
          : accepted[0]?.id ?? null;
      return { defaultModel, availableModels: accepted, options: accepted.map((model) => model.id) };
    });
  } catch (error) {
    console.warn('[MiniMax Code] failed to read the model catalog:', error instanceof Error ? error.message : error);
    return empty;
  }
}

/**
 * The catalog is per-account and changes rarely, but reading it boots an ACP
 * agent — cache it, and never cache an empty (failed) read.
 */
export async function getMinimaxModelConfig(): Promise<MinimaxModelConfig> {
  if (modelsCache && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return modelsCache.config;
  }
  if (modelsInflight) {
    return modelsInflight;
  }
  modelsInflight = fetchMinimaxModelConfig()
    .then((config) => {
      if (config.availableModels.length > 0) {
        modelsCache = { config, fetchedAt: Date.now() };
      }
      return config;
    })
    .finally(() => {
      modelsInflight = null;
    });
  return modelsInflight;
}

/**
 * Thinking efforts for one model (null/'' = the account default model). An
 * empty list means the model has no effort control.
 */
export async function getMinimaxThinkingEfforts(model: string | null | undefined): Promise<MinimaxThinkingEfforts> {
  const config = await getMinimaxModelConfig();
  const resolved = model?.trim() || config.defaultModel;
  if (!resolved) return { model: null, levels: [], defaultLevel: null };
  const cached = effortsCache.get(resolved);
  if (cached && Date.now() - cached.fetchedAt < MODELS_CACHE_TTL_MS) {
    return { model: resolved, levels: cached.levels, defaultLevel: cached.defaultLevel };
  }
  try {
    const parsed = await probeSession.run(async ({ rpc, sessionId }) =>
      parseMinimaxThinkingEfforts(
        getRecord(await rpc.request('session/set_config_option', { sessionId, configId: 'model', value: resolved }))
          ?.configOptions
      )
    );
    effortsCache.set(resolved, { ...parsed, fetchedAt: Date.now() });
    return { model: resolved, ...parsed };
  } catch (error) {
    console.warn('[MiniMax Code] failed to read thinking efforts:', error instanceof Error ? error.message : error);
    // Not "no effort control": callers must not cache a failed read.
    return { model: resolved, levels: [], defaultLevel: null, failed: true };
  }
}
