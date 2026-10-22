import assert from 'node:assert/strict';
import { workDisclosureScope, type WorkDisclosureScope } from '../../src/ui/utils/work-disclosure-scope';
import { findTimelineItemWithToolCall, findToolCallMessage, findWorkGroupWithToolCall } from '../../src/ui/utils/tool-call-lookup';
import { deriveTranscriptTimelineItems } from '../../src/ui/utils/transcript-timeline';
import { resolveScopedChoices } from '../../src/ui/components/WorkstreamDisclosureState';
import type { StreamMessage } from '../../src/ui/types';

const prompt = (createdAt: number) => ({ type: 'user_prompt', prompt: 'go', createdAt }) as StreamMessage;
const assistant = (uuid: string, createdAt?: number) =>
  ({ type: 'assistant', uuid, createdAt, message: { role: 'assistant', content: [{ type: 'text', text: uuid }] } }) as unknown as StreamMessage;
const result = (createdAt?: number) =>
  ({ type: 'result', subtype: 'success', duration_ms: 1, total_cost_usd: 0, usage: {}, createdAt }) as unknown as StreamMessage;
const ended = (uuid: string, createdAt?: number) =>
  ({ type: 'system', subtype: 'background_task_ended', uuid, createdAt, outcome: { status: 'completed', summary: '' } }) as unknown as StreamMessage;

// Stored history: every message carries its row time. A prompt's turn, a run
// the agent started itself after a background task ended, then the next prompt.
const stored = [
  prompt(100), assistant('a1', 101), assistant('a2', 102), result(103),
  ended('e', 104), assistant('b1', 105), assistant('b2', 106), result(107),
  prompt(200), assistant('c1', 201), result(202),
];
const groups = { a: ['a1', 'a2'], b: ['b1', 'b2'], c: ['c1'] } as const;
const indicesOf = (messages: StreamMessage[], uuids: readonly string[]) =>
  uuids.map((uuid) => messages.findIndex((message) => (message as { uuid?: string }).uuid === uuid)).filter((index) => index >= 0);
const scopeOf = (messages: StreamMessage[], group: keyof typeof groups) => workDisclosureScope('s', messages, indicesOf(messages, groups[group]));
const names = (scope: WorkDisclosureScope) => [scope.scope, ...scope.aliases];

// The prompt's run is named by its prompt; the woken run by the message that opened it.
assert.equal(scopeOf(stored, 'a').scope, 's:start:user_prompt@100');
assert.equal(scopeOf(stored, 'b').scope, 's:start:uuid:e');
assert.equal(scopeOf(stored, 'c').scope, 's:start:user_prompt@200');
// Groups of different runs never share a name.
for (const [x, y] of [['a', 'b'], ['a', 'c'], ['b', 'c']] as const) {
  assert.equal(names(scopeOf(stored, x)).some((name) => names(scopeOf(stored, y)).includes(name)), false, `${x} and ${y} share no name`);
}

// Paging: history arrives a page at a time from the end, and a page can cut a
// run anywhere. Whatever a group was named on any partial page stays one of
// its names once more history loads (so its stored choices carry over), and
// is never a name of another group.
for (let cut = 1; cut < stored.length; cut += 1) {
  const page = stored.slice(cut);
  for (const group of Object.keys(groups) as Array<keyof typeof groups>) {
    const indices = indicesOf(page, groups[group]);
    if (indices.length === 0) continue;
    const partial = workDisclosureScope('s', page, indices);
    const full = scopeOf(stored, group);
    assert.ok(names(full).includes(partial.scope), `cut ${cut}: ${group}'s page name ${partial.scope} survives (${names(full).join(', ')})`);
    for (const other of Object.keys(groups) as Array<keyof typeof groups>) {
      if (other === group) continue;
      assert.equal(names(scopeOf(stored, other)).includes(partial.scope), false, `cut ${cut}: ${group}'s page name is not ${other}'s`);
    }
  }
}

