import assert from 'node:assert/strict';
import { designToolNameOf, isDesignWriteTool } from '../../src/shared/design-tools';
import { findPendingToolUse, sameToolInput } from '../../src/electron/libs/tool-caller-attribution';
import { designToolDisplay } from '../../src/ui/utils/design-tool-display';
import { designGuideText } from '../../src/electron/design/guide';
import type { StreamMessage } from '../../src/shared/types';

// Names: bare or namespaced by Aegis's own servers; another server's look-alike is not ours.
assert.equal(designToolNameOf('design_update'), 'design_update');
assert.equal(designToolNameOf('mcp__aegis-sessions__design_update'), 'design_update');
assert.equal(designToolNameOf('aegis-sessions_design_read'), 'design_read');
assert.equal(designToolNameOf('aegis-widgets.design_preview'), 'design_preview');
assert.equal(designToolNameOf('aegis-sessions/design_guide'), 'design_guide');
assert.equal(designToolNameOf('mcp__figma__design_update'), null);
assert.equal(designToolNameOf('my_design_update'), null);
assert.equal(designToolNameOf('design_updates'), null);
assert.equal(isDesignWriteTool('mcp__aegis-sessions__design_create'), true);
assert.equal(isDesignWriteTool('design_preview'), false);

// Input matching ignores key order and undefined keys.
assert.ok(sameToolInput({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1, d: undefined }));
assert.ok(!sameToolInput({ a: 1 }, { a: 2 }));
assert.ok(!sameToolInput([1, 2], [2, 1]));

const call = (id: string, input: unknown, name = 'design_read') =>
  ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }) as unknown as StreamMessage;
const result = (id: string) =>
  ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }) as unknown as StreamMessage;
const sub = { ...call('sub-1', { documentId: 'd' }), parentToolUseId: 'task-1' } as unknown as StreamMessage;
const match = (name: unknown) => designToolNameOf(name) === 'design_read';
const history = [call('c1', { documentId: 'd' }), result('c1'), sub, call('c2', { documentId: 'd' }), call('c3', { documentId: 'e' })];
assert.equal(findPendingToolUse(history, match, { documentId: 'd' }), 'c2', 'the latest unanswered top-level call');
assert.equal(findPendingToolUse(history, match, { documentId: 'd' }, new Set(['c2'])), null, 'claimed calls are skipped');
assert.equal(findPendingToolUse(history, match, { documentId: 'x' }), null);

// Trace wording.
assert.deepEqual(designToolDisplay('design_create', { title: 'Atlas website' }, 'success'), { verb: 'Created design', target: 'Atlas website' });
assert.deepEqual(designToolDisplay('design_update', { operations: [{ type: 'add', name: 'Pricing' }] }, 'pending'), { verb: 'Drawing', target: 'Pricing' });
assert.deepEqual(designToolDisplay('design_update', { operations: [{ type: 'content', boardId: 'b1' }, { type: 'content', boardId: 'b2' }] }, 'success'), { verb: 'Edited', target: '2 boards' });
assert.deepEqual(designToolDisplay('design_update', { summary: 'Calmer pricing', operations: [] }, 'success'), { verb: '', target: 'Calmer pricing' });
assert.equal(designToolDisplay('mcp__aegis-sessions__design_preview', {}, 'pending')?.verb, 'Checking');
assert.equal(designToolDisplay('read_session', {}, 'success'), null);

// Guide: topics narrow it; a picked style guide leads.
const all = designGuideText();
assert.match(all, /## Tokens first/);
assert.match(all, /## Check once with a preview/);
const some = designGuideText(['color']);
assert.match(some, /## Color and surfaces/);
assert.doesNotMatch(some, /## Tokens first/);
const styled = designGuideText(['type'], { name: 'Quiet Slate', text: '# Quiet Slate\nInk #2f3244 on #eff1f4.' });
assert.ok(styled.indexOf('Style guide: Quiet Slate') < styled.indexOf('## Typography'));

console.log('design-tools: names, attribution matching, trace wording and guide passed');
