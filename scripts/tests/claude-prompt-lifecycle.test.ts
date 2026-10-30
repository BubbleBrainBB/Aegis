import assert from 'node:assert/strict';
import { ClaudePromptLifecycle, type PromptFrame } from '../../src/electron/libs/claude-prompt-lifecycle';
import { settleClaudeResult, withdrawClaudePrompts } from '../../src/electron/libs/claude-turn-accounting';
import {
  classifyResultForStop,
  markTurnsStopped,
  shouldAutoDenyPermission,
} from '../../src/electron/libs/claude-stop-reconcile';

// Frames as the Claude CLI emits them (recorded from Claude Code with
// cancel_async_message + interrupt, and with two prompts queued behind a turn).
const queued = (uuid: string) => ({ type: 'command_lifecycle', state: 'queued', command_uuid: uuid });
const started = (uuid: string) => ({ type: 'command_lifecycle', state: 'started', command_uuid: uuid });
const cancelled = (uuid: string) => ({ type: 'command_lifecycle', state: 'cancelled', command_uuid: uuid });
const completed = (uuid: string) => ({ type: 'command_lifecycle', state: 'completed', command_uuid: uuid });
const init = { type: 'system', subtype: 'init' };
const result = (uuids: string[]) => ({ type: 'result', user_message_uuids: uuids });

/**
 * The host's turn ledger, driven exactly as ipc-handlers drives it: Stop marks
 * every in-flight turn stopped; a withdrawal settles both counts; a result is
 * classified against the state before it settles. Output, permissions and the
 * result of a turn are suppressed/denied/idled while stopped turns remain.
 */
class HostLedger {
  inFlightTurns = 0;
  stoppedTurns = 0;
  dispatch() { this.inFlightTurns += 1; }
  stop() { this.stoppedTurns = markTurnsStopped(this); }
  withdrawn(count: number) { Object.assign(this, withdrawClaudePrompts(this, count)); }
  result(answered: number | undefined) {
    const classification = classifyResultForStop(this);
    const settled = settleClaudeResult({ ...this, selfStartedTurn: false }, answered);
    this.inFlightTurns = settled.inFlightTurns;
    this.stoppedTurns = settled.stoppedTurns;
    return classification;
  }
  /** What the host does with output and permission requests of the turn running now. */
  get treatsRunningTurnAsStopped() { return shouldAutoDenyPermission(this); }
}

/** Runner + host wired as in production: frames in stream order, host callbacks synchronous. */
function harness() {
  const lifecycle = new ClaudePromptLifecycle();
  const host = new HostLedger();
  const events: string[] = [];
  const feed = (frame: object): PromptFrame => {
    const out = lifecycle.observe(frame);
    if (out.withdrawn) { host.withdrawn(1); events.push(`withdrawn ${out.withdrawn}`); }
    if (out.opened) events.push(`opened ${out.opened}`);
    if (out.joined) events.push(`joined ${out.joined.promptId}<${out.joined.openerId}`);
    if (out.interrupt) events.push('interrupt');
    return out;
  };
  const send = (uuid: string, withdrawable = true) => { lifecycle.sent(uuid, withdrawable); host.dispatch(); };
  return { lifecycle, host, events, feed, send };
}

// ── F1: Stop withdraws a queued steer; the follow-up sent after Stop runs clean ──
{
  const { lifecycle, host, events, feed, send } = harness();
  send('A'); feed(queued('A')); feed(started('A')); feed(init);
  send('B'); feed(queued('B'));                          // steer queued behind A
  host.stop();
  const cancels = lifecycle.beginStop();
  assert.deepEqual(cancels, ['B'], 'Stop cancels the queued steer, never the running turn');
  assert.equal(host.stoppedTurns, 2);
  // CLI order (recorded): cancelled B, then the interrupted result of A,
  // then the follow-up C sent after Stop.
  feed(cancelled('B'));
  assert.deepEqual(events, ['opened A', 'withdrawn B'], 'withdrawn in stream order, before the stopped result');
  assert.deepEqual(host, Object.assign(new HostLedger(), { inFlightTurns: 1, stoppedTurns: 1 }));
  send('C'); feed(queued('C'));                          // the user's follow-up after Stop
  const stoppedResult = host.result(feed(result(['A'])).answered);
  assert.equal(stoppedResult.stoppedByUser, true, "A's result is the stopped turn's");
  feed(cancelled('A'));                                  // A's terminal frame: an interrupted turn, not a withdrawal
  assert.equal(events.includes('withdrawn A'), false);
  assert.equal(lifecycle.stopReceipt([]), false, 'nothing the Stop missed');
  feed(started('C'));
  feed(init);
  assert.equal(host.stoppedTurns, 0, "C's turn starts with nothing stopped left");
  assert.equal(host.treatsRunningTurnAsStopped, false, "C's output is kept and its permission requests reach the user");
  const followUp = host.result(feed(result(['C'])).answered);
  assert.equal(followUp.stoppedByUser, false, "C's result completes the session normally");
  assert.deepEqual(host, Object.assign(new HostLedger(), { inFlightTurns: 0, stoppedTurns: 0 }));
  assert.deepEqual(events, ['opened A', 'withdrawn B', 'opened C'], 'C is never interrupted');
}

// The old failure mode, for contrast: settling the withdrawal from the cancel
// RESPONSE (out of band) instead of the frame lets C run while B still counts.
{
  const host = new HostLedger();
  host.dispatch(); host.dispatch();
  host.stop();
  host.result(1);                                        // A's stopped result
  host.dispatch();                                       // C
  assert.equal(host.treatsRunningTurnAsStopped, true, 'without in-order settlement C would be treated as stopped');
}

