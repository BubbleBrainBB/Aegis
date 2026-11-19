import { execFile, spawn } from 'child_process';
import { appendFileSync, constants as fsConstants, mkdirSync, promises as fsPromises, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join } from 'path';
import { promisify } from 'util';
import type { GitBranchInfo, GitWorktree } from '../../shared/types';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

async function runGit(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS) {
  return execFileAsync('git', args, {
    cwd,
    timeout,
    maxBuffer: 1024 * 1024 * 20,
  });
}

type GitStreamOutcome = 'ended' | 'stopped' | 'timeout';

/**
 * Runs git and hands each NUL-separated record of its output to `onRecord` as
 * it arrives, so output of any size is never held whole. `onRecord` returns
 * false to stop git there. Resolves with how the run ended; rejects when git
 * itself fails.
 */
function streamGitRecords(
  cwd: string,
  args: string[],
  timeoutMs: number,
  onRecord: (record: Buffer) => boolean | void
): Promise<GitStreamOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let outcome: GitStreamOutcome = 'ended';
    let pending: Buffer | null = null;
    let stderr = '';
    const stop = (reason: 'stopped' | 'timeout') => {
      if (outcome !== 'ended') return;
      outcome = reason;
      child.kill();
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      let start = 0;
      while (outcome === 'ended') {
        const end = chunk.indexOf(0, start);
        if (end === -1) break;
        const piece = chunk.subarray(start, end);
        const record = pending ? Buffer.concat([pending, piece]) : piece;
        pending = null;
        start = end + 1;
        if (onRecord(record) === false) stop('stopped');
      }
      if (outcome === 'ended' && start < chunk.length) {
        const tail = chunk.subarray(start);
        pending = pending ? Buffer.concat([pending, tail]) : tail;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (outcome !== 'ended' || code === 0) resolve(outcome);
      else reject(new Error(stderr.trim() || `git exited with code ${code}`));
    });
  });
}

function sanitizeWorktreeName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '')
    .replace(/\.\.+/g, '.');
  return sanitized || `aegis-${Date.now()}`;
}

function sanitizePathSegment(value: string): string {
  return sanitizeWorktreeName(value).replace(/[\\/]+/g, '-');
}

export async function assertGitRepo(cwd: string): Promise<void> {
  await runGit(cwd, ['rev-parse', '--git-dir'], 5000);
}

export async function getGitTopLevel(cwd: string): Promise<string> {
  const { stdout } = await runGit(cwd, ['rev-parse', '--show-toplevel'], 5000);
  return stdout.trim() || cwd;
}

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  const { stdout } = await runGit(cwd, ['branch', '--show-current'], 5000);
  return stdout.trim() || null;
}

export async function getHeadCommit(cwd: string): Promise<string> {
  const { stdout } = await runGit(cwd, ['rev-parse', 'HEAD'], 5000);
  return stdout.trim();
}

// Aegis 把 worktree 建在 <repoRoot>/.worktrees/ 之内；不写排除规则的话，
// 链接 worktree 会以 "?? .worktrees/" 永久出现在用户主工作区的 git status 里
// （污染 changes 视图、误触 dirty 检查，stash -u 对它无效）。
// 写 .git/info/exclude 而非用户的 .gitignore——排除规则属于本机工具，不该进版本库。
export async function ensureWorktreesExcluded(cwd: string): Promise<void> {
  const { stdout } = await runGit(cwd, ['rev-parse', '--git-common-dir'], 5000);
  const rawDir = stdout.trim();
  if (!rawDir) return;
  const repoRoot = await getGitTopLevel(cwd);
  const gitCommonDir = isAbsolute(rawDir) ? rawDir : join(repoRoot, rawDir);
  const excludePath = join(gitCommonDir, 'info', 'exclude');
  let existing = '';
  try {
    existing = readFileSync(excludePath, 'utf8');
  } catch {
    // 文件不存在则创建
  }
  const hasRule = existing
    .split('\n')
    .some((line) => {
      const trimmed = line.trim();
      return trimmed === '.worktrees/' || trimmed === '.worktrees' || trimmed === '/.worktrees/';
    });
  if (hasRule) return;
  mkdirSync(dirname(excludePath), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(excludePath, `${prefix}# Aegis worktrees (auto-added)\n.worktrees/\n`, 'utf8');
}

export async function hasDirtyWorkingTree(cwd: string): Promise<boolean> {
  await assertGitRepo(cwd);
  const { stdout } = await runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], 30_000);
  return stdout.trim().length > 0;
}

/** `git status --short` lines for a quick read of uncommitted work. */
export async function getShortStatus(cwd: string, timeout = 5000): Promise<string[]> {
  const { stdout } = await runGit(cwd, ['status', '--short', '--untracked-files=normal'], timeout);
  return stdout.split('\n').filter((line) => line.trim().length > 0);
}

async function getLatestStashSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'refs/stash'], 5000);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function stashWorkingTree(input: {
  cwd: string;
  message: string;
}): Promise<{ created: boolean; stashSha: string | null; output: string }> {
  if (!(await hasDirtyWorkingTree(input.cwd))) {
    return { created: false, stashSha: null, output: '' };
  }
  const beforeSha = await getLatestStashSha(input.cwd);
  const { stdout, stderr } = await runGit(
    input.cwd,
    ['stash', 'push', '--include-untracked', '-m', input.message],
    120_000
  );
  const afterSha = await getLatestStashSha(input.cwd);
  return {
    created: Boolean(afterSha && afterSha !== beforeSha),
    stashSha: afterSha,
    output: `${stdout || ''}${stderr || ''}`.trim(),
  };
}

async function findStashSelectorBySha(cwd: string, stashSha: string): Promise<string | null> {
  const { stdout } = await runGit(cwd, ['stash', 'list', '--format=%H%x00%gd'], 5000);
  for (const line of stdout.split('\n')) {
    const [sha, selector] = line.split('\0');
    if (sha === stashSha && selector) {
      return selector;
    }
  }
  return null;
}

