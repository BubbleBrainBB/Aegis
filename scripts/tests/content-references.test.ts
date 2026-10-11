// Codex `visualize` references become visualization parts in place; other
// content references and half-streamed ones never show as raw boxes.
import assert from 'node:assert/strict';
import { splitContentReferences as split } from '../../src/ui/utils/content-references';

const ref = (kind: string, payload: string) => `${kind}${payload}`;
assert.deepEqual(split('plain text'), [{ type: 'text', text: 'plain text' }]);

const parts = split(`Before\n${ref('visualize', '{"path":"/p/a.html","title":"GDP","mode":"wide"}')}\nAfter`);
assert.deepEqual(parts.map((part) => part.type), ['text', 'visualize', 'text']);
assert.deepEqual(parts[1].type === 'visualize' && parts[1].reference, { path: '/p/a.html', title: 'GDP', mode: 'wide' });

assert.deepEqual(split(`A ${ref('cite', 'turn0search0')} B`), [{ type: 'text', text: 'A ' }, { type: 'text', text: ' B' }], 'citations are dropped');
assert.deepEqual(split(`A ${ref('visualize', 'not json')} B`).map((part) => part.type), ['text', 'text'], 'a broken reference is dropped');
assert.deepEqual(split('Answer visualize{"path":"/p/a.h'), [{ type: 'text', text: 'Answer ' }], 'a reference mid-stream is held back');
assert.equal(split(ref('visualize', '{"path":"/p/a.html"}') + ref('visualize', '{"path":"/p/b.html"}')).filter((part) => part.type === 'visualize').length, 2);
console.log('content-references: visualize parts in place, other and partial references hidden');
