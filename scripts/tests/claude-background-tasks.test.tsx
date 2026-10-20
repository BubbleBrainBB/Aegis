import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ClaudeBackgroundTasks, type BackgroundTaskEvent } from '../../src/electron/libs/claude-background-tasks';
import { useAppStore } from '../../src/ui/store/useAppStore';
import { deriveTranscriptTimelineItems } from '../../src/ui/utils/transcript-timeline';
import { createBatchWorkstreamModel } from '../../src/ui/utils/workstream';
import { openBackgroundTaskDetail } from '../../src/ui/components/BackgroundTasksControl';
import fs from 'node:fs';
import { BackgroundTaskEndedRow, resolveOutcomeTask, startedBy } from '../../src/ui/components/BackgroundTaskEndedRow';
import type { StreamMessage } from '../../src/ui/types';

// Frame sequences recorded from the real CLI (claude-agent-sdk 0.3.299).
const init = { type: 'system', subtype: 'init' };
const result = { type: 'result', subtype: 'success' };
const text = { type: 'assistant' };
const started = (id: string, extra: object = {}) => ({
  type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `toolu_${id}`,
  description: `Sleep ${id}`, is_backgrounded: true, task_type: 'local_bash', ...extra,
});
const running = (...ids: string[]) => ({
  type: 'system', subtype: 'background_tasks_changed',
  tasks: ids.map((id) => ({ task_id: id, task_type: 'local_bash', description: `Sleep ${id}` })),
});
const updated = (id: string) => ({ type: 'system', subtype: 'task_updated', task_id: id, patch: { status: 'completed' } });
const notified = (id: string, status: string, extra: object = {}) => ({
  type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: `toolu_${id}`, status,
  output_file: `/tmp/${id}.output`, summary: `Background command "Sleep ${id}" ${status} (exit code 0)`, ...extra,
});

function feed(frames: object[], tracker = new ClaudeBackgroundTasks()) {
  const out: Array<{ at: number; event: BackgroundTaskEvent }> = [];
  const consumed: number[] = [];
  frames.forEach((frame, at) => {
    const { events, consumed: drop } = tracker.observe(frame);
    for (const event of events) out.push({ at, event });
    if (drop) consumed.push(at);
  });
  return { out, consumed, tracker };
}
const chips = (out: ReturnType<typeof feed>['out']) =>
  out.filter((e) => e.event.kind === 'tasks').map((e) => [e.at, (e.event as { tasks: { taskId: string }[] }).tasks.map((t) => t.taskId)]);
const outcomes = (out: ReturnType<typeof feed>['out']) =>
  out.filter((e) => e.event.kind === 'outcome').map((e) => e.event.kind === 'outcome' && e.event.outcome);

// A prompt sent while a background task runs: every turn opens with an init,
// and none of them may clear the task's chip. Its end leaves one outcome.
{
  const frames = [
    init, text, running('b'), started('b'), result, // 0-4: the task starts
    init, text, result, // 5-7: the user's next turn
    updated('b'), notified('b', 'completed'), running(), init, text, result, // 8-13: it ends, the agent wakes
  ];
  const { out, consumed } = feed(frames);
  assert.deepEqual(chips(out), [[0, []], [2, ['b']], [10, []]], 'only the first init and the snapshots touch the chips');
  assert.deepEqual(consumed, [2, 10], 'snapshots are handled here; everything else flows on');
  assert.deepEqual(outcomes(out), [{
    taskId: 'b', toolUseId: 'toolu_b', status: 'completed',
    summary: 'Background command "Sleep b" completed (exit code 0)',
    description: 'Sleep b', taskType: 'local_bash',
  }]);
}

// The snapshot arrives before task_started (as recorded): the chip still gets
// its tool call once the task is known, on the next snapshot.
{
  const { out } = feed([init, running('x'), started('x'), running('x', 'y'), started('y')]);
  const last = out.at(-1)!.event;
  assert.equal(last.kind, 'tasks');
  assert.equal(last.kind === 'tasks' && last.tasks[0].toolUseId, 'toolu_x');
}

// A resumed process reports the previous process's unfinished task before its
// first init: shown as stopped, though this process never saw it start.
{
  const orphan = {
    type: 'system', subtype: 'task_notification', task_id: 'old', tool_use_id: 'toolu_old', status: 'stopped',
    output_file: '', summary: "Background shell command didn't finish before the previous session ended",
  };
  const { out } = feed([orphan, init, result, init, text, result]);
  assert.deepEqual(outcomes(out), [{
    taskId: 'old', toolUseId: 'toolu_old', status: 'stopped',
    summary: "Background shell command didn't finish before the previous session ended",
    description: undefined, taskType: undefined,
  }]);
  assert.deepEqual(chips(out), [[1, []]], 'the new process clears leftover chips at its first init');
}

