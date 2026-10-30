import assert from 'node:assert/strict';
import { ClaudePromptQueue, StopWithdrawalGate, withdrawQueued } from '../../src/electron/libs/claude-prompt-queue';
import { settleClaudeResult, withdrawClaudePrompts } from '../../src/electron/libs/claude-turn-accounting';
import { markTurnsStopped } from '../../src/electron/libs/claude-stop-reconcile';
import { buildSessionUserPromptSummaries } from '../../src/shared/outline-summary';
import { opensTurn } from '../../src/shared/turn-boundary';
import { deriveTranscriptTimelineItems } from '../../src/ui/utils/transcript-timeline';
import { createBatchWorkstreamModel, latestTurnHasPendingSubagentTasks } from '../../src/ui/utils/workstream';
import { buildTurnChangeContext } from '../../src/ui/utils/turn-change-records';
import { useAppStore } from '../../src/ui/store/useAppStore';
import { useComposerQueueStore } from '../../src/ui/store/useComposerQueueStore';
import type { ServerEvent, StreamMessage } from '../../src/ui/types';

// ── Runner prompt queue: what Stop may withdraw ──────────────────────────────

const init = { type: 'system', subtype: 'init' };
const started = (uuid: string) => ({ type: 'command_lifecycle', state: 'started', command_uuid: uuid });
const result = (uuids?: string[]) => ({ type: 'result', ...(uuids ? { user_message_uuids: uuids } : {}) });
{
  const queue = new ClaudePromptQueue();
  queue.sent('a');
  assert.deepEqual(queue.withdrawable(), [], 'nothing is withdrawable before a turn runs (prewait batch)');
  queue.observe(started('a'));
  queue.observe(init);
  queue.sent('b');
  queue.sent('c');
  assert.deepEqual(queue.withdrawable(), ['b', 'c'], 'steers queued behind the live turn');
  queue.observe(started('b')); // folded in between tool rounds
  assert.deepEqual(queue.withdrawable(), ['c'], 'a folded steer rides the turn');
  assert.deepEqual(queue.withdrawn(['c']), ['c']);
  assert.equal(queue.observe(result(['a', 'b'])).answered, 2, 'the result answers the opener and the folded steer');
  assert.deepEqual(queue.withdrawable(), [], 'between turns nothing is offered');
  assert.equal(queue.observe(result(['c'])).answered, 0, 'a withdrawn prompt is never counted again');
}
{
  const queue = new ClaudePromptQueue();
  queue.sent('a');
  queue.observe(init);
  queue.sent('b');
  assert.equal(queue.observe(result(['a', 'b'])).answered, 2);
  assert.deepEqual(queue.withdrawn(['b']), [], 'answered meanwhile: not withdrawn, the ledger already settled it');
  assert.equal(queue.observe(result()).answered, undefined, 'older CLIs do not say');
  queue.sent('x');
  queue.observe(init);
  queue.observe({ ...started('x'), parent_tool_use_id: 'task' });
  assert.deepEqual(queue.withdrawable(), ['x'], 'subagent frames never mark a host prompt taken');
}

// A steer the CLI takes while no turn runs opened a turn of its own (late).
{
  const queue = new ClaudePromptQueue();
  queue.sent('a');
  assert.deepEqual(queue.observe(started('a')), { opened: 'a' }, 'the opener opens its turn');
  queue.observe(init);
  queue.sent('steer');
  assert.deepEqual(queue.observe(started('steer')), {}, 'folded into the live turn: not an opener');
  queue.sent('late');
  queue.observe(result(['a', 'steer']));
  assert.deepEqual(queue.observe(started('late')), { opened: 'late' }, 'taken after the turn ended: it opens the next turn');
  assert.deepEqual(queue.observe(started('late')), {}, 'reported once');
}

// ── Stop: cancels go out before the interrupt, in the same tick ──────────────

