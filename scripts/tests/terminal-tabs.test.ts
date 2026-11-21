import assert from 'node:assert/strict';
import {
  closeRightTerminalPaneTab,
  rightTerminalScopeId,
  TerminalTabStore,
  type TerminalTabDraft,
} from '../../src/ui/terminal/terminal-tabs';

// The tab store behind the embedded terminals: tabs belong to a scope, not
// to the panel that shows them, and only an explicit removal ends one.

const draft = (cwd: string, agent: TerminalTabDraft['agent'] = 'shell'): TerminalTabDraft => ({
  label: agent === 'shell' ? 'Terminal' : agent,
  agent,
  initialCommand: agent === 'shell' ? null : agent,
  initialNotice: null,
  cwd,
});

function watch(store: TerminalTabStore) {
  const removed: string[] = [];
  let changes = 0;
  store.onRemove((scope, tabId) => removed.push(`${scope}::${tabId}`));
  store.subscribe(() => {
    changes += 1;
  });
  return { removed, changes: () => changes };
}

// ── A scope keeps its tabs across mounts ─────────────────────────────────────
{
  const store = new TerminalTabStore();
  const seen = watch(store);
  const scope = 'session-1:right-terminal';
  assert.equal(store.get(scope).tabs.length, 0);
  assert.equal(store.get(scope), store.get('other'), 'an unknown scope reads as the same empty value');

  // Mounting twice (React development mode) creates one tab, not two.
  let drafts = 0;
  const make = () => {
    drafts += 1;
    return draft('/work/a');
  };
  const first = store.ensure(scope, make);
  const second = store.ensure(scope, make);
  assert.equal(drafts, 1, 'the second ensure does not build a tab');
  assert.equal(first, second, 'and returns the same snapshot');
  assert.equal(first.tabs.length, 1);
  assert.equal(first.activeTabId, first.tabs[0].id);
  assert.deepEqual(seen.removed, []);

  // Coming back later (same scope) finds the same tab id: the same shell.
  const tabId = first.tabs[0].id;
  assert.equal(store.ensure(scope, () => draft('/work/moved')).tabs[0].id, tabId);
  assert.equal(store.get(scope).tabs[0].cwd, '/work/a', 'an existing tab keeps the folder it was opened in');

  // A tab opened after the session moved starts in the new folder.
  const claude = store.add(scope, draft('/work/moved', 'claude'));
  assert.notEqual(claude.id, tabId);
  assert.deepEqual(store.get(scope).tabs.map((tab) => tab.cwd), ['/work/a', '/work/moved']);
  assert.equal(store.get(scope).activeTabId, claude.id, 'a new tab becomes the active one');

  // Snapshots only change when something changed.
  const before = store.get(scope);
  const changesBefore = seen.changes();
  store.setActivity(scope, tabId, null);
  store.setActive(scope, claude.id);
  store.setStatus(scope, null);
  store.setActive(scope, 'no-such-tab');
  assert.equal(store.get(scope), before);
  assert.equal(seen.changes(), changesBefore, 'no-op updates notify nobody');
  store.setActivity(scope, tabId, 'running');
  store.setStatus(scope, 'Failed to spawn shell');
  assert.equal(store.get(scope).tabs[0].activity, 'running');
  assert.equal(store.get(scope).status, 'Failed to spawn shell');
  assert.notEqual(store.get(scope), before);

  // Closing a tab is reported once; the neighbour takes over.
  assert.equal(store.remove(scope, claude.id), 1);
  assert.deepEqual(seen.removed, [`${scope}::${claude.id}`]);
  assert.equal(store.get(scope).activeTabId, tabId);
  assert.equal(store.remove(scope, claude.id), 1, 'removing it again changes nothing');
  assert.deepEqual(seen.removed, [`${scope}::${claude.id}`]);

  // Closing the last tab forgets the scope; the next mount starts fresh.
  assert.equal(store.remove(scope, tabId), 0);
  assert.deepEqual(store.scopeIds(), []);
  assert.equal(seen.removed.length, 2);
  assert.equal(store.ensure(scope, () => draft('/work/moved')).tabs[0].cwd, '/work/moved');
}

