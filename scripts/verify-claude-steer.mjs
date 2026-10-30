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
// Stop: the runner's stopTurn (cancels, then the interrupt, in one tick).
assert.ok(
  ipc.includes('const stopTurn = entry.handle.stopTurn ?? entry.handle.interrupt!;'),
  'Stop must go through the runner\'s stopTurn'
);
// Withdrawals and late-steer moves settle from the CLI's own frames, in
// stream order; the count-based re-interrupt only runs for runners that do
// not track prompt identity (the runner interrupts what Stop missed itself).
assert.ok(ipc.includes('onPromptsWithdrawn: (promptIds) => settleWithdrawnClaudePrompts(mainWindow, session.id, handle, promptIds),'),
  'withdrawals must settle from the runner\'s frame callback');
assert.ok(ipc.includes('onPromptStarted: (started) => moveLateClaudeSteer(mainWindow, session.id, handle, started),'),
  'a late steer must move to where its turn opened');
assert.ok(ipc.includes('if (!currentEntry.handle.tracksPromptIdentity?.()) {'),
  'no count-based re-interrupt for identity-tracking runners');
assert.ok(ipc.includes('promptIds = promptIds.filter((id) => counted.delete(id));'),
  'a withdrawal settles each prompt once, only if still counted');
assert.ok(
  ipc.includes('if (!(error instanceof ClaudeGoalWithdrawnError)) handleSessionStop(mainWindow, sessionId);'),
  'a withdrawn goal start must not stop the session again'
);
// Stored Claude messages reload in arrival order (claude-session-clock).
assert.ok(ipc.includes('createdAt: claudeTimestamp(session.id, attributedMessage.createdAt ?? Date.now()),'),
  'stored Claude stream messages are stamped in arrival order');
assert.ok(ipc.includes("const createdAt = nextProvider === 'claude' ? claudeTimestamp(sessionId) : Date.now();"),
  'a Claude prompt is stamped in the same sequence');

const runner = read('src', 'electron', 'libs', 'runner.ts');
// Re-interrupts (after a result, for a woken turn) never withdraw: only the
// Stop press does, for the prompts pending at that moment.
const interruptBody = runner.slice(runner.indexOf('    interrupt: async () => {'), runner.indexOf('    stopTurn: async () => {'));
assert.ok(interruptBody.length > 0 && !/beginStop|cancelAsyncMessage/.test(interruptBody), 'interrupt() must not withdraw prompts');
const stopBody = runner.slice(runner.indexOf('    stopTurn: async () => {'), runner.indexOf('    tracksPromptIdentity:'));
assert.match(stopBody, /const toCancel = promptLifecycle\.beginStop\(\);\s*if \(cancel\) for \(const uuid of toCancel\) void cancel\(uuid\)[\s\S]*stopInterruptPending = true;[\s\S]*await interruptQuery\(\)/,
  'stopTurn writes the cancels, then the interrupt, without awaiting in between');
assert.ok(!/await[\s\S]*const toCancel/.test(stopBody), 'nothing awaited before the cancels');
assert.ok(runner.includes('if (goalSet) rejectClaudeGoalSet(session.id, new ClaudeGoalWithdrawnError());'),
  'withdrawing a /goal prompt must end its goal-start wait');
assert.ok(runner.includes('if (promptFrame.withdrawn) promptWithdrawn(promptFrame.withdrawn);'),
  'withdrawals come from the frame loop');
assert.ok(runner.includes('interrupt: () => interruptQuery(),'), 'the /goal controller interrupts through interruptQuery (Stop receipt)');
assert.match(runner, /message: \{ content: \[\{ type: 'text', text: trimmed \}\] \},\s*hostEcho: true,/,
  'the runner must mark its own prompt echo');

console.log('verify-claude-steer: ok');
