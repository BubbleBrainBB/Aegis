import assert from 'node:assert/strict';
import type { StreamMessage } from '../../src/shared/types';
import { deriveTranscriptTimelineItems, type TranscriptTimelineItem } from '../../src/ui/utils/transcript-timeline';
import { isNarrationBlock, markNarrationBlocks, markNarrationFromSignatures, narrationText, signatureBlockKind } from '../../src/shared/narration-block';
import { projectMessages } from '../../src/shared/remote/projection';
import { TurnState } from '../../src/electron/feishu/turn';

// An agent that writes its answer, then calls a bookkeeping tool (report_status,
// propose_follow_up), then adds a closing line keeps the whole answer visible.
// Real work between the texts still folds the earlier one into the trace.
// Claude can return that answer as a "narration" thinking block; it is still
// the answer, while reasoning and narration ahead of real work stay folded.

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
const thinking = (uuid: string, value: string, extra: Record<string, unknown> = {}): StreamMessage => ({
  type: 'assistant',
  uuid,
  createdAt: at(),
  message: { content: [{ type: 'thinking', thinking: value, ...extra }] },
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
  const tracedBlocks = work.flatMap((item) =>
    item.group.messages.flatMap((message) =>
      (message as { message?: { content?: Array<{ type: string; name?: string; thinking?: string }> } }).message?.content ?? []
    )
  );
  const tracedTools = tracedBlocks.filter((block) => block.type === 'tool_use').map((block) => block.name);
  const tracedThinking = tracedBlocks.filter((block) => block.type === 'thinking').map((block) => block.thinking);
  return { items, answers, work, answerText, tracedTools, tracedThinking };
}

/**
 * A thinking signature as Claude sends it: a protobuf envelope whose metadata
 * names the block kind, followed by the opaque payload.
 */
function signature(kind: string, payloadBytes = 600): string {
  const metadata = [0x08, 0x13, 0x18, 0x02, 0x38, 0x01, 0x42, kind.length, ...Buffer.from(kind, 'latin1')];
  const body = [0x0a, metadata.length, ...metadata, 0x12, 0x0c, ...new Array(12).fill(0xab), 0x1a, 0x0c];
  const length = body.length + payloadBytes;
  const envelope = [0x08, 0x04, 0x12, (length & 0x7f) | 0x80, length >> 7, ...body, ...new Array(payloadBytes).fill(0xcd)];
  return Buffer.from(envelope).toString('base64');
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

// Dev session 6cc8861d: Claude wrote its answer, which came back as a
// narration thinking block, then called report_status and closed with a line
// pointing back at it. Stored before narration was tagged: only the signature tells.
const CODE_WORD_ANSWER =
  "I couldn't find a code word for #322 in Aegis conversation 322, the GitHub repo (which has no remote), " +
  "or saved memory and repo files. If you can reopen that conversation or paste its aegis://sessions/<id> link, I'll read it again.";
{
  const { items, answers, work, answerText, tracedTools, tracedThinking } = view([
    prompt('What code word did I give you in #322'),
    thinking('think-1', "I'm trying to figure out what code word the user gave me in session #322.", { signature: signature('thinking') }),
    call('t1', 'ToolSearch', { query: 'select:mcp__aegis-sessions__read_session' }),
    toolResult('t1'),
    call('t2', 'mcp__aegis-sessions__read_session', { sessionId: '322' }),
    toolResult('t2'),
    thinking('think-2', "Maybe this is GitHub issue or PR #322, so I'll check the git remote.", { signature: signature('thinking') }),
    call('t3', 'Bash', { command: 'git remote -v' }),
    toolResult('t3'),
    thinking('think-3', "I'm checking whether I can locate it, and I need to report back on the result.\n\n", { signature: signature('thinking') }),
    thinking('narration', `${CODE_WORD_ANSWER}\n\n`, { signature: signature('narration', 1200), durationMs: 1658 }),
    call('t4', REPORT, { outcome: 'blocked', summary: 'Conversation #322 is no longer available' }),
    toolResult('t4'),
    text('closing', "Here's my answer above."),
    done(),
  ]);
  assert.equal(answers.length, 1, 'the narration and the closing line render as one answer');
  assert.equal(answers[0].assistantPresentation, 'answer');
  assert.equal(answerText(answers[0]), `${CODE_WORD_ANSWER}\nHere's my answer above.`);
  assert.ok(
    (answers[0].message as { message: { content: Array<{ type: string }> } }).message.content.every((block) => block.type === 'text'),
    'the answer shows the narration as text, not as a reasoning block'
  );
  assert.equal(work.length, 1, 'one Worked-for trace');
  assert.ok(items.indexOf(work[0]) < items.indexOf(answers[0]), 'the trace sits above the answer');
  assert.equal(work[0].canCollapse, true);
  assert.deepEqual(tracedTools, ['ToolSearch', 'mcp__aegis-sessions__read_session', 'Bash', REPORT]);
  assert.equal(tracedThinking.length, 3, 'ordinary reasoning stays in the trace');
  assert.ok(tracedThinking.every((value) => !value?.startsWith("I couldn't find")), 'the answer is not folded');
}

// Tagged by the runner (no signature to read), and no closing line: the narration is the answer.
{
  const { answers, answerText, tracedTools, tracedThinking } = view([
    prompt('Deploy it'),
    call('t1', 'Bash', { command: 'printenv' }),
    toolResult('t1'),
    thinking('think', 'No key in the environment.'),
    thinking('narration', 'I need the staging API key.', { narration: true }),
    call('t2', REPORT, { outcome: 'blocked', summary: 'Needs the key' }),
    toolResult('t2'),
    done(),
  ]);
  assert.equal(answers.length, 1);
  assert.equal(answerText(answers[0]), 'I need the staging API key.');
  assert.deepEqual(tracedTools, ['Bash', REPORT]);
  assert.deepEqual(tracedThinking, ['No key in the environment.']);
}

// Narration ahead of real work is commentary: it stays in the trace as before,
// even when a bookkeeping call sits between it and the work.
{
  const { answers, answerText, tracedTools, tracedThinking } = view([
    prompt('Check the build'),
    thinking('narration-1', 'Let me run the build.', { signature: signature('narration') }),
    call('t1', 'Bash', { command: 'npm run build' }),
    toolResult('t1'),
    thinking('narration-2', 'The build is still going, I will wait for it.', { narration: true }),
    call('t2', REPORT, { outcome: 'in_progress', summary: 'Build running' }),
    toolResult('t2'),
    call('t3', 'Bash', { command: 'tail build.log' }),
    toolResult('t3'),
    text('answer', 'The build passes.'),
    done(),
  ]);
  assert.equal(answers.length, 1);
  assert.equal(answerText(answers[0]), 'The build passes.');
  assert.deepEqual(tracedTools, ['Bash', REPORT, 'Bash']);
  assert.deepEqual(tracedThinking, ['Let me run the build.', 'The build is still going, I will wait for it.']);
}

// Ordinary reasoning before a bookkeeping call is never promoted, with or
// without a signature, and a turn whose only prose is the closing line keeps it.
{
  const { answers, answerText, tracedThinking } = view([
    prompt('Fix the bug'),
    call('t1', 'Edit', { file_path: 'a.ts' }),
    toolResult('t1'),
    thinking('think', 'The user should hear that the key is missing.', { signature: signature('thinking') }),
    call('t2', REPORT, { outcome: 'blocked', summary: 'Needs the key' }),
    toolResult('t2'),
    text('closing', 'I need the staging API key.'),
    done(),
  ]);
  assert.equal(answers.length, 1);
  assert.equal(answerText(answers[0]), 'I need the staging API key.');
  assert.deepEqual(tracedThinking, ['The user should hear that the key is missing.']);
}

// While the turn still runs, narration stays in the live trace.
{
  const messages = [
    prompt('What code word did I give you in #322'),
    call('t1', 'Bash', { command: 'git remote -v' }),
    toolResult('t1'),
    thinking('narration', CODE_WORD_ANSWER, { signature: signature('narration') }),
    call('t2', REPORT, { outcome: 'blocked', summary: 'Not available' }),
    toolResult('t2'),
  ];
  const { answers, work, tracedThinking } = view(messages, { sessionRunning: true, activeTurnStartIndex: 0 });
  assert.equal(answers.length, 0, 'a running turn keeps its narration in the live trace');
  assert.equal(work.length, 1);
  assert.equal(work[0].active, true);
  assert.deepEqual(tracedThinking, [CODE_WORD_ANSWER]);
}

// Reading the block kind: the signature's envelope, or the runner's tag.
{
  assert.equal(signatureBlockKind(signature('narration')), 'narration');
  assert.equal(signatureBlockKind(signature('thinking')), 'thinking');
  // The head of the two signatures stored for session 6cc8861d.
  assert.equal(signatureBlockKind('CAQSvwoKEQgTGAI4AUIJbmFycmF0aW9uEgz2Nl8OA0rvESavOl8aDOVwKWEp'), 'narration');
  assert.equal(signatureBlockKind('CAQSgQYKEAgTGAI4AUIIdGhpbmtpbmcSDLxjkUS2QvFp5khfYBoMUbNh3ZVQ'), 'thinking');
  for (const unreadable of [undefined, '', 'not base64 !!', 'AAAA', Buffer.from('narration').toString('base64'), signature('narration').slice(0, 12)]) {
    assert.equal(signatureBlockKind(unreadable), undefined, `unreadable signature ${String(unreadable)}`);
  }

  assert.equal(isNarrationBlock({ type: 'thinking', thinking: 'Done.', signature: signature('narration') }), true);
  assert.equal(isNarrationBlock({ type: 'thinking', thinking: 'Done.', narration: true }), true);
  assert.equal(isNarrationBlock({ type: 'thinking', thinking: 'Done.', signature: signature('thinking') }), false);
  assert.equal(isNarrationBlock({ type: 'thinking', thinking: 'Done.' }), false);
  assert.equal(isNarrationBlock({ type: 'thinking', thinking: '  ', narration: true }), false, 'no text: ordinary thinking');
  assert.equal(isNarrationBlock({ type: 'text', text: 'Done.', narration: true } as never), false);

  // The runner tags the blocks a frame lists in narration_block_indexes.
  const frame = { id: 'msg_1', content: [{ type: 'thinking', thinking: 'Why.' }, { type: 'thinking', thinking: 'Done.' }, { type: 'text', text: 'Hi' }] };
  assert.deepEqual(markNarrationBlocks(frame, [1, 2]).content, [
    { type: 'thinking', thinking: 'Why.' },
    { type: 'thinking', thinking: 'Done.', narration: true },
    { type: 'text', text: 'Hi' },
  ]);
  assert.equal((frame.content[1] as { narration?: boolean }).narration, undefined, 'the frame itself is not changed');
  assert.equal(markNarrationBlocks(frame, undefined), frame);
  assert.equal(markNarrationBlocks(frame, []), frame);
  assert.equal(markNarrationBlocks(frame, 'nope'), frame);
}

// The other readers of a reply. The agent now ends its turn after report_status
// without a closing line, so the narration can be the only prose there is.
{
  const turn = [
    prompt('What code word did I give you in #322'),
    call('t1', 'Bash', { command: 'git remote -v' }),
    toolResult('t1'),
    thinking('think', 'I need to report back.', { signature: signature('thinking') }),
    thinking('narration', `${CODE_WORD_ANSWER}\n\n`, { signature: signature('narration', 1200) }),
    call('t2', REPORT, { outcome: 'blocked', summary: 'Conversation #322 is no longer available' }),
    toolResult('t2'),
    done(),
  ];

  // Another device gets a copy without signatures: the narration is marked on
  // it, its timeline shows the same answer, and the plain text carries it.
  const projected = projectMessages(turn);
  const blocksOf = (id: string) =>
    (projected.find((message) => message.id === id)!.raw as { message: { content: Array<Record<string, unknown>> } }).message.content;
  assert.deepEqual(blocksOf('narration'), [{ type: 'thinking', thinking: `${CODE_WORD_ANSWER}\n\n`, narration: true }]);
  assert.deepEqual(blocksOf('think'), [{ type: 'thinking', thinking: 'I need to report back.' }]);
  assert.equal(projected.find((message) => message.id === 'narration')!.text, CODE_WORD_ANSWER);
  assert.equal(projected.find((message) => message.id === 'think')!.text, '');
  const remote = view(projected.map((message) => message.raw as StreamMessage));
  assert.equal(remote.answers.length, 1);
  assert.equal(remote.answerText(remote.answers[0]), CODE_WORD_ANSWER);
  assert.deepEqual(remote.tracedThinking, ['I need to report back.']);

  // The Feishu card: the narration is the answer, and not also a thought.
  const card = new TurnState();
  card.ingest({ type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: 'I need to report back.' } } } as unknown as StreamMessage);
  card.ingest({ type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: CODE_WORD_ANSWER } } } as unknown as StreamMessage);
  for (const message of turn) card.ingest(message);
  card.finish('done');
  assert.equal(card.answer(), CODE_WORD_ANSWER);
  assert.equal(card.thinking, 'I need to report back.');
  assert.deepEqual(card.blocks.map((block) => block.kind), ['tool', 'text', 'tool']);
  // Reasoning is still only a thought.
  const plain = new TurnState();
  plain.ingest(thinking('think', 'Why this fails.', { signature: signature('thinking') }));
  assert.equal(plain.answer(), '');
  assert.equal(plain.thinking, 'Why this fails.');

  // The helpers behind them.
  assert.equal(narrationText({ type: 'thinking', thinking: ' Done. ', narration: true }), 'Done.');
  assert.equal(narrationText({ type: 'thinking', thinking: 'Why.', signature: signature('thinking') }), undefined);
  assert.equal(narrationText({ type: 'text', text: 'Done.' }), undefined);
  assert.equal(narrationText(null), undefined);
  const stored = { content: [{ type: 'thinking', thinking: 'Why.', signature: signature('thinking') }, { type: 'thinking', thinking: 'Done.', signature: signature('narration') }] };
  assert.deepEqual(markNarrationFromSignatures(stored).content.map((block) => (block as { narration?: boolean }).narration), [undefined, true]);
  assert.equal(markNarrationFromSignatures({ content: 'plain' }).content, 'plain');
}

console.log('answer-after-bookkeeping: ok');
