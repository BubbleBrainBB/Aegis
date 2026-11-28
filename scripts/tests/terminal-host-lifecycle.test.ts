import assert from 'node:assert/strict';
import Module from 'node:module';

// The renderer side of terminal persistence, in Node: the real TerminalHost,
// ManagedTerminal and tab store, with xterm and the DOM replaced by small
// fakes. A terminal that leaves the screen keeps its shell and its screen;
// only removing its tab closes it, once.

// ── Fakes ────────────────────────────────────────────────────────────────────
class FakeElement {
  style: Record<string, string> = {};
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  isConnected = true;
  appendChild(child: FakeElement) {
    child.remove();
    this.children.push(child);
    child.parentElement = this;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((item) => item !== this);
    this.parentElement = null;
  }
}

class FakeXterm {
  static all: FakeXterm[] = [];
  cols = 80;
  rows = 24;
  element: FakeElement | undefined;
  options: Record<string, unknown>;
  unicode = { activeVersion: '' };
  buffer = { active: { viewportY: 0, baseY: 0 } };
  screen = '';
  disposed = false;
  private listener: ((data: string) => void) | null = null;
  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
    FakeXterm.all.push(this);
  }
  loadAddon() {}
  onData(listener: (data: string) => void) {
    this.listener = listener;
  }
  open(container: FakeElement) {
    this.element = new FakeElement();
    container.appendChild(this.element);
  }
  write(data: string) {
    this.screen += data;
  }
  reset() {
    this.screen = '';
  }
  type(data: string) {
    this.listener?.(data);
  }
  focus() {}
  refresh() {}
  scrollToBottom() {}
  getSelection() {
    return '';
  }
  dispose() {
    this.disposed = true;
  }
}

class FakeAddon {
  fit() {}
  findNext() {
    return false;
  }
  onContextLoss() {}
  clearTextureAtlas() {}
  dispose() {}
}

const stubs: Record<string, unknown> = {
  '@xterm/xterm': { Terminal: FakeXterm },
  '@xterm/addon-clipboard': { ClipboardAddon: FakeAddon },
  '@xterm/addon-fit': { FitAddon: FakeAddon },
  '@xterm/addon-image': { ImageAddon: FakeAddon },
  '@xterm/addon-ligatures': { LigaturesAddon: FakeAddon },
  '@xterm/addon-search': { SearchAddon: FakeAddon },
  '@xterm/addon-unicode11': { Unicode11Addon: FakeAddon },
  '@xterm/addon-webgl': { WebglAddon: FakeAddon },
};
type Loader = (request: string, ...rest: unknown[]) => unknown;
const moduleInternals = Module as unknown as { _load: Loader };
const realLoad = moduleInternals._load;
moduleInternals._load = function (request: string, ...rest: unknown[]) {
  if (request in stubs) return stubs[request];
  if (request.endsWith('.css')) return {};
  return realLoad.call(this, request, ...rest);
};