// ── A steer the cancel could not reach (it was being folded into A) ──────────
{
  const { lifecycle, host, events, feed, send } = harness();
  send('A'); feed(started('A')); feed(init);
  send('B'); feed(queued('B'));
  feed(started('B'));                                    // folded in between tool rounds
  host.stop();
  assert.deepEqual(lifecycle.beginStop(), [], 'already started: nothing to cancel');
  assert.equal(lifecycle.stopReceipt([]), false);
  send('C');
  host.result(feed(result(['A', 'B'])).answered);       // A's turn answers the folded steer too
  assert.equal(host.stoppedTurns, 0);
  feed(started('C')); feed(init);
  assert.equal(host.treatsRunningTurnAsStopped, false);
  assert.deepEqual(events, ['opened A', 'opened C']);
}

// ── A finished on its own just before the Stop reached the CLI: B already started ──
{
  const { lifecycle, host, events, feed, send } = harness();
  send('A'); feed(started('A')); feed(init);
  send('B'); feed(queued('B'));
  host.stop();
  const cancels = lifecycle.beginStop();                  // host has not seen A's result yet
  assert.deepEqual(cancels, ['B']);
  host.result(feed(result(['A'])).answered);             // A ended naturally
  feed(completed('A'));
  feed(started('B'));                                     // B opened before the cancel arrived: cancel refused
  feed(init);
  assert.equal(lifecycle.stopReceipt([]), false, "the Stop's interrupt reaches B (it is running): no second interrupt");
  assert.equal(host.treatsRunningTurnAsStopped, true, "B is stopped: its output is the stopped turn's drain");
  send('C');
  host.result(feed(result(['B'])).answered);
  feed(started('C')); feed(init);
  assert.equal(host.treatsRunningTurnAsStopped, false, 'C runs clean');
  assert.deepEqual(events, ['opened A', 'opened B', 'opened C'], 'no interrupt of our own: the Stop covered B');
}

// ── Stop between turns: the next batch was already parked ─────────────────────
{
  const { lifecycle, events, feed, send } = harness();
  send('A'); feed(started('A')); feed(init); feed(result(['A']));
  send('B'); feed(queued('B'));                           // parked for the next turn
  assert.deepEqual(lifecycle.beginStop(), ['B'], 'still cancelled by uuid (a parked batch refuses it)');
  assert.equal(lifecycle.stopReceipt(['B']), false, 'the interrupt could not reach B: noted');
  send('C');
  const opened = feed(started('B'));
  assert.equal(opened.interrupt, true, 'B is interrupted when its turn opens');
  feed(init); feed(result(['B']));
  const follow = feed(started('C'));
  assert.equal(follow.interrupt, undefined, 'the follow-up sent after Stop is never interrupted');
  assert.deepEqual(events, ['opened A', 'opened B', 'interrupt', 'opened C']);
}

// A stopped prompt that already opened the running turn when the receipt lands.
{
  const { lifecycle, feed, send } = harness();
  send('A'); feed(started('A')); feed(init); feed(result(['A']));
  send('B'); feed(queued('B'));
  lifecycle.beginStop();
  feed(started('B'));                                     // our consumer saw it before the receipt
  assert.equal(lifecycle.stopReceipt(['B']), true, 'interrupt it now');
  assert.equal(lifecycle.stopReceipt(['B']), false, 'only the Stop\'s own receipt counts, once');
}

// ── Late steers: the CLI takes two queued prompts as one batch (recorded) ─────
{
  const { events, feed, send } = harness();
  send('A'); feed(queued('A')); feed(started('A')); feed(init);
  send('B'); send('C'); feed(queued('B')); feed(queued('C'));
  feed(result(['A'])); feed(completed('A'));
  feed(started('B')); feed(started('C')); feed(init);
  assert.deepEqual(events, ['opened A', 'opened B', 'joined C<B'], 'one opener per turn; the rest joined its batch');
  assert.equal(feed(result(['B', 'C'])).answered, 2);
}

// ── Older CLIs: no lifecycle frames, nothing tracked, nothing withdrawn ──────
{
  const lifecycle = new ClaudePromptLifecycle();
  lifecycle.sent('A', true);
  lifecycle.observe(init);
  lifecycle.sent('B', true);
  assert.equal(lifecycle.tracksIdentity, false);
  assert.deepEqual(lifecycle.beginStop(), []);
  assert.equal(lifecycle.stopReceipt(['B']), false);
  assert.equal(lifecycle.observe({ type: 'result' }).answered, undefined);
}

// A prompt the host does not know by id is never cancelled (nothing could settle it).
{
  const lifecycle = new ClaudePromptLifecycle();
  lifecycle.sent('A', true);
  lifecycle.observe(started('A')); lifecycle.observe(init);
  lifecycle.sent('anon', false);
  lifecycle.observe(queued('anon'));
  assert.deepEqual(lifecycle.beginStop(), []);
}

// Subagent frames never touch the host's prompts.
{
  const lifecycle = new ClaudePromptLifecycle();
  lifecycle.sent('A', true);
  assert.deepEqual(lifecycle.observe({ ...started('A'), parent_tool_use_id: 'task' }), {});
  assert.deepEqual(lifecycle.observe(started('A')), { opened: 'A' });
}

console.log('claude-prompt-lifecycle.test.ts passed');