// Foreground subagents, work a subagent launched, and housekeeping tasks
// report elsewhere (or nowhere): no transcript row.
{
  const { out } = feed([
    init,
    started('fg', { task_type: 'local_agent', is_backgrounded: false }), notified('fg', 'completed'),
    started('nested', { parent_task_id: 'fg' }), notified('nested', 'completed'),
    started('quiet', { skip_transcript: true, ambient: true }), notified('quiet', 'completed'),
    notified('watch', 'completed', { ambient: true }),
    started('moved', { task_type: 'local_agent', is_backgrounded: false }),
    { type: 'system', subtype: 'task_updated', task_id: 'moved', patch: { is_backgrounded: true } },
    notified('moved', 'failed'),
  ]);
  assert.deepEqual(outcomes(out).map((o) => o && [o.taskId, o.status]), [['moved', 'failed']],
    'only a task that ran in the background gets a row');
}

// Ambient entries never become chips; the process end clears shown chips once.
{
  const tracker = new ClaudeBackgroundTasks();
  const { out } = feed([init, { type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'a', task_type: 'local_bash', description: 'A' },
    { task_id: 'w', task_type: 'monitor', description: 'Watcher', ambient: true },
  ] }], tracker);
  assert.deepEqual(chips(out).at(-1), [1, ['a']]);
  assert.deepEqual(tracker.end(), [{ kind: 'tasks', tasks: [] }]);
  const idle = new ClaudeBackgroundTasks();
  idle.observe(init);
  assert.deepEqual(idle.end(), [], 'nothing shown, nothing to clear');
}

// A repeated notification for a run adds no second row, even for a task the
// first one filtered out; a resumed task's next run (new run_id) does.
{
  const { out } = feed([
    init,
    started('fg', { task_type: 'local_agent', is_backgrounded: false }),
    notified('fg', 'completed', { run_id: 'r1' }), notified('fg', 'completed', { run_id: 'r1' }),
    started('b'), notified('b', 'completed', { run_id: 'r1' }), notified('b', 'completed', { run_id: 'r1' }),
    notified('b', 'stopped', { run_id: 'r2' }),
  ]);
  assert.deepEqual(outcomes(out).map((o) => o && [o.taskId, o.status]), [['b', 'completed'], ['b', 'stopped']]);
}

// Task frames reach the tracker before the /goal controller, which swallows
// frames while its own control command runs.
{
  const runner = fs.readFileSync(new URL('../../src/electron/libs/runner.ts', import.meta.url), 'utf8');
  const observeAt = runner.indexOf('backgroundTasks.observe(message');
  const goalAt = runner.indexOf('await goalController.receive(message');
  assert.ok(observeAt > 0 && goalAt > observeAt, 'the tracker sees every frame before the goal controller');
}

// A new runner taking the session clears the chips: a predecessor's late
// closing snapshot is dropped as not the owner's, and non-Claude runners never
// report tasks.
{
  const ipc = fs.readFileSync(new URL('../../src/electron/ipc-handlers.ts', import.meta.url), 'utf8');
  assert.match(
    ipc,
    /runnerHandles\.set\(session\.id, \{[\s\S]{0,4000}?\n  \}\);\n(?:\s*\/\/[^\n]*\n)*\s*broadcastSessionEvent\(mainWindow, \{\s*type: 'stream\.message',\s*payload: \{\s*sessionId: session\.id,\s*message: \{ type: 'system', subtype: 'background_tasks',[^}]*tasks: \[\] \},/,
    'registering a runner broadcasts an empty task list'
  );
}

// The store keeps the chips across a turn's init and keeps the outcome as a
// transcript message.
const id = useAppStore.getState().createDraftSession('/tmp/background-tasks-test');
const read = () => useAppStore.getState().sessions[id];
const emit = (message: StreamMessage) => useAppStore.getState().handleServerEvent({
  type: 'stream.message', payload: { sessionId: id, message },
});
useAppStore.setState((s) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id], provider: 'claude', messages: [] } } }));
emit({ type: 'system', subtype: 'background_tasks', uuid: 'bt-1', session_id: 's', tasks: [
  { taskId: 'b', toolUseId: 'toolu_b', description: 'Watch CI', taskType: 'local_bash' },
] });
emit({ type: 'system', subtype: 'init', session_id: 's', model: 'm', permissionMode: 'default', cwd: '/tmp', tools: [] });
assert.equal(read().backgroundTasks?.length, 1, 'a turn starting does not hide running tasks');
const ended: StreamMessage = {
  type: 'system', subtype: 'background_task_ended', uuid: 'end-1', session_id: 's',
  outcome: { taskId: 'b', toolUseId: 'toolu_b', status: 'failed', summary: 'Background command "Watch CI" failed (exit code 1)', description: 'Watch CI', taskType: 'local_bash' },
};
emit(ended);
emit({ type: 'system', subtype: 'background_tasks', uuid: 'bt-2', session_id: 's', tasks: [] });
assert.equal(read().backgroundTasks?.length, 0);
assert.ok(read().messages.some((m) => m.type === 'system' && m.subtype === 'background_task_ended'), 'the outcome is kept');