void (async () => {
  const queue = new ClaudePromptQueue();
  queue.sent('a');
  queue.observe(started('a'));
  queue.observe(init);
  queue.sent('steer');
  const wire: string[] = [];
  let ack: (value: boolean) => void = () => {};
  const withdrawal = withdrawQueued(queue, (uuid) => {
    wire.push(`cancel ${uuid}`);
    return new Promise<boolean>((resolve) => { ack = resolve; });
  });
  wire.push('interrupt');
  assert.deepEqual(wire, ['cancel steer', 'interrupt'], 'the interrupt is written behind the cancels, before any later send');
  ack(true);
  assert.deepEqual(await withdrawal, ['steer']);
  assert.deepEqual(await withdrawQueued(new ClaudePromptQueue(), undefined), [], 'CLIs without cancel_async_message withdraw nothing');

  // The race: the stopped turn's result lands before the CLI answers the
  // cancel, and the user sends a follow-up after Stop. The result must not
  // re-interrupt (the turn now starting is the follow-up), and once the
  // withdrawal settles nothing Stop covered is left to interrupt.
  let ledger = { inFlightTurns: 2, stoppedTurns: 0 }; // turn A + queued steer
  ledger.stoppedTurns = markTurnsStopped({ ...ledger, stoppedTurns: 0 } as Parameters<typeof markTurnsStopped>[0]);
  assert.equal(ledger.stoppedTurns, 2);
  const gate = new StopWithdrawalGate();
  let releaseCancel: (ids: string[]) => void = () => {};
  const interrupts: string[] = [];
  const settledWith: boolean[] = [];
  gate.begin(new Promise<string[]>((resolve) => { releaseCancel = resolve; }).then((ids) => {
    ledger = withdrawClaudePrompts(ledger, ids.length);
  }), (reinterrupt) => {
    settledWith.push(reinterrupt);
    if (reinterrupt && ledger.stoppedTurns > 0) interrupts.push('reinterrupt');
  });
  const afterResult = settleClaudeResult({ ...ledger, selfStartedTurn: false }, 1);
  ledger = { inFlightTurns: afterResult.inFlightTurns, stoppedTurns: afterResult.stoppedTurns };
  assert.equal(ledger.stoppedTurns, 1, 'the steer being withdrawn still counts as stopped');
  if (!gate.deferReinterrupt()) interrupts.push('reinterrupt');
  ledger.inFlightTurns += 1; // the follow-up sent after Stop (not stopped)
  assert.deepEqual(interrupts, [], 'no re-interrupt while the withdrawal is out');
  releaseCancel(['steer']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(settledWith, [true], 'the waiting re-interrupt is reconsidered once');
  assert.deepEqual(ledger, { inFlightTurns: 1, stoppedTurns: 0 }, 'only the follow-up is in flight');
  assert.deepEqual(interrupts, [], 'the follow-up is never interrupted');
  assert.equal(gate.deferReinterrupt(), false, 'no withdrawal out: re-interrupts go straight through');

  // A steer the CLI would not cancel (it was being folded in) stays stopped:
  // the waiting re-interrupt then goes out for it.
  {
    let stopped = { inFlightTurns: 2, stoppedTurns: 2 };
    const g = new StopWithdrawalGate();
    let done: (ids: string[]) => void = () => {};
    const fired: string[] = [];
    g.begin(new Promise<string[]>((resolve) => { done = resolve; }).then((ids) => {
      stopped = withdrawClaudePrompts(stopped, ids.length);
    }), (reinterrupt) => { if (reinterrupt && stopped.stoppedTurns > 0) fired.push('reinterrupt'); });
    const settled = settleClaudeResult({ ...stopped, selfStartedTurn: false }, 1);
    stopped = { inFlightTurns: settled.inFlightTurns, stoppedTurns: settled.stoppedTurns };
    assert.equal(g.deferReinterrupt(), true);
    done([]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fired, ['reinterrupt']);
  }
  console.log('claude-steer-turn.test.ts: stop withdrawal ordering passed');
})().catch((error) => { console.error(error); process.exit(1); });

// ── Host ledger: withdrawn prompts never get a result ────────────────────────

assert.deepEqual(withdrawClaudePrompts({ inFlightTurns: 3, stoppedTurns: 3 }, 2), { inFlightTurns: 1, stoppedTurns: 1 });
assert.deepEqual(withdrawClaudePrompts({ inFlightTurns: 1, stoppedTurns: 1 }, 1), { inFlightTurns: 0, stoppedTurns: 0 },
  'the stopped turn result landed first: the withdrawal drains the runner');
assert.deepEqual(withdrawClaudePrompts({ inFlightTurns: 1, stoppedTurns: 0 }, 3), { inFlightTurns: 0, stoppedTurns: 0 });

// ── Turn boundaries: a steer joins the turn ───────────────────────────────────

const opener: StreamMessage = { type: 'user_prompt', prompt: 'Run the checks', createdAt: 100 };
const steer: StreamMessage = { type: 'user_prompt', prompt: 'Also lint', createdAt: 300, steer: true, promptId: 'p-steer' };
const echo: StreamMessage = {
  type: 'user', uuid: 'p-steer', message: { content: [{ type: 'text', text: 'Also lint' }] }, hostEcho: true, createdAt: 301,
} as StreamMessage;
const assistant = (uuid: string, createdAt: number, content: unknown[], phase?: 'commentary' | 'final_answer') => ({
  type: 'assistant', uuid, createdAt, agentId: 'claude', agentRunId: 'run-1',
  ...(phase ? { phase } : {}), message: { content },
}) as StreamMessage;
const bash = assistant('a-bash', 200, [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 20' } }]);
const bashResult: StreamMessage = {
  type: 'user', uuid: 'u-result', createdAt: 320,
  message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
} as StreamMessage;
const lint = assistant('a-lint', 400, [{ type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'npm run lint' } }]);
const lintResult: StreamMessage = {
  type: 'user', uuid: 'u-lint', createdAt: 450,
  message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'clean' }] },
} as StreamMessage;
const answer = assistant('a-answer', 600, [{ type: 'text', text: 'Checks and lint pass.' }], 'final_answer');
const done: StreamMessage = {
  type: 'result', subtype: 'success', duration_ms: 25000, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, createdAt: 700,
} as StreamMessage;
const turn = [opener, bash, steer, echo, bashResult, lint, lintResult, answer, done];

