import assert from 'node:assert/strict';
import { openSelfStartedTurn, settleClaudeResult } from '../../src/electron/libs/claude-turn-accounting';
import { markTurnsStopped } from '../../src/electron/libs/claude-stop-reconcile';

const ledger = (inFlightTurns: number, stoppedTurns: number, selfStartedTurn: boolean) => ({
  inFlightTurns,
  stoppedTurns,
  selfStartedTurn,
});

// A prompted turn answers its prompt, named or not.
assert.deepEqual(settleClaudeResult(ledger(1, 0, false), undefined), { hostPrompts: 1, settledTurns: 1, inFlightTurns: 0, stoppedTurns: 0 });
assert.deepEqual(settleClaudeResult(ledger(1, 0, false), 0), { hostPrompts: 1, settledTurns: 1, inFlightTurns: 0, stoppedTurns: 0 });

// Prompts folded into one turn settle together.
assert.deepEqual(settleClaudeResult(ledger(3, 0, false), 2), { hostPrompts: 2, settledTurns: 2, inFlightTurns: 1, stoppedTurns: 0 });

// A self-started turn answering no prompt settles only itself.
assert.deepEqual(settleClaudeResult(ledger(1, 0, true), undefined), { hostPrompts: 0, settledTurns: 1, inFlightTurns: 0, stoppedTurns: 0 });

// A send counted before the woken turn's first frame: the woken result must
// not consume that prompt.
assert.deepEqual(
  settleClaudeResult(ledger(2, 0, true), undefined),
  { hostPrompts: 0, settledTurns: 1, inFlightTurns: 1, stoppedTurns: 0 },
  'the pending prompt stays in flight'
);

// A prompt folded into the woken turn settles with it.
assert.deepEqual(settleClaudeResult(ledger(2, 0, true), 1), { hostPrompts: 1, settledTurns: 2, inFlightTurns: 0, stoppedTurns: 0 });

// Stop during a woken turn with a folded prompt: one combined result drains
// both counters, so no phantom stopped turn is left to re-interrupt.
assert.deepEqual(
  settleClaudeResult(ledger(2, 2, true), 1),
  { hostPrompts: 1, settledTurns: 2, inFlightTurns: 0, stoppedTurns: 0 },
  'a combined stopped result settles every stopped obligation it closes'
);

// Stopped prompts folded into one result, with a live follow-up behind them.
assert.deepEqual(settleClaudeResult(ledger(3, 2, false), 2), { hostPrompts: 2, settledTurns: 2, inFlightTurns: 1, stoppedTurns: 0 });

// A stopped turn queued behind the one settling stays stopped.
assert.deepEqual(settleClaudeResult(ledger(2, 2, false), undefined), { hostPrompts: 1, settledTurns: 1, inFlightTurns: 1, stoppedTurns: 1 });

// Stopped obligations never exceed what remains in flight.
assert.deepEqual(settleClaudeResult(ledger(1, 3, false), 1), { hostPrompts: 1, settledTurns: 1, inFlightTurns: 0, stoppedTurns: 0 });

// ── Whole sequences, driven the way ipc-handlers drives the ledger ──────────

type Ledger = { inFlightTurns: number; stoppedTurns: number; selfStartedTurn: boolean };
const send = (l: Ledger): Ledger => ({ ...l, inFlightTurns: l.inFlightTurns + 1 });
const stop = (l: Ledger): Ledger => ({ ...l, stoppedTurns: markTurnsStopped(l) });
const result = (l: Ledger, answered?: number) => {
  const s = settleClaudeResult(l, answered);
  return {
    ledger: { inFlightTurns: s.inFlightTurns, stoppedTurns: s.stoppedTurns, selfStartedTurn: false },
    stoppedByUser: l.stoppedTurns > 0,
    reinterrupt: l.stoppedTurns > 0 && s.stoppedTurns > 0,
  };
};

// A woken turn with no stop outstanding runs live.
{
  const opened = openSelfStartedTurn({ inFlightTurns: 0, stoppedTurns: 0, selfStartedTurn: false });
  assert.equal(opened.interrupt, false, 'nothing to stop');
  assert.deepEqual(result(opened).ledger, { inFlightTurns: 0, stoppedTurns: 0, selfStartedTurn: false });
}

// Queued prompt -> Stop -> wake init -> zero-host wake result -> queued prompt.
// The woken turn must not consume the queued prompt's stop.
{
  let l = stop(send({ inFlightTurns: 0, stoppedTurns: 0, selfStartedTurn: false }));
  const opened = openSelfStartedTurn(l);
  assert.equal(opened.interrupt, true, 'a turn woken under an outstanding stop is interrupted');
  const wake = result(opened);
  assert.equal(wake.stoppedByUser, true, 'the woken turn settles as stopped');
  assert.equal(wake.reinterrupt, true, 'the queued stopped prompt is re-interrupted when it starts');
  l = wake.ledger;
  assert.deepEqual(l, { inFlightTurns: 1, stoppedTurns: 1, selfStartedTurn: false });
  const queued = result(l);
  assert.equal(queued.stoppedByUser, true, 'the queued prompt still settles as stopped');
  assert.deepEqual(queued.ledger, { inFlightTurns: 0, stoppedTurns: 0, selfStartedTurn: false });
}

// Same, with a live follow-up sent after the stop: only the follow-up runs live.
{
  let l = send(stop(send({ inFlightTurns: 0, stoppedTurns: 0, selfStartedTurn: false })));
  const wake = result(openSelfStartedTurn(l));
  assert.equal(wake.stoppedByUser, true);
  const stopped = result(wake.ledger);
  assert.equal(stopped.stoppedByUser, true, 'the stopped prompt stays stopped');
  assert.equal(stopped.reinterrupt, false, 'the follow-up is not interrupted');
  const followUp = result(stopped.ledger);
  assert.equal(followUp.stoppedByUser, false, 'the follow-up settles live');
  assert.deepEqual(followUp.ledger, { inFlightTurns: 0, stoppedTurns: 0, selfStartedTurn: false });
}

// Stop during a woken turn, with a prompt queued behind it: both settle stopped.
{
  let l: Ledger = openSelfStartedTurn({ inFlightTurns: 0, stoppedTurns: 0, selfStartedTurn: false });
  l = stop(send(l));
  const wake = result(l);
  assert.equal(wake.stoppedByUser, true);
  assert.equal(wake.reinterrupt, true);
  assert.deepEqual(result(wake.ledger).ledger, { inFlightTurns: 0, stoppedTurns: 0, selfStartedTurn: false });
}

console.log('claude-turn-accounting.test.ts passed');
