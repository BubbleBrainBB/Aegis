import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TerminalEvent } from '../../src/shared/terminal';

// TerminalManager with real shells (no Electron): a shell is reattached, not
// restarted, when it is opened again, also from another folder; and a deleted
// session takes its shells, what runs in them, and their history with it.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aegis-terminal-manager-')));
const historyDir = path.join(root, 'history');
const cwdA = path.join(root, 'a');
const cwdB = path.join(root, 'b');
for (const dir of [historyDir, cwdA, cwdB]) mkdirSync(dir);
process.env.AEGIS_TERMINAL_HISTORY_DIR = historyDir;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** The shell's `sleep` children; its startup files may run other short-lived ones. */
const sleepersOf = (pid: number): number[] => {
  try {
    return execFileSync('pgrep', ['-P', String(pid), '-x', 'sleep']).toString().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
};
async function until(check: () => boolean, label: string, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await delay(100);
  }
  throw new Error(`timed out: ${label}`);
}
const historyFiles = () => readdirSync(historyDir).filter((file) => file.endsWith('.log'));

async function main() {
  if (process.platform === 'win32') {
    console.log('terminal-manager.test.ts skipped on Windows');
    return;
  }
  const { TerminalManager } = await import('../../src/electron/libs/terminal-manager');
  const events: TerminalEvent[] = [];
  const manager = new TerminalManager((event) => events.push(event));
  const started = () => events.filter((event) => event.type === 'started').length;
  const output = (scope: string) =>
    events.filter((event) => event.type === 'output' && event.threadId === scope).map((event) => (event as { data: string }).data).join('');
  const open = async (threadId: string, terminalId: string, cwd: string) => {
    const result = await manager.open({ threadId, terminalId, cwd, cols: 80, rows: 24, agentKind: 'shell' });
    assert.ok(result.ok, result.ok ? '' : result.message);
    return result.snapshot;
  };

  try {
    // A shell with something long-lived running in it.
    const scope = 'session-1:right-terminal';
    const first = await open(scope, 'tab-1', cwdA);
    const shellPid = first.pid!;
    assert.equal(first.cwd, cwdA);
    manager.write({ threadId: scope, terminalId: 'tab-1', data: 'sleep 300\r' });
    await until(() => sleepersOf(shellPid).length > 0, 'the shell runs the long-lived command');
    const childPid = sleepersOf(shellPid)[0];

    // Opening it again (the panel came back) is the same shell, even when the
    // session has moved to another folder in the meantime.
    const again = await open(scope, 'tab-1', cwdA);
    assert.equal(again.pid, shellPid);
    const moved = await open(scope, 'tab-1', cwdB);
    assert.equal(moved.pid, shellPid, 'another folder does not restart the shell');
    assert.equal(moved.cwd, cwdA, 'the shell stays in the folder it was started in');
    assert.ok(alive(childPid), 'what runs in the shell is untouched');
    assert.equal(started(), 1, 'one shell was started');
    assert.ok(moved.history.includes('sleep 300'), 'the reattached snapshot carries the screen so far');
    assert.ok(manager.getSnapshot({ threadId: scope, terminalId: 'tab-1' })?.status === 'running');

    // A second pane tab of the same session, a draft that became this session,
    // and an unrelated session whose id only shares a prefix.
    const second = await open('session-1:right-terminal:two', 'tab-1', cwdA);
    const fromDraft = await open('draft-9:right-terminal', 'tab-1', cwdA);
    const other = await open('session-10:right-terminal', 'tab-1', cwdB);
    manager.adoptOwner('draft-9', 'session-1');
    for (const id of ['session-1:right-terminal', 'session-1:right-terminal:two', 'draft-9:right-terminal', 'session-10:right-terminal']) {
      manager.write({ threadId: id, terminalId: 'tab-1', data: 'echo MARK_$((40+2))\r' });
    }
    await until(() => output('session-10:right-terminal').includes('MARK_42'), 'the other session prints');
    await until(() => output('draft-9:right-terminal').includes('MARK_42'), 'the draft shell prints');
    await delay(200);
    assert.equal(historyFiles().length, 4, 'one history file per shell');

    // Deleting the session ends its shells and their process trees.
    assert.equal(manager.closeOwner('session-1'), 3);
    await until(
      () => ![shellPid, childPid, second.pid!, fromDraft.pid!].some(alive),
      'the session shells and the command running in one of them end'
    );
    assert.ok(alive(other.pid!), 'another session keeps its shell');
    assert.equal(manager.getSnapshot({ threadId: scope, terminalId: 'tab-1' }), null);
    assert.equal(historyFiles().length, 1, 'their history is removed with them');
    assert.equal(manager.closeOwner('session-1'), 0, 'nothing is left to close');
    assert.equal(events.filter((event) => event.type === 'exited').length, 0, 'a closed shell is not reported as exited');

    // Closing one tab for good removes its history as well.
    manager.close({ threadId: 'session-10:right-terminal', terminalId: 'tab-1', deleteHistory: true });
    await until(() => !alive(other.pid!), 'the closed tab ends');
    assert.equal(historyFiles().length, 0);

    console.log('terminal-manager.test.ts passed');
  } finally {
    manager.disposeAll();
    // Let the kill grace period run so nothing outlives the test.
    await delay(1200);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
    setTimeout(() => process.exit(), 50);
  });
