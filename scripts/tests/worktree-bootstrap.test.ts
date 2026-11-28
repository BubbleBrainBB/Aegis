// Verifies worktree environment bootstrapping (1:1 CoW cloning of ignored local
// files like node_modules/.env, .worktreeinclude overrides, hard safety
// exclusions, isolation from main repo, and clean git/hygiene integration).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrapWorktreeEnvironment,
  isHardExcludedPath,
  isSoftExcludedPath,
  normalizeRelativePath,
} from '../../src/electron/libs/worktree-bootstrap';
import { createWorktree, removeWorktree } from '../../src/electron/libs/git-service';
import { worktreeHoldsWork } from '../../src/electron/libs/worktree-work';

// macOS Unix sockets enforce a 104-byte sun_path limit; keep the temp root short.
const tempBase = process.platform === 'darwin' ? '/tmp' : tmpdir();
const temp = realpathSync(mkdtempSync(join(tempBase, 'aegis-wtb-')));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    stdio: 'pipe',
  })
    .toString()
    .trim();

function writeFixtureFile(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

async function testPureHelpers(): Promise<void> {
  assert.equal(normalizeRelativePath('node_modules/'), 'node_modules');
  assert.equal(normalizeRelativePath('apps\\ios\\Config\\Local.xcconfig'), 'apps/ios/Config/Local.xcconfig');
  assert.equal(normalizeRelativePath(''), null);
  assert.equal(normalizeRelativePath('/etc/passwd'), null);
  assert.equal(normalizeRelativePath('../outside'), null);
  assert.equal(normalizeRelativePath('a/../../b'), null);

  assert.equal(isHardExcludedPath('.git'), true);
  assert.equal(isHardExcludedPath('.git/config'), true);
  assert.equal(isHardExcludedPath('.worktrees'), true);
  assert.equal(isHardExcludedPath('.worktrees/iso-1'), true);
  assert.equal(isHardExcludedPath('.claude/worktrees'), true);
  assert.equal(isHardExcludedPath('.claude/worktrees/foo'), true);
  assert.equal(isHardExcludedPath('.DS_Store'), true);
  assert.equal(isHardExcludedPath('nested/.DS_Store'), true);
  assert.equal(isHardExcludedPath('custom/wt', new Set(['custom/wt'])), true);
  assert.equal(isHardExcludedPath('.claude/settings.local.json'), false);
  assert.equal(isHardExcludedPath('node_modules'), false);

  assert.equal(isSoftExcludedPath('release'), false, 'no repo-specific folder names');
  assert.equal(isSoftExcludedPath('.aegis-design-qa'), false, 'no repo-specific folder names');
  assert.equal(isSoftExcludedPath('release/Aegis.dmg'), true);
  assert.equal(isSoftExcludedPath('app.dmg'), true);
  assert.equal(isSoftExcludedPath('debug.log'), true);
  assert.equal(isSoftExcludedPath('npm-debug.log.1'), true);
  assert.equal(isSoftExcludedPath('node_modules'), false);
  assert.equal(isSoftExcludedPath('.env.local'), false);
}

async function testFullWorktreeBootstrapFlow(): Promise<void> {
  const repo = join(temp, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);

  // 1. Tracked repo files + .gitignore
  writeFixtureFile(
    repo,
    '.gitignore',
    [
      'node_modules/',
      '.env',
      '.env.local',
      'dist-electron/',
      'apps/ios/Config/Local.xcconfig',
      '.claude/',
      'release/',
      '*.log',
      '.DS_Store',
      '中文缓存/',
      'top.sock',
      'socket-dir/',
      'custom-wt/',
      '*.bin',
    ].join('\n') + '\n'
  );
  writeFixtureFile(repo, 'package.json', '{"name":"demo"}\n');
  writeFixtureFile(repo, 'apps/ios/Config/Base.xcconfig', 'BASE = 1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial commit');

  // 2. Populate local gitignored environment
  writeFixtureFile(repo, '.env', 'API_KEY=secret-from-main\n');
  writeFixtureFile(repo, '.env.local', 'PORT=3000\n');
  writeFixtureFile(repo, 'apps/ios/Config/Local.xcconfig', 'DEVELOPMENT_TEAM = TEAM123\n');
  writeFixtureFile(repo, 'dist-electron/main.js', 'console.log("built");\n');
  writeFixtureFile(repo, '中文缓存/数据.txt', 'utf8-ok\n');
  writeFixtureFile(repo, 'node_modules/demo-pkg/index.js', 'module.exports = 42;\n');
  writeFixtureFile(repo, 'node_modules/demo-pkg/cli.js', '#!/usr/bin/env node\n');
  chmodSync(join(repo, 'node_modules/demo-pkg/cli.js'), 0o755);
  mkdirSync(join(repo, 'node_modules/.bin'), { recursive: true });
  if (process.platform !== 'win32') {
    symlinkSync('../demo-pkg/cli.js', join(repo, 'node_modules/.bin/demo-cli'));
    symlinkSync('../missing/target.js', join(repo, 'node_modules/.bin/broken-cli'));
  }

  // Ancestor directory containing both a safe ignored file and a hard-excluded worktrees subdir
  writeFixtureFile(repo, '.claude/settings.local.json', '{"allowed":true}\n');
  writeFixtureFile(repo, '.claude/worktrees/nested-wt/should-not-copy.txt', 'nope\n');

  // Soft-excluded files (release/, *.log, .DS_Store)
  writeFixtureFile(repo, 'release/installer.dmg', 'big-dmg\n');
  writeFixtureFile(repo, 'release/nested/.git/config', 'fixture');
  writeFixtureFile(repo, 'release/nested/output.log', 'fixture');
  writeFixtureFile(repo, 'release/nested/keep.log', 'include');
  writeFixtureFile(repo, 'release/manifest.json', '{"version":"1.0"}\n');
  writeFixtureFile(repo, 'dev.log', 'log-noise\n');
  writeFixtureFile(repo, '.DS_Store', 'finder-junk\n');

  // Ignored file above the plain-copy size limit
  writeFileSync(join(repo, 'big.bin'), Buffer.alloc(11 * 1024 * 1024, 1));

  // Untracked but NOT ignored work that matches .worktreeinclude must never be copied
  writeFixtureFile(repo, 'notes/todo.md', 'unfinished work\n');

  // Explicit .worktreeinclude overriding a soft-excluded file (release/manifest.json)
  // and trying to include hard-excluded paths (which MUST still be blocked).
  writeFixtureFile(
    repo,
    '.worktreeinclude',
    [
      '# Keep only the manifest from release/',
      'release/manifest.json',
      'release/nested/keep.log',
      '中文缓存/',
      'notes/',
      '.git/HEAD',
      '.worktrees/',
    ].join('\n') + '\n'
  );

  // Pre-existing linked worktree inside repo (must NEVER be copied recursively)
  const existingWtPath = join(repo, 'custom-wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'existing-branch', existingWtPath);
  writeFixtureFile(existingWtPath, 'secret-in-other-wt.txt', 'other\n');

  // Pre-existing `.worktrees/` entry
  writeFixtureFile(repo, '.worktrees/old-wt/stale.txt', 'stale\n');

  // Real Unix domain sockets (top-level + nested inside an ignored directory) must not crash bootstrap
  const socketDir = join(repo, 'socket-dir');
  mkdirSync(socketDir, { recursive: true });
  writeFixtureFile(repo, 'socket-dir/good.txt', 'still-copied\n');
  const sockPath = join(socketDir, 'agent.sock');
  const topSockPath = join(repo, 'top.sock');
  const sockServer = process.platform !== 'win32' ? createServer() : null;
  const topSockServer = process.platform !== 'win32' ? createServer() : null;
  if (sockServer && topSockServer) {
    await new Promise<void>((resolveListen, rejectListen) => {
      sockServer.once('error', rejectListen);
      sockServer.listen(sockPath, () => resolveListen());
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      topSockServer.once('error', rejectListen);
      topSockServer.listen(topSockPath, () => resolveListen());
    });
  }

  try {
    // Opt-out `bootstrap: false` leaves worktree bare
    const bare = await createWorktree({
      cwd: repo,
      branch: 'main',
      newBranch: 'feature/bare-test',
      bootstrap: false,
    });
    assert.equal(existsSync(join(bare.path, '.env')), false, 'bootstrap: false skips cloning');
    assert.equal(existsSync(join(bare.path, 'node_modules')), false, 'bootstrap: false skips node_modules');

    // Re-running bootstrap explicitly on a bare worktree never overwrites tracked files
    writeFileSync(join(bare.path, 'package.json'), '{"name":"worktree-edit"}\n', 'utf8');
    const explicitRun = await bootstrapWorktreeEnvironment({
      sourceRoot: repo,
      worktreePath: bare.path,
    });
    assert.equal(explicitRun.failed.length, 0);
    assert.equal(readFileSync(join(bare.path, 'package.json'), 'utf8'), '{"name":"worktree-edit"}\n');
    assert.equal(readFileSync(join(bare.path, '.env'), 'utf8'), 'API_KEY=secret-from-main\n');
    await removeWorktree({ cwd: repo, path: bare.path, force: true });

    // 3. Create worktree via createWorktree() — bootstrap runs automatically by default!
    const created = await createWorktree({
      cwd: repo,
      branch: 'main',
      newBranch: 'feature/bootstrap-test',
    });
    const wt = created.path;

    // Local ignored environment files are 1:1 present immediately
    assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'API_KEY=secret-from-main\n');
    assert.equal(readFileSync(join(wt, '.env.local'), 'utf8'), 'PORT=3000\n');
    assert.equal(readFileSync(join(wt, 'apps/ios/Config/Local.xcconfig'), 'utf8'), 'DEVELOPMENT_TEAM = TEAM123\n');
    assert.equal(readFileSync(join(wt, 'apps/ios/Config/Base.xcconfig'), 'utf8'), 'BASE = 1\n');
    assert.equal(readFileSync(join(wt, '中文缓存/数据.txt'), 'utf8'), 'utf8-ok\n');
    if (explicitRun.copyOnWrite) {
      assert.equal(readFileSync(join(wt, 'dist-electron/main.js'), 'utf8'), 'console.log("built");\n');
      assert.equal(readFileSync(join(wt, 'node_modules/demo-pkg/index.js'), 'utf8'), 'module.exports = 42;\n');
      assert.equal(readFileSync(join(wt, '.claude/settings.local.json'), 'utf8'), '{"allowed":true}\n');
      assert.equal(readFileSync(join(wt, 'socket-dir/good.txt'), 'utf8'), 'still-copied\n');
      if (process.platform !== 'win32') {
        assert.equal(readlinkSync(join(wt, 'node_modules/.bin/demo-cli')), '../demo-pkg/cli.js');
        assert.equal(readlinkSync(join(wt, 'node_modules/.bin/broken-cli')), '../missing/target.js');
        assert.equal(lstatSync(join(wt, 'node_modules/demo-pkg/cli.js')).mode & 0o111, 0o111);
      }
    } else {
      assert.equal(existsSync(join(wt, 'dist-electron')), false);
      assert.equal(existsSync(join(wt, 'node_modules')), false);
    }
    assert.equal(existsSync(join(wt, '.claude/worktrees')), false);
    assert.equal(existsSync(join(wt, 'release/nested/.git')), false);
    assert.equal(existsSync(join(wt, 'release/nested/output.log')), false);
    assert.equal(existsSync(join(wt, 'release/installer.dmg')), false);
    assert.equal(readFileSync(join(wt, 'release/nested/keep.log'), 'utf8'), 'include');

    // Hard exclusions never copied
    assert.equal(existsSync(join(wt, '.worktrees')), false, '.worktrees must never be copied');
    assert.equal(existsSync(join(wt, 'custom-wt')), false, 'existing linked worktree must never be copied');
    assert.equal(existsSync(join(wt, '.DS_Store')), false, '.DS_Store must never be copied');
    assert.equal(lstatSync(join(wt, '.git')).isFile(), true, 'worktree .git file must remain intact');

    // Soft exclusions skipped by default, EXCEPT what .worktreeinclude explicitly requested
    assert.equal(existsSync(join(wt, 'dev.log')), false, '*.log skipped by default');
    assert.equal(
      readFileSync(join(wt, 'release/manifest.json'), 'utf8'),
      '{"version":"1.0"}\n',
      '.worktreeinclude overrides soft exclusion'
    );
    assert.equal(existsSync(join(wt, 'notes')), false, '.worktreeinclude never copies untracked, non-ignored work');

    // Top-level Unix socket is skipped, and nested socket inside an ignored dir does not break bootstrap
    assert.equal(existsSync(join(wt, 'top.sock')), false, 'top-level Unix socket must be skipped');
    assert.equal(existsSync(join(wt, 'socket-dir/agent.sock')), false);

    // True isolation on macOS: mutating .env and node_modules in the worktree does NOT touch main repo!
    writeFileSync(join(wt, '.env'), 'API_KEY=mutated-in-worktree\n', 'utf8');
    assert.equal(
      readFileSync(join(repo, '.env'), 'utf8'),
      'API_KEY=secret-from-main\n',
      'mutating worktree .env must not affect main repo'
    );
    if (explicitRun.copyOnWrite) {
      writeFileSync(join(wt, 'node_modules/demo-pkg/index.js'), 'module.exports = 999;\n', 'utf8');
      assert.equal(
        readFileSync(join(repo, 'node_modules/demo-pkg/index.js'), 'utf8'),
        'module.exports = 42;\n',
        'APFS clone node_modules must be copy-on-write isolated from main repo'
      );
    }

    // Git status & worktree-work hygiene remain 100% clean after bootstrap
    assert.equal(git(wt, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    assert.equal(await worktreeHoldsWork(wt, repo), false, 'bootstrapped worktree still reports no uncommitted work');

    // Non-forced git worktree remove still succeeds cleanly
    await removeWorktree({ cwd: repo, path: wt });
    assert.equal(existsSync(wt), false);

    // 5. Without copy-on-write (ext4, NTFS, another volume): no links back to the
    // main repo, no directory copies, only small files and .worktreeinclude.
    const plain = await createWorktree({
      cwd: repo,
      branch: 'main',
      newBranch: 'feature/no-cow',
      bootstrap: false,
    });
    const plainRun = await bootstrapWorktreeEnvironment({
      sourceRoot: repo,
      worktreePath: plain.path,
      copyOnWrite: false,
    });
    assert.equal(plainRun.copyOnWrite, false);
    assert.deepEqual(plainRun.failed, []);
    assert.equal(readFileSync(join(plain.path, '.env'), 'utf8'), 'API_KEY=secret-from-main\n');
    assert.equal(readFileSync(join(plain.path, '.env.local'), 'utf8'), 'PORT=3000\n');
    assert.equal(readFileSync(join(plain.path, 'apps/ios/Config/Local.xcconfig'), 'utf8'), 'DEVELOPMENT_TEAM = TEAM123\n');
    assert.equal(lstatSync(join(plain.path, 'node_modules'), { throwIfNoEntry: false }), undefined, 'node_modules neither copied nor linked');
    assert.equal(existsSync(join(plain.path, 'dist-electron')), false, 'ignored directories need copy-on-write');
    assert.equal(existsSync(join(plain.path, 'big.bin')), false, 'large ignored files need copy-on-write');
    assert.equal(readFileSync(join(plain.path, 'release/manifest.json'), 'utf8'), '{"version":"1.0"}\n');
    assert.equal(existsSync(join(plain.path, 'release/installer.dmg')), false);
    assert.equal(readFileSync(join(plain.path, '中文缓存/数据.txt'), 'utf8'), 'utf8-ok\n', '.worktreeinclude directories are copied');
    assert.equal(existsSync(join(plain.path, 'notes')), false);
    assert.equal(git(plain.path, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    assert.equal(await worktreeHoldsWork(plain.path, repo), false);
    await removeWorktree({ cwd: repo, path: plain.path });
    assert.equal(existsSync(plain.path), false, 'non-forced remove works without copy-on-write');
  } finally {
    if (sockServer) {
      await new Promise<void>((resolveClose) => sockServer.close(() => resolveClose()));
    }
    if (topSockServer) {
      await new Promise<void>((resolveClose) => topSockServer.close(() => resolveClose()));
    }
  }
}

async function testIsolatedDependencyLinks(): Promise<void> {
  if (process.platform === 'win32') return;
  const repo = join(temp, 'link-source');
  git(temp, 'init', '-q', '-b', 'main', repo);
  writeFixtureFile(repo, '.gitignore', '*.link\nlinks/\nlocal-package/\n');
  writeFixtureFile(repo, '.worktreeinclude', 'links/\nlocal-package/\n');
  writeFixtureFile(repo, 'packages/demo/index.js', 'source');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'local dependency');

  const sourcePackage = join(repo, 'packages/demo');
  symlinkSync(sourcePackage, join(repo, 'package.link'));
  mkdirSync(join(repo, 'links'));
  const alias = join(temp, 'package-alias');
  symlinkSync(sourcePackage, alias);
  symlinkSync(alias, join(repo, 'links/indirect'));
  symlinkSync(sourcePackage, join(repo, 'links/absolute'));
  symlinkSync('../../link-source/packages/demo', join(repo, 'links/relative'));
  symlinkSync('missing.js', join(repo, 'links/dangling'));
  symlinkSync(join(repo, '.git'), join(repo, 'links/metadata'));
  const external = join(temp, 'shared-package');
  mkdirSync(external);
  symlinkSync(external, join(repo, 'links/external'));
  mkdirSync(join(repo, 'local-package'));
  writeFixtureFile(repo, 'local-package/index.js', 'ignored dependency');
  symlinkSync(join(repo, 'local-package'), join(repo, 'ignored.link'));

  for (const mode of ['automatic', 'plain']) {
    const worktree = await createWorktree({
      cwd: repo, branch: 'main', newBranch: 'link-' + mode, bootstrap: mode === 'automatic',
    });
    if (mode === 'plain') {
      const result = await bootstrapWorktreeEnvironment({ sourceRoot: repo, worktreePath: worktree.path, copyOnWrite: false });
      assert.deepEqual(result.failed, []);
    }
    for (const name of ['package.link', 'links/absolute', 'links/relative', 'links/indirect']) {
      const link = join(worktree.path, name);
      assert.equal(realpathSync(link), realpathSync(join(worktree.path, 'packages/demo')), name);
      writeFileSync(join(link, 'index.js'), mode + name);
      assert.equal(readFileSync(join(sourcePackage, 'index.js'), 'utf8'), 'source');
    }
    assert.equal(realpathSync(join(worktree.path, 'ignored.link')), realpathSync(join(worktree.path, 'local-package')));
    assert.equal(readlinkSync(join(worktree.path, 'links/dangling')), 'missing.js');
    assert.equal(readlinkSync(join(worktree.path, 'links/external')), external);
    assert.equal(lstatSync(join(worktree.path, 'links/metadata'), { throwIfNoEntry: false }), undefined);
  }
}

async function testLinksAcrossCheckouts(): Promise<void> {
  if (process.platform === 'win32') return;
  const main = join(temp, 'versions');
  git(temp, 'init', '-q', '-b', 'main', main);
  writeFixtureFile(main, '.gitignore', '*.link\nlinks/\n.worktrees/\n');
  writeFixtureFile(main, '.worktreeinclude', 'links/\n');
  for (const version of ['v1', 'v2']) writeFixtureFile(main, 'packages/' + version + '/version', version);
  const current = join(main, 'packages/current');
  const optional = join(main, 'packages/optional');
  const external = join(temp, 'external-version');
  mkdirSync(external);
  symlinkSync(external, optional);
  symlinkSync('v2', current);
  symlinkSync('links/generated', join(main, 'generated'));
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'select v2');
  git(main, 'branch', 'target');
  unlinkSync(current);
  symlinkSync('v1', current);
  unlinkSync(optional);
  symlinkSync('v1', optional);
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'select v1');

  const source = join(main, '.worktrees/source');
  const sibling = join(temp, 'versions-sibling');
  git(main, 'worktree', 'add', '-qb', 'source', source);
  git(main, 'worktree', 'add', '-qb', 'sibling', sibling);
  mkdirSync(join(source, 'links'));
  symlinkSync('packages/current', join(source, 'local.link'));
  symlinkSync(current, join(source, 'main.link'));
  writeFixtureFile(main, 'same.link', 'ignored local settings');
  symlinkSync(join(main, 'same.link'), join(source, 'same.link'));
  symlinkSync(join(sibling, 'packages/current/version'), join(source, 'links/sibling-version'));
  symlinkSync(current, join(temp, 'version-alias'));
  symlinkSync(join(temp, 'version-alias/version'), join(source, 'links/indirect-version'));
  const alternateSpelling = join(temp, 'VERSIONS/packages/current/version');
  const caseAlias = existsSync(alternateSpelling);
  if (caseAlias) symlinkSync(alternateSpelling, join(source, 'links/case-version'));
  symlinkSync('packages/optional/version', join(source, 'optional.link'));
  writeFixtureFile(source, 'links/generated/version', 'generated');
  symlinkSync('../generated/version', join(source, 'links/generated-version'));
  for (const [from, to] of [['a', 'b'], ['b', 'a']]) {
    writeFixtureFile(main, 'links/' + to, 'main only');
    symlinkSync(join(main, 'links', to), join(source, 'links', from));
  }

  for (const mode of ['automatic', 'plain']) {
    const { path } = await createWorktree({
      cwd: source, branch: 'target', newBranch: 'versions-' + mode, bootstrap: mode === 'automatic',
    });
    if (mode === 'plain') {
      const result = await bootstrapWorktreeEnvironment({ sourceRoot: source, worktreePath: path, copyOnWrite: false });
      assert.deepEqual(result.failed, []);
    }
    const targetFile = join(path, 'packages/v2/version');
    assert.equal(readlinkSync(join(path, 'local.link')), join('packages', 'current'));
    assert.equal(lstatSync(join(path, 'same.link'), { throwIfNoEntry: false }), undefined);
    assert.equal(lstatSync(join(path, 'optional.link'), { throwIfNoEntry: false }), undefined);
    assert.equal(readFileSync(join(path, 'links/generated-version'), 'utf8'), 'generated');
    for (const name of ['links/a', 'links/b']) {
      assert.equal(lstatSync(join(path, name), { throwIfNoEntry: false }), undefined);
    }
    const versionLinks = ['main.link/version', 'local.link/version', 'links/sibling-version', 'links/indirect-version'];
    if (caseAlias) versionLinks.push('links/case-version');
    for (const name of versionLinks) {
      assert.equal(realpathSync(join(path, name)), realpathSync(targetFile), name);
      assert.equal(readFileSync(join(path, name), 'utf8'), 'v2');
      writeFileSync(join(path, name), 'edited');
      assert.equal(readFileSync(targetFile, 'utf8'), 'edited');
      writeFileSync(targetFile, 'v2');
    }
    for (const checkout of [main, source, sibling]) {
      assert.equal(readFileSync(join(checkout, 'packages/current/version'), 'utf8'), 'v1');
      assert.equal(readFileSync(join(checkout, 'packages/v2/version'), 'utf8'), 'v2');
    }
  }
}

async function testTargetCheckoutRules(): Promise<void> {
  const repo = join(temp, 'branches');
  git(temp, 'init', '-q', '-b', 'main', repo);
  writeFixtureFile(repo, '.gitignore', 'shared.local\ncache/*\n!cache/keep.txt\nalias/*.local\n');
  writeFixtureFile(repo, 'config/tracked.txt', 'tracked');
  if (process.platform !== 'win32') symlinkSync('config', join(repo, 'alias'));
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'target rules');
  git(repo, 'branch', 'target');

  if (process.platform !== 'win32') unlinkSync(join(repo, 'alias'));
  writeFixtureFile(repo, '.gitignore', '.env\nshared.local\ncache/\nalias/*.local\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'source rules');
  writeFixtureFile(repo, '.env', 'fixture');
  writeFixtureFile(repo, 'shared.local', 'shared');
  writeFixtureFile(repo, 'cache/keep.txt', 'visible in target');
  writeFixtureFile(repo, 'cache/data', 'ignored in both');
  writeFixtureFile(repo, 'alias/settings.local', 'local');
  writeFixtureFile(repo, '.worktreeinclude', '.env\ncache/\n');
  const target = await createWorktree({ cwd: repo, branch: 'target' });
  assert.equal(existsSync(join(target.path, '.env')), false);
  assert.equal(existsSync(join(target.path, 'cache/keep.txt')), false);
  assert.equal(readFileSync(join(target.path, 'cache/data'), 'utf8'), 'ignored in both');
  assert.equal(readFileSync(join(target.path, 'shared.local'), 'utf8'), 'shared');
  if (process.platform !== 'win32') {
    assert.equal(readlinkSync(join(target.path, 'alias')), 'config');
    assert.equal(existsSync(join(target.path, 'config/settings.local')), false);
  }
  assert.equal(git(target.path, 'status', '--porcelain', '--untracked-files=all'), '');
}

async function testImportedIgnoreRules(): Promise<void> {
  const repo = join(temp, 'import-rules');
  git(temp, 'init', '-q', '-b', 'main', repo);
  const folders = ['out', 'loose', 'self', 'occupied', 'existing', 'nested', 'visible'];
  writeFixtureFile(repo, '.gitignore', folders.map(dir => dir + '/*').join('\n') + '\n!nested/inner/\nnested/inner/*\n!visible/draft.txt\n');
  writeFixtureFile(repo, '.worktreeinclude', folders.map(dir => dir + '/').join('\n'));
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'target ignore policy');
  git(repo, 'branch', 'target');
  writeFixtureFile(repo, '.gitignore', folders.map(dir => dir + '/').join('\n'));
  // A tracked sibling forces ls-files to return individual loose candidates.
  for (const name of ['loose/tracked', 'nested/inner/tracked']) writeFixtureFile(repo, name, 'tracked');
  git(repo, 'add', '.gitignore');
  git(repo, 'add', '-f', 'loose/tracked', 'nested/inner/tracked');
  git(repo, 'commit', '-qm', 'source ignore policy');
  for (const dir of folders) {
    const rules = { self: '!.gitignore\n', visible: 'draft.txt\n' };
    writeFixtureFile(repo, dir + '/.gitignore', rules[dir as keyof typeof rules] ?? '!report.txt\n');
    writeFixtureFile(repo, dir + '/report.txt', 'private report');
    writeFixtureFile(repo, dir + '/local', 'safe to copy');
  }
  writeFixtureFile(repo, 'nested/inner/.gitignore', '!child.txt\n');
  writeFixtureFile(repo, 'nested/inner/child.txt', 'private child');
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), '');

  for (const mode of ['auto', 'plain']) {
    const { path } = await createWorktree({ cwd: repo, branch: 'target', newBranch: 'rules-' + mode, bootstrap: false });
    writeFixtureFile(path, 'occupied/report.txt', 'already here');
    writeFixtureFile(path, 'existing/.gitignore', '!local\n');
    writeFixtureFile(path, 'visible/draft.txt', 'ongoing work');
    const originalStatus = git(path, 'status', '--porcelain', '--untracked-files=all');
    assert.equal(originalStatus, '?? visible/draft.txt');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await bootstrapWorktreeEnvironment({ sourceRoot: repo, worktreePath: path, copyOnWrite: mode === 'plain' ? false : undefined });
      assert.deepEqual(result.failed, []);
      for (const dir of ['out', 'loose', 'nested']) {
        assert.equal(readFileSync(join(path, dir, '.gitignore'), 'utf8'), '!report.txt\n');
        assert.equal(existsSync(join(path, dir, 'report.txt')), false, dir);
        assert.equal(readFileSync(join(path, dir, 'local'), 'utf8'), 'safe to copy');
      }
      assert.equal(readFileSync(join(path, 'nested/inner/.gitignore'), 'utf8'), '!child.txt\n');
      assert.equal(existsSync(join(path, 'nested/inner/child.txt')), false);
      assert.equal(existsSync(join(path, 'self/.gitignore')), false);
      assert.equal(existsSync(join(path, 'occupied/.gitignore')), false);
      assert.equal(readFileSync(join(path, 'occupied/report.txt'), 'utf8'), 'already here');
      assert.equal(readFileSync(join(path, 'existing/.gitignore'), 'utf8'), '!local\n');
      assert.equal(existsSync(join(path, 'existing/local')), false);
      assert.equal(existsSync(join(path, 'visible/.gitignore')), false);
      assert.equal(git(path, 'status', '--porcelain', '--untracked-files=all'), originalStatus);
    }
  }
}

