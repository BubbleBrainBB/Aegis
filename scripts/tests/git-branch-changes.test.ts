// What a branch changed against its base, measured in a real scratch
// repository with a remote: the totals behind the Environment card's Changes
// row. Committing and pushing must not empty them, and the default branch
// moving on must not add to them. A repository with no commit yet still has
// totals, and untracked files are counted as git counts them, in bounded time.
// A tree with more untracked files than anyone lists (a node_modules nobody
// ignored) still gets a count, a status list, a patch and one-step staging.
// Compiled + executed by scripts/verify-run-group.mjs.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  commitStagedChanges,
  getChangeStatsSince,
  getUncommittedChangeStats,
  getUntrackedChangeStats,
  getUntrackedPatch,
  getWorkingTreeStatus,
  listUntracked,
  listUntrackedPaths,
  resolveBranchBase,
  scanWorkingTree,
  stageAllChanges,
} from '../../src/electron/libs/git-service';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function branchChanges(cwd: string, known: { defaultBranch: string | null; upstreamRef: string | null }) {
  const base = await resolveBranchBase(cwd, known);
  return base ? { baseRef: base.baseRef, ...(await getChangeStatsSince(cwd, base.mergeBase)) } : null;
}

/** What git itself reports for one untracked file: added lines, or null when it cannot diff it. */
function gitNumstat(cwd: string, filePath: string): number | null {
  let output = '';
  try {
    output = git(cwd, ['diff', '--no-index', '--numstat', '--', '/dev/null', filePath]);
  } catch (error) {
    // `--no-index` exits 1 when the files differ; the numbers are on stdout.
    output = String((error as { stdout?: unknown }).stdout ?? '');
  }
  const match = output.match(/^(\d+|-)\t(\d+|-)\t/);
  if (!match) return null;
  return match[1] === '-' ? 0 : Number(match[1]);
}

/** The patch git itself writes for one untracked file. */
function gitNewFilePatch(cwd: string, filePath: string): string {
  try {
    return git(cwd, ['-c', 'core.quotepath=false', 'diff', '--no-index', '--no-color', '--unified=3', '--', '/dev/null', filePath]);
  } catch (error) {
    return String((error as { stdout?: unknown }).stdout ?? '');
  }
}

const patchedFiles = (patch: string) => [...patch.matchAll(/^diff --git a\/(.+) b\/\1$/gm)].map((match) => match[1]);

function initRepo(dir: string, extraArgs: string[] = []): void {
  git(path.dirname(dir), ['init', '--initial-branch=main', ...extraArgs, dir]);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
}

// A branch with no commit yet is a normal state: what is staged and what is
// untracked are the uncommitted changes, and no base exists to compare with.
async function unbornHead(root: string) {
  for (const format of ['sha1', 'sha256']) {
    const repo = path.join(root, `unborn-${format}`);
    initRepo(repo, [`--object-format=${format}`]);
    assert.deepEqual(await getUncommittedChangeStats(repo), { files: 0, insertions: 0, deletions: 0 });

    fs.writeFileSync(path.join(repo, 'staged.txt'), 'one\ntwo\n');
    git(repo, ['add', 'staged.txt']);
    fs.appendFileSync(path.join(repo, 'staged.txt'), 'three\n');
    fs.writeFileSync(path.join(repo, 'loose.txt'), 'x\n');
    await assert.rejects(getChangeStatsSince(repo, 'HEAD'), /bad revision 'HEAD'/);
    assert.deepEqual(await getUncommittedChangeStats(repo), { files: 2, insertions: 4, deletions: 0 });
    assert.deepEqual(patchedFiles((await getUntrackedPatch(repo)).patch), ['loose.txt']);
    assert.equal(await resolveBranchBase(repo, { defaultBranch: null, upstreamRef: null }), null);
    assert.equal(await resolveBranchBase(repo, { defaultBranch: 'main', upstreamRef: null }), null);

    // Once the first commit exists, HEAD is the base again.
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'first']);
    assert.deepEqual(await getUncommittedChangeStats(repo), { files: 0, insertions: 0, deletions: 0 });
  }

  // Anything other than a missing first commit is still an error.
  const notRepo = path.join(root, 'not-a-repo');
  fs.mkdirSync(notRepo);
  await assert.rejects(getUncommittedChangeStats(notRepo));
}

