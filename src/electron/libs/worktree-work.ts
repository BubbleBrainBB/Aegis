import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS });
  return stdout.trim();
}

/** Where a worktree's commits are applied back to: the remote's default branch and what the project has checked out. */
async function applyTargets(worktreePath: string, projectCwd: string | null): Promise<string[]> {
  const targets = await Promise.all([
    git(worktreePath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).catch(() => ''),
    projectCwd && existsSync(projectCwd) ? git(projectCwd, ['rev-parse', 'HEAD']).catch(() => '') : '',
  ]);
  return targets.filter(Boolean);
}

/**
 * Whether a session's worktree still has work to apply back: the folder exists
 * and it has uncommitted changes or commits that no apply target contains. A
 * failed check counts as work, so nothing leaves review on a guess. Rebased and
 * squashed merges keep new commit ids, so those worktrees also count as work.
 */
export async function worktreeHoldsWork(worktreePath: string, projectCwd: string | null): Promise<boolean> {
  if (!existsSync(worktreePath)) return false;
  try {
    if (await git(worktreePath, ['status', '--porcelain'])) return true;
    for (const target of await applyTargets(worktreePath, projectCwd)) {
      const contained = await git(worktreePath, ['merge-base', '--is-ancestor', 'HEAD', target]).then(() => true, () => false);
      if (contained) return false;
    }
    return true;
  } catch {
    return true;
  }
}
