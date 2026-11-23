import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyUserDataOverride, resolveUserDataOverride } from '../../src/electron/libs/user-data-override';

// AEGIS_USER_DATA_DIR: the folder it names becomes the profile, or the launch
// ends. It never goes on with the default profile, which is the user's real
// data. The app is replaced here by a host that records what it was told.

const root = mkdtempSync(path.join(tmpdir(), 'aegis-user-data-override-'));
const restore: string[] = [];

function launch(value: string | undefined, cwd?: string) {
  const told = { profile: null as string | null, quit: null as number | null, said: [] as string[], errors: [] as string[] };
  const handled = applyUserDataOverride(
    value,
    {
      setUserData: (dir) => { told.profile = dir; },
      quit: (code) => { told.quit = code; },
      log: (message) => told.said.push(message),
      error: (message) => told.errors.push(message),
    },
    cwd
  );
  return { handled, ...told };
}

/** The launch ended, and no profile was chosen for it. */
function assertRefused(run: ReturnType<typeof launch>, label: string) {
  assert.equal(run.quit, 1, `${label}: the launch ends with a failure code`);
  assert.equal(run.profile, null, `${label}: no profile is set`);
  assert.equal(run.handled, true, `${label}: the caller does not go on to the default profile`);
  assert.equal(run.errors.length, 1, label);
  assert.match(run.errors[0], /AEGIS_USER_DATA_DIR cannot be used/, label);
  assert.match(run.errors[0], /Quitting instead of opening the default profile/, label);
}

try {
  // ── Not set: the caller picks the default profile, as before ──────────────
  for (const value of [undefined, '', '   ']) {
    const run = launch(value);
    assert.deepEqual([run.handled, run.profile, run.quit], [false, null, null]);
    assert.deepEqual(resolveUserDataOverride(value), { kind: 'none' });
  }

  // ── A folder that can be used ────────────────────────────────────────────
  const fresh = path.join(root, 'not', 'there', 'yet');
  let run = launch(fresh);
  assert.deepEqual([run.handled, run.profile, run.quit], [true, fresh, null]);
  assert.ok(statSync(fresh).isDirectory(), 'the folder is created, parents included');
  assert.deepEqual(run.said, [`[main] userData overridden via AEGIS_USER_DATA_DIR: ${fresh}`]);
  // One that exists already, with spaces around the value.
  run = launch(`  ${fresh}  `);
  assert.equal(run.profile, fresh);
  // A relative path is taken from the working directory.
  const cwd = path.join(root, 'cwd');
  mkdirSync(cwd);
  run = launch(path.join('profiles', 'one'), cwd);
  assert.equal(run.profile, path.join(cwd, 'profiles', 'one'));
  assert.ok(existsSync(path.join(cwd, 'profiles', 'one')));

  // ── A folder that cannot be used ends the launch ──────────────────────────
  const file = path.join(root, 'a-file');
  writeFileSync(file, 'not a folder');
  assertRefused(launch(file), 'the path is a file');
  assertRefused(launch(path.join(file, 'below')), 'the path is below a file');
  assert.equal(resolveUserDataOverride(path.join(file, 'below')).kind, 'unusable');
  // What happened on 2026-11-23: a relative path, from a working directory
  // where it cannot be created (`/` under `open`).
  const blocked = path.join(root, 'blocked-cwd');
  writeFileSync(blocked, '');
  assertRefused(launch(path.join('profiles', 'after-empty'), blocked), 'a relative path that cannot be created');

  // Permissions do not stop an administrator, and Windows has no such modes.
  const permissionsApply = process.platform !== 'win32' && process.getuid?.() !== 0;
  if (permissionsApply) {
    const readOnlyParent = path.join(root, 'read-only-parent');
    mkdirSync(readOnlyParent);
    chmodSync(readOnlyParent, 0o555);
    restore.push(readOnlyParent);
    assertRefused(launch(path.join(readOnlyParent, 'profile')), 'the folder cannot be created');
    assert.deepEqual(readdirSync(readOnlyParent), []);

    const readOnly = path.join(root, 'read-only-profile');
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o555);
    restore.push(readOnly);
    assertRefused(launch(readOnly), 'the folder exists but cannot be written');
  }

  // The message names the folder that was tried, resolved.
  run = launch(path.join('profiles', 'x'), blocked);
  assert.ok(run.errors[0].includes(path.join(blocked, 'profiles', 'x')));

  process.stdout.write(`user-data-override: all checks passed${permissionsApply ? '' : ' (permission cases skipped)'}\n`);
} finally {
  for (const dir of restore) {
    try { chmodSync(dir, 0o755); } catch { /* gone */ }
  }
  rmSync(root, { recursive: true, force: true });
}