// The scan counts in-process; its totals have to be the ones git reports.
async function untrackedScan(root: string) {
  const repo = path.join(root, 'scan');
  initRepo(repo);
  fs.writeFileSync(
    path.join(repo, '.gitattributes'),
    '*.dat binary\n*.frc diff\n*.opq diff=opaque\n*.pln diff=Plain.Text\n*.py2 diff=python\n*.unk diff=nosuchdriver\n'
  );
  // Named diff drivers: the repository says whether their files are binary.
  git(repo, ['config', 'diff.opaque.binary', 'true']);
  git(repo, ['config', 'diff.Plain.Text.binary', 'false']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);

  const nul = Buffer.from([0]);
  const files: Array<[string, Buffer | string]> = [
    ['empty.txt', ''],
    ['one-line.txt', 'a\n'],
    ['no-trailing-newline.txt', 'a\nb'],
    ['only-newlines.txt', '\n\n\n'],
    ['crlf.txt', 'a\r\nb\r\n'],
    ['lone-cr.txt', 'a\rb\rc'],
    ['with space.txt', 'x\ny\n'],
    [' edge spaces .txt', 'x\n'],
    ['unicode-名前.txt', '一\n二\n'],
    ['dir/nested/deep.txt', 'd\n'],
    ['binary.bin', Buffer.from([0, 1, 2, 0, 255])],
    ['utf16.txt', Buffer.from('hello\nworld\n', 'utf16le')],
    // git looks for a NUL in the first 8000 bytes only.
    ['nul-at-7999.txt', Buffer.concat([Buffer.alloc(7999, 'a'), nul, Buffer.from('\n')])],
    ['nul-at-8000.txt', Buffer.concat([Buffer.alloc(8000, 'a'), nul, Buffer.from('\n')])],
    ['late-nul.txt', Buffer.concat([Buffer.from('a\n'.repeat(5000)), nul, Buffer.from('b\nc')])],
    // Larger than one read, with a line break on the chunk edge.
    ['multi-chunk.txt', Buffer.concat([Buffer.alloc(64 * 1024 - 1, 'a'), Buffer.from('\n'), Buffer.from('b\n'.repeat(70_000))])],
    // Attributes override what the content looks like.
    ['text-marked-binary.dat', 'l1\nl2\n'],
    ['nul-marked-text.frc', Buffer.concat([Buffer.from('a'), nul, Buffer.from('b\nc\n')])],
    // So does a named driver with a `binary` setting; one without it leaves the content to decide.
    ['text-under-binary-driver.opq', 'l1\nl2\nl3\n'],
    ['nul-under-text-driver.pln', Buffer.concat([Buffer.from('a'), nul, Buffer.from('b\nc\n')])],
    ['text-under-builtin-driver.py2', 'def f():\n    pass\n'],
    ['nul-under-builtin-driver.py2', Buffer.concat([Buffer.from('a'), nul, Buffer.from('b\n')])],
    ['text-under-unknown-driver.unk', 'u\n'],
  ];
  let expected = 0;
  for (const [name, content] of files) {
    const target = path.join(repo, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    const fromGit = gitNumstat(repo, name);
    assert.notEqual(fromGit, null, `git reports ${name}`);
    expected += fromGit ?? 0;
    assert.deepEqual(
      await getUntrackedChangeStats(repo),
      { files: files.findIndex(([entry]) => entry === name) + 1, insertions: expected, deletions: 0 },
      `same total as git after adding ${name}`
    );
  }
  let count = files.length;

  if (process.platform !== 'win32') {
    // A symlink is its target path, whether or not that exists.
    fs.symlinkSync('one-line.txt', path.join(repo, 'link'));
    fs.symlinkSync('/nonexistent/target', path.join(repo, 'dangling'));
    expected += (gitNumstat(repo, 'link') ?? 0) + (gitNumstat(repo, 'dangling') ?? 0);
    count += 2;
    assert.deepEqual(await getUntrackedChangeStats(repo), { files: count, insertions: expected, deletions: 0 });
  }

  // A nested repository is listed as one entry that git cannot diff either.
  initRepo(path.join(repo, 'inner'));
  fs.writeFileSync(path.join(repo, 'inner', 'n.txt'), 'n\n');
  assert.equal(gitNumstat(repo, 'inner/'), null);
  count += 1;
  const complete = { files: count, insertions: expected, deletions: 0 };
  assert.deepEqual(await getUntrackedChangeStats(repo), complete);
  // The totals built on the scan carry no flag either.
  assert.deepEqual(await getUncommittedChangeStats(repo), complete);

  // The patch for the same files comes from one git pass over a throwaway
  // index; it reads as the per-file patches do and leaves the repository alone.
  const listed = (await listUntrackedPaths(repo)).filter((name) => !name.endsWith('/'));
  assert.equal(listed.length, count - 1);
  const gitFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return gitFiles(full);
      const stat = fs.statSync(full);
      return [`${full} ${stat.size} ${stat.mtimeMs}`];
    });
  const repoState = () => gitFiles(path.join(repo, '.git')).sort().join('\n');
  const stateBefore = repoState();
  const whole = await getUntrackedPatch(repo);
  assert.equal(whole.incomplete, false);
  assert.equal(whole.patch, listed.map((name) => gitNewFilePatch(repo, name)).join(''));
  assert.equal(repoState(), stateBefore);
  // From a subfolder, only its files, named from the repository root like every other patch.
  assert.deepEqual(patchedFiles((await getUntrackedPatch(path.join(repo, 'dir'))).patch), ['dir/nested/deep.txt']);
  // Cut for size: whole files from the start, and it says files are missing.
  const cut = await getUntrackedPatch(repo, { maxBytes: 2000 });
  assert.equal(cut.incomplete, true);
  assert.ok(cut.patch.length > 0 && cut.patch.length <= 2000 && whole.patch.startsWith(cut.patch));
  assert.ok(whole.patch.slice(cut.patch.length).startsWith('diff --git '), 'the cut is between two files');

  // Past its file bound the patch holds the first files and says the rest are missing.
  const firstThree = (await listUntrackedPaths(repo)).slice(0, 3);
  assert.deepEqual(await getUntrackedPatch(repo, { maxFiles: 3 }), {
    patch: firstThree.map((name) => gitNewFilePatch(repo, name)).join(''),
    incomplete: true,
  });
  assert.equal((await getUntrackedPatch(repo, { maxFiles: listed.length + 1 })).incomplete, false);

  // With no scratch folder to be had the patch is written file by file: the
  // same files, never past the size bound, and cut between two files.
  const scratchVariables = ['TMPDIR', 'TMP', 'TEMP'] as const;
  const savedScratch = scratchVariables.map((name) => process.env[name]);
  for (const name of scratchVariables) process.env[name] = path.join(root, 'no-such-folder');
  try {
    const fileByFile = await getUntrackedPatch(repo);
    assert.deepEqual(fileByFile, { patch: listed.map((name) => gitNewFilePatch(repo, name)).join('\n'), incomplete: false });
    for (const maxBytes of [100, 300, 2000, 150_000]) {
      const cutSlow = await getUntrackedPatch(repo, { maxBytes });
      assert.equal(cutSlow.incomplete, true);
      assert.ok(Buffer.byteLength(cutSlow.patch) <= maxBytes, `file by file stays within ${maxBytes} bytes`);
      assert.ok(fileByFile.patch.startsWith(cutSlow.patch));
      assert.match(fileByFile.patch.slice(cutSlow.patch.length), /^\n?diff --git /, 'the cut is between two files');
    }
    assert.deepEqual(await getUntrackedPatch(repo, { deadlineMs: 0 }), { patch: '', incomplete: true });
  } finally {
    scratchVariables.forEach((name, index) => {
      if (savedScratch[index] === undefined) delete process.env[name];
      else process.env[name] = savedScratch[index];
    });
  }

  // More files than the scan covers is said, not passed off as files with no lines.
  assert.deepEqual(await getUntrackedChangeStats(repo, { maxFiles: 3 }), {
    files: count,
    insertions: firstThree.reduce((sum, name) => sum + (gitNumstat(repo, name) ?? 0), 0),
    deletions: 0,
    incomplete: true,
  });
  // The listing holds only the names asked for and still counts every file.
  const everyPath = await listUntrackedPaths(repo);
  assert.deepEqual(await listUntracked(repo, { keep: 2 }), { paths: everyPath.slice(0, 2), total: count, complete: true });
  assert.equal((await listUntracked(repo, { keep: 2, timeoutMs: 0 })).complete, false);
  // One large file does not make a tree too big to count: it is read in full.
  const largeLog = path.join(repo, 'large.log');
  fs.writeFileSync(largeLog, 'a line of a log file\n'.repeat(450_000));
  assert.ok(fs.statSync(largeLog).size > 9 * 1024 * 1024);
  assert.deepEqual(await getUntrackedChangeStats(repo), { files: count + 1, insertions: expected + 450_000, deletions: 0 });
  assert.equal(gitNumstat(repo, 'large.log'), 450_000);
  // Past core.bigFileThreshold git diffs a file as binary without reading it,
  // unless an attribute calls it text; the scan counts the same way.
  git(repo, ['config', 'core.bigFileThreshold', '1m']);
  fs.writeFileSync(path.join(repo, 'large.frc'), 'x\n'.repeat(600_000));
  assert.equal(gitNumstat(repo, 'large.log'), 0);
  assert.equal(gitNumstat(repo, 'large.frc'), 600_000);
  assert.deepEqual(await getUntrackedChangeStats(repo), { files: count + 2, insertions: expected + 600_000, deletions: 0 });
  git(repo, ['config', '--unset', 'core.bigFileThreshold']);
  fs.rmSync(largeLog);
  fs.rmSync(path.join(repo, 'large.frc'));
  // Out of time before the first file: nothing counted, and it says so.
  assert.deepEqual(await getUntrackedChangeStats(repo, { deadlineMs: 0 }), {
    files: count,
    insertions: 0,
    deletions: 0,
    incomplete: true,
    // Cut by time, not by the file cap: the next scan may count differently.
    unsettled: true,
  });
  assert.equal((await getUncommittedChangeStats(repo, getUntrackedChangeStats(repo, { deadlineMs: 0 }))).incomplete, true);

  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = path.join(repo, 'unreadable.txt');
    fs.writeFileSync(locked, 'secret\n');
    fs.chmodSync(locked, 0o000);
    try {
      // Its lines are unknown, so the total is a lower bound; the same one on every scan.
      assert.deepEqual(await getUntrackedChangeStats(repo), { files: count + 1, insertions: expected, deletions: 0, incomplete: true });
      // The patch lacks it and says so, and the other files still come from the one pass.
      assert.deepEqual(await getUntrackedPatch(repo), { patch: whole.patch, incomplete: true });
    } finally {
      fs.chmodSync(locked, 0o644);
      fs.rmSync(locked);
    }
  }
}

