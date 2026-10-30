import assert from 'node:assert/strict';
import { planClaudeSend } from '../../src/electron/libs/claude-steer';
import { StreamRetryTracker } from '../../src/electron/libs/stream-retry-tracker';
import { restoreRetryHistory } from '../../src/ui/utils/stream-retry';
import { useAppStore } from '../../src/ui/store/useAppStore';
import type { ServerEvent, StreamMessage } from '../../src/ui/types';

// ── planClaudeSend ───────────────────────────────────────────────────────────

const steady = { configDrift: false, hadInvalidThinking: false, model: 'opus' };
const live = { inFlightTurns: 1, claudeModel: 'opus' };

{
  const plan = planClaudeSend(live, steady);
  assert.deepEqual(plan, { midTurn: true, respawn: false, markStaleConfig: false, sendModel: 'opus' },
    'a plain steer joins the live turn');
}
{
  const plan = planClaudeSend(live, { ...steady, configDrift: true, model: 'sonnet' });
  assert.equal(plan.respawn, false, 'drift must not kill the live turn');
  assert.equal(plan.markStaleConfig, true, 'drift is deferred to the drain');
  assert.equal(plan.sendModel, 'opus', 'the live turn keeps its model: no setModel mid-turn');
}
{
  const plan = planClaudeSend({ ...live, claudeModel: undefined }, { ...steady, configDrift: true, model: 'sonnet' });
  assert.equal(plan.sendModel, undefined, 'a runner spawned on the default model stays on it');
}
{
  // Streamed invalid thinking dooms the runner before its result lands; the
  // stored history is already sanitized, so hadInvalidThinking is false.
  const plan = planClaudeSend({ ...live, doomed: true }, steady);
  assert.equal(plan.respawn, true, 'a poisoned runner is never fed a steer');
  assert.equal(plan.markStaleConfig, false);
}
assert.equal(planClaudeSend({ ...live, autoApprove: true }, steady).respawn, true,
  'an automation runner never takes a human turn');
assert.equal(planClaudeSend(live, { ...steady, hadInvalidThinking: true }).respawn, true);
{
  const idle = { inFlightTurns: 0, claudeModel: 'opus' };
  assert.deepEqual(planClaudeSend(idle, steady), { midTurn: false, respawn: false, markStaleConfig: false, sendModel: 'opus' });
  const drift = planClaudeSend(idle, { ...steady, configDrift: true, model: 'sonnet' });
  assert.equal(drift.respawn, true, 'idle drift respawns as before');
  assert.equal(planClaudeSend({ ...idle, staleConfig: true }, steady).respawn, true,
    'a staleConfig runner that was not retired yet still respawns once idle');
}
{
  const stopped = { inFlightTurns: 1, stoppedTurns: 1, claudeModel: 'opus' };
  const plan = planClaudeSend(stopped, { ...steady, configDrift: true, model: 'sonnet' });
  assert.equal(plan.midTurn, false, 'a user-stopped turn is not live');
  assert.equal(plan.respawn, true);
  assert.equal(planClaudeSend({ inFlightTurns: 2, stoppedTurns: 1 }, steady).midTurn, true,
    'a live follow-up behind a stopped turn is steerable');
}
// A self-started (background-wake) turn counts in inFlightTurns like a sent prompt.
assert.equal(planClaudeSend({ inFlightTurns: 1 }, steady).midTurn, true);

// ── Retry tracker: the host echo of a steer is not a recovered connection ────

const echo = (text: string): StreamMessage => ({
  type: 'user', uuid: `echo-${text}`, message: { content: [{ type: 'text', text }] }, hostEcho: true,
} as StreamMessage);
const retry = (attempt = 1): StreamMessage => ({ type: 'system', subtype: 'api_retry',
  uuid: `retry-${attempt}`, session_id: 's', attempt, maxRetries: 10, delayMs: 500, errorStatus: null,
} as StreamMessage);
const thinking = (text: string): StreamMessage => ({ type: 'stream_event', event: {
  type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text },
} } as StreamMessage);
const textDelta = (text: string): StreamMessage => ({ type: 'stream_event', event: {
  type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
} } as StreamMessage);
{
  const tracker = new StreamRetryTracker();
  tracker.observe(thinking('Partial'));
  tracker.observe(retry());
  assert.equal(tracker.observe(echo('steer')).resolved, undefined, 'a steer echo must not resolve a pending retry');
  assert.ok(tracker.observe(thinking('Recovered')).resolved, 'real output still resolves it');
}

// History reload: a persisted steer prompt does not end the retry either.
{
  const restored = restoreRetryHistory([
    retry(),
    { type: 'user_prompt', prompt: 'steer', steer: true, createdAt: 1 } as StreamMessage,
    echo('steer'),
  ], 'running');
  assert.equal(restored.streaming.retry?.uuid, 'retry-1', 'reload keeps the retry pending across a steer');
}

// ── Store: a steer keeps the live turn's streaming state ─────────────────────

const id = useAppStore.getState().createDraftSession('/tmp/claude-steer');
const read = () => useAppStore.getState().sessions[id];
const dispatch = (event: ServerEvent) => useAppStore.getState().handleServerEvent(event);
const emit = (message: StreamMessage) => dispatch({ type: 'stream.message', payload: { sessionId: id, message } } as ServerEvent);
const flush = () => dispatch({ type: 'session.status', payload: { sessionId: id, status: 'running' } } as ServerEvent);
const prompt = (text: string, steer?: boolean) => dispatch({
  type: 'stream.user_prompt', payload: { sessionId: id, prompt: text, createdAt: Date.now(), ...(steer ? { steer } : {}) },
} as ServerEvent);
const reset = () => useAppStore.setState(s => ({ sessions: { ...s.sessions, [id]: {
  ...s.sessions[id], provider: 'claude', status: 'running', messages: [],
  streaming: { text: '', thinking: '', isStreaming: false },
} } }));

reset();
emit(textDelta('Hello '));
flush();
emit(textDelta('wor')); // Still buffered in the coalescer when the steer lands.
prompt('steer', true);
emit(echo('steer'));
emit(textDelta('ld'));
flush();
assert.equal(read().streaming.text, 'Hello world', 'a steer flushes buffered deltas and keeps the partial text');
assert.equal(read().messages.filter(m => m.type === 'user_prompt').length, 1);

reset();
emit(thinking('Considering '));
flush();
prompt('steer', true);
emit(echo('steer'));
emit(thinking('options'));
flush();
assert.equal(read().streaming.thinking, 'Considering options', 'a steer keeps the partial thinking');

reset();
emit(thinking('Original thought'));
emit(retry());
prompt('steer', true);
emit(echo('steer'));
assert.equal(read().streaming.retry?.uuid, 'retry-1', 'a steer during an API retry keeps the retry indicator');
assert.equal(read().streaming.thinking, 'Original thought');
assert.equal(read().messages.filter(m => m.type === 'assistant' && m.interrupted).length, 0,
  'the retry is not archived by the steer');

// A new turn's prompt still resets everything, as before.
reset();
emit(textDelta('Previous answer'));
flush();
prompt('next turn');
assert.equal(read().streaming.text, '', 'a turn-starting prompt resets the streaming buffer');
emit(textDelta('Fresh'));
flush();
emit(echo('next turn'));
assert.equal(read().streaming.text, 'Fresh', 'the host echo never clears streaming output');

console.log('claude-steer.test.ts passed');