assert.equal(opensTurn(opener), true);
assert.equal(opensTurn(steer), false);

function steeredTimeline(messages: StreamMessage[], running: boolean) {
  const timeline = deriveTranscriptTimelineItems(messages, { sessionRunning: running, activeTurnStartIndex: 0 });
  const prompts = timeline.filter(item => item.type === 'message' && item.message.type === 'user_prompt');
  assert.equal(prompts.length, 1, 'only the opener is a bubble; the steer does not split the turn');
  const work = timeline.filter(item => item.type === 'work');
  assert.equal(work.length, 1, 'one work fold for the whole steered turn');
  const group = work[0];
  assert(group.type === 'work');
  const model = createBatchWorkstreamModel({
    messages: group.group.messages, toolStatusMap: new Map(), toolResultsMap: new Map(), isSessionRunning: group.active,
  });
  return { timeline, group, entries: model.entries };
}

{
  const { timeline, group, entries } = steeredTimeline(turn, false);
  const kinds = entries.map(entry => entry.type);
  assert.deepEqual(kinds.filter(kind => kind !== 'note'), ['tool', 'steer', 'tool'], 'the steer sits in the trace where it joined');
  const row = entries.find(entry => entry.type === 'steer');
  assert.equal(row?.summary, 'Also lint');
  assert.equal(group.group.durationMs, 25000, 'the fold times the whole turn, not the half before the steer');
  const answerIndex = timeline.findIndex(item => item.type === 'message' && item.message.type === 'assistant');
  assert(answerIndex > timeline.indexOf(group), 'the final answer stays below the fold');
}
{
  const { group, entries } = steeredTimeline(turn.slice(0, 6), true);
  assert.equal(group.active, true, 'mid-run the fold is the live work');
  assert(entries.some(entry => entry.type === 'steer'));
}

// Latest-turn scans start at the opener, not the steer.
{
  const task = assistant('a-task', 200, [{ type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'bg', prompt: 'x' } }]);
  assert.equal(latestTurnHasPendingSubagentTasks([opener, task, steer, echo]), true,
    'a subagent started before the steer still holds the session busy');
}
{
  const write = (uuid: string, createdAt: number, file: string) =>
    assistant(uuid, createdAt, [{ type: 'tool_use', id: `w-${uuid}`, name: 'Write', input: { file_path: file, content: 'x' } }]);
  const wrote = (uuid: string, createdAt: number) => ({
    type: 'user', uuid: `r-${uuid}`, createdAt,
    message: { content: [{ type: 'tool_result', tool_use_id: `w-${uuid}`, content: 'ok' }] },
  }) as StreamMessage;
  const { turns } = buildTurnChangeContext(
    [opener, write('one', 200, '/tmp/a.ts'), wrote('one', 210), steer, echo, write('two', 400, '/tmp/b.ts'), wrote('two', 410), answer, done],
    '/tmp'
  );
  assert.equal(turns.length, 1, 'a steered turn is one change card, not two');
}

