// Building the chat's iOS app for its simulator, so an agent goes from an
// edit to the app running in one call: find the Xcode project and scheme,
// xcodebuild for the device, and read which app it made.
//
// Each call builds once, from the code as it is now; nothing is kept for a
// later call. A build that outlasts an agent's tool call (they time out
// after a few minutes) is stopped, and the agent gets the xcodebuild
// command to run in its own shell instead.

import { spawn, type ChildProcess } from 'child_process';
import type { Dirent } from 'fs';
import { readdir, stat } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { run } from './toolchain';

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'Pods', 'DerivedData', 'build', '.build', 'dist', 'Carthage']);
/** All of one call's build work (listing schemes, compiling, reading the
 * settings) fits in this, leaving about a minute of the 5-minute tool-call
 * limit of Codex and Kimi for install and launch. */
const BUILD_BUDGET_MS = 4 * 60_000;
/** Kept back from compiling for reading the build settings after it. */
const SETTINGS_RESERVE_MS = 30_000;
const MAX_ERROR_LINES = 25;

export interface XcodeContainer {
  path: string;
  kind: 'workspace' | 'project';
}

/** Xcode workspaces and projects in a folder and up to `depth` levels down,
 * shallowest first. A workspace next to a same-named project (CocoaPods)
 * replaces it. */
export async function findXcodeContainers(root: string, depth = 3): Promise<XcodeContainer[]> {
  const found: Array<XcodeContainer & { level: number }> = [];
  const walk = async (dir: string, level: number) => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name.endsWith('.xcworkspace')) found.push({ path, kind: 'workspace', level });
      else if (entry.name.endsWith('.xcodeproj')) found.push({ path, kind: 'project', level });
      else if (level < depth && !entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name)) await walk(path, level + 1);
    }
  };
  await walk(root, 0);
  const stem = (path: string) => join(dirname(path), basename(path).replace(/\.(xcworkspace|xcodeproj)$/, ''));
  const workspaces = new Set(found.filter((item) => item.kind === 'workspace').map((item) => stem(item.path)));
  return found
    .filter((item) => item.kind === 'workspace' || !workspaces.has(stem(item.path)))
    .sort((a, b) => a.level - b.level || (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'workspace' ? -1 : 1))
    .map(({ path, kind }) => ({ path, kind }));
}

/** The container to build: the one named, else the only one (or the only
 * shallowest one) in the chat's folder. */
export async function chooseContainer(cwd: string, named?: string): Promise<XcodeContainer> {
  if (named) {
    const path = isAbsolute(named) ? named : resolve(cwd, named);
    const kind = path.endsWith('.xcworkspace') ? 'workspace' : path.endsWith('.xcodeproj') ? 'project' : null;
    if (!kind || !(await stat(path).then((info) => info.isDirectory()).catch(() => false))) {
      throw new Error(`${named} is not an .xcodeproj or .xcworkspace.`);
    }
    return { path, kind };
  }
  const containers = await findXcodeContainers(cwd);
  if (containers.length === 0) {
    throw new Error(`No Xcode project or workspace in ${cwd}. An iOS app needs one (a Swift package alone builds no app); pass project with its path.`);
  }
  if (containers.length === 1) return containers[0];
  const list = containers.map((item) => `- ${relative(cwd, item.path) || item.path}`).join('\n');
  throw new Error(`Several Xcode projects here; pass project with the one to build:\n${list}`);
}

const containerArgs = (container: XcodeContainer) => [container.kind === 'workspace' ? '-workspace' : '-project', container.path];

/** The scheme to build: the one named, else the only one, else the one named
 * after the container. */
export function chooseScheme(schemes: string[], container: XcodeContainer, named?: string): string {
  if (named) {
    if (schemes.length && !schemes.includes(named)) throw new Error(`No scheme "${named}". Schemes: ${schemes.join(', ')}.`);
    return named;
  }
  if (schemes.length === 1) return schemes[0];
  const own = basename(container.path).replace(/\.(xcworkspace|xcodeproj)$/, '');
  if (schemes.includes(own)) return own;
  if (schemes.length === 0) throw new Error(`${basename(container.path)} has no shared schemes; pass scheme.`);
  throw new Error(`Several schemes; pass scheme with the app's: ${schemes.join(', ')}.`);
}

async function listSchemes(container: XcodeContainer, timeoutMs: number, signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await run('xcodebuild', ['-list', '-json', ...containerArgs(container)], { timeoutMs, signal });
  const parsed = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { project?: { schemes?: string[] }; workspace?: { schemes?: string[] } };
  return parsed.workspace?.schemes ?? parsed.project?.schemes ?? [];
}

export interface BuiltApp {
  appPath: string;
  bundleId: string;
}

/** The app target a scheme builds for this device, from its build settings. */
export function appFromBuildSettings(
  settings: Array<{ target?: string; buildSettings?: Record<string, string> }>
): BuiltApp | null {
  for (const entry of settings) {
    const values = entry.buildSettings ?? {};
    if (values.WRAPPER_EXTENSION !== 'app' || !values.TARGET_BUILD_DIR) continue;
    const name = values.FULL_PRODUCT_NAME || values.WRAPPER_NAME;
    if (!name) continue;
    return { appPath: join(values.TARGET_BUILD_DIR, name), bundleId: values.PRODUCT_BUNDLE_IDENTIFIER ?? '' };
  }
  return null;
}

/** What to show an agent of a failed build: the compiler's errors and the
 * commands that failed, not thousands of lines of log. */