// It renders as its own row in the transcript.
const items = deriveTranscriptTimelineItems([ended]);
assert.equal(items.length, 1);
assert.equal(items[0].type === 'message' && items[0].message, ended);
const html = renderToStaticMarkup(createElement(BackgroundTaskEndedRow, {
  sessionId: id, outcome: ended.type === 'system' && ended.subtype === 'background_task_ended' ? ended.outcome : (null as never),
}));
assert.match(html, /data-background-task-ended="failed"/);
assert.match(html, /Watch CI/);
assert.match(html, /Background command/);
assert.match(html, /trace-meta-error[^>]*>Failed/);
const orphanHtml = renderToStaticMarkup(createElement(BackgroundTaskEndedRow, {
  sessionId: id, outcome: { taskId: 'old', toolUseId: 'toolu_old', status: 'stopped', summary: "Background shell command didn't finish before the previous session ended" },
}));
assert.match(orphanHtml, /didn&#x27;t finish before the previous session ended/);
assert.match(orphanHtml, />Background task</, 'an unknown kind reads as a plain background task');
assert.match(orphanHtml, />Stopped</);
// With the starting tool call in the session, the orphan reads as that task.
// (Server rendering reads the store's initial snapshot, so test the lookup.)
const history = [
  { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'tool_use', id: 'toolu_old', name: 'Bash', input: { command: 'sleep 300', description: 'Long watch', run_in_background: true } }] } },
  { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 'toolu_sub', name: 'Agent', input: { description: 'Review diff', prompt: 'x' } }] } },
] as StreamMessage[];
assert.equal(startedBy(history, 'toolu_old'), 'local_bash\nLong watch');
assert.equal(startedBy(history, 'toolu_sub'), 'local_agent\nReview diff');
assert.equal(startedBy(history, 'toolu_missing'), null);
assert.equal(startedBy(undefined, 'toolu_old'), null);

// An outcome arriving between stream deltas keeps what is already streamed.
{
  useAppStore.setState((st) => ({ sessions: { ...st.sessions, [id]: { ...st.sessions[id], status: 'running', messages: [] } } }));
  const delta = (text: string): StreamMessage => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } } as StreamMessage);
  emit(delta('1\n2\n3\n'));
  useAppStore.getState().handleServerEvent({ type: 'session.status', payload: { sessionId: id, status: 'running' } } as never);
  emit({ ...ended, uuid: 'end-mid' } as StreamMessage);
  emit(delta('4\n'));
  useAppStore.getState().handleServerEvent({ type: 'session.status', payload: { sessionId: id, status: 'running' } } as never);
  assert.equal(read().streaming.text, '1\n2\n3\n4\n', 'the streamed prefix survives the outcome');
  assert.equal(read().streaming.isStreaming, true);
}

