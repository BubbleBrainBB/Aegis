import assert from 'node:assert/strict';
import { ClaudePromptQueue } from '../../src/electron/libs/claude-prompt-queue';
import { withdrawClaudePrompts } from '../../src/electron/libs/claude-turn-accounting';
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
  assert.equal(queue.observe(result(['a', 'b'])), 2, 'the result answers the opener and the folded steer');
  assert.deepEqual(queue.withdrawable(), [], 'between turns nothing is offered');
  assert.equal(queue.observe(result(['c'])), 0, 'a withdrawn prompt is never counted again');
}
{
  const queue = new ClaudePromptQueue();
  queue.sent('a');
  queue.observe(init);
  queue.sent('b');
  assert.equal(queue.observe(result(['a', 'b'])), 2);
  assert.deepEqual(queue.withdrawn(['b']), [], 'answered meanwhile: not withdrawn, the ledger already settled it');
  assert.equal(queue.observe(result()), undefined, 'older CLIs do not say');
  queue.sent('x');
  queue.observe(init);
  queue.observe({ ...started('x'), parent_tool_use_id: 'task' });
  assert.deepEqual(queue.withdrawable(), ['x'], 'subagent frames never mark a host prompt taken');
}

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

console.log('claude-steer-turn.test.ts passed');