export async function applyStash(input: {
  cwd: string;
  stashSha: string;
  drop?: boolean;
}): Promise<string> {
  const applied = await runGit(input.cwd, ['stash', 'apply', input.stashSha], 120_000);
  let output = `${applied.stdout || ''}${applied.stderr || ''}`.trim();
  if (input.drop) {
    const selector = await findStashSelectorBySha(input.cwd, input.stashSha);
    if (selector) {
      const dropped = await runGit(input.cwd, ['stash', 'drop', selector], 30_000);
      output = `${output}\n${dropped.stdout || ''}${dropped.stderr || ''}`.trim();
    }
  }
  return output;
}

export async function dropStash(input: {
  cwd: string;
  stashSha: string;
}): Promise<string> {
  const selector = await findStashSelectorBySha(input.cwd, input.stashSha);
  if (!selector) {
    return '';
  }
  const { stdout, stderr } = await runGit(input.cwd, ['stash', 'drop', selector], 30_000);
  return `${stdout || ''}${stderr || ''}`.trim();
}

export async function listWorktrees(cwd: string): Promise<GitWorktree[]> {
  const repoRoot = await getGitTopLevel(cwd);
  const { stdout } = await runGit(cwd, ['worktree', 'list', '--porcelain']);
  const records = stdout.split(/\n(?=worktree )/).map((item) => item.trim()).filter(Boolean);

  return records.map((record) => {
    const lines = record.split('\n');
    const result: GitWorktree = {
      path: '',
      branch: null,
      head: null,
      detached: false,
      locked: false,
      prunable: false,
      current: false,
    };

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        result.path = line.slice('worktree '.length).trim();
      } else if (line.startsWith('HEAD ')) {
        result.head = line.slice('HEAD '.length).trim() || null;
      } else if (line.startsWith('branch ')) {
        result.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '') || null;
      } else if (line === 'detached') {
        result.detached = true;
      } else if (line.startsWith('locked')) {
        result.locked = true;
      } else if (line.startsWith('prunable')) {
        result.prunable = true;
      }
    }

    result.current = result.path === repoRoot;
    return result;
  });
}

export async function getWorktreeBranchMap(cwd: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const worktrees = await listWorktrees(cwd).catch(() => []);
  for (const worktree of worktrees) {
    if (worktree.branch) {
      map.set(worktree.branch, worktree.path);
    }
  }
  return map;
}

export async function listBranches(cwd: string): Promise<{
  detachedHead: boolean;
  headShortHash: string | null;
  entries: GitBranchInfo[];
}> {
  await assertGitRepo(cwd);
  const worktreeMap = await getWorktreeBranchMap(cwd);
  const { stdout } = await runGit(cwd, [
    'for-each-ref',
    '--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(objectname:short)',
    '--sort=-committerdate',
    'refs/heads',
    'refs/remotes',
  ]);

  const entries: GitBranchInfo[] = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [fullRef = '', shortName = '', head = '', upstream = '', shortHash = ''] = line.split('\0');
      const remote = fullRef.startsWith('refs/remotes/');
      const name = remote ? shortName.replace(/^origin\//, '') : shortName;
      return {
        name,
        fullRef,
        current: head === '*',
        remote,
        upstream: upstream || null,
        shortHash,
        worktreePath: !remote ? worktreeMap.get(name) ?? null : null,
      };
    })
    .filter((entry) => entry.name && entry.fullRef !== 'refs/remotes/origin/HEAD');

  let headShortHash: string | null = null;
  const detachedHead = !entries.some((entry) => entry.current);
  if (detachedHead) {
    try {
      const { stdout: headStdout } = await runGit(cwd, ['rev-parse', '--short', 'HEAD'], 5000);
      headShortHash = headStdout.trim() || null;
    } catch {
      headShortHash = null;
    }
  }

  return { detachedHead, headShortHash, entries };
}

export async function createWorktree(input: {
  cwd: string;
  branch: string;
  newBranch?: string | null;
  path?: string | null;
}): Promise<GitWorktree> {
  await assertGitRepo(input.cwd);
  const repoRoot = await getGitTopLevel(input.cwd);
  const branch = sanitizeWorktreeName(input.branch);
  const newBranch = input.newBranch ? sanitizeWorktreeName(input.newBranch) : null;
  const worktreePath =
    input.path?.trim() ||
    join(repoRoot, '.worktrees', sanitizePathSegment(newBranch || branch));
  mkdirSync(dirname(worktreePath), { recursive: true });
  const args = newBranch
    ? ['worktree', 'add', '-b', newBranch, worktreePath, branch]
    : ['worktree', 'add', worktreePath, branch];
  await runGit(input.cwd, args, 120_000);
  return {
    path: worktreePath,
    branch: newBranch || branch,
    head: null,
    detached: false,
    locked: false,
    prunable: false,
    current: false,
  };
}

export async function removeWorktree(input: {
  cwd: string;
  path: string;
  force?: boolean;
}): Promise<void> {
  const args = ['worktree', 'remove'];
  if (input.force) args.push('--force');
  args.push(input.path);
  await runGit(input.cwd, args, 120_000);
}

export interface GitDiffStatSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  untracked: number;
}

// 工作树对 ref 的比较（同时覆盖已 commit 与未 commit 的改动）。
// 不能用 `<ref>...HEAD`：CLI agent 通常不 commit，HEAD == ref 时那种形式恒为空。
export async function getDiffStatAgainstRef(cwd: string, ref: string): Promise<GitDiffStatSummary> {
  const { stdout } = await runGit(cwd, ['diff', '--numstat', ref], 60_000);
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of stdout.split('\n')) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!match) continue;
    filesChanged += 1;
    if (match[1] !== '-') insertions += Number(match[1]);
    if (match[2] !== '-') deletions += Number(match[2]);
  }
  const { stdout: statusOut } = await runGit(
    cwd,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    30_000
  );
  const untracked = statusOut.split('\n').filter((line) => line.startsWith('?? ')).length;
  return { filesChanged, insertions, deletions, untracked };
}