async function testTargetIndex(): Promise<void> {
  const repo = join(temp, 'target-index');
  git(temp, 'init', '-q', '-b', 'main', repo);
  writeFixtureFile(repo, '.gitignore', 'vendor/\ncache/\n*.local\n');
  writeFixtureFile(repo, '.worktreeinclude', 'vendor/\ncache/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'shared rules');
  const { path } = await createWorktree({ cwd: repo, branch: 'main', newBranch: 'index-target', bootstrap: false });
  git(path, 'update-index', '--add', '--cacheinfo', '160000,' + git(repo, 'rev-parse', 'HEAD') + ',vendor/pkg');
  writeFixtureFile(path, 'cache/tracked', 'tracked');
  git(path, 'add', '-f', 'cache/tracked');
  git(path, 'commit', '-qm', 'target index');
  unlinkSync(join(path, 'cache/tracked'));
  writeFixtureFile(repo, 'vendor/pkg/config.local', 'source only');
  writeFixtureFile(repo, 'cache/tracked', 'source only');
  writeFixtureFile(repo, 'independent.local', 'copied');
  const status = git(path, 'status', '--porcelain', '--untracked-files=all');
  const result = await bootstrapWorktreeEnvironment({ sourceRoot: repo, worktreePath: path });
  assert.deepEqual(result.failed, []);
  assert.equal(existsSync(join(path, 'vendor/pkg/config.local')), false);
  assert.equal(existsSync(join(path, 'cache/tracked')), false);
  assert.equal(readFileSync(join(path, 'independent.local'), 'utf8'), 'copied');
  assert.equal(git(path, 'status', '--porcelain', '--untracked-files=all'), status);
}

(async () => {
  try {
    await testPureHelpers();
    await testFullWorktreeBootstrapFlow();
    await testIsolatedDependencyLinks();
    await testLinksAcrossCheckouts();
    await testTargetCheckoutRules();
    await testImportedIgnoreRules();
    await testTargetIndex();
    console.log('worktree-bootstrap tests passed');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