type Call = [name: string, input: Record<string, unknown>];
const calls: Call[] = [];
const named = (name: string) => calls.filter((call) => call[0] === name).map((call) => call[1]);
const listeners = new Set<(event: Record<string, unknown>) => void>();
const emit = (event: Record<string, unknown>) => {
  for (const listener of [...listeners]) listener({ createdAt: '', ...event });
};
const snapshotFor = (input: Record<string, unknown>) => ({
  threadId: input.threadId,
  terminalId: input.terminalId,
  cwd: input.cwd,
  status: 'running',
  pid: 1,
  history: 'PROMPT$ ',
  exitCode: null,
  exitSignal: null,
  updatedAt: '',
  cols: 80,
  rows: 24,
  agentKind: 'shell',
});
const record = (name: string) => async (input: Record<string, unknown>) => {
  calls.push([name, input]);
  return name === 'open' ? { ok: true, snapshot: snapshotFor(input) } : { ok: true };
};
const windowListeners = { addEventListener() {}, removeEventListener() {} };
Object.assign(globalThis, {
  window: {
    ...windowListeners,
    requestAnimationFrame: (run: () => void) => setTimeout(run, 1),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    clearTimeout: (handle: number) => clearTimeout(handle),
    electron: {
      terminal: {
        open: record('open'),
        write: record('write'),
        resize: record('resize'),
        clear: record('clear'),
        close: record('close'),
        onEvent: (listener: (event: Record<string, unknown>) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  },
  document: { ...windowListeners, visibilityState: 'visible', documentElement: { classList: { contains: () => false } } },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
});

const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { terminalHost, terminalKey } = require('../../src/ui/terminal/terminal-host') as typeof import('../../src/ui/terminal/terminal-host');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { terminalTabs, rightTerminalScopeId } = require('../../src/ui/terminal/terminal-tabs') as typeof import('../../src/ui/terminal/terminal-tabs');
  type Spec = import('../../src/ui/terminal/terminal-host').TerminalSpec;

  const onScreen = { visible: true, active: true };
  const scope = rightTerminalScopeId('session-1', '/work/a', 'terminal')!;
  const draft = (cwd: string) => ({ label: 'Terminal', agent: 'shell' as const, initialCommand: null, initialNotice: null, cwd });
  const specFor = (tabScope: string, tab: { id: string; cwd?: string }, sessionCwd: string): Spec => ({
    key: terminalKey(tabScope, tab.id),
    scope: tabScope,
    tabId: tab.id,
    cwd: tab.cwd ?? sessionCwd,
    agent: 'shell',
    launch: null,
    notice: null,
  });
  const mount = (spec: Spec, container: FakeElement) => terminalHost.mount(spec, onScreen, container as unknown as HTMLDivElement);

  // ── First mount, the way React development mode does it: mount, unmount, mount.
  const tab = terminalTabs.ensure(scope, () => draft('/work/a')).tabs[0];
  terminalTabs.ensure(scope, () => draft('/work/a'));
  const spec = specFor(scope, tab, '/work/a');
  const firstPanel = new FakeElement();
  mount(spec, firstPanel);
  terminalHost.unmount(spec.key);
  mount(spec, firstPanel);
  await settle();
  assert.equal(named('open').length, 1, 'one shell is opened for one tab');
  assert.equal(named('open')[0].cwd, '/work/a');
  assert.equal(named('close').length, 0, 'the repeated mount does not start a shell and end it again');
  assert.equal(FakeXterm.all.length, 1);
  const xterm = FakeXterm.all[0];
  assert.ok(xterm.screen.includes('PROMPT$ '), 'the shell history is on screen');
  assert.equal(xterm.element!.parentElement, firstPanel);

  emit({ type: 'output', threadId: scope, terminalId: tab.id, data: 'BEFORE-SWITCH\r\n' });
  await settle(120);
  assert.ok(xterm.screen.includes('BEFORE-SWITCH'));

  // ── The user switches to another session: the panel unmounts.
  terminalHost.unmount(spec.key);
  assert.equal(firstPanel.children.length, 0, 'the terminal is taken off screen');
  emit({ type: 'output', threadId: scope, terminalId: tab.id, data: 'AWAY-1\r\n' });
  emit({ type: 'output', threadId: scope, terminalId: tab.id, data: 'AWAY-2\r\n' });
  await settle(120);
  assert.equal(named('close').length, 0, 'leaving the panel does not close the shell');
  assert.equal(xterm.disposed, false);
  assert.equal(xterm.screen.includes('AWAY-1'), false, 'output is held while the terminal is away');

  // ── Back again: the tab store still has the tab, so the same key mounts.
  assert.equal(terminalTabs.ensure(scope, () => draft('/work/elsewhere')).tabs[0].id, tab.id);
  const secondPanel = new FakeElement();
  mount(spec, secondPanel);
  await settle();
  assert.equal(named('open').length, 1, 'coming back does not open another shell');
  assert.equal(named('close').length, 0);
  assert.equal(FakeXterm.all.length, 1, 'and reuses the same screen');
  assert.equal(xterm.element!.parentElement, secondPanel);
  const order = ['PROMPT$ ', 'BEFORE-SWITCH', 'AWAY-1', 'AWAY-2'].map((text) => xterm.screen.indexOf(text));
  assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])), `screen and held output are kept in order: ${order}`);
  xterm.type('x');
  await settle(50);
  assert.deepEqual(named('write').map((input) => input.data), ['x'], 'typing reaches the same shell');

  // ── The session moves to another folder (an agent worktree, say).
  const tabNow = terminalTabs.get(scope).tabs[0];
  const movedSpec = specFor(scope, tabNow, '/work/b');
  assert.equal(movedSpec.cwd, '/work/a', 'the tab keeps the folder it was opened in');
  terminalHost.update(movedSpec);
  // Even a caller that passes the new folder does not restart the shell.
  terminalHost.update({ ...movedSpec, cwd: '/work/b' });
  terminalHost.unmount(spec.key);
  mount({ ...movedSpec, cwd: '/work/b' }, secondPanel);
  await settle();
  assert.equal(named('open').length, 1, 'a folder change opens nothing');
  assert.equal(named('close').length, 0, 'and closes nothing');
  assert.ok(xterm.screen.includes('BEFORE-SWITCH'), 'the screen is not reset');

  // ── A second tab, then closing the first: exactly one close, for that tab.
  const extra = terminalTabs.add(scope, draft('/work/b'));
  mount(specFor(scope, extra, '/work/b'), new FakeElement());
  await settle();
  assert.equal(named('open').length, 2);
  assert.equal(named('open')[1].cwd, '/work/b', 'a tab opened after the move starts in the new folder');
  assert.equal(terminalTabs.remove(scope, tab.id), 1);
  await settle(50);
  assert.deepEqual(named('close'), [{ threadId: scope, terminalId: tab.id, deleteHistory: true }]);
  assert.equal(xterm.disposed, true);
  terminalTabs.remove(scope, tab.id);
  terminalHost.destroy(spec.key);
  await settle(50);
  assert.equal(named('close').length, 1, 'closing it again sends nothing');
  emit({ type: 'output', threadId: scope, terminalId: tab.id, data: 'LATE\r\n' });

  // ── Deleting the session closes what is left of it, mounted or not.
  const otherScope = rightTerminalScopeId('session-2', '/work/c', 'terminal')!;
  const otherTab = terminalTabs.ensure(otherScope, () => draft('/work/c')).tabs[0];
  const otherSpec = specFor(otherScope, otherTab, '/work/c');
  mount(otherSpec, new FakeElement());
  await settle();
  terminalHost.unmount(otherSpec.key);
  terminalTabs.dropOwner('session-1');
  await settle(50);
  assert.deepEqual(named('close').slice(1), [{ threadId: scope, terminalId: extra.id, deleteHistory: true }]);
  assert.equal(FakeXterm.all[1].disposed, true);
  assert.equal(FakeXterm.all[2].disposed, false, 'another session is left alone');
  terminalTabs.dropOwner('session-2');
  await settle(50);
  assert.equal(named('close').length, 3);
  assert.equal(named('close')[2].threadId, otherScope);
  assert.equal(listeners.size, 0, 'the host stops listening once no terminal is left');

  console.log('terminal-host-lifecycle.test.ts passed');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
