import assert from 'node:assert/strict';
import { withdrawClaudePrompts } from '../../src/electron/libs/claude-turn-accounting';
import { buildSessionUserPromptSummaries } from '../../src/shared/outline-summary';
import { opensTurn } from '../../src/shared/turn-boundary';
import { deriveTranscriptTimelineItems } from '../../src/ui/utils/transcript-timeline';
import { createBatchWorkstreamModel, latestTurnHasPendingSubagentTasks } from '../../src/ui/utils/workstream';
import { buildTurnChangeContext } from '../../src/ui/utils/turn-change-records';
import { useAppStore } from '../../src/ui/store/useAppStore';
import { useComposerQueueStore } from '../../src/ui/store/useComposerQueueStore';
import type { ServerEvent, StreamMessage } from '../../src/ui/types';

// ── Host ledger: withdrawn prompts never get a result ────────────────────────

assert.deepEqual(withdrawClaudePrompts({ inFlightTurns: 3, stoppedTurns: 3 }, 2), { inFlightTurns: 1, stoppedTurns: 1 });
assert.deepEqual(withdrawClaudePrompts({ inFlightTurns: 1, stoppedTurns: 1 }, 1), { inFlightTurns: 0, stoppedTurns: 0 },
  'the stopped turn result landed first: the withdrawal drains the runner');
assert.deepEqual(withdrawClaudePrompts({ inFlightTurns: 1, stoppedTurns: 0 }, 3), { inFlightTurns: 0, stoppedTurns: 0 });

// ── Turn boundaries: a steer joins the turn ───────────────────────────────────

const opener: StreamMessage = { type: 'user_prompt', prompt: 'Run the checks', createdAt: 100 };
// Sent at 300, read by Claude at 330 once the running tool finished.
const steer: StreamMessage = { type: 'user_prompt', prompt: 'Also lint', createdAt: 300, startedAt: 330, steer: true, promptId: 'p-steer' };
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