// A scan out of time stops reading, it does not just stop reporting: a file
// far too large to read in the time allowed (all holes, so it takes no disk)
// is given up between two reads, and nothing is still being read on return.
async function scanStopsReading(root: string) {
  const repo = path.join(root, 'stops');
  initRepo(repo);
  // Marked as text, so neither the first bytes nor core.bigFileThreshold end the read early.
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.frc diff\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);
  const endless = path.join(repo, 'endless.frc');
  fs.writeFileSync(endless, 'x\n');
  try {
    fs.truncateSync(endless, 1024 ** 4);
  } catch {
    console.log('git-branch-changes: no sparse files here, skipping the read-stop check');
    return;
  }
  try {
    const startedAt = Date.now();
    const stats = await getUntrackedChangeStats(repo, { deadlineMs: 1500 });
    const elapsed = Date.now() - startedAt;
    assert.deepEqual(stats, { files: 1, insertions: 0, deletions: 0, incomplete: true, unsettled: true });
    assert.ok(elapsed < 6000, `the scan returned ${elapsed} ms after a 1500 ms deadline`);
  } finally {
    fs.rmSync(endless);
  }
}

// A read that never comes back (a stalled network mount) cannot be stopped
// between reads. The scan does not wait for it: it answers once its time is
// up, and the reader closes its file whenever the read returns.
async function scanDoesNotWaitForStuckRead(root: string) {
  const repo = path.join(root, 'stuck');
  initRepo(repo);
  fs.writeFileSync(path.join(repo, 'ok.txt'), 'a\nb\n');
  fs.writeFileSync(path.join(repo, 'stuck.txt'), 'never\nread\n');
  const realOpen = fs.promises.open;
  let release = () => {};
  let closed = false;
  const stuck = new Promise<void>((resolve) => {
    release = resolve;
  });
  (fs.promises as { open: unknown }).open = async (target: fs.PathLike, ...rest: [fs.OpenMode?, fs.Mode?]) => {
    const handle = await realOpen(target, ...rest);
    if (!String(target).endsWith('stuck.txt')) return handle;
    const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<unknown>;
    const close = handle.close.bind(handle);
    Object.assign(handle, {
      read: async (...args: unknown[]) => {
        await stuck;
        return read(...args);
      },
      close: async () => {
        closed = true;
        return close();
      },
    });
    return handle;
  };
  try {
    const startedAt = Date.now();
    const stats = await getUntrackedChangeStats(repo, { deadlineMs: 300 });
    const elapsed = Date.now() - startedAt;
    assert.equal(stats.incomplete, true);
    assert.equal(stats.unsettled, true);
    assert.equal(stats.files, 2);
    assert.ok(elapsed < 3000, `the scan answered ${elapsed} ms after a 300 ms deadline with one read stuck`);
    assert.equal(closed, false);
    // Once the read comes back, its reader stops and lets go of the file.
    release();
    for (let attempt = 0; attempt < 100 && !closed; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closed, true, 'the stuck file is closed after its read returns');
  } finally {
    release();
    (fs.promises as { open: unknown }).open = realOpen;
  }
}

