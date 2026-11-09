import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

// Per-turn patches should stay small — they are persisted into the session
// transcript and shipped to the renderer.
const TURN_PATCH_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const TURN_PATCH_MAX_CHARS = 2 * 1024 * 1024;

let snapshotCounter = 0;

export interface TurnTreeDiff {
  patch: string;
  truncated: boolean;
}

/**
 * Captures the full working-tree state (tracked + untracked, .gitignore
 * respected) as a git tree hash, WITHOUT touching the repository's real
 * index: all index operations run against a throwaway GIT_INDEX_FILE.
 * Returns null when cwd is not inside a git repo or git fails.
 */
export async function captureGitTreeSnapshot(cwd: string): Promise<string | null> {
  if (!cwd) return null;
  snapshotCounter += 1;
  const indexFile = path.join(
    os.tmpdir(),
    `aegis-turn-index-${process.pid}-${Date.now()}-${snapshotCounter}`
  );
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd, env, timeout: 5000 });
    // Seed the temp index from HEAD; a repo with no commits yet starts empty.
    try {
      await execFileAsync('git', ['read-tree', 'HEAD'], { cwd, env, timeout: 10000 });
    } catch {
      await execFileAsync('git', ['read-tree', '--empty'], { cwd, env, timeout: 10000 });
    }
    await execFileAsync('git', ['add', '-A'], { cwd, env, timeout: 30000 });
    const { stdout } = await execFileAsync('git', ['write-tree'], { cwd, env, timeout: 10000 });
    return stdout.trim() || null;
  } catch {
    return null;
  } finally {
    void fs.unlink(indexFile).catch(() => {});
  }
}

/**
 * Pathspecs leaving out the repository's own linked worktrees that sit inside
 * it (an agent's `.worktrees/x`): `git add -A` records each as a gitlink, a
 * "Subproject commit" that is no change to the folder.
 */
async function nestedWorktreeExcludes(cwd: string): Promise<string[]> {
  try {
    const [{ stdout: top }, { stdout: list }] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 5000 }),
      execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd, timeout: 5000 }),
    ]);
    const root = top.trim();
    return [...list.matchAll(/^worktree (.+)$/gm)]
      .map((match) => path.relative(root, match[1]))
      .filter((rel) => rel && !rel.startsWith('..') && !path.isAbsolute(rel))
      .map((rel) => `:(top,exclude,literal)${rel.split(path.sep).join('/')}`);
  } catch {
    return [];
  }
}

/**
 * Unified diff between two tree snapshots produced by
 * captureGitTreeSnapshot. Tree-to-tree diff covers modified, deleted and
 * (because the snapshots `git add -A`) newly created untracked files alike.
 */
export async function diffGitTreeSnapshots(
  cwd: string,
  beforeTree: string,
  afterTree: string,
  /** Folder put in front of every path, e.g. `worktree/` for `a/worktree/src/x.ts`. */
  pathPrefix = ''
): Promise<TurnTreeDiff> {
  if (beforeTree === afterTree) {
    return { patch: '', truncated: false };
  }
  const excludes = await nestedWorktreeExcludes(cwd);
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        '-c',
        'core.quotepath=false',
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--unified=3',
        ...(pathPrefix ? [`--src-prefix=a/${pathPrefix}`, `--dst-prefix=b/${pathPrefix}`] : []),
        beforeTree,
        afterTree,
        ...(excludes.length ? ['--', ...excludes] : []),
      ],
      { cwd, timeout: 15000, maxBuffer: TURN_PATCH_MAX_BUFFER_BYTES }
    );
    const truncated = stdout.length > TURN_PATCH_MAX_CHARS;
    return {
      patch: truncated ? stdout.slice(0, TURN_PATCH_MAX_CHARS) : stdout,
      truncated,
    };
  } catch {
    return { patch: '', truncated: false };
  }
}

/**
 * The commit a linked worktree had checked out when it was added: the oldest
 * entry of its own HEAD reflog. Null when git can't tell.
 */
export async function worktreeStartCommit(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['reflog', 'show', 'HEAD', '--format=%H'], {
      cwd,
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim().split('\n').pop()?.trim() || null;
  } catch {
    return null;
  }
}
