// Terminals follow the session's life in the app store: a draft that becomes
// a real session keeps its terminals, switching sessions ends nothing, and
// deleting a session ends that session's terminals only.
import assert from 'node:assert/strict';
import type { ServerEvent } from '../../src/ui/types';
import { useAppStore } from '../../src/ui/store/useAppStore';
import { rightTerminalScopeId, terminalTabs, type TerminalTabDraft } from '../../src/ui/terminal/terminal-tabs';

const store = () => useAppStore.getState();
const send = (event: unknown) => store().handleServerEvent(event as ServerEvent);
const draftTab = (cwd: string): TerminalTabDraft => ({ label: 'Terminal', agent: 'shell', initialCommand: null, initialNotice: null, cwd });
const removed: string[] = [];
terminalTabs.onRemove((scope, tabId) => removed.push(`${scope}::${tabId}`));

// A terminal opened while the chat is still a draft.
const draftId = store().createDraftSession('/projects/x');
const draftScope = rightTerminalScopeId(draftId, '/projects/x', 'terminal')!;
const tabId = terminalTabs.ensure(draftScope, () => draftTab('/projects/x')).tabs[0].id;

// The first message turns the draft into a real session.
useAppStore.setState({ pendingDraftSessionId: draftId, pendingStart: true });
send({ type: 'session.status', payload: { sessionId: 'real-1', status: 'running', title: 'Task', cwd: '/projects/x' } });
assert.equal(store().activeSessionId, 'real-1');
assert.equal(store().sessions[draftId], undefined, 'the draft is replaced by the session');
const realScope = rightTerminalScopeId('real-1', '/projects/x', 'terminal')!;
assert.equal(realScope, draftScope, 'the session keeps the scope its terminal was opened under');
assert.equal(terminalTabs.get(realScope).tabs[0].id, tabId);
assert.deepEqual(removed, [], 'becoming a real session ends no terminal');

// Another session with its own terminal; switching between them ends nothing.
send({ type: 'session.status', payload: { sessionId: 'real-2', status: 'idle', title: 'Other', cwd: '/projects/y' } });
const otherScope = rightTerminalScopeId('real-2', '/projects/y', 'terminal')!;
terminalTabs.ensure(otherScope, () => draftTab('/projects/y'));
store().setActiveSession('real-2');
store().setActiveSession('real-1');
store().setShowSettings(true);
store().setShowSettings(false);
assert.deepEqual(removed, [], 'switching sessions or opening Settings ends no terminal');
assert.equal(terminalTabs.scopeIds().length, 2);

// Deleting a session ends its terminals, and only its own.
send({ type: 'session.deleted', payload: { sessionId: 'real-1' } });
assert.deepEqual(removed, [`${draftScope}::${tabId}`]);
assert.deepEqual(terminalTabs.scopeIds(), [otherScope]);
assert.equal(rightTerminalScopeId('real-1', '/projects/x', 'terminal'), 'real-1:right-terminal', 'the alias to the draft is gone');
send({ type: 'session.deleted', payload: { sessionId: 'real-1' } });
assert.equal(removed.length, 1, 'a repeated delete event ends nothing more');

send({ type: 'session.deleted', payload: { sessionId: 'real-2' } });
assert.equal(removed.length, 2);
assert.deepEqual(terminalTabs.scopeIds(), []);

console.log('terminal-session-cleanup.test.ts passed');