// One git process per file made a thousand untracked files take seconds on
// every refresh. Measured against process starts on the same machine, so a
// slow or busy machine moves both sides: the scan has to beat a quarter of
// the processes the per-file approach would start.
async function untrackedScanCost(root: string) {
  const repo = path.join(root, 'many');
  initRepo(repo);
  const fileCount = 1000;
  for (let index = 0; index < fileCount; index += 1) {
    fs.mkdirSync(path.join(repo, `d${index % 20}`), { recursive: true });
    fs.writeFileSync(path.join(repo, `d${index % 20}`, `f${index}.txt`), `line ${index}\nsecond\nthird`);
  }
  await getUntrackedChangeStats(repo);

  let started = process.hrtime.bigint();
  for (let index = 0; index < fileCount / 4; index += 1) git(repo, ['--version']);
  const quarterOfTheProcesses = Number(process.hrtime.bigint() - started) / 1e6;

  started = process.hrtime.bigint();
  const stats = await getUntrackedChangeStats(repo);
  const scan = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepEqual(stats, { files: fileCount, insertions: fileCount * 3, deletions: 0 });
  assert.ok(
    scan < quarterOfTheProcesses,
    `scanning ${fileCount} untracked files took ${scan.toFixed(0)} ms; starting ${fileCount / 4} git processes takes ${quarterOfTheProcesses.toFixed(0)} ms`
  );

  started = process.hrtime.bigint();
  const { patch, incomplete } = await getUntrackedPatch(repo);
  const patching = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(incomplete, false);
  assert.equal(patchedFiles(patch).length, fileCount);
  assert.ok(
    patching < quarterOfTheProcesses,
    `the patch for ${fileCount} untracked files took ${patching.toFixed(0)} ms; starting ${fileCount / 4} git processes takes ${quarterOfTheProcesses.toFixed(0)} ms`
  );
  console.log(
    `git-branch-changes: ${fileCount} untracked files counted in ${scan.toFixed(0)} ms, patched in ${patching.toFixed(0)} ms (${fileCount / 4} git starts: ${quarterOfTheProcesses.toFixed(0)} ms)`
  );
}

