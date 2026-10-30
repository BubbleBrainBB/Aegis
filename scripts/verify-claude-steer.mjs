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
// The reuse/steer decision lives in the pure planner (unit-tested by
// scripts/tests/claude-steer.test.ts); ipc-handlers must route through it.
assert.ok(ipc.includes("from './libs/claude-steer'"), 'ipc-handlers must use the claude-steer planner');
for (const name of ['modelChanged', 'betasChanged', 'accessModeChanged', 'executionModeChanged', 'claudeReasoningEffortChanged']) {
  assert.match(
    ipc,
    new RegExp(`planClaudeSend\\(existingEntry, \\{\\s*configDrift:[\\s\\S]{0,200}\\b${name}\\b`),
    `configDrift must include ${name}`
  );
}
assert.ok(ipc.includes('claudePlan?.respawn === true'), 'the reuse guard must respawn exactly when the plan says so');
assert.ok(
  ipc.includes('if (claudePlan?.markStaleConfig) existingEntry.staleConfig = true;'),
  'a steer carrying new config must mark the runner staleConfig'
);
assert.ok(
  ipc.includes('const sendModel = claudePlan ? claudePlan.sendModel : nextModel;'),
  'a steer must hand the runner its current model, never the new selection'
);
assert.ok(
  ipc.includes("claudeModel: provider === 'claude' ? resolvedModelOverride : undefined,"),
  'a spawned Claude runner must record the model it was handed'
);
// The drained result retires a staleConfig runner; that is what applies the drift.
assert.ok(
  ipc.includes('if (entry.doomed || entry.staleConfig || entry.autoApprove) {') &&
    ipc.includes('if ((currentEntry.inFlightTurns ?? 0) === 0) finishDrainedClaudeRunner(session.id, currentEntry);'),
  'a drained doomed or staleConfig Claude runner must be retired'
);
// The prompt echo tells the renderer the turn goes on (stream + persisted copy).
assert.equal(ipc.match(/\.\.\.\(claudeSteer \? \{ steer: true \} : \{\}\),/g)?.length, 2,
  'both the broadcast and the persisted user_prompt must carry steer');

// Atomicity: the Claude plan is read from the live entry and acted on with no
// await in between, so no runner event (doom, background wake, drain) can
// land between the decision and the dispatch. The only awaits allowed in that
// span are other providers' runtime checks, which never run for Claude.
assert.match(
  ipc,
  /const claudePlan =\s*nextProvider === 'claude' &&\s*existingEntry\?\.provider === 'claude' &&\s*runnerHandles\.get\(sessionId\) === existingEntry/,
  'the Claude plan must come from the live runner entry'
);
const planAt = ipc.indexOf('const claudePlan =');
const dispatchAt = ipc.indexOf('existingEntry.handle.send(', planAt);
assert.ok(planAt > 0 && dispatchAt > planAt, 'plan precedes the warm dispatch');
const span = ipc.slice(planAt, dispatchAt);
const otherProviderGate = /await get(Opencode|Kimi|Grok|Devin|Mimo|Minimax)RuntimeStatus\(\)/;
for (const line of span.split('\n').filter(l => !l.trim().startsWith('//') && /\bawait\b/.test(l))) {
  assert.match(line, otherProviderGate, `no await may sit between the Claude plan and its dispatch: ${line.trim()}`);
}
// Claude's runtime check guards spawning only: it sits after the warm
// dispatch, ahead of startRunner.
const claudeGateAt = ipc.indexOf('await getClaudeRuntimeStatusCached(nextModel || null)', planAt);
const spawnAt = ipc.indexOf('startRunner(\n    mainWindow,\n    sessions.getSession(sessionId)', planAt);
assert.ok(claudeGateAt > dispatchAt && claudeGateAt < spawnAt, 'the Claude runtime check must run on the spawn path only');

// A steer joins the run already going: it keeps the agent run id, or
// attributed sessions would split the one turn at the steer.
assert.ok(
  ipc.includes('if (!(claudeSteer && existingEntry.activeAgentRunId && existingEntry.activeAgentId === sessionAgentId)) {'),
  'a steer must keep the live agent run id'
);
// Stop: the withdrawal's cancels are written right before the interrupt, in
// one tick; a result's re-interrupt waits while the withdrawal is out.
assert.match(
  ipc,
  /const withdrawal = entry\.handle\.withdrawQueuedPrompts\?\.\(\);\s*entry\.handle\.interrupt!\(\)/,
  'Stop must issue the withdrawal and the interrupt back to back'
);
assert.ok(
  ipc.includes('if (!currentEntry.stopWithdrawal?.deferReinterrupt()) {'),
  'a result must not re-interrupt while the withdrawal is unanswered'
);
assert.ok(
  ipc.includes('onPromptOpenedTurn: (promptId) => promoteLateClaudeSteer(mainWindow, session.id, handle, promptId)'),
  'a steer that opened its own turn must be rewritten as that turn\'s opener'
);
assert.ok(
  ipc.includes('if (!(error instanceof ClaudeGoalWithdrawnError)) handleSessionStop(mainWindow, sessionId);'),
  'a withdrawn goal start must not stop the session again'
);

const runner = read('src', 'electron', 'libs', 'runner.ts');
// Withdrawal belongs to the Stop press alone: re-interrupts (after a result,
// for a woken turn) must never take back prompts sent after Stop.
const interruptBody = runner.slice(runner.indexOf('    interrupt: async () => {'), runner.indexOf('    stopTask: async'));
assert.ok(interruptBody.length > 0 && !/withdraw/i.test(interruptBody), 'interrupt() must not withdraw prompts');
assert.ok(runner.includes('if (goalSetWithdrawn) rejectClaudeGoalSet(session.id, new ClaudeGoalWithdrawnError());'),
  'withdrawing a /goal prompt must end its goal-start wait');
assert.match(runner, /message: \{ content: \[\{ type: 'text', text: trimmed \}\] \},\s*hostEcho: true,/,
  'the runner must mark its own prompt echo');

console.log('verify-claude-steer: ok');
