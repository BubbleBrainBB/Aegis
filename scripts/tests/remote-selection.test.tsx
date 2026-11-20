// The composer's choices for a session on another Mac: shown from what that Mac
// (and the main process) says, so a composer opened again shows them still, and
// told to the main process when made, so they outlive the composer.
// Run: npx tsx scripts/tests/remote-selection.test.tsx
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RemotePermissionControl, useRemoteSelection, type RemoteSelection } from '../../src/ui/components/RemoteAgentPicker';
import type { RemoteAgentEntry } from '../../src/shared/remote/agent-catalog';
import type { RemoteTaskSettings } from '../../src/shared/remote/protocol';

const told: Array<{ action: string; payload: unknown }> = [];
(globalThis as { window?: unknown }).window = {
  electron: {
    remoteHosts: (action: string, payload: unknown) => {
      told.push({ action, payload });
      return Promise.resolve();
    },
  },
};

const catalog: RemoteAgentEntry[] = [
  { provider: 'claude', defaultModel: 'sonnet', models: [] },
  { provider: 'bubble', defaultModel: 'kimi', models: [{ id: 'kimi', label: 'Kimi', efforts: ['low', 'high'] }] },
];
const SESSION = 'rh-0123456789ab-b1';

/** Mounts a composer for the session and returns what it would send, after an optional pick. */
function mount(key: string, provider: string | undefined, initial: RemoteTaskSettings | undefined, pick?: (selection: RemoteSelection) => void) {
  let seen: RemoteSelection | undefined;
  function Probe() {
    const selection = useRemoteSelection(key, catalog, provider, initial);
    const [picked, setPicked] = useState(false);
    if (pick && !picked) {
      setPicked(true);
      pick(selection);
    }
    seen = selection;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return seen!;
}

// What that Mac has for the session is what the composer shows and sends:
// Full Access set earlier is still Full Access when the composer opens again.
// Plan or not is always said: a Mac that keeps what a message leaves out would otherwise
// keep a plan that began over there since, under a composer showing none.
assert.deepEqual(mount(SESSION, 'bubble', { model: 'kimi', permissionMode: 'bypassPermissions' }).settings, { model: 'kimi', permissionMode: 'bypassPermissions', plan: false });
assert.equal(mount(SESSION, 'claude', { permissionMode: 'acceptEdits' }).settings.plan, false);
assert.equal(mount(SESSION, 'codex', {}).settings.plan, false);
assert.deepEqual(mount(SESSION, 'bubble', { permissionMode: 'bypassPermissions', plan: true }).settings, { permissionMode: 'bypassPermissions', plan: true });
// Nothing known: the agent's default, said in full with each message.
assert.equal(mount(SESSION, 'bubble', undefined).settings.permissionMode, 'default');
assert.equal(mount(SESSION, 'bubble', {}).settings.permissionMode, 'default');
assert.equal(mount(SESSION, 'codex', {}).provider, 'claude', 'an agent that Mac does not list falls to its first');
assert.deepEqual(told, [], 'opening a composer chooses nothing');

// A pick shows at once, and the main process is told for a session that exists:
// it keeps the choice for every later message and for the next composer.
const picked = mount(SESSION, 'bubble', { model: 'kimi' }, (selection) => selection.setPermission('bypassPermissions'));
assert.deepEqual(picked.settings, { model: 'kimi', permissionMode: 'bypassPermissions', plan: false });
assert.deepEqual(told, [{ action: 'choose', payload: { sessionId: SESSION, settings: { permissionMode: 'bypassPermissions', plan: false } } }]);
// Plan is a toggle beside Bubble's modes: the mode under it stays.
told.length = 0;
const planning = mount(SESSION, 'bubble', { permissionMode: 'bypassPermissions' }, (selection) => selection.setPermission('plan'));
assert.deepEqual(planning.settings, { permissionMode: 'bypassPermissions', plan: true });
assert.deepEqual(told, [{ action: 'choose', payload: { sessionId: SESSION, settings: { plan: true } } }]);
// A model pick clears the effort that went with the old one.
told.length = 0;
const model = mount(SESSION, 'bubble', { model: 'old', effort: 'high', permissionMode: 'bypassPermissions' }, (selection) => selection.setModel('kimi'));
assert.equal(model.settings.model, 'kimi');
assert.equal(model.settings.effort, undefined);
assert.equal(model.settings.permissionMode, 'bypassPermissions');
assert.equal(told.length, 1);

// A draft (a task not started yet) is nobody's to keep but the composer's own.
told.length = 0;
const draft = mount('/aegis-remote/0123456789ab/p1/coworker', undefined, undefined, (selection) => selection.setPermission('bypassPermissions'));
assert.equal(draft.settings.permissionMode, 'bypassPermissions');
assert.deepEqual(told, []);

// The control shows what the session has.
const control = renderToStaticMarkup(createElement(function Control() {
  const selection = useRemoteSelection(SESSION, catalog, 'bubble', { permissionMode: 'bypassPermissions' });
  return createElement(RemotePermissionControl, { selection });
}));
assert.match(control, /Permission mode: Full access/i);

console.log('remote-selection: ok');