const statusLines = (cwd: string, untracked: 'all' | 'normal') =>
  git(cwd, ['status', '--porcelain', `--untracked-files=${untracked}`]).split('\n').filter(Boolean);

// The change count and the status list behind the card and the commit dialog:
// what `git status -uall` says for an ordinary repository, without depending
// on the size of that output.
async function workingTreeStatus(root: string) {
  const repo = path.join(root, 'status');
  initRepo(repo);
  for (const name of ['keep.txt', 'edit.txt', 'gone.txt', 'old-name.txt', 'sub/inner.txt']) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), `${name}\nsecond line\nthird line\n`);
  }
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);
  assert.deepEqual(await getWorkingTreeStatus(repo), { entries: [], folded: false, truncated: false });
  assert.deepEqual(await scanWorkingTree(repo).changeCount, { total: 0, atLeast: false });

  fs.appendFileSync(path.join(repo, 'edit.txt'), 'more\n');
  fs.rmSync(path.join(repo, 'gone.txt'));
  git(repo, ['mv', 'old-name.txt', 'new-name.txt']);
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
  git(repo, ['add', 'staged.txt']);
  fs.writeFileSync(path.join(repo, 'loose.txt'), 'loose\n');
  fs.mkdirSync(path.join(repo, 'newdir'));
  for (let index = 1; index <= 5; index += 1) fs.writeFileSync(path.join(repo, 'newdir', `f${index}.txt`), 'new\n');

  const lines = (status: Awaited<ReturnType<typeof getWorkingTreeStatus>>) =>
    status.entries.map((entry) => `${entry.index}${entry.worktree} ${entry.filePath}`).sort();
  // A new folder with five files lists five; a rename is one entry under its new name.
  const everyFile = await getWorkingTreeStatus(repo);
  assert.deepEqual(lines(everyFile), [
    ' D gone.txt',
    ' M edit.txt',
    '?? loose.txt',
    '?? newdir/f1.txt',
    '?? newdir/f2.txt',
    '?? newdir/f3.txt',
    '?? newdir/f4.txt',
    '?? newdir/f5.txt',
    'A  staged.txt',
    'R  new-name.txt',
  ]);
  assert.equal(everyFile.folded, false);
  assert.equal(everyFile.truncated, false);
  assert.equal(statusLines(repo, 'all').length, 10);
  assert.deepEqual(await scanWorkingTree(repo).changeCount, { total: 10, atLeast: false });

  // From a subfolder the count is still the repository's, as `git status` is,
  // while the untracked totals stay those of the subfolder.
  fs.writeFileSync(path.join(repo, 'sub', 'new.txt'), 'one\ntwo\n');
  const sub = path.join(repo, 'sub');
  assert.deepEqual(await scanWorkingTree(repo).changeCount, { total: 11, atLeast: false });
  assert.deepEqual(await scanWorkingTree(sub).changeCount, { total: 11, atLeast: false });
  assert.deepEqual(await scanWorkingTree(sub).untracked, { files: 1, insertions: 2, deletions: 0 });
  assert.deepEqual(await scanWorkingTree(repo).untracked, { files: 7, insertions: 8, deletions: 0 });
  assert.equal((await getWorkingTreeStatus(sub)).entries.length, 11);

  // At the bound nothing changes; past it git's default view takes over and
  // a wholly untracked folder is one entry.
  assert.equal((await getWorkingTreeStatus(repo, { maxUntracked: 7 })).folded, false);
  const byFolder = await getWorkingTreeStatus(repo, { maxUntracked: 6 });
  assert.equal(byFolder.folded, true);
  assert.deepEqual(lines(byFolder), [
    ' D gone.txt',
    ' M edit.txt',
    '?? loose.txt',
    '?? newdir/',
    '?? sub/new.txt',
    'A  staged.txt',
    'R  new-name.txt',
  ]);
  assert.equal(statusLines(repo, 'normal').length, 7);
  const cutShort = await getWorkingTreeStatus(repo, { maxEntries: 3 });
  assert.deepEqual([cutShort.entries.length, cutShort.truncated], [3, true]);

  // Untracked files that cannot be listed in time: the count falls back to
  // git's default view and says it is a lower bound, and so do the totals.
  const outOfTime = scanWorkingTree(repo, { listTimeoutMs: 0 });
  assert.deepEqual(await outOfTime.changeCount, { total: 7, atLeast: true });
  assert.equal((await outOfTime.untracked).incomplete, true);

  // "Commit all changes" stages with one `git add -A`, from wherever it is run.
  await stageAllChanges(sub);
  const staged = statusLines(repo, 'all');
  assert.equal(staged.length, 11, 'every entry is still there');
  assert.ok(staged.every((line) => /^[MADR]  /.test(line)), `everything is staged:\n${staged.join('\n')}`);
  await commitStagedChanges(repo, 'all of it');
  assert.equal(git(repo, ['log', '-1', '--format=%s']).trim(), 'all of it');
  assert.deepEqual(await getWorkingTreeStatus(repo), { entries: [], folded: false, truncated: false });
  // A refused commit says why, as git does.
  await assert.rejects(commitStagedChanges(repo, 'nothing left'), /nothing to commit/);
  fs.appendFileSync(path.join(repo, 'edit.txt'), 'unstaged\n');
  await assert.rejects(commitStagedChanges(repo, 'unstaged only'), /no changes added to commit/);
  git(repo, ['checkout', 'edit.txt']);

  // A submodule whose only change is an untracked file inside it is an entry
  // of `git status`, though no file of this repository is untracked.
  const library = path.join(root, 'status-library');
  initRepo(library);
  fs.writeFileSync(path.join(library, 'lib.txt'), 'lib\n');
  git(library, ['add', '.']);
  git(library, ['commit', '-m', 'library']);
  git(repo, ['-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', library, 'lib']);
  git(repo, ['commit', '-m', 'submodule']);
  fs.writeFileSync(path.join(repo, 'lib', 'untracked.txt'), 'new\n');
  assert.deepEqual(statusLines(repo, 'all'), [' M lib']);
  assert.deepEqual(await scanWorkingTree(repo).changeCount, { total: 1, atLeast: false });
  assert.deepEqual((await getWorkingTreeStatus(repo)).entries, [{ index: ' ', worktree: 'M', filePath: 'lib' }]);

  const notRepo = path.join(root, 'status-not-a-repo');
  fs.mkdirSync(notRepo);
  await assert.rejects(stageAllChanges(notRepo), /not a git repository/);
  await assert.rejects(getWorkingTreeStatus(notRepo));
  await assert.rejects(scanWorkingTree(notRepo).changeCount);
}

