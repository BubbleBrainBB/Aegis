// Whether a session's worktree still has work to apply back, against real git.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeHoldsWork } from '../../src/electron/libs/worktree-work';

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'aegis-worktree-work-')));
const project = join(temp, 'project');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const commit = (cwd: string, name: string) => { writeFileSync(join(cwd, name), name); git(cwd, 'add', name); git(cwd, 'commit', '-qm', name); };

(async () => {
try {
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  commit(project, 'base.txt');
  const worktree = join(temp, 'wt');
  git(project, 'worktree', 'add', '-q', '-b', 'task', worktree);

  assert.equal(await worktreeHoldsWork(worktree, project), false, 'a fresh worktree has no work');
  writeFileSync(join(worktree, 'draft.txt'), 'draft');
  assert.equal(await worktreeHoldsWork(worktree, project), true, 'an untracked file is work');
  git(worktree, 'add', 'draft.txt'); git(worktree, 'commit', '-qm', 'draft');
  assert.equal(await worktreeHoldsWork(worktree, project), true, 'an unmerged commit is work');
  git(project, 'merge', '-q', '--ff-only', 'task');
  assert.equal(await worktreeHoldsWork(worktree, project), false, 'merged into the project checkout, nothing is left');

  commit(worktree, 'more.txt');
  assert.equal(await worktreeHoldsWork(worktree, project), true, 'a later commit is work again');
  git(project, 'switch', '-q', '--detach', 'task~1');
  git(project, 'update-ref', 'refs/remotes/origin/main', 'task');
  git(project, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  assert.equal(await worktreeHoldsWork(worktree, project), false, 'merged into the remote default branch, nothing is left');

  assert.equal(await worktreeHoldsWork(join(temp, 'missing'), project), false, 'a removed worktree has nothing left');
  assert.equal(await worktreeHoldsWork(temp, project), true, 'a folder git cannot read stays in review');
  console.log('worktree-work tests passed');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
})().catch((error) => { console.error(error); process.exit(1); });
