// A finished turn shows its widgets — and, from the first widget on, the
// reply text between and after them — outside the collapsed trace, in order.
// Working notes before the first widget, rejected widgets and other tools stay
// in the trace; workflow boards always come out.
import assert from 'node:assert/strict';
import { pinnedTurnEntries } from '../../src/ui/utils/turn-pins';
import type { WorkstreamEntry } from '../../src/ui/utils/workstream';

const note = (id: string, text: string) => ({ id, type: 'note', summary: text, detail: text }) as unknown as WorkstreamEntry;
const tool = (id: string, toolName: string, input: unknown, status = 'success', isError = false) =>
  ({ id, type: 'tool', toolName, status, block: { id, name: toolName, input }, result: { is_error: isError } }) as unknown as WorkstreamEntry;
const widget = (id: string, status = 'success', isError = false) => tool(id, 'mcp__aegis-sessions__show_widget', { html: '<div></div>' }, status, isError);
const ids = (entries: WorkstreamEntry[]) => pinnedTurnEntries(entries).map((entry) => entry.id);

assert.deepEqual(
  ids([
    note('plan', 'Let me draw this.'),
    tool('guide', 'widget_guide', {}),
    widget('w1'),
    note('between', 'The stem pulls up; gravity pulls down.'),
    tool('bash', 'Bash', { command: 'ls' }),
    widget('w2'),
    note('after', 'Everywhere, "down" means toward the center.'),
  ]),
  ['w1', 'between', 'w2', 'after'],
  'visual → text → visual, working notes and other tools stay in the trace'
);

assert.deepEqual(ids([note('a', 'plain answer'), tool('bash', 'Bash', {})]), [], 'no widget, nothing pinned');
assert.deepEqual(
  ids([widget('bad', 'error', true), note('fix', 'Fixing the script.'), widget('good'), note('done', 'Here it is.')]),
  ['good', 'done'],
  'a rejected widget is not drawn and does not start the pinned run'
);
assert.deepEqual(
  ids([widget('stopped', 'interrupted'), note('after', 'Stopped mid-way.')]),
  ['stopped', 'after'],
  'a call the tool never answered (a stopped turn) still shows its markup'
);
assert.deepEqual(ids([widget('w'), note('echo', '<budget:remaining_tokens>1</budget:remaining_tokens>')]), ['w'], 'empty text after stripping is skipped');
assert.deepEqual(
  ids([tool('wf', 'start_workflow', { request: 'x' }) as WorkstreamEntry]).length,
  0,
  'a plain tool named start_workflow is not a task entry'
);
console.log('turn-pins: widgets and the text between them pinned in order; notes before, rejected widgets and tools stay');