export interface GitBranchBase {
  /** The ref the branch is measured against, e.g. `origin/main`. */
  baseRef: string;
  mergeBase: string;
}

/**
 * Where a branch's own work starts: its merge-base with the default branch,
 * so the default branch moving on does not count against it. The
 * remote-tracking ref comes first because a worktree often has no local copy
 * of the default branch, and because on the default branch itself it keeps
 * unpushed commits in view. Without a known default branch the upstream is
 * the only base there is.
 */
export async function resolveBranchBase(
  cwd: string,
  known: { defaultBranch: string | null; upstreamRef: string | null }
): Promise<GitBranchBase | null> {
  const candidates = known.defaultBranch
    ? [`origin/${known.defaultBranch}`, known.defaultBranch]
    : known.upstreamRef
      ? [known.upstreamRef]
      : [];
  for (const baseRef of candidates) {
    try {
      const { stdout } = await runGit(cwd, ['merge-base', baseRef, 'HEAD'], 5000);
      const mergeBase = stdout.trim();
      if (mergeBase) return { baseRef, mergeBase };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export interface GitChangeStats {
  files: number;
  insertions: number;
  deletions: number;
  /**
   * Set when the untracked files were more than the scan covers, could not
   * all be read, or it ran out of time: `insertions` is a lower bound.
   */
  incomplete?: true;
  /**
   * Set when time cut the count short. Unlike the file cap, which leaves the
   * same files out every time, this can give two different totals for one
   * unchanged tree.
   */
  unsettled?: true;
}

function parseNumstat(stdout: string): GitChangeStats {
  const stats = { files: 0, insertions: 0, deletions: 0 };
  for (const line of stdout.split('\n')) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!match) continue;
    stats.files += 1;
    if (match[1] !== '-') stats.insertions += Number(match[1]);
    if (match[2] !== '-') stats.deletions += Number(match[2]);
  }
  return stats;
}

export interface UntrackedListing {
  /** The first paths in git's order, as many as were asked for. */
  paths: string[];
  /** How many git listed. */
  total: number;
  /** False when git ran out of time: `total` and `paths` are only what it had listed by then. */
  complete: boolean;
}

const UNTRACKED_LIST_TIMEOUT_MS = 10_000;

/**
 * Untracked, non-ignored files under `cwd`, relative to it. The list is read
 * as git writes it and only the first `keep` names are held, so a tree of any
 * size is counted without its whole listing in memory. Names are kept exactly
 * as git reports them: one with leading or trailing spaces is still a file.
 */
export async function listUntracked(
  cwd: string,
  options: { keep: number; timeoutMs?: number }
): Promise<UntrackedListing> {
  const paths: string[] = [];
  let total = 0;
  const outcome = await streamGitRecords(
    cwd,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    options.timeoutMs ?? UNTRACKED_LIST_TIMEOUT_MS,
    (record) => {
      if (record.length === 0) return;
      total += 1;
      if (paths.length < options.keep) paths.push(record.toString('utf8'));
    }
  );
  return { paths, total, complete: outcome === 'ended' };
}

/** Every untracked path at once; for trees known to be small. */
export async function listUntrackedPaths(cwd: string): Promise<string[]> {
  const listing = await listUntracked(cwd, { keep: Number.MAX_SAFE_INTEGER });
  if (!listing.complete) throw new Error('git ls-files timed out');
  return listing.paths;
}

export interface UntrackedScanLimits {
  /** Files past this many are left uncounted, so a huge tree gives the same totals every time. */
  maxFiles: number;
  /** Wall-clock bound for reading attributes and counting, once the files are listed. */
  deadlineMs: number;
}

const UNTRACKED_SCAN_LIMITS: UntrackedScanLimits = {
  maxFiles: 10_000,
  deadlineMs: 5_000,
};
const UNTRACKED_SCAN_CONCURRENCY = 8;
// How long a scan out of time waits for its readers to stop.
const UNTRACKED_SCAN_WIND_DOWN_MS = 250;
const UNTRACKED_SCAN_CHUNK_BYTES = 64 * 1024;
// git calls a file binary when a NUL byte sits in its first 8000 bytes.
const GIT_BINARY_SNIFF_BYTES = 8000;
// The default of core.bigFileThreshold.
const GIT_BIG_FILE_BYTES = 512 * 1024 * 1024;

type DiffAttribute = 'text' | 'binary';

/**
 * `diff.<driver>.binary` for every driver the repository configures: a path
 * whose `diff` attribute names one is binary or text as its driver says,
 * whatever it holds. A driver without the setting leaves it to the content.
 */
async function readDiffDriverPolicies(cwd: string): Promise<Map<string, DiffAttribute>> {
  const policies = new Map<string, DiffAttribute>();
  try {
    const { stdout } = await runGit(cwd, ['config', '--type=bool', '-z', '--get-regexp', '^diff\\..+\\.binary$'], 5000);
    for (const record of stdout.split('\0')) {
      // `diff.<driver>.binary`, a line break, then the value; the driver keeps its case and may hold dots.
      const lineBreak = record.indexOf('\n');
      if (lineBreak === -1) continue;
      const driver = record.slice('diff.'.length, lineBreak - '.binary'.length);
      policies.set(driver, record.slice(lineBreak + 1) === 'true' ? 'binary' : 'text');
    }
  } catch {
    // None configured (exit 1), or not readable: every driver leaves it to the content.
  }
  return policies;
}

/**
 * The `diff` attribute of each path that decides how git reads it: `-diff`
 * (or `binary`) makes git report a file as binary whatever it holds, `diff`
 * as text, and a named driver as its `binary` setting says.
 */
async function readDiffAttributes(cwd: string, paths: string[]): Promise<Map<string, DiffAttribute>> {
  const attributes = new Map<string, DiffAttribute>();
  if (paths.length === 0) return attributes;
  try {
    const pending = execFileAsync('git', ['check-attr', '-z', '--stdin', 'diff'], {
      cwd,
      timeout: 10_000,
      maxBuffer: 1024 * 1024 * 64,
    });
    // A git that exits early closes the pipe; its failure arrives through `pending`.
    pending.child.stdin?.on('error', () => undefined);
    pending.child.stdin?.end(`${paths.join('\0')}\0`);
    const fields = (await pending).stdout.split('\0');
    const byDriver = new Map<string, string[]>();
    for (let index = 0; index + 2 < fields.length; index += 3) {
      const value = fields[index + 2];
      if (value === 'unset') attributes.set(fields[index], 'binary');
      else if (value === 'set') attributes.set(fields[index], 'text');
      else if (value !== 'unspecified') byDriver.set(value, [...(byDriver.get(value) ?? []), fields[index]]);
    }
    // Named drivers are rare, so their settings are only read when a path uses one.
    if (byDriver.size > 0) {
      const policies = await readDiffDriverPolicies(cwd);
      for (const [driver, driverPaths] of byDriver) {
        const policy = policies.get(driver);
        if (policy) for (const filePath of driverPaths) attributes.set(filePath, policy);
      }
    }
  } catch {
    // Without attributes every file is judged by its content, as git does by default.
  }
  return attributes;
}

/**
 * core.bigFileThreshold: git diffs a larger file as binary without reading
 * it, unless the `diff` attribute says it is text.
 */
async function readBigFileThreshold(cwd: string): Promise<number> {
  try {
    const { stdout } = await runGit(cwd, ['config', '--type=int', '--get', 'core.bigFileThreshold'], 5000);
    const value = Number(stdout.trim());
    return Number.isFinite(value) && value > 0 ? value : GIT_BIG_FILE_BYTES;
  } catch {
    // Not set (exit 1), or not readable: the default applies.
    return GIT_BIG_FILE_BYTES;
  }
}

/** Newline bytes in the first `length` bytes of `chunk` (a reused buffer may hold older bytes past them). */
function countNewlines(chunk: Buffer, length: number): number {
  let count = 0;
  for (let index = chunk.indexOf(10); index !== -1 && index < length; index = chunk.indexOf(10, index + 1)) {
    count += 1;
  }
  return count;
}

/**
 * The lines `git diff --numstat` reports for a file added in full, counted
 * without starting a process: a final line without a newline counts, a
 * binary file has none, a symlink is its target, and a nested repository
 * (listed as a directory) has none. A file gone since it was listed has no
 * lines. Null when the lines could not be counted: the file cannot be read,
 * or `stopped` turned true first, which is checked between reads so a scan
 * out of time leaves no file being read behind it.
 */
async function countAddedLines(
  absolutePath: string,
  attribute: DiffAttribute | undefined,
  bigFileBytes: number,
  chunk: Buffer,
  stopped: () => boolean
): Promise<number | null> {
  let handle: fsPromises.FileHandle | null = null;
  try {
    const stat = await fsPromises.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      const target = await fsPromises.readlink(absolutePath, { encoding: 'buffer' });
      if (target.length === 0) return 0;
      return countNewlines(target, target.length) + (target[target.length - 1] === 10 ? 0 : 1);
    }
    if (!stat.isFile() || stat.size === 0 || attribute === 'binary') return 0;
    if (attribute !== 'text' && stat.size > bigFileBytes) return 0;

    handle = await fsPromises.open(absolutePath, 'r');
    let total = 0;
    let lines = 0;
    let lastByte = 10;
    // Up to the size it had when listed, as git reads it: a log still being written never ends.
    while (total < stat.size) {
      if (stopped()) return null;
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - total), null);
      if (bytesRead === 0) break;
      if (attribute !== 'text' && total < GIT_BINARY_SNIFF_BYTES) {
        const nul = chunk.indexOf(0);
        if (nul !== -1 && nul < bytesRead && total + nul < GIT_BINARY_SNIFF_BYTES) return 0;
      }
      lines += countNewlines(chunk, bytesRead);
      lastByte = chunk[bytesRead - 1];
      total += bytesRead;
    }
    return lines + (lastByte === 10 ? 0 : 1);
  } catch (error: unknown) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 0 : null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Untracked files count as added in full; `git diff <ref>` never lists them.
 * The lines are counted in-process, within the limits above, because one git
 * process per file takes seconds per thousand files. A tree with more files
 * than the scan covers, a file it cannot read, or a scan it cannot finish in
 * time, is reported as `incomplete`; when time was the reason, also as
 * `unsettled`. A scan out of time stops its readers before it returns, short
 * of one whose read does not come back. `listed` is a listing of `cwd` made
 * elsewhere, holding at least `maxFiles` paths, so the tree is walked once.
 */
