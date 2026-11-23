import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { extractToolChangeRecordSets, extractToolChangeRecords } from '../../src/ui/utils/change-records';
import { buildTurnChangeContext } from '../../src/ui/utils/turn-change-records';
import type { StreamMessage } from '../../src/ui/types';

// The chat rebuilds its change records from the whole transcript on every
// message that lands. These checks hold that to one diff per tool call.

let reads = 0;

/** An Edit whose `old_string` counts how often the records read it. */
function editInput(filePath: string, oldText: string, newText: string): Record<string, unknown> {
  const input: Record<string, unknown> = { file_path: filePath, new_string: newText };
  Object.defineProperty(input, 'old_string', {
    enumerable: true,
    get() {
      reads += 1;
      return oldText;
    },
  });
  return input;
}

const prompt = (text: string): StreamMessage => ({ type: 'user_prompt', prompt: text }) as StreamMessage;
const toolUse = (id: string, name: string, input: Record<string, unknown>, parentToolUseId?: string): StreamMessage =>
  ({
    type: 'assistant',
    uuid: `use:${id}`,
    ...(parentToolUseId ? { parentToolUseId } : {}),
    message: { content: [{ type: 'tool_use', id, name, input }] },
  }) as unknown as StreamMessage;
const toolResult = (id: string, content = 'Done', parentToolUseId?: string): StreamMessage =>
  ({
    type: 'assistant',
    uuid: `result:${id}`,
    ...(parentToolUseId ? { parentToolUseId } : {}),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }] },
  }) as unknown as StreamMessage;
const text = (uuid: string, value: string): StreamMessage =>
  ({ type: 'assistant', uuid, message: { content: [{ type: 'text', text: value }] } }) as unknown as StreamMessage;

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

// ── One diff per tool call, however often the transcript is read ────────────
{
  let messages: StreamMessage[] = [
    prompt('change two files'),
    toolUse('e1', 'Edit', editInput('/p/a.ts', 'one\ntwo\nthree\n', 'one\n2\nthree\n')),
    toolResult('e1'),
    toolUse('e2', 'Edit', editInput('/p/b.ts', 'alpha\nbeta\n', 'alpha\nbeta\ngamma\n')),
  ];

  reads = 0;
  const first = buildTurnChangeContext(messages);
  const readsPerPass = reads;
  assert.ok(readsPerPass > 0, 'the first pass reads the edits');
  assert.deepEqual(
    first.turns[0].records.map((record) => [record.filePath, record.state, record.addedLines, record.removedLines]),
    [['/p/a.ts', 'success', 1, 1], ['/p/b.ts', 'pending', 1, 0]]
  );
  assert.equal(first.changeRecordByToolUseId.get('e1')?.diffContent, '@@ -1,3 +1,3 @@\n one\n-two\n+2\n three');

  // Narration lands: the same stored calls are not diffed again.
  messages = [...messages, text('t1', 'Working on it.')];
  reads = 0;
  const second = buildTurnChangeContext(messages);
  assert.equal(reads, 0, 'a new message does not diff earlier edits again');
  assert.deepEqual(plain(second.turns), plain({ ...first, turns: [{ ...first.turns[0], lastMessageIndex: 4 }] }.turns));

  // The pending call gets its result: only that call is worked out again.
  messages = [...messages, toolResult('e2')];
  reads = 0;
  const third = buildTurnChangeContext(messages);
  assert.equal(reads, readsPerPass / 2, 'a result re-reads its own call only');
  assert.deepEqual(third.turns[0].records.map((record) => record.state), ['success', 'success']);

  // A call that is sent again with a new input replaces the old records.
  messages = messages.map((message) =>
    (message as { uuid?: string }).uuid === 'use:e1'
      ? toolUse('e1', 'Edit', editInput('/p/a.ts', 'one\ntwo\nthree\n', 'one\nthree\n'))
      : message
  );
  const fourth = buildTurnChangeContext(messages);
  assert.deepEqual(
    fourth.turns[0].records.map((record) => [record.filePath, record.addedLines, record.removedLines]),
    [['/p/a.ts', 0, 1], ['/p/b.ts', 1, 0]]
  );

  // Callers own what they get: a change to a returned record stays out of the next read.
  const mine = extractToolChangeRecords(messages);
  mine[0].addedLines = 999;
  mine[0].diffContent = 'tampered';
  assert.deepEqual(plain(extractToolChangeRecords(messages)), plain(extractToolChangeRecords(plain(messages) as StreamMessage[])));

  // The same transcript as fresh objects (nothing kept) gives the same context.
  const kept = buildTurnChangeContext(messages);
  const fresh = buildTurnChangeContext(plain(messages) as StreamMessage[]);
  assert.deepEqual(plain(kept.turns), plain(fresh.turns));
  assert.deepEqual(plain([...kept.changeRecordsByToolUseId]), plain([...fresh.changeRecordsByToolUseId]));
}