// A live run: results arrive without a time or uuid. They are left out of the
// names rather than named by position, and a run keeps its name when it finishes.
const live = [prompt(100), assistant('a1'), assistant('a2'), result(), ended('e'), assistant('b1'), assistant('b2')];
const running = workDisclosureScope('s', live, indicesOf(live, groups.b));
const finished = workDisclosureScope('s', [...live, result()], indicesOf(live, groups.b));
assert.equal(running.scope, 's:start:uuid:e');
assert.equal(finished.scope, running.scope, 'a run keeps its name when it finishes');
assert.equal(names(finished).some((name) => /@|uuid/.test(name) === false), false, 'no positional names');

// History paging in one message at a time, with the user toggling folds along
// the way: every fold must read back the user's latest choice through the
// registry's resolution, whatever the run's results are named (stored), not
// named (live), or missing (a run still going), and no fold may read another's.
const scenarios: Array<[string, StreamMessage[]]> = [
  ['stored results', stored],
  ['unnamed live results', [prompt(100), assistant('a1'), assistant('a2'), result(), ended('e'), assistant('b1'), assistant('b2'), result(), prompt(200), assistant('c1'), result()]],
  ['unfinished last run', [prompt(100), assistant('a1', 101), assistant('a2', 102), result(103), ended('e', 104), assistant('b1', 105), assistant('b2', 106), prompt(200), assistant('c1', 201)]],
];
let seed = 7;
const random = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
for (const [label, full] of scenarios) {
  for (let trial = 0; trial < 40; trial += 1) {
    const turns: Record<string, Record<string, { expanded: boolean; order: number }>> = {};
    const expected: Partial<Record<keyof typeof groups, boolean>> = {};
    let order = 0;
    for (let cut = full.length - 1; cut >= 0; cut -= 1) {
      const page = full.slice(cut);
      for (const group of Object.keys(groups) as Array<keyof typeof groups>) {
        const indices = indicesOf(page, groups[group]);
        if (indices.length === 0) continue;
        const { scope, aliases } = workDisclosureScope('s', page, indices);
        const seen = resolveScopedChoices(turns, [scope, ...aliases]).turn;
        assert.equal(seen, expected[group], `${label}, trial ${trial}, cut ${cut}: ${group} reads its latest choice`);
        if (random() < 0.4) {
          const expanded = random() < 0.5;
          order += 1;
          turns[scope] = { ...turns[scope], turn: { expanded, order } };
          expected[group] = expanded;
        }
      }
    }
  }
}

// Tool call lookup: top-level work, inline work, and calls a subagent made.
const call = (uuid: string, id: string, parentToolUseId?: string) =>
  ({ type: 'assistant', uuid, createdAt: 1, parentToolUseId, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } }) as unknown as StreamMessage;
const transcript = [
  prompt(300), call('t1', 'top-call'), { type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 'top-call', content: 'ok' }] } } as unknown as StreamMessage,
  call('n1', 'nested-call', 'task-1'), assistant('done', 2), result(3),
];
const items = deriveTranscriptTimelineItems(transcript, { activeTurnStartIndex: 0, sessionRunning: false });
assert.ok(findWorkGroupWithToolCall(items, 'top-call'), 'a top-level call is found in its work group');
assert.ok(findTimelineItemWithToolCall(items, 'top-call'));
assert.equal(findWorkGroupWithToolCall(items, 'nested-call'), null, 'a subagent call is not in the transcript');
assert.equal(findToolCallMessage(transcript, 'nested-call')?.parentToolUseId, 'task-1', 'its owning task is known');
assert.equal(findToolCallMessage(transcript, 'missing'), null);
// A call shown in an assistant message's inline work is found through that message.
const inlineCall = call('i1', 'inline-call');
const inlineItems = [{
  type: 'message', message: assistant('answer', 5), originalIndex: 0,
  inlineWorkGroup: { id: 'work:inline', messages: [inlineCall], originalIndices: [1] },
}] as unknown as Parameters<typeof findTimelineItemWithToolCall>[0];
assert.equal(findTimelineItemWithToolCall(inlineItems, 'inline-call'), inlineItems[0], 'inline work is searched');
assert.equal(findWorkGroupWithToolCall(inlineItems, 'inline-call'), null, 'inline work is not a work group');

console.log('work disclosure scope: per-run names, paging and tool call lookup passed');