// A steer reads as the user's message, as Codex steers do: a bubble where it
// joined the turn, with the work before and after it on either side.
{
  const timeline = deriveTranscriptTimelineItems(turn, { sessionRunning: false, activeTurnStartIndex: 0 });
  const shape = timeline.map(item => item.type === 'work' ? 'work'
    : item.message.type === 'user_prompt' ? `prompt ${item.message.prompt}` : item.message.type);
  assert.deepEqual(shape.filter(kind => kind !== 'result' && kind !== 'user'),
    ['prompt Run the checks', 'work', 'prompt Also lint', 'work', 'assistant'],
    'the steer is a bubble between the work before and after it, never a trace row');
  for (const item of timeline) {
    if (item.type !== 'work') continue;
    const model = createBatchWorkstreamModel({
      messages: item.group.messages, toolStatusMap: new Map(), toolResultsMap: new Map(), isSessionRunning: false,
    });
    assert(model.entries.every(entry => (entry as { summary?: string }).summary !== 'Also lint'), 'no steer row in the trace');
  }
  const work = timeline.filter(item => item.type === 'work');
  assert.deepEqual(work.map(item => item.type === 'work' && item.canCollapse), [true, true],
    'the work before the steer was not stopped: it folds like finished work');
  assert.deepEqual(work.map(item => item.type === 'work' && item.group.durationMs), [230, 370],
    'each stretch times itself: up to when Claude read the steer, then from there to the result');
}
{
  // Mid-run the live segment is the one after the latest bubble.
  const live = turn.slice(0, 6);
  const timeline = deriveTranscriptTimelineItems(live, { sessionRunning: true, activeTurnStartIndex: live.indexOf(steer) });
  const work = timeline.filter(item => item.type === 'work');
  assert.deepEqual(work.map(item => item.type === 'work' && item.active), [false, true]);
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

// The outline lists the steer's bubble like any other.
{
  const outline = buildSessionUserPromptSummaries([opener, bash, steer, echo, bashResult, lint, lintResult, answer, done]);
  assert.deepEqual(outline.map(entry => entry.text), ['Run the checks', 'Also lint']);
}

// ── Store: Stop hands withdrawn steers back to the composer queue ────────────

const id = useAppStore.getState().createDraftSession('/tmp/claude-steer-turn');
const dispatch = (event: ServerEvent) => useAppStore.getState().handleServerEvent(event);
useAppStore.setState(state => ({ sessions: { ...state.sessions, [id]: {
  ...state.sessions[id], provider: 'claude', status: 'running', messages: [],
  streaming: { text: '', thinking: '', isStreaming: false },
} } }));
// Deferred prompts are shown at once but never echoed or stored until the CLI
// takes them; a withdrawal removes the bubble and hands the prompt back.
const send = (prompt: string, promptId: string) => {
  dispatch({ type: 'stream.user_prompt', payload: { sessionId: id, prompt, createdAt: Date.now(), steer: true, promptId, deferred: true } } as ServerEvent);
};
send('first steer', 's1');
send('second steer', 's2');
assert.deepEqual(useAppStore.getState().sessions[id].pendingPrompts?.map(m => m.prompt), ['first steer', 'second steer'],
  'unread prompts wait below the transcript, in send order');
assert.equal(useAppStore.getState().sessions[id].messages.length, 0);
useComposerQueueStore.getState().enqueue(id, {
  id: 'later', displayPrompt: 'queued after', effectivePrompt: 'queued after', attachments: [], references: {},
});
const draft = (promptId: string, prompt: string, sentAt: number, effectivePrompt = prompt) =>
  ({ promptId, prompt, effectivePrompt, attachments: [], sentAt });
// The CLI's frames withdraw one prompt at a time: s1's frame, then s2's.
dispatch({ type: 'stream.prompts_withdrawn', payload: { sessionId: id, promptIds: ['s1'], prompts: [draft('s1', 'first steer', 100)] } } as ServerEvent);
dispatch({ type: 'stream.prompts_withdrawn', payload: { sessionId: id, promptIds: ['s2', 'hidden'], prompts: [
  draft('s2', 'second steer', 200, 'second steer (resolved)'),
] } } as ServerEvent);
assert.equal(useAppStore.getState().sessions[id].messages.length, 0, 'unread prompts never sit in the transcript');
assert.deepEqual(useAppStore.getState().sessions[id].pendingPrompts, [], 'withdrawn bubbles leave the bottom of the transcript');
assert.deepEqual(
  (useComposerQueueStore.getState().queues[id] ?? []).map(item => [item.displayPrompt, item.effectivePrompt]),
  [['first steer', 'first steer'], ['second steer', 'second steer (resolved)'], ['queued after', 'queued after']],
  'withdrawn prompts return in send order across separate hand-backs, ahead of later queued messages'
);
// Handed back out of order (the runner went away with one, a frame withdrew another).
{
  const otherId = useAppStore.getState().createDraftSession('/tmp/claude-steer-order');
  dispatch({ type: 'stream.prompts_withdrawn', payload: { sessionId: otherId, promptIds: ['b'], prompts: [draft('b', 'second', 20)] } } as ServerEvent);
  dispatch({ type: 'stream.prompts_withdrawn', payload: { sessionId: otherId, promptIds: ['a'], prompts: [draft('a', 'first', 10)] } } as ServerEvent);
  assert.deepEqual((useComposerQueueStore.getState().queues[otherId] ?? []).map(item => item.displayPrompt), ['first', 'second']);
}

// The CLI takes deferred prompts: each moves to the end of the stream right
// now — a steer if it folded into the running turn or joined a batch, the
// opening prompt of a new turn otherwise. Its echo arrives after it.
{
  const lateId = useAppStore.getState().createDraftSession('/tmp/claude-steer-late');
  const late: StreamMessage = { type: 'user_prompt', prompt: 'One more thing', createdAt: 500, steer: true, promptId: 'p-late' };
  const firstAnswer = assistant('a-first', 600, [{ type: 'text', text: 'First answer.' }], 'final_answer');
  const secondAnswer = assistant('a-second', 900, [{ type: 'text', text: 'Second answer.' }], 'final_answer');
  useAppStore.setState(state => ({ sessions: { ...state.sessions, [lateId]: {
    ...state.sessions[lateId], provider: 'claude', status: 'running',
    messages: [opener, bash, bashResult, firstAnswer, done],
    pendingPrompts: [late],
    streaming: { text: '', thinking: '', isStreaming: false },
  } } }));
  dispatch({ type: 'stream.prompt_started', payload: { sessionId: lateId, promptId: 'p-late', steer: false, startedAt: 750 } } as ServerEvent);
  dispatch({ type: 'stream.message', payload: { sessionId: lateId, message: echo } } as ServerEvent);
  const moved = useAppStore.getState().sessions[lateId].messages;
  const lastPrompt = moved.at(-2);
  assert(lastPrompt?.type === 'user_prompt' && lastPrompt.prompt === 'One more thing', 'it now opens the turn after the previous result');
  assert.equal(lastPrompt.steer, undefined, 'no longer a steer');
  assert.equal(lastPrompt.startedAt, 750, 'it records when Claude read it');
  assert.equal(lastPrompt.createdAt, 500, 'and keeps when it was sent');
  assert.deepEqual(useAppStore.getState().sessions[lateId].pendingPrompts, [], 'it left the bottom for its place');
  const timeline = deriveTranscriptTimelineItems([...moved, secondAnswer], { sessionRunning: false });
  assert.equal(timeline.filter(item => item.type === 'message' && item.message.type === 'user_prompt').length, 2,
    'the late steer is its own turn, as a bubble');
  assert.equal(timeline.filter(item => item.type === 'message' && item.message.type === 'assistant').length, 2,
    'each turn keeps its own visible answer');
}
{
  const batchId = useAppStore.getState().createDraftSession('/tmp/claude-steer-batch');
  const b: StreamMessage = { type: 'user_prompt', prompt: 'Late B', createdAt: 400, steer: true, promptId: 'p-b' };
  const c: StreamMessage = { type: 'user_prompt', prompt: 'Follow-up C', createdAt: 410, promptId: 'p-c' };
  const firstAnswer = assistant('a-first', 600, [{ type: 'text', text: 'First answer.' }], 'final_answer');
  useAppStore.setState(state => ({ sessions: { ...state.sessions, [batchId]: {
    ...state.sessions[batchId], provider: 'claude', status: 'running',
    messages: [opener, firstAnswer, done],
    pendingPrompts: [b, c],
    streaming: { text: '', thinking: '', isStreaming: false },
  } } }));
  dispatch({ type: 'stream.prompt_started', payload: { sessionId: batchId, promptId: 'p-b', steer: false } } as ServerEvent);
  dispatch({ type: 'stream.prompt_started', payload: { sessionId: batchId, promptId: 'p-c', steer: true } } as ServerEvent);
  const moved = useAppStore.getState().sessions[batchId].messages;
  const shape = moved.map(m => m.type === 'user_prompt' ? `prompt ${m.promptId}${m.steer ? ' (steer)' : ''}` : m.type);
  assert.deepEqual(shape, ['prompt undefined', 'assistant', 'result', 'prompt p-b', 'prompt p-c (steer)'],
    'both leave the previous turn in the order the CLI took them; the one that joined the batch is a steer of it');
  const secondAnswer = assistant('a-second', 900, [{ type: 'text', text: 'BEE. SEA.' }], 'final_answer');
  const timeline = deriveTranscriptTimelineItems([...moved, secondAnswer], { sessionRunning: false });
  assert.equal(timeline.filter(item => item.type === 'message' && item.message.type === 'user_prompt').length, 3,
    'every prompt is a bubble');
  assert.equal(moved.filter(opensTurn).length, 2, 'two turns: the joined prompt opens none');
}

console.log('claude-steer-turn.test.ts passed');