export async function getUntrackedChangeStats(
  cwd: string,
  limits: Partial<UntrackedScanLimits> = {},
  listed?: Promise<UntrackedListing>
): Promise<GitChangeStats> {
  const { maxFiles, deadlineMs } = { ...UNTRACKED_SCAN_LIMITS, ...limits };
  const listing = await (listed ?? listUntracked(cwd, { keep: maxFiles }));
  const scanned = listing.paths.slice(0, maxFiles);
  let insertions = 0;
  let uncounted = 0;
  let stopped = false;
  let workers: Promise<unknown> = Promise.resolve();

  const scan = (async () => {
    if (scanned.length === 0) return true;
    const [attributes, bigFileBytes] = await Promise.all([readDiffAttributes(cwd, scanned), readBigFileThreshold(cwd)]);
    if (stopped) return false;
    let next = 0;
    const worker = async () => {
      const chunk = Buffer.allocUnsafe(UNTRACKED_SCAN_CHUNK_BYTES);
      while (!stopped && next < scanned.length) {
        const filePath = scanned[next];
        next += 1;
        const lines = await countAddedLines(join(cwd, filePath), attributes.get(filePath), bigFileBytes, chunk, () => stopped);
        if (stopped) return;
        if (lines === null) uncounted += 1;
        else insertions += lines;
      }
    };
    workers = Promise.all(Array.from({ length: Math.min(UNTRACKED_SCAN_CONCURRENCY, scanned.length) }, worker));
    await workers;
    return true;
  })();

  let timer: NodeJS.Timeout | undefined;
  const finished = await Promise.race([
    scan,
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), deadlineMs);
    }),
  ]);
  clearTimeout(timer);
  // Past the deadline every reader stops at its next read, which is at most
  // one chunk away, so they are given a moment to close their files. A read
  // that does not come back (a stalled network mount) is not waited for: its
  // reader stops and closes whenever it does.
  stopped = true;
  scan.catch(() => undefined);
  let windDown: NodeJS.Timeout | undefined;
  await Promise.race([
    workers.catch(() => undefined),
    new Promise<void>((resolve) => {
      windDown = setTimeout(resolve, UNTRACKED_SCAN_WIND_DOWN_MS);
    }),
  ]);
  clearTimeout(windDown);

  const stats: GitChangeStats = { files: listing.total, insertions, deletions: 0 };
  const outOfTime = !finished || !listing.complete;
  if (outOfTime || uncounted > 0 || listing.total > scanned.length) stats.incomplete = true;
  if (outOfTime) stats.unsettled = true;
  return stats;
}

