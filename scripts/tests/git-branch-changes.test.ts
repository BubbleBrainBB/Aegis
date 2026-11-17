// What a branch changed against its base, measured in a real scratch
// repository with a remote: the totals behind the Environment card's Changes
// row. Committing and pushing must not empty them, and the default branch
// moving on must not add to them.
// Compiled + executed by scripts/verify-run-group.mjs.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getChangeStatsSince,
  getUntrackedChangeStats,
  listUntrackedPaths,
  resolveBranchBase,
} from '../../src/electron/libs/git-service';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function branchChanges(cwd: string, known: { defaultBranch: string | null; upstreamRef: string | null }) {
  const base = await resolveBranchBase(cwd, known);
  return base ? { baseRef: base.baseRef, ...(await getChangeStatsSince(cwd, base.mergeBase)) } : null;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-branch-changes-'));
  try {
    const remote = path.join(root, 'remote.git');
    const repo = path.join(root, 'repo');
    git(root, ['init', '--bare', '--initial-branch=main', remote]);
    git(root, ['init', '--initial-branch=main', repo]);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init']);
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-u', 'origin', 'main']);

    const onMain = { defaultBranch: 'main', upstreamRef: 'origin/main' };
    assert.deepEqual(await branchChanges(repo, onMain), { baseRef: 'origin/main', files: 0, insertions: 0, deletions: 0 });

    // An unpushed commit on the default branch itself is still measured.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    git(repo, ['commit', '-am', 'unpushed']);
    assert.deepEqual(await branchChanges(repo, onMain), { baseRef: 'origin/main', files: 1, insertions: 1, deletions: 0 });
    git(repo, ['reset', '--hard', 'origin/main']);

    // A committed and pushed feature branch: nothing is uncommitted, and the
    // upstream equals HEAD, yet the branch's work is all there.
    git(repo, ['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n2\nthree\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'new\nfile\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'feature work']);
    git(repo, ['push', '-u', 'origin', 'feature']);
    const onFeature = { defaultBranch: 'main', upstreamRef: 'origin/feature' };
    assert.deepEqual(await getChangeStatsSince(repo, 'HEAD'), { files: 0, insertions: 0, deletions: 0 });
    assert.deepEqual(await branchChanges(repo, onFeature), { baseRef: 'origin/main', files: 2, insertions: 3, deletions: 1 });

    // Uncommitted edits and untracked files (binary ones count as a file
    // with no lines) are part of the same total.
    fs.appendFileSync(path.join(repo, 'b.txt'), 'more\n');
    fs.writeFileSync(path.join(repo, 'c d.txt'), 'x\ny\n');
    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]));
    assert.deepEqual(await getUntrackedChangeStats(repo), { files: 2, insertions: 2, deletions: 0 });
    assert.deepEqual(await getChangeStatsSince(repo, 'HEAD'), { files: 3, insertions: 3, deletions: 0 });
    assert.deepEqual(await branchChanges(repo, onFeature), { baseRef: 'origin/main', files: 4, insertions: 6, deletions: 1 });

    // A name with surrounding spaces is listed as it is, so the patch built
    // from this list holds the same files the totals count.
    fs.writeFileSync(path.join(repo, ' spaced.txt '), 'kept\n');
    assert.deepEqual((await listUntrackedPaths(repo)).sort(), [' spaced.txt ', 'blob.bin', 'c d.txt']);
    assert.deepEqual(await getUntrackedChangeStats(repo), { files: 3, insertions: 3, deletions: 0 });
    fs.rmSync(path.join(repo, ' spaced.txt '));

    // A detached HEAD has the same work on top of the same base.
    git(repo, ['checkout', '--detach']);
    assert.deepEqual(
      await branchChanges(repo, { defaultBranch: 'main', upstreamRef: null }),
      { baseRef: 'origin/main', files: 4, insertions: 6, deletions: 1 }
    );
    git(repo, ['checkout', 'feature']);

    // The default branch moving on is not the feature branch's change.
    const other = path.join(root, 'other');
    git(root, ['clone', remote, other]);
    git(other, ['config', 'user.email', 'test@example.com']);
    git(other, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(other, 'main-only.txt'), 'elsewhere\n');
    git(other, ['add', '.']);
    git(other, ['commit', '-m', 'main moves on']);
    git(other, ['push', 'origin', 'main']);
    git(repo, ['fetch', 'origin']);
    assert.deepEqual(await branchChanges(repo, onFeature), { baseRef: 'origin/main', files: 4, insertions: 6, deletions: 1 });

    // With no remote-tracking default branch, the local one is the base.
    git(repo, ['update-ref', '-d', 'refs/remotes/origin/main']);
    assert.equal((await branchChanges(repo, onFeature))?.baseRef, 'main');

    // No known default branch: the upstream is the only base there is.
    assert.deepEqual(
      await branchChanges(repo, { defaultBranch: null, upstreamRef: 'origin/feature' }),
      { baseRef: 'origin/feature', files: 3, insertions: 3, deletions: 0 }
    );
    assert.equal(await branchChanges(repo, { defaultBranch: null, upstreamRef: null }), null);
    assert.equal(await branchChanges(repo, { defaultBranch: 'trunk', upstreamRef: null }), null);

    console.log('git-branch-changes: base resolution and branch totals passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
