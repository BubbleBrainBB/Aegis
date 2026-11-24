import assert from 'node:assert/strict';
import {
  deriveTranscriptTimelineItems,
  findActiveTurnStartIndex,
  type TranscriptTimelineItem,
} from '../../src/ui/utils/transcript-timeline';
import type { StreamMessage } from '../../src/ui/types';

// Antigravity goes on by itself after a turn whose command went to the
// background. These checks hold how the chat lays that out: the work agy does
// by itself stays live while it runs. Its completed phases share one summary
// with the work that started them. Messages are shaped as the adapter
// sends them (scripts/tests/antigravity-acp-adapter.test.ts holds that side).

let clock = Date.UTC(2026, 10, 22, 11, 32, 4);
const at = (seconds: number) => (clock += seconds * 1000);

const prompt = (text: string): StreamMessage => ({ type: 'user_prompt', prompt: text, createdAt: at(1) }) as StreamMessage;
const assistant = (uuid: string, block: Record<string, unknown>, seconds = 1): StreamMessage =>
  ({ type: 'assistant', uuid, createdAt: at(seconds), message: { content: [block] } }) as unknown as StreamMessage;
const thinking = (id: string, text: string) => assistant(`antigravity-thinking:t:${id}`, { type: 'thinking', thinking: text });
const text = (id: string, value: string) => assistant(`antigravity-assistant:t:${id}`, { type: 'text', text: value });
const call = (id: string, command: string) =>
  assistant(`antigravity-tool-use:t:${id}`, { type: 'tool_use', id, name: 'Bash', input: { command } });
const callResult = (id: string, content: string) =>
  assistant(`antigravity-tool-result:t:${id}`, { type: 'tool_result', tool_use_id: id, content, is_error: false }, 0);
const usage = (): StreamMessage =>
  ({ type: 'system', subtype: 'token_usage', uuid: `antigravity-token-usage:t:${at(0)}:${Math.random()}`, session_id: 't', provider: 'antigravity', createdAt: clock,
    usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1, contextWindow: 1000 } }) as unknown as StreamMessage;
const result = (durationMs: number): StreamMessage =>
  ({ type: 'result', subtype: 'success', duration_ms: durationMs, createdAt: at(0), total_cost_usd: 0, usage: {} }) as unknown as StreamMessage;
const wokeByItself = (): StreamMessage =>
  ({ type: 'system', subtype: 'init', session_id: 'agy-1', model: 'gemini-4-neon', permissionMode: '', cwd: '/p', tools: [], selfStarted: true, createdAt: at(60) }) as unknown as StreamMessage;

/** One line per timeline item: what it is, and how its trace is shown. */
function layout(
  messages: StreamMessage[],
  options: { running: boolean; groupAntigravityContinuations?: boolean; activeTurnStartIndex?: number }
): string[] {
  const items = deriveTranscriptTimelineItems(messages, {
    // As the chat does: the live turn starts at the latest prompt or self-started turn.
    activeTurnStartIndex: options.activeTurnStartIndex ?? findActiveTurnStartIndex(messages),
    sessionRunning: options.running,
    groupAntigravityContinuations: options.groupAntigravityContinuations ?? true,
  });
  const entries = (item: Extract<TranscriptTimelineItem, { type: 'work' }>) =>
    item.group.messages
      .flatMap((message) => (message.type === 'assistant' ? message.message.content : []))
      .map((block) => (block.type === 'tool_use' ? String((block.input as { command?: string }).command) : block.type))
      .join(', ');
  return items.flatMap((item) => {
    if (item.type === 'work') {
      const state = item.active
        ? 'live'
        : item.canCollapse
          ? `folded${typeof item.group.durationMs === 'number' ? ` ${Math.round(item.group.durationMs / 1000)}s` : ''}`
          : 'open';
      return [`trace (${state}): ${entries(item)}`];
    }
    const message = item.message;
    if (message.type === 'user_prompt') return [`prompt: ${message.prompt}`];
    if (message.type === 'assistant') {
      const block = message.message.content[0] as { text?: string };
      return [`${item.assistantPresentation}: ${block.text}`];
    }
    return [];
  });
}

// The turn the person asked for: a build command that outlives the turn.
const askedTurn = [
  prompt('Package the app'),
  usage(),
  thinking('1', 'I will start the build.'),
  call('call_bg_1', 'npm run dist'),
  text('1', 'Started the build; waiting for it to finish.'),
  usage(),
  callResult('call_bg_1', 'npm run dist'),
  result(28_000),
];
// What agy then does with no prompt from anyone, as the adapter now sends it.
const wokenWork = [wokeByItself(), usage(), thinking('2', 'The build finished.'), call('call_check_2', 'ls dist'), callResult('call_check_2', 'app.dmg')];
const wokenEnd = [text('2', 'The build is done: app.dmg.'), usage(), result(9_000)];

// ── While agy works by itself: its trace is live, under the answer above ────
{
  assert.deepEqual(layout([...askedTurn, ...wokenWork], { running: true }), [
    'prompt: Package the app',
    'trace (folded 28s): thinking, npm run dist',
    'answer: Started the build; waiting for it to finish.',
    'trace (live): thinking, ls dist',
  ]);
}