// Layout: mid-turn outcomes sit in the trace where they happened; one after a
// finished turn opens the turn it wakes; an orphan reported before a reply
// stays ahead of it.
{
  const runId = 'run-1';
  const tool = (tid: string, at: number) => ({ type: 'assistant', uuid: tid, createdAt: at, agentRunId: runId, message: { content: [{ type: 'tool_use', id: tid, name: 'Bash', input: { command: 'echo ' + tid } }] } });
  const res = (tid: string, at: number) => ({ type: 'user', uuid: tid + 'r', createdAt: at, message: { content: [{ type: 'tool_result', tool_use_id: tid, content: 'ok' }] } });
  const outcomeAt = (at: number) => ({ type: 'system', subtype: 'background_task_ended', uuid: 'o' + at, session_id: 's', createdAt: at, agentRunId: runId, outcome: { taskId: 't', toolUseId: 'toolu_t', status: 'completed', summary: 'done', description: 'Watch CI', taskType: 'local_bash' } });
  const say = (uid: string, text: string, at: number) => ({ type: 'assistant', uuid: uid, createdAt: at, agentRunId: runId, message: { content: [{ type: 'text', text }] } });
  const done = { type: 'result', subtype: 'success', duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } };
  const show = (list: StreamMessage[], options = {}) => deriveTranscriptTimelineItems(list, options)
    .filter((item) => !(item.type === 'message' && item.message.type === 'result'))
    .map((item) => item.type === 'work' ? `work[${item.group.messages.map((m) => m.uuid).join(',')}]` : `${item.message.type}:${(item.message as { uuid?: string }).uuid ?? ''}`);
  const mid = [{ type: 'user_prompt', prompt: 'go', createdAt: 1 }, tool('A', 2), res('A', 3), outcomeAt(5), tool('B', 6), res('B', 7), say('ans', 'All done.', 9), done] as StreamMessage[];
  assert.deepEqual(show(mid), ['user_prompt:', 'work[A,o5,B]', 'assistant:ans'], 'completed turn');
  assert.deepEqual(show(mid.slice(0, 6), { sessionRunning: true, activeTurnStartIndex: 0 }), ['user_prompt:', 'work[A,o5,B]'], 'running turn');
  const woken = [{ type: 'user_prompt', prompt: 'pong', createdAt: 1 }, say('pong', 'pong', 2), done, outcomeAt(5), tool('B', 6), res('B', 7), say('ci', 'CI finished', 9), done] as StreamMessage[];
  assert.deepEqual(show(woken), ['user_prompt:', 'assistant:pong', 'system:o5', 'work[B]', 'assistant:ci'], 'woken turn');
  assert.deepEqual(show(woken.slice(0, 6), { sessionRunning: true, activeTurnStartIndex: 0 }), ['user_prompt:', 'assistant:pong', 'system:o5', 'work[B]'], 'woken turn running');
  const orphan = [{ type: 'user_prompt', prompt: 'ack', createdAt: 1 }, outcomeAt(2), say('ack', 'ack', 3), done] as StreamMessage[];
  assert.deepEqual(show(orphan), ['user_prompt:', 'system:o2', 'assistant:ack'], 'orphan before the reply');
  // A task that ended while the reply streamed wakes a turn after the result:
  // that turn opens at its marked init, and the earlier reply stays an answer.
  const wokeInit = { type: 'system', subtype: 'init', session_id: 's', model: 'm', permissionMode: 'x', cwd: '/', tools: [], selfStarted: true };
  const streamed = [{ type: 'user_prompt', prompt: 'count', createdAt: 1 }, tool('A', 2), res('A', 3), outcomeAt(4), say('nums', '1 2 3', 5), done, wokeInit, say('woke', 'It finished.', 8), done] as StreamMessage[];
  const visible = show(streamed).filter((entry) => entry !== 'system:');
  assert.deepEqual(visible, ['user_prompt:', 'work[A,o4]', 'assistant:nums', 'assistant:woke'], 'the woken turn does not swallow the reply before it');
  const plainInit = streamed.map((m) => (m === (wokeInit as unknown) ? { ...wokeInit, selfStarted: undefined } : m)) as StreamMessage[];
  assert.ok(show(plainInit).includes('work[A,o4,nums]'), 'an unmarked init does not split (control)');
  // Both replies on either side of a woken-turn boundary are answers (copy
  // action, citations), not progress.
  const presentation = (list: StreamMessage[]) => deriveTranscriptTimelineItems(list)
    .flatMap((item) => item.type === 'message' && item.message.type === 'assistant' ? [`${item.message.uuid}=${item.assistantPresentation}`] : []);
  assert.deepEqual(presentation(woken), ['pong=answer', 'ci=answer'], 'outcome-opened woken turn');
  assert.deepEqual(presentation(streamed), ['nums=answer', 'woke=answer'], 'init-opened woken turn');
  assert.deepEqual(presentation(plainInit), ['woke=answer'], 'one turn without the mark (control)');
  // In the trace it is an entry of its own, in order.
  const model = createBatchWorkstreamModel({ messages: mid.slice(1, 6) as never, toolStatusMap: new Map(), toolResultsMap: new Map(), isSessionRunning: false });
  assert.deepEqual(model.entries.map((entry) => entry.type), ['tool', 'backgroundTaskEnded', 'tool']);
}

// An orphan opens what its starting tool call was: a subagent's panel.
{
  const resolved = resolveOutcomeTask({ taskId: 'old', toolUseId: 'toolu_sub', status: 'stopped', summary: 'gone' }, startedBy(history, 'toolu_sub'));
  assert.deepEqual(resolved, { toolUseId: 'toolu_sub', taskType: 'local_agent', description: 'Review diff' });
  const opened: string[] = [];
  useAppStore.setState({ openSubagentPanel: (toolUseId: string) => { opened.push(toolUseId); } } as never);
  openBackgroundTaskDetail(id, resolved);
  assert.deepEqual(opened, ['toolu_sub']);
}

console.log('claude-background-tasks: ok');
