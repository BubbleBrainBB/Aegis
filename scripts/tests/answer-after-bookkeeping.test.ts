import assert from 'node:assert/strict';
import type { StreamMessage } from '../../src/shared/types';
import { deriveTranscriptTimelineItems, type TranscriptTimelineItem } from '../../src/ui/utils/transcript-timeline';

// An agent that writes its answer, then calls a bookkeeping tool (report_status,
// propose_follow_up), then adds a closing line keeps the whole answer visible.
// Real work between the texts still folds the earlier one into the trace.

type MessageItem = Extract<TranscriptTimelineItem, { type: 'message' }>;
type WorkItem = Extract<TranscriptTimelineItem, { type: 'work' }>;

let clock = 1_000;
const at = () => (clock += 1_000);

const prompt = (text: string): StreamMessage => ({ type: 'user_prompt', prompt: text, createdAt: at() });
const text = (uuid: string, value: string): StreamMessage => ({
  type: 'assistant',
  uuid,
  createdAt: at(),
  message: { content: [{ type: 'text', text: value }] },
}) as StreamMessage;
const call = (id: string, name: string, input: Record<string, unknown> = {}): StreamMessage => ({
  type: 'assistant',
  uuid: `use-${id}`,
  createdAt: at(),
  message: { content: [{ type: 'tool_use', id, name, input }] },
}) as StreamMessage;
const toolResult = (id: string): StreamMessage => ({
  type: 'user',
  uuid: `result-${id}`,
  createdAt: at(),
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
}) as StreamMessage;
const done = (): StreamMessage => ({
  type: 'result',
  subtype: 'success',
  duration_ms: 60_000,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  createdAt: at(),
}) as StreamMessage;

const REPORT = 'mcp__aegis-sessions__report_status';
const PROPOSE = 'mcp__aegis-sessions__propose_follow_up';

function view(messages: StreamMessage[], options: Parameters<typeof deriveTranscriptTimelineItems>[1] = {}) {
  const items = deriveTranscriptTimelineItems(messages, options);
  const answers = items.filter(
    (item): item is MessageItem => item.type === 'message' && item.message.type === 'assistant'
  );
  const work = items.filter((item): item is WorkItem => item.type === 'work');
  const answerText = (item: MessageItem) =>
    ((item.message as { message: { content: Array<{ type: string; text?: string }> } }).message.content)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  const tracedTools = work.flatMap((item) =>
    item.group.messages.flatMap((message) =>
      ((message as { message?: { content?: Array<{ type: string; name?: string }> } }).message?.content ?? [])
        .filter((block) => block.type === 'tool_use')
        .map((block) => block.name)
    )
  );
  return { items, answers, work, answerText, tracedTools };
}

// The reported session: answer, report_status, closing line.
{
  const { items, answers, work, answerText, tracedTools } = view([
    prompt('Can we move to the cloud?'),
    call('t1', 'Bash', { command: 'ls src/electron/remote' }),
    toolResult('t1'),
    text('answer', 'Yes. Three routes: A, B, C.'),
    call('t2', REPORT, { outcome: 'question', summary: 'Picked routes', question: 'Which goal?' }),
    toolResult('t2'),
    text('closing', 'Answer the two questions above and I will start with A.'),
    done(),
  ]);
  assert.equal(answers.length, 1, 'the two texts render as one answer');
  assert.equal(answers[0].assistantPresentation, 'answer');
  assert.equal(answerText(answers[0]), 'Yes. Three routes: A, B, C.\nAnswer the two questions above and I will start with A.');
  assert.equal(work.length, 1, 'one Worked-for trace');
  assert.deepEqual(tracedTools, ['Bash', REPORT], 'the trace keeps both calls in order');
  assert.ok(items.indexOf(work[0]) < items.indexOf(answers[0]), 'the trace sits above the answer');
  assert.equal(work[0].canCollapse, true);
}

// Same with propose_follow_up, and with reasoning before the call.
{
  const { answers, answerText, tracedTools } = view([
    prompt('Fix the bug'),
    call('t1', 'Edit', { file_path: 'a.ts' }),
    toolResult('t1'),
    text('answer', 'Fixed it in a.ts.'),
    {
      type: 'assistant',
      uuid: 'think',
      createdAt: at(),
      message: { content: [{ type: 'thinking', thinking: 'Worth a separate task.' }] },
    } as StreamMessage,
    call('t2', PROPOSE, { title: 'Clean up b.ts' }),
    toolResult('t2'),
    text('closing', 'I also proposed a follow-up.'),
    done(),
  ]);
  assert.equal(answers.length, 1);
  assert.equal(answerText(answers[0]), 'Fixed it in a.ts.\nI also proposed a follow-up.');
  assert.deepEqual(tracedTools, ['Edit', PROPOSE]);
}

// Real work between two texts: the first is still narration and folds.
{
  const { answers, answerText, tracedTools } = view([
    prompt('Check the build'),
    text('narration', 'Let me run the build.'),
    call('t1', 'Bash', { command: 'npm run build' }),
    toolResult('t1'),
    text('answer', 'The build passes.'),
    done(),
  ]);
  assert.equal(answers.length, 1);
  assert.equal(answerText(answers[0]), 'The build passes.');
  assert.deepEqual(tracedTools, ['Bash']);
}

// A bookkeeping call with no closing line: the answer is the text before it.
{
  const { answers, answerText, tracedTools } = view([
    prompt('Deploy it'),
    text('answer', 'I need the staging API key.'),
    call('t1', REPORT, { outcome: 'blocked', summary: 'Needs the key' }),
    toolResult('t1'),
    done(),
  ]);
  assert.equal(answers.length, 1);
  assert.equal(answerText(answers[0]), 'I need the staging API key.');
  assert.deepEqual(tracedTools, [REPORT]);
}

// Text and the bookkeeping call in one message (providers that batch blocks).
{
  const { answers, answerText, tracedTools } = view([
    prompt('Deploy it'),
    {
      type: 'assistant',
      uuid: 'batched',
      createdAt: at(),
      message: {
        content: [
          { type: 'text', text: 'I need the staging API key.' },
          { type: 'tool_use', id: 't1', name: 'report_status', input: { outcome: 'blocked', summary: 'Needs the key' } },
        ],
      },
    } as StreamMessage,
    toolResult('t1'),
    done(),
  ]);
  assert.equal(answers.length, 1);
  assert.equal(answerText(answers[0]), 'I need the staging API key.');
  assert.deepEqual(tracedTools, ['report_status']);
}

// A batched message with real work keeps its text as narration.
{
  const { answers, answerText } = view([
    prompt('Check it'),
    {
      type: 'assistant',
      uuid: 'batched',
      createdAt: at(),
      message: {
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    } as StreamMessage,
    toolResult('t1'),
    text('answer', 'All good.'),
    done(),
  ]);
  assert.equal(answers.length, 1);
  assert.equal(answerText(answers[0]), 'All good.');
}

// While the turn still runs, nothing is promoted yet.
{
  const messages = [
    prompt('Can we move to the cloud?'),
    text('answer', 'Yes. Three routes.'),
    call('t1', REPORT, { outcome: 'question', summary: 'Routes', question: 'Which goal?' }),
    toolResult('t1'),
  ];
  const { answers, work } = view(messages, { sessionRunning: true, activeTurnStartIndex: 0 });
  assert.equal(answers.length, 0, 'a running turn keeps its text in the live trace');
  assert.equal(work.length, 1);
  assert.equal(work[0].active, true);
}

console.log('answer-after-bookkeeping: ok');