/**
 * Everything the working tree holds on top of `ref`: commits made since,
 * staged and unstaged edits, and untracked files. Pass `untracked` to share
 * one scan between several refs.
 */
export async function getChangeStatsSince(
  cwd: string,
  ref: string,
  untracked?: Promise<GitChangeStats>
): Promise<GitChangeStats> {
  const [tracked, extra] = await Promise.all([
    runGit(cwd, ['diff', '--numstat', ref, '--'], 10_000).then(({ stdout }) => parseNumstat(stdout)),
    untracked ?? getUntrackedChangeStats(cwd),
  ]);
  const stats: GitChangeStats = {
    files: tracked.files + extra.files,
    insertions: tracked.insertions + extra.insertions,
    deletions: tracked.deletions + extra.deletions,
  };
  if (extra.incomplete) stats.incomplete = true;
  if (extra.unsettled) stats.unsettled = true;
  return stats;
}

/** True while the current branch has no commit yet (a fresh `git init`). */
async function isHeadUnborn(cwd: string): Promise<boolean> {
  try {
    await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], 5000);
    return false;
  } catch (error: unknown) {
    // `--quiet` exits 1 for a name that resolves to nothing; anything else is a real failure.
    return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 1);
  }
}

/** The id of the tree with no entries, in the repository's own hash format. */
async function getEmptyTreeId(cwd: string): Promise<string> {
  const pending = execFileAsync('git', ['hash-object', '-t', 'tree', '--stdin'], { cwd, timeout: 5000 });
  pending.child.stdin?.on('error', () => undefined);
  pending.child.stdin?.end();
  return (await pending).stdout.trim();
}

/**
 * The uncommitted work: staged and unstaged edits against HEAD, plus
 * untracked files. A branch with no commit yet has no HEAD to compare with,
 * so everything staged counts as added, measured against the empty tree.
 */
export async function getUncommittedChangeStats(
  cwd: string,
  untracked?: Promise<GitChangeStats>
): Promise<GitChangeStats> {
  const scan = untracked ?? getUntrackedChangeStats(cwd);
  scan.catch(() => undefined);
  try {
    return await getChangeStatsSince(cwd, 'HEAD', scan);
  } catch (error: unknown) {
    if (!(await isHeadUnborn(cwd))) throw error;
    return getChangeStatsSince(cwd, await getEmptyTreeId(cwd), scan);
  }
}

export interface UntrackedPatchLimits {
  /**
   * Files past this many are left out: entering them in the throwaway index
   * costs more than their share as the list grows, and a patch this long is
   * cut for size anyway.
   */
  maxFiles: number;
  /** The patch is cut before it grows past this. */
  maxBytes: number;
  /** Wall-clock bound for writing the patch, once the files are listed. */
  deadlineMs: number;
}

export interface UntrackedPatch {
  patch: string;
  /**
   * True when the patch lacks files the listing has: more than `maxFiles`,
   * out of time, past `maxBytes`, or a file git cannot read.
   */
  incomplete: boolean;
}

const UNTRACKED_PATCH_LIMITS: UntrackedPatchLimits = {
  maxFiles: 5_000,
  maxBytes: 16 * 1024 * 1024,
  deadlineMs: 5_000,
};
const UNTRACKED_PATCH_ARGS = ['-c', 'core.quotepath=false', 'diff', '--no-color', '--unified=3'];

function execOutput(error: unknown): string {
  return error && typeof error === 'object' && 'stdout' in error
    ? String((error as { stdout?: unknown }).stdout ?? '')
    : '';
}

/** A patch that stopped in the middle of a file, without that file. */
function dropUnfinishedFile(patch: string): string {
  const lastFile = patch.lastIndexOf('\ndiff --git ');
  return lastFile === -1 ? patch : patch.slice(0, lastFile + 1);
}