// ── The main agent's records, numbered apart from its subagents' ────────────
{
  const messages: StreamMessage[] = [
    prompt('delegate'),
    toolUse('task1', 'Task', { description: 'edit things' }),
    toolUse('s1', 'Edit', { file_path: '/p/sub.ts', old_string: 'a\n', new_string: 'b\n' }, 'task1'),
    toolResult('s1', 'Done', 'task1'),
    toolUse('m1', 'Write', { file_path: '/p/main.ts', content: 'x\ny\n' }),
    toolResult('m1'),
    toolUse('s2', 'Bash', { command: 'rm /p/old.ts' }, 'task1'),
    toolUse('m2', 'Edit', { file_path: '/p/main.ts', old_string: 'x\n', new_string: 'z\n' }),
    toolResult('task1'),
  ];
  const sets = extractToolChangeRecordSets(messages);
  assert.deepEqual(sets.records.map((record) => [record.toolUseId, record.order]), [['s1', 0], ['m1', 1], ['s2', 2], ['m2', 3]]);
  // What reading the main agent's messages alone gives, order and state included.
  const mainOnly = extractToolChangeRecords(messages.filter((message) => !(message as { parentToolUseId?: string }).parentToolUseId));
  assert.deepEqual(plain(sets.mainRecords), plain(mainOnly));
  assert.deepEqual(sets.mainRecords.map((record) => [record.toolUseId, record.order, record.state]), [['m1', 0, 'success'], ['m2', 1, 'pending']]);
  assert.deepEqual(plain(sets.records), plain(extractToolChangeRecords(messages)));

  const context = buildTurnChangeContext(messages);
  assert.deepEqual(context.turns[0].records.map((record) => record.filePath), ['/p/main.ts']);
  assert.deepEqual([...context.changeRecordByToolUseId.keys()], ['s1', 'm1', 's2', 'm2']);
}

// ── A session of whole-file edits to a 14,000-line file stays responsive ────
{
  // What an agent that reports whole files as an edit's old and new text
  // leaves in a transcript: 20 edits of about 600 KB on each side.
  const fileLines = Array.from({ length: 14_000 }, (_, index) => `  const entry${index} = table[${index}] ?? fallback;`);
  let current = `${fileLines.join('\n')}\n`;
  let messages: StreamMessage[] = [prompt('optimize')];
  let total = 0;
  let worst = 0;
  const land = (message: StreamMessage) => {
    messages = [...messages, message];
    const start = performance.now();
    buildTurnChangeContext(messages);
    const elapsed = performance.now() - start;
    total += elapsed;
    worst = Math.max(worst, elapsed);
  };
  for (let edit = 0; edit < 20; edit += 1) {
    const lines = [...fileLines];
    for (let done = 0; done <= edit; done += 1) lines[500 + done * 600] = `  const changed${done} = true;`;
    const next = `${lines.join('\n')}\n`;
    land(text(`think:${edit}`, 'Reading the file.'));
    land(toolUse(`big${edit}`, 'Edit', { file_path: '/p/big.ts', old_string: current, new_string: next }));
    land(toolResult(`big${edit}`));
    for (let note = 0; note < 5; note += 1) land(text(`note:${edit}:${note}`, 'Still working.'));
    current = next;
  }
  const context = buildTurnChangeContext(messages);
  assert.equal(context.turns[0].totalAdded, 20);
  assert.equal(context.turns[0].totalRemoved, 20);
  assert.equal(context.changeRecordByToolUseId.get('big19')?.diffContent?.includes('@@ -11898,7 +11898,7 @@'), true);
  // Before: every landing diffed every edit so far twice, about a second each,
  // which is minutes over these 160 landings.
  assert.ok(total < 3000, `160 landings took ${total.toFixed(0)} ms in all`);
  assert.ok(worst < 400, `the slowest landing took ${worst.toFixed(0)} ms`);
}

console.log('turn-change-records-cache: all checks passed');
