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
assert.ok(ipc.includes('onPromptStarted: (started) => storeStartedClaudePrompt(mainWindow, session.id, started),'),
  'a prompt sent into a busy runner must be stored where the CLI takes it');
// Deferred: a send into a busy identity-tracking runner is not stored at send.
assert.match(ipc, /const claudeDeferred =[\s\S]{0,400}\(existingEntry\?\.inFlightTurns \?\? 0\) > 0 &&\s*existingEntry\?\.handle\.tracksPromptIdentity\?\.\(\) === true;/,
  'only sends into a busy runner that reports prompt lifecycle are deferred');
assert.match(ipc, /if \(nextClaudePromptId\) \{\s*const draftDesign[\s\S]{0,800}\} else \{\s*sessions\.addMessage\(/,
  'a deferred prompt is registered, not stored, at send');
assert.ok(ipc.includes('if (!currentEntry.handle.tracksPromptIdentity?.()) {'),
  'no count-based re-interrupt for identity-tracking runners');
assert.ok(ipc.includes('promptIds = promptIds.filter((id) => deferredClaudePrompts.get(id)?.sessionId === sessionId);'),
  'a withdrawal settles each prompt once');
assert.ok(!ipc.includes('deleteMessagesById'), 'a withdrawn prompt was never stored: nothing to delete');
assert.ok(
  ipc.includes('if (!(error instanceof ClaudeGoalWithdrawnError)) handleSessionStop(mainWindow, sessionId);'),
  'a withdrawn goal start must not stop the session again'
);
// Stored Claude messages reload in arrival order (claude-session-clock):
// ordered by sort key, their timestamps untouched.
assert.ok(ipc.includes("provider === 'claude' ? { sortKey: claudeSortKey(session.id, attributedMessage.createdAt ?? Date.now()) } : undefined"),
  'stored Claude stream messages carry arrival-order sort keys');
assert.ok(ipc.includes("nextProvider === 'claude' ? { sortKey: claudeSortKey(sessionId, createdAt) } : undefined"),
  'a Claude prompt stored at send joins the same sequence');

const runner = read('src', 'electron', 'libs', 'runner.ts');
// Re-interrupts (after a result, for a woken turn) never withdraw: only the
// Stop press does, for the prompts pending at that moment.
const interruptBody = runner.slice(runner.indexOf('    interrupt: async () => {'), runner.indexOf('    stopTurn: async () => {'));
assert.ok(interruptBody.length > 0 && !/beginStop|cancelAsyncMessage/.test(interruptBody), 'interrupt() must not withdraw prompts');
const stopBody = runner.slice(runner.indexOf('    stopTurn: async () => {'), runner.indexOf('    tracksPromptIdentity:'));
assert.match(stopBody, /const stop = promptLifecycle\.beginStop\(\);\s*if \(cancel\) for \(const uuid of stop\.cancel\) void cancel\(uuid\)[\s\S]*stopInterruptGeneration = stop\.generation;[\s\S]*await interruptQuery\(\)/,
  'stopTurn writes the cancels, then the interrupt (tagged with its Stop), without awaiting in between');
assert.ok(!/await[\s\S]*const stop = /.test(stopBody), 'nothing awaited before the cancels');
// Echoes wait for the CLI to take their prompt; prompts never taken come back.
assert.ok(runner.includes('if (promptLifecycle.tracksIdentity && message.uuid) pendingEchoes.set(message.uuid as string, echo);'),
  'a prompt\'s echo waits for the CLI to take it');
assert.match(runner, /onPromptStarted\?\.\(promptFrame\.started\);[\s\S]{0,250}if \(echo\) onMessage\(echo\);/,
  'the prompt is stored before its echo');
// A host prompt that never reached the CLI (Stop while it was still being
// prepared, the runner going away, a failed preparation) goes back too: the
// enqueue marks the hand-over right at the push and reports the rest from
// its finally. The host settles the ledger only for ids it still counts
// (Stop's cancelPendingPrompts already took them out), so nothing twice.
assert.match(runner, /inputQueue\.push\(message\);\s*handedOver = true;/, 'the hand-over is marked right at the push');
assert.match(runner, /promptCancellation\.settle\(seq\);\s*if \(!handedOver && \(promptId \|\| goalSet\)\) handBack\(promptId, \{ submitted: false, goalSet \}\);/,
  'a prompt that never reached the CLI is handed back once — a /goal prompt even without a host id');
assert.ok(runner.includes('for (const uuid of goalPromptUuids) handBack(undefined, { submitted: true, goalSet: true });'),
  'at runner end, a /goal prompt the CLI never took ends its goal start even without a host id');
assert.ok(runner.includes('goalPromptUuids.delete(promptFrame.started.promptId);'), 'a /goal prompt the CLI took is no longer tracked');
// Every exit goes through handBack (goal work, goal-start wait, the host).
assert.ok(runner.includes('const goalSet = isGoalSetPrompt(trimmed);'), 'a /goal prompt is known from the start of its preparation');
assert.ok(runner.includes('handBack(uuid, { submitted: true, goalSet: goalPromptUuids.delete(uuid) });'), 'CLI withdrawals hand back through handBack');
assert.ok(runner.includes('for (const uuid of promptLifecycle.unstarted()) promptWithdrawn(uuid);'), 'the runner-end sweep hands back through handBack');
assert.equal((runner.match(/onPromptsWithdrawn\?\.\(/g) || []).length, 1, 'onPromptsWithdrawn is reached only through handBack');
assert.ok(ipc.includes('const settled = new Set(promptIds.filter((id) => counted.has(id)));'),
  'the ledger only settles ids the runner entry still counts');
const handback = read('src', 'electron', 'libs', 'claude-prompt-handback.ts');
assert.ok(handback.includes('if (prompt.goalSet) deps.rejectGoalStart(new ClaudeGoalWithdrawnError());')
  && runner.includes('rejectGoalStart: (error) => rejectClaudeGoalSet(session.id, error),'),
  'withdrawing a /goal prompt must end its goal-start wait');
assert.ok(runner.includes('if (promptFrame.withdrawn) promptWithdrawn(promptFrame.withdrawn);'),
  'withdrawals come from the frame loop');
assert.ok(runner.includes('interrupt: () => interruptQuery(),'), 'the /goal controller interrupts through interruptQuery (Stop receipt)');
assert.match(runner, /message: \{ content: \[\{ type: 'text', text: trimmed \}\] \},\s*hostEcho: true,/,
  'the runner must mark its own prompt echo');

console.log('verify-claude-steer: ok');