export function buildErrors(output: string): string {
  const lines = output.split('\n');
  const picked: string[] = [];
  const seen = new Set<string>();
  const add = (line: string) => {
    const trimmed = line.trim().slice(0, 400);
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    picked.push(trimmed);
  };
  let inFailedList = false;
  for (const line of lines) {
    if (/The following build commands failed:/.test(line)) {
      inFailedList = true;
      add(line);
      continue;
    }
    if (inFailedList) {
      if (!line.trim() || /^\(\d+ failures?\)/.test(line.trim())) inFailedList = false;
      add(line);
      continue;
    }
    if (/(^|: )(fatal )?error: /.test(line) || /^xcodebuild: error/.test(line)) add(line);
  }
  // xcodebuild's own "a command failed" line says nothing the compiler's
  // errors do not.
  const specific = picked.filter((line) => !/produced no further output/.test(line));
  const chosen = specific.length ? specific : picked.length ? picked : lines.filter((line) => line.trim()).slice(-30);
  const shown = chosen.slice(0, MAX_ERROR_LINES);
  if (chosen.length > shown.length) shown.push(`… ${chosen.length - shown.length} more`);
  return shown.join('\n');
}

export type BuildOutcome =
  | { ok: true; app: BuiltApp; seconds: number; scheme: string; configuration: string }
  | { ok: false; errors: string; seconds: number; scheme: string; configuration: string }
  | { ok: false; tooLong: true; command: string; scheme: string; configuration: string };

/** Builds running now, stopped if Aegis quits. */
const running = new Set<ChildProcess>();

export interface BuildRequest {
  cwd: string;
  udid: string;
  project?: string;
  scheme?: string;
  configuration?: string;
}

/** Build the app for the device, now, from the code as it is. */
export async function buildForSimulator(request: BuildRequest, signal?: AbortSignal): Promise<BuildOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + BUILD_BUDGET_MS;
  const left = () => deadline - Date.now();
  const seconds = () => Math.round((Date.now() - startedAt) / 1000);
  const container = await chooseContainer(request.cwd, request.project);
  const configuration = request.configuration || 'Debug';
  const command = (scheme: string) =>
    ['xcodebuild', ...containerArgs(container), '-scheme', scheme, '-configuration', configuration, '-destination', `id=${request.udid}`, 'build']
      .map(shellQuote)
      .join(' ');
  // Listing schemes resolves packages first, which can be slow too.
  const schemes = await listSchemes(container, Math.max(1_000, left() - SETTINGS_RESERVE_MS), signal).catch((error) => {
    if (left() <= SETTINGS_RESERVE_MS) return null;
    throw error;
  });
  if (!schemes) return { ok: false, tooLong: true, command: command(request.scheme ?? '<scheme>'), scheme: request.scheme ?? 'the app', configuration };
  const scheme = chooseScheme(schemes, container, request.scheme);
  const base = [...containerArgs(container), '-scheme', scheme, '-configuration', configuration, '-destination', `id=${request.udid}`];
  const budget = left() - SETTINGS_RESERVE_MS;
  const output = budget > 0 ? await xcodebuild([...base, '-quiet', 'build'], budget, signal) : { code: 1, text: '', timedOut: true };
  if (output.timedOut) return { ok: false, tooLong: true, command: command(scheme), scheme, configuration };
  if (output.code !== 0) return { ok: false, errors: buildErrors(output.text), seconds: seconds(), scheme, configuration };
  const { stdout } = await run('xcodebuild', [...base, '-showBuildSettings', '-json'], { timeoutMs: Math.max(15_000, left()), signal });
  const app = appFromBuildSettings(JSON.parse(stdout.slice(stdout.indexOf('['))));
  if (!app) {
    return { ok: false, errors: `Scheme "${scheme}" built, but it makes no iOS app to run (no .app product).`, seconds: seconds(), scheme, configuration };
  }
  // The built app's own identifier is the one to launch.
  const plist = await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(app.appPath, 'Info.plist')], { timeoutMs: 20_000 }).catch(() => null);
  return { ok: true, app: { ...app, bundleId: plist?.stdout.trim() || app.bundleId }, seconds: seconds(), scheme, configuration };
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** xcodebuild with its output kept (stdout and stderr, in order), so a
 * failure can be summarised. Errors are in stdout as much as stderr.
 * Stopped after `budgetMs` or when the tool call is cancelled. */
function xcodebuild(args: string[], budgetMs: number, signal?: AbortSignal): Promise<{ code: number; text: string; timedOut: boolean }> {
  return new Promise((resolveRun) => {
    const child = spawn('xcodebuild', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    const chunks: string[] = [];
    let size = 0;
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      chunks.push(text);
      size += text.length;
      // A long log keeps its end; errors are reported near it.
      while (size > 4_000_000 && chunks.length > 1) size -= chunks.shift()!.length;
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, budgetMs);
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (result: { code: number; text: string }) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      running.delete(child);
      resolveRun({ ...result, timedOut });
    };
    child.once('error', (error) => finish({ code: 1, text: `xcodebuild could not start: ${error.message}` }));
    child.once('close', (code, signalName) => {
      const text = chunks.join('');
      finish({ code: code ?? 1, text: signalName ? `${text}\nxcodebuild was stopped (${signalName}).` : text });
    });
  });
}

/** Aegis quits: stop builds still running. */
export function cancelSimulatorBuilds(): void {
  for (const child of running) child.kill('SIGTERM');
  running.clear();
}