/**
 * The files git can write a patch for. One it cannot open stops a whole
 * `git diff`, so those are taken out first (`unreadable`); a file gone since
 * it was listed is dropped without a word, there is nothing left to show.
 */
async function splitDiffableFiles(cwd: string, files: string[]): Promise<{ diffable: string[]; unreadable: number }> {
  const verdicts = new Array<'diffable' | 'unreadable' | 'gone'>(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const index = next;
      next += 1;
      const absolutePath = join(cwd, files[index]);
      try {
        // A symlink is diffed as its target path, readable or not.
        if (!(await fsPromises.lstat(absolutePath)).isSymbolicLink()) {
          await fsPromises.access(absolutePath, fsConstants.R_OK);
        }
        verdicts[index] = 'diffable';
      } catch (error: unknown) {
        const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
        verdicts[index] = code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'unreadable';
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UNTRACKED_SCAN_CONCURRENCY, files.length) }, worker));
  return {
    diffable: files.filter((_, index) => verdicts[index] === 'diffable'),
    unreadable: verdicts.filter((verdict) => verdict === 'unreadable').length,
  };
}

/**
 * All the files in one `git diff`: they are entered as intent-to-add in a
 * throwaway index, which makes git show each as a new file, in the same text
 * as `git diff --no-index /dev/null <file>`. Nothing is written to the
 * repository: the index, and the empty blob git stores for such entries, go
 * to a scratch folder. Throws when git refuses any of it (a path that just
 * vanished, a sparse checkout).
 */
async function getUntrackedPatchInOnePass(
  cwd: string,
  files: string[],
  maxBytes: number,
  deadline: number
): Promise<UntrackedPatch> {
  const scratch = await fsPromises.mkdtemp(join(tmpdir(), 'aegis-untracked-'));
  try {
    const { stdout } = await runGit(cwd, ['rev-parse', '--git-path', 'objects'], 5000);
    const repositoryObjects = stdout.trim();
    await fsPromises.mkdir(join(scratch, 'objects'));
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join(scratch, 'index'),
      // New objects land in the scratch folder; the repository's are only read.
      GIT_OBJECT_DIRECTORY: join(scratch, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: isAbsolute(repositoryObjects) ? repositoryObjects : join(cwd, repositoryObjects),
      // Names are taken as they are, not as patterns.
      GIT_LITERAL_PATHSPECS: '1',
    };
    const adding = execFileAsync(
      'git',
      ['-c', 'core.splitIndex=false', 'add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'],
      { cwd, env, timeout: Math.max(1, deadline - Date.now()), maxBuffer: 1024 * 1024 }
    );
    adding.child.stdin?.on('error', () => undefined);
    adding.child.stdin?.end(`${files.join('\0')}\0`);
    await adding;
    try {
      const { stdout } = await execFileAsync('git', [...UNTRACKED_PATCH_ARGS, '--no-ext-diff', '--'], {
        cwd,
        env,
        timeout: Math.max(1, deadline - Date.now()),
        maxBuffer: maxBytes,
      });
      return { patch: stdout, incomplete: false };
    } catch (error: unknown) {
      const failure = error as { code?: unknown; killed?: boolean };
      // Stopped for size or time: what git wrote until then is a usable start.
      if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || failure.killed) {
        return { patch: dropUnfinishedFile(execOutput(error)), incomplete: true };
      }
      throw error;
    }
  } finally {
    await fsPromises.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * One git process per file: slow, but a file git refuses costs only itself.
 * It stops at the deadline, or before the file that would take the patch
 * past `maxBytes`.
 */
async function getUntrackedPatchFileByFile(
  cwd: string,
  files: string[],
  maxBytes: number,
  deadline: number
): Promise<UntrackedPatch> {
  const patches: string[] = [];
  let size = 0;
  let skipped = false;
  for (const filePath of files) {
    const timeLeft = deadline - Date.now();
    // The newline that joins this patch to the ones before it counts too.
    const room = maxBytes - size - (patches.length > 0 ? 1 : 0);
    if (timeLeft <= 0 || room <= 0) return { patch: patches.join('\n'), incomplete: true };
    let patch = '';
    try {
      ({ stdout: patch } = await execFileAsync('git', [...UNTRACKED_PATCH_ARGS, '--no-index', '--', '/dev/null', filePath], {
        cwd,
        timeout: Math.min(10_000, timeLeft),
        maxBuffer: room,
      }));
    } catch (error: unknown) {
      const failure = error as { code?: unknown; killed?: boolean };
      if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || failure.killed) {
        return { patch: patches.join('\n'), incomplete: true };
      }
      // `--no-index` exits 1 when the files differ, with the patch on stdout;
      // anything else is a file git could not diff.
      if (failure.code === 1) patch = execOutput(error);
      else skipped = true;
    }
    if (!patch.trim()) continue;
    const bytes = Buffer.byteLength(patch);
    if (bytes > room) return { patch: patches.join('\n'), incomplete: true };
    patches.push(patch);
    size += bytes + (patches.length > 1 ? 1 : 0);
  }
  return { patch: patches.join('\n'), incomplete: skipped };
}

/**
 * Untracked files as new-file patches, written by git, for the first
 * `maxFiles` of the files the totals count. A nested repository, listed as a
 * directory, has no patch.
 */
export async function getUntrackedPatch(
  cwd: string,
  limits: Partial<UntrackedPatchLimits> = {}
): Promise<UntrackedPatch> {
  const { maxFiles, maxBytes, deadlineMs } = { ...UNTRACKED_PATCH_LIMITS, ...limits };
  const listing = await listUntracked(cwd, { keep: maxFiles });
  const cut = !listing.complete || listing.total > listing.paths.length;
  const files = listing.paths.filter((filePath) => !filePath.endsWith('/'));
  const deadline = Date.now() + deadlineMs;
  const { diffable, unreadable } = await splitDiffableFiles(cwd, files);
  if (diffable.length === 0) return { patch: '', incomplete: cut || unreadable > 0 };
  let written: UntrackedPatch;
  try {
    written = await getUntrackedPatchInOnePass(cwd, diffable, maxBytes, deadline);
  } catch {
    written = await getUntrackedPatchFileByFile(cwd, diffable, maxBytes, deadline);
  }
  return { patch: written.patch, incomplete: written.incomplete || cut || unreadable > 0 };
}