// A folder of dependencies nobody ignored: more untracked files than the
// scan, the patch or the status list take one by one. Everything still
// answers, says what it left out, and staging is one process. Timed against
// process starts on the same machine, as above: each step has to beat a tenth
// of the processes that one per file would start.
async function manyUntrackedFiles(root: string) {
  const repo = path.join(root, 'huge');
  initRepo(repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);
  fs.appendFileSync(path.join(repo, 'tracked.txt'), 'two\n');
  const fileCount = 12_000;
  for (let index = 0; index < fileCount; index += 1) {
    const folder = path.join(repo, 'vendor', `package-${index % 100}`);
    if (index < 100) fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `module-${index}.js`), 'first\nsecond\n');
  }

  let started = process.hrtime.bigint();
  for (let index = 0; index < fileCount / 40; index += 1) git(repo, ['--version']);
  const tenthOfTheProcesses = (Number(process.hrtime.bigint() - started) / 1e6) * 4;

  started = process.hrtime.bigint();
  const scan = scanWorkingTree(repo);
  assert.deepEqual(await scan.changeCount, { total: fileCount + 1, atLeast: false });
  // The first 10,000 files are counted, and the total says it is a lower bound.
  assert.deepEqual(await scan.untracked, { files: fileCount, insertions: 20_000, deletions: 0, incomplete: true });
  assert.deepEqual(await getUncommittedChangeStats(repo, scan.untracked), {
    files: fileCount + 1,
    insertions: 20_001,
    deletions: 0,
    incomplete: true,
  });
  const overview = Number(process.hrtime.bigint() - started) / 1e6;

  started = process.hrtime.bigint();
  const status = await getWorkingTreeStatus(repo);
  assert.deepEqual(status, {
    entries: [
      { index: ' ', worktree: 'M', filePath: 'tracked.txt' },
      { index: '?', worktree: '?', filePath: 'vendor/' },
    ],
    folded: true,
    truncated: false,
  });
  const listing = Number(process.hrtime.bigint() - started) / 1e6;

  started = process.hrtime.bigint();
  const patch = await getUntrackedPatch(repo);
  const patching = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(patch.incomplete, true);
  assert.equal(patchedFiles(patch.patch).length, 5000);

  started = process.hrtime.bigint();
  await stageAllChanges(repo);
  const staging = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(git(repo, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean).length, fileCount + 1);
  // The commit does not print a line per file: git's summary of 12,000 new files is not waited for.
  started = process.hrtime.bigint();
  assert.equal((await commitStagedChanges(repo, 'everything')).length < 1000, true);
  const committing = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(git(repo, ['log', '-1', '--format=%s']).trim(), 'everything');
  assert.deepEqual(await scanWorkingTree(repo).changeCount, { total: 0, atLeast: false });

  for (const [name, took] of [['overview totals', overview], ['status list', listing], ['patch', patching], ['staging', staging], ['commit', committing]] as const) {
    assert.ok(
      took < tenthOfTheProcesses,
      `${name} for ${fileCount} untracked files took ${took.toFixed(0)} ms; starting ${fileCount / 10} git processes takes ${tenthOfTheProcesses.toFixed(0)} ms`
    );
  }
  console.log(
    `git-branch-changes: ${fileCount} untracked files: totals ${overview.toFixed(0)} ms, status list ${listing.toFixed(0)} ms, patch ${patching.toFixed(0)} ms, git add -A ${staging.toFixed(0)} ms, commit ${committing.toFixed(0)} ms (${fileCount / 10} git starts: about ${tenthOfTheProcesses.toFixed(0)} ms)`
  );
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-branch-changes-'));
  try {
    await unbornHead(root);
    await untrackedScan(root);
    await scanStopsReading(root);
    await scanDoesNotWaitForStuckRead(root);
    await untrackedScanCost(root);
    await workingTreeStatus(root);
    await manyUntrackedFiles(root);

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

// A check that waits on something that never comes back leaves Node with
// nothing to do, and it would exit 0 without a word.
let finished = false;
process.on('exit', (code) => {
  if (finished || code !== 0) return;
  console.error('git-branch-changes: ended before the checks finished (a check is waiting on something that never returns)');
  process.exitCode = 1;
});

main()
  .then(() => {
    finished = true;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
