#!/usr/bin/env node
// The composer's permission mode stays changeable while the agent runs, for
// every provider. A live Claude turn switches at once (session.setClaudeMode);
// the others take the mode with the next send. The Electron check is
// scripts/tests/composer-picker-layout-electron.test.mjs (manual run).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const prompt = read('src/ui/components/PromptInput.tsx');
const pickers = prompt.match(/<PermissionModePicker[\s\S]*?\/>/g) || [];
assert.ok(pickers.length >= 10, `PromptInput: expected every provider's PermissionModePicker, found ${pickers.length}`);
// Only the start lock may disable a picker: a draft's first message carries
// the mode it was sent with, and the draft row a pick changes meanwhile is
// replaced by the new session. Never the running state.
assert.ok(/const startLocked = pendingStart \|\| draftStartLocked;/.test(prompt), 'PromptInput: startLocked is pendingStart || draftStartLocked');
for (const picker of pickers) {
  assert.ok(/disabled=\{startLocked\}/.test(picker), `PromptInput: a PermissionModePicker is not locked by a pending start:\n${picker}`);
  assert.ok(!/isBusy|isRunning|approvalPending/.test(picker), `PromptInput: a PermissionModePicker is disabled by running state:\n${picker}`);
}
const remote = prompt.match(/<RemotePermissionControl[^>]*\/>/);
assert.ok(remote, 'PromptInput: RemotePermissionControl missing');
assert.ok(/disabled=\{startLocked \|\| remoteOffline\}/.test(remote[0]), 'PromptInput: RemotePermissionControl may only be disabled by a pending start or an offline device');
assert.ok(prompt.includes("type: 'session.setClaudeMode'"), 'PromptInput: the Claude picker must tell the main process without a send');

// Main process: the event reaches a live runner and the stored mode.
const shared = read('src/shared/types.ts');
assert.ok(shared.includes("type: 'session.setClaudeMode'"), 'shared/types: session.setClaudeMode client event');
const ipc = read('src/electron/ipc-handlers.ts');
assert.ok(ipc.includes("case 'session.setClaudeMode':"), 'ipc-handlers: session.setClaudeMode is handled');
assert.ok(/setClaudePermissionMode\(accessMode, executionMode\)/.test(ipc), 'ipc-handlers: a live Claude runner switches its query');
const runner = read('src/electron/libs/runner.ts');
assert.ok(/setClaudePermissionMode: async \(accessMode, executionMode\)/.test(runner), 'runner: Claude handle exposes setClaudePermissionMode');
assert.ok(/createClaudePermissionSwitcher\(/.test(runner), 'runner: permission switches go through the serialized switcher (claude-permission-switch)');
assert.ok(!/activeQuery\.setPermissionMode\(nextMode\)[\s\S]{0,200}currentPermissionMode = nextMode/.test(runner), 'runner: no unserialized setPermissionMode path');
// Qoder takes its mode at spawn only: a changed pick respawns the warm runner.
assert.ok(/qoderPermissionModeChanged \|\|/.test(ipc), 'ipc-handlers: a changed Qoder permission mode respawns the warm runner');
assert.ok(/allowDangerouslySkipPermissions: !workflowPolicy\?\.readOnly/.test(runner), 'runner: Full Access must stay reachable mid-turn (allowDangerouslySkipPermissions)');

console.log('composer-permission-running: all checks passed');