export interface GitStatusRecord {
  /** The index column of `git status --porcelain`, e.g. `M`, `A`, `?`. */
  index: string;
  /** The work tree column. */
  worktree: string;
  /** Relative to the repository root. An untracked folder listed as one entry ends in `/`. */
  filePath: string;
}

type UntrackedMode = 'all' | 'normal';

const GIT_STATUS_TIMEOUT_MS = 10_000;

/**
 * `git status --porcelain -z`, one entry at a time. A renamed or copied
 * entry is followed by the path it came from, which is not an entry.
 */
async function streamStatusEntries(
  cwd: string,
  untracked: UntrackedMode,
  onEntry: (index: string, worktree: string, filePath: Buffer) => boolean | void
): Promise<void> {
  let originalPathNext = false;
  const outcome = await streamGitRecords(
    cwd,
    ['-c', 'core.quotepath=false', 'status', '--porcelain', '-z', `--untracked-files=${untracked}`],
    GIT_STATUS_TIMEOUT_MS,
    (record) => {
      if (originalPathNext) {
        originalPathNext = false;
        return;
      }
      if (record.length < 4) return;
      const index = String.fromCharCode(record[0]);
      const worktree = String.fromCharCode(record[1]);
      originalPathNext = index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C';
      return onEntry(index, worktree, record.subarray(3));
    }
  );
  if (outcome === 'timeout') throw new Error('git status timed out');
}

export interface WorkingTreeStatusLimits {
  /** With more untracked files than this, a wholly untracked folder is listed as one entry. */
  maxUntracked: number;
  /** The list stops here whatever it holds. */
  maxEntries: number;
}

export interface WorkingTreeStatus {
  entries: GitStatusRecord[];
  /** True when untracked folders are listed as one entry each, not file by file. */
  folded: boolean;
  /** True when the list stopped at `maxEntries`. */
  truncated: boolean;
}

const WORKING_TREE_STATUS_LIMITS: WorkingTreeStatusLimits = { maxUntracked: 10_000, maxEntries: 50_000 };

/**
 * What `git status` lists, with every untracked file on its own line while
 * they are few enough. A tree with more of them (a `node_modules` nobody
 * ignored) is listed the way git does by default, each wholly untracked
 * folder as one entry, so the answer stays small and quick.
 */
export async function getWorkingTreeStatus(
  cwd: string,
  limits: Partial<WorkingTreeStatusLimits> = {}
): Promise<WorkingTreeStatus> {
  const { maxUntracked, maxEntries } = { ...WORKING_TREE_STATUS_LIMITS, ...limits };
  const read = async (mode: 'all' | 'normal') => {
    const entries: GitStatusRecord[] = [];
    let untracked = 0;
    let tooManyUntracked = false;
    let truncated = false;
    await streamStatusEntries(cwd, mode, (index, worktree, filePath) => {
      if (index === '?' && mode === 'all') {
        untracked += 1;
        if (untracked > maxUntracked) {
          tooManyUntracked = true;
          return false;
        }
      }
      if (entries.length >= maxEntries) {
        truncated = true;
        return false;
      }
      entries.push({ index, worktree, filePath: filePath.toString('utf8') });
    });
    return { entries, tooManyUntracked, truncated };
  };
  const everyFile = await read('all');
  if (!everyFile.tooManyUntracked) return { entries: everyFile.entries, folded: false, truncated: everyFile.truncated };
  const byFolder = await read('normal');
  return { entries: byFolder.entries, folded: true, truncated: byFolder.truncated };
}

export interface WorkingTreeChangeCount {
  /** Entries `git status` lists with every untracked file on its own line. */
  total: number;
  /** True when the untracked files could not be listed in time: `total` is a lower bound. */
  atLeast: boolean;
}

/**
 * How many entries the repository's `git status` has, without asking git to
 * print every untracked file: those are counted from a listing. `listed` is
 * the listing of `cwd`; it covers the repository when `cwd` is its root, and
 * a subfolder gets one more listing from the root.
 */
async function countWorkingTreeChanges(
  cwd: string,
  listed: Promise<UntrackedListing>,
  timeoutMs?: number
): Promise<WorkingTreeChangeCount> {
  // Git's default view: it does not go into wholly untracked folders, so it
  // is quick, and it sees tracked entries exactly as the full view does.
  const status = (async () => {
    let tracked = 0;
    let untrackedByFolder = 0;
    await streamStatusEntries(cwd, 'normal', (index) => {
      if (index === '?') untrackedByFolder += 1;
      else tracked += 1;
    });
    return { tracked, untrackedByFolder };
  })();
  status.catch(() => undefined);
  const { stdout } = await runGit(cwd, ['rev-parse', '--show-cdup'], 5000);
  const pathToRoot = stdout.trim();
  const untracked = pathToRoot ? await listUntracked(join(cwd, pathToRoot), { keep: 0, timeoutMs }) : await listed;
  const { tracked, untrackedByFolder } = await status;
  if (untracked.complete) return { total: tracked + untracked.total, atLeast: false };
  // The walk did not end in time: a folder counts as one, which is never more than it holds.
  return { total: tracked + untrackedByFolder, atLeast: true };
}

export interface WorkingTreeScan {
  /** The count behind `totalChanges`. */
  changeCount: Promise<WorkingTreeChangeCount>;
  /** Lines added by untracked files, part of both the uncommitted and the branch totals. */
  untracked: Promise<GitChangeStats>;
}

