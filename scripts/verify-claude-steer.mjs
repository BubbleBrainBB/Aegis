#!/usr/bin/env node

// Claude mid-turn steer wiring. The fold itself (a streaming-input prompt
// pushed during a turn joins it between tool rounds, and that turn's result
// lists every uuid it consumed) is the CLI's behavior; the ledger side is
// covered by scripts/tests/claude-turn-accounting.test.ts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const promptInput = read('src', 'ui', 'components', 'PromptInput.tsx');
assert.match(
  promptInput,
  /const canSteerWhileRunning =[\s\S]{0,1200}runtimeProvider === 'claude'/,
  'the composer must offer Steer for running Claude turns'
);

const bridge = read('src', 'electron', 'feishu', 'bridge.ts');
assert.match(
  bridge,
  /const STEERABLE = new Set\(\[[^\]]*"claude"/,
  'the Feishu bridge must steer running Claude turns like the desktop composer'
);

const ipc = read('src', 'electron', 'ipc-handlers.ts');
assert.match(
  ipc,
  /const claudeMidTurn =\s*nextProvider === 'claude' &&\s*existingEntry\?\.provider === 'claude' &&\s*\(existingEntry\.inFlightTurns \?\? 0\) > \(existingEntry\.stoppedTurns \?\? 0\);/,
  'a Claude send is mid-turn only while a live (not user-stopped) turn is in flight'
);
assert.ok(
  ipc.includes("(!claudeMidTurn && (claudeConfigDrift || existingEntry.doomed === true))"),
  'composer drift and doom must not abort a live Claude turn the send steers into'
);
assert.ok(
  ipc.includes('if (claudeMidTurn && claudeConfigDrift) existingEntry.doomed = true;'),
  'a steer carrying new config must doom the runner so the next turn respawns with it'
);
for (const name of ['modelChanged', 'betasChanged', 'accessModeChanged', 'executionModeChanged', 'claudeReasoningEffortChanged']) {
  assert.match(
    ipc,
    new RegExp(`const claudeConfigDrift =[\\s\\S]{0,200}\\b${name}\\b`),
    `claudeConfigDrift must include ${name}`
  );
}
// The drained result retires a doomed runner; that is what applies the drift.
assert.ok(
  ipc.includes('if (drained && (currentEntry.doomed || currentEntry.autoApprove))'),
  'a drained doomed Claude runner must be retired'
);

console.log('verify-claude-steer: ok');