// ── Sessions own their scopes ────────────────────────────────────────────────
{
  const store = new TerminalTabStore();
  const seen = watch(store);
  const scopeOf = (sessionId: string | null, pane: string, cwd: string | null = '/work/a') =>
    rightTerminalScopeId(sessionId, cwd, pane, store)!;

  assert.equal(scopeOf('s1', 'terminal'), 's1:right-terminal', 'the plain terminal tab keeps its old scope');
  assert.equal(scopeOf('s1', 'terminal:abc'), 's1:right-terminal:abc');
  assert.equal(scopeOf(null, 'terminal'), 'project:/work/a:right-terminal');
  assert.equal(rightTerminalScopeId(null, null, 'terminal', store), null);

  store.ensure(scopeOf('s1', 'terminal'), () => draft('/work/a'));
  store.add(scopeOf('s1', 'terminal'), draft('/work/a', 'codex'));
  store.ensure(scopeOf('s1', 'terminal:abc'), () => draft('/work/a'));
  store.ensure(scopeOf('s10', 'terminal'), () => draft('/work/b'));
  store.ensure(scopeOf('s2', 'terminal'), () => draft('/work/b'));

  // Closing one pane tab ends that scope only.
  closeRightTerminalPaneTab('s1', 'terminal:abc', store);
  assert.equal(seen.removed.length, 1);
  assert.ok(seen.removed[0].startsWith('s1:right-terminal:abc::'));
  assert.deepEqual(store.scopeIds().sort(), ['s1:right-terminal', 's10:right-terminal', 's2:right-terminal'].sort());

  // Deleting a session ends all of its tabs, and nobody else's ("s1" is not "s10").
  store.dropOwner('s1');
  assert.equal(seen.removed.length, 3);
  assert.deepEqual(store.scopeIds().sort(), ['s10:right-terminal', 's2:right-terminal'].sort());
  store.dropOwner('s1');
  store.dropOwner('');
  assert.equal(seen.removed.length, 3, 'dropping again is a no-op');

  // A draft with a terminal becomes a real session: same scope, same tabs.
  const draftScope = scopeOf('draft-1', 'terminal');
  const draftTabId = store.ensure(draftScope, () => draft('/work/c')).tabs[0].id;
  store.adoptOwner('draft-1', 'real-1');
  assert.equal(scopeOf('real-1', 'terminal'), draftScope, 'the session keeps using the draft scope');
  assert.equal(store.get(scopeOf('real-1', 'terminal')).tabs[0].id, draftTabId);
  assert.equal(seen.removed.length, 3, 'promotion ends nothing');
  // More pane tabs of that session are filed under the same owner and go with it.
  store.ensure(scopeOf('real-1', 'terminal:two'), () => draft('/work/c'));
  store.dropOwner('real-1');
  assert.equal(seen.removed.length, 5);
  assert.equal(scopeOf('real-1', 'terminal'), 'real-1:right-terminal', 'the alias is forgotten with the session');

  // A draft without terminals leaves no alias behind.
  store.adoptOwner('draft-2', 'real-2');
  assert.equal(scopeOf('real-2', 'terminal'), 'real-2:right-terminal');

  // With no session open the pane tab is shared by every project folder.
  store.ensure(scopeOf(null, 'terminal', '/work/a'), () => draft('/work/a'));
  store.ensure(scopeOf(null, 'terminal', '/work/b'), () => draft('/work/b'));
  store.ensure(scopeOf(null, 'terminal:x', '/work/a'), () => draft('/work/a'));
  closeRightTerminalPaneTab(null, 'terminal', store);
  assert.deepEqual(store.scopeIds().sort(), ['project:/work/a:right-terminal:x', 's10:right-terminal', 's2:right-terminal'].sort());
}

console.log('terminal-tabs.test.ts passed');