/**
 * The change count and the untracked totals of a work tree from one walk of
 * its untracked files. Both promises are safe to leave unawaited.
 */
export function scanWorkingTree(
  cwd: string,
  limits: Partial<UntrackedScanLimits> & { listTimeoutMs?: number } = {}
): WorkingTreeScan {
  const maxFiles = limits.maxFiles ?? UNTRACKED_SCAN_LIMITS.maxFiles;
  const listed = listUntracked(cwd, { keep: maxFiles, timeoutMs: limits.listTimeoutMs });
  listed.catch(() => undefined);
  const changeCount = countWorkingTreeChanges(cwd, listed, limits.listTimeoutMs);
  const untracked = getUntrackedChangeStats(cwd, limits, listed);
  changeCount.catch(() => undefined);
  untracked.catch(() => undefined);
  return { changeCount, untracked };
}

const GIT_OUTPUT_TAIL_CHARS = 8192;

/**
 * Runs a git command that may print a line per file, keeping only the end of
 * what it says: enough for a message, whatever the size of the tree. A
 * failure carries both ends as `stdout` and `stderr`.
 */
function runGitKeepingTail(cwd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = { stdout: '', stderr: '' };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (chunk: Buffer) => {
        tail[stream] = `${tail[stream]}${chunk.toString('utf8')}`.slice(-GIT_OUTPUT_TAIL_CHARS);
      });
    }
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(tail);
        return;
      }
      const said = [tail.stderr.trim(), tail.stdout.trim()].filter(Boolean).join('\n');
      const message = timedOut ? `git ${args[0]} timed out.` : said || `git ${args[0]} exited with code ${code}.`;
      reject(Object.assign(new Error(message), tail));
    });
  });
}

/**
 * Stages everything, as `git add -A` does: one process however many files
 * there are. Hashing a very large tree takes a while, hence the long bound.
 */
export async function stageAllChanges(cwd: string): Promise<void> {
  await runGitKeepingTail(cwd, ['add', '-A'], 300_000);
}

/**
 * Commits what is staged and returns what git said. Quiet, because the
 * summary git prints otherwise diffs every file and lists each new one,
 * which takes many seconds and megabytes for a large commit; why a commit
 * was refused is still said.
 */
export async function commitStagedChanges(cwd: string, message: string): Promise<string> {
  const { stdout, stderr } = await runGitKeepingTail(cwd, ['commit', '--quiet', '-m', message], 120_000);
  return `${stdout}${stderr}`.trim();
}

const MAX_DIFF_TEXT_CHARS = 400_000;

export async function getDiffAgainstRef(cwd: string, ref: string): Promise<string> {
  const { stdout } = await runGit(cwd, ['diff', ref], 120_000);
  return stdout.length > MAX_DIFF_TEXT_CHARS
    ? `${stdout.slice(0, MAX_DIFF_TEXT_CHARS)}\n… (diff truncated)`
    : stdout;
}

// tracked 改动（暂存或未暂存）才阻塞 adopt；用户自己的 untracked 文件不阻塞——
// merge 若会覆盖 untracked 文件，git 自己会中止。
export async function hasTrackedChanges(cwd: string): Promise<boolean> {
  const { stdout } = await runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=no'], 30_000);
  return stdout.trim().length > 0;
}

export async function commitAllChanges(input: {
  cwd: string;
  message: string;
}): Promise<boolean> {
  await runGit(input.cwd, ['add', '-A'], 60_000);
  const { stdout } = await runGit(input.cwd, ['status', '--porcelain=v1'], 30_000);
  if (!stdout.trim()) return false;
  await runGit(input.cwd, ['commit', '-m', input.message, '--no-verify'], 60_000);
  return true;
}

// squash-merge 到主工作区暂存区（不自动 commit，改动留给用户审查）。
// 冲突时用 `git reset --merge` 干净中止（冲突的 squash-merge 后 MERGE_HEAD 不存在，
// `merge --abort` 不可用）。
export async function squashMergeBranch(input: {
  cwd: string;
  branch: string;
}): Promise<{ ok: boolean; conflict: boolean; message: string }> {
  try {
    const { stdout, stderr } = await runGit(input.cwd, ['merge', '--squash', input.branch], 120_000);
    return { ok: true, conflict: false, message: `${stdout || ''}${stderr || ''}`.trim() };
  } catch (error) {
    // CONFLICT 行走 stdout；execFile 的 error.message 只含 stderr，必须合并检查
    const err = error as { message?: string; stdout?: string; stderr?: string };
    const combined = `${err.stdout || ''}\n${err.stderr || ''}\n${err.message || ''}`;
    const conflict = /conflict/i.test(combined);
    await runGit(input.cwd, ['reset', '--merge'], 60_000).catch(() => undefined);
    return { ok: false, conflict, message: combined.trim() };
  }
}

export async function deleteBranch(input: {
  cwd: string;
  branch: string;
  force?: boolean;
}): Promise<void> {
  const args = ['branch', input.force ? '-D' : '-d', input.branch];
  await runGit(input.cwd, args, 30_000);
}

export async function checkoutBranch(input: {
  cwd: string;
  branch: string;
}): Promise<string> {
  const { stdout, stderr } = await runGit(input.cwd, ['checkout', input.branch], 120_000);
  return `${stdout || ''}${stderr || ''}`.trim();
}

export async function createBranch(input: {
  cwd: string;
  branch: string;
}): Promise<string> {
  const branch = input.branch.trim();
  await runGit(input.cwd, ['check-ref-format', '--branch', branch], 5000);
  const { stdout, stderr } = await runGit(input.cwd, ['checkout', '-b', branch], 120_000);
  return `${stdout || ''}${stderr || ''}`.trim();
}