// The outline keeps one entry per turn: the steer's reply and files stay with the opener.
{
  const outline = buildSessionUserPromptSummaries([opener, bash, steer, echo, bashResult, lint, lintResult, answer, done]);
  assert.equal(outline.length, 1, 'no outline entry for a steer (it has no bubble to jump to)');
  assert.equal(outline[0].text, 'Run the checks');
  assert.equal(outline[0].replyText, 'Checks and lint pass.', 'the reply after the steer belongs to the opener');
}

// ── Store: Stop hands withdrawn steers back to the composer queue ────────────

const id = useAppStore.getState().createDraftSession('/tmp/claude-steer-turn');
const dispatch = (event: ServerEvent) => useAppStore.getState().handleServerEvent(event);
useAppStore.setState(state => ({ sessions: { ...state.sessions, [id]: {
  ...state.sessions[id], provider: 'claude', status: 'running', messages: [],
  streaming: { text: '', thinking: '', isStreaming: false },
} } }));
const send = (prompt: string, promptId: string) => {
  dispatch({ type: 'stream.user_prompt', payload: { sessionId: id, prompt, createdAt: Date.now(), steer: true, promptId } } as ServerEvent);
  dispatch({ type: 'stream.message', payload: { sessionId: id, message: {
    type: 'user', uuid: promptId, message: { content: [{ type: 'text', text: prompt }] }, hostEcho: true,
  } } } as ServerEvent);
};
send('first steer', 's1');
send('second steer', 's2');
useComposerQueueStore.getState().enqueue(id, {
  id: 'later', displayPrompt: 'queued after', effectivePrompt: 'queued after', attachments: [], references: {},
});
dispatch({ type: 'stream.prompts_withdrawn', payload: { sessionId: id, promptIds: ['s1', 's2', 'hidden'], prompts: [
  { promptId: 's1', prompt: 'first steer', effectivePrompt: 'first steer', attachments: [] },
  { promptId: 's2', prompt: 'second steer', effectivePrompt: 'second steer (resolved)', attachments: [] },
] } } as ServerEvent);
const left = useAppStore.getState().sessions[id].messages;
assert.equal(left.length, 0, 'withdrawn bubbles and their host echoes leave the transcript');
assert.deepEqual(
  (useComposerQueueStore.getState().queues[id] ?? []).map(item => [item.displayPrompt, item.effectivePrompt]),
  [['first steer', 'first steer'], ['second steer', 'second steer (resolved)'], ['queued after', 'queued after']],
  'withdrawn steers return ahead of later queued messages, as they were sent'
);

// A late steer opened its own turn: the store makes it that turn's opener,
// after the previous turn's result, and the timeline shows two turns.
{
  const lateId = useAppStore.getState().createDraftSession('/tmp/claude-steer-late');
  const late: StreamMessage = { type: 'user_prompt', prompt: 'One more thing', createdAt: 500, steer: true, promptId: 'p-late' };
  const firstAnswer = assistant('a-first', 600, [{ type: 'text', text: 'First answer.' }], 'final_answer');
  const secondAnswer = assistant('a-second', 900, [{ type: 'text', text: 'Second answer.' }], 'final_answer');
  useAppStore.setState(state => ({ sessions: { ...state.sessions, [lateId]: {
    ...state.sessions[lateId], provider: 'claude', status: 'running',
    messages: [opener, bash, late, bashResult, firstAnswer, done],
    streaming: { text: '', thinking: '', isStreaming: false },
  } } }));
  dispatch({ type: 'stream.prompt_opened_turn', payload: { sessionId: lateId, promptId: 'p-late', createdAt: 800 } } as ServerEvent);
  const moved = useAppStore.getState().sessions[lateId].messages;
  const lastPrompt = moved.at(-1);
  assert(lastPrompt?.type === 'user_prompt' && lastPrompt.prompt === 'One more thing');
  assert.equal(lastPrompt.steer, undefined, 'no longer a steer');
  assert.equal(lastPrompt.createdAt, 800, 'it opens the turn when that turn opened');
  const timeline = deriveTranscriptTimelineItems([...moved, secondAnswer], { sessionRunning: false });
  const bubbles = timeline.filter(item => item.type === 'message' && item.message.type === 'user_prompt');
  assert.equal(bubbles.length, 2, 'the late steer is its own turn, as a bubble');
  const answers = timeline.filter(item => item.type === 'message' && item.message.type === 'assistant');
  assert.equal(answers.length, 2, 'each turn keeps its own visible answer');
}

console.log('claude-steer-turn.test.ts passed');