// ── Where the live turn starts: at agy's own turn, not the prompt before it ─
{
  const lastPromptIndex = (messages: StreamMessage[]) =>
    messages.reduce((last, message, index) => (message.type === 'user_prompt' ? index : last), -1);
  const live = [...askedTurn, ...wokenWork];
  const wokeAt = live.findIndex((message) => message.type === 'system' && message.subtype === 'init');
  assert.equal(findActiveTurnStartIndex(askedTurn), 0, 'a prompt opens the live turn');
  assert.equal(findActiveTurnStartIndex(live), wokeAt, 'then the turn agy started by itself does');
  // The live timer counts from there: a minute after the prompt, not from it.
  const startedAt = (index: number) => (live[index] as { createdAt: number }).createdAt;
  assert.ok(startedAt(wokeAt) - startedAt(0) >= 60_000);
  // A selfStarted init inside a turn that has not ended opens nothing (the turn is still the prompt's).
  assert.equal(findActiveTurnStartIndex([...askedTurn.slice(0, -1), wokeByItself()]), 0);
  // A later prompt takes over again; a subagent's messages never count.
  assert.equal(findActiveTurnStartIndex([...live, prompt('Thanks')]), live.length);
  assert.equal(findActiveTurnStartIndex([...live, { ...prompt('inner'), parentToolUseId: 'task' } as StreamMessage]), wokeAt);
  assert.equal(findActiveTurnStartIndex([]), -1);

  // A completed phase stays folded even when old records only identify the prompt.
  const silentTurn = [prompt('Package the app'), usage(), call('call_bg_1', 'npm run dist'), callResult('call_bg_1', 'npm run dist'), result(12_000)];
  const woken = [...silentTurn, ...wokenWork];
  assert.deepEqual(layout(woken, { running: true, activeTurnStartIndex: lastPromptIndex(woken) }), [
    'prompt: Package the app',
    'trace (folded 12s): npm run dist',
    'trace (live): thinking, ls dist',
  ]);
  assert.deepEqual(layout(woken, { running: true }), [
    'prompt: Package the app',
    'trace (folded 12s): npm run dist',
    'trace (live): thinking, ls dist',
  ]);
}

// Completed phases contribute one elapsed time and keep their notes in order.
{
  const whole = [...askedTurn, ...wokenWork, ...wokenEnd];
  const expected = [
    'prompt: Package the app',
    'trace (folded 37s): thinking, npm run dist, text, thinking, ls dist',
    'answer: The build is done: app.dmg.',
  ];
  assert.deepEqual(layout(whole, { running: false }), expected);
  // Other providers still render an explicit wake as a separate turn.
  assert.equal(layout(whole, { running: false, groupAntigravityContinuations: false }).filter(row => row.startsWith('trace')).length, 2);
  const liveAgain = [...whole, wokeByItself(), thinking('3', 'Checking again.')];
  assert.deepEqual(layout(liveAgain, { running: true }), [...expected, 'trace (live): thinking']);
  assert.deepEqual(layout([...liveAgain, text('3', 'All done.'), result(4_000)], { running: false }), [
    'prompt: Package the app',
    'trace (folded 41s): thinking, npm run dist, text, thinking, ls dist, text, thinking',
    'answer: All done.',
  ]);
  // And the next prompt starts an ordinary turn below it.
  assert.deepEqual(
    layout([...whole, prompt('Thanks'), text('3', 'Any time.'), usage(), result(2_000)], { running: false }).slice(-2),
    ['prompt: Thanks', 'answer: Any time.']
  );
}

// ── Transcripts stored before such turns were marked ────────────────────────
// No init and no result for agy's own work: thoughts and calls simply follow
// the turn's result. They used to be folded into the turn above, under its
// "Worked for 28s", as if they had happened before its answer.
{
  const unmarkedWork = [usage(), thinking('2', 'The build finished.'), call('call_check_2', 'ls dist'), callResult('call_check_2', 'app.dmg'), usage()];
  const stored = [...askedTurn, ...unmarkedWork];
  assert.deepEqual(layout(stored, { running: false, groupAntigravityContinuations: false }), [
    'prompt: Package the app',
    'trace (folded 28s): thinking, npm run dist, thinking, ls dist',
    'answer: Started the build; waiting for it to finish.',
  ]);
  assert.deepEqual(layout(stored, { running: false }), [
    'prompt: Package the app',
    'trace (folded): thinking, npm run dist, text, thinking, ls dist',
  ]);
  // With words of its own, and a prompt after it.
  const later = [...stored, text('2', 'The build is done.'), usage(), prompt('Thanks'), text('3', 'Any time.'), usage(), result(2_000)];
  assert.deepEqual(layout(later, { running: false }), [
    'prompt: Package the app',
    'trace (folded 30s): thinking, npm run dist, text, thinking, ls dist',
    'answer: The build is done.',
    'prompt: Thanks',
    'answer: Any time.',
  ]);
}

// ── An ordinary turn reads the same with or without the rule ────────────────
{
  const ordinary = [...askedTurn, prompt('And now?'), usage(), thinking('4', 'Checking.'), call('call_5', 'ls'), callResult('call_5', 'a b'), text('4', 'All there.'), usage(), result(4_000)];
  assert.deepEqual(layout(ordinary, { running: false }), layout(ordinary, { running: false, groupAntigravityContinuations: false }));
  const running = ordinary.slice(0, -3);
  assert.deepEqual(layout(running, { running: true }), layout(running, { running: true, groupAntigravityContinuations: false }));
  assert.deepEqual(layout(running, { running: true }).slice(-2), ['prompt: And now?', 'trace (live): thinking, ls']);
}

console.log('antigravity-woken-turn: all checks passed');
