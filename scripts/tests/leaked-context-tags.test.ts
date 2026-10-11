// Echoed context tags (Claude's <budget:remaining_tokens>) never reach the
// chat, including mid-stream; other angle-bracket text is left alone.
import assert from 'node:assert/strict';
import { stripLeakedContextTags as strip } from '../../src/ui/utils/leaked-context-tags';

assert.equal(strip('<budget:remaining_tokens>15000000</budget:remaining_tokens>'), '');
assert.equal(strip('<budget:remaining_tokens>15000000</budget:remaining_tokens>\n\n## useEffect'), '## useEffect');
assert.equal(strip('Answer.<budget:token_budget>200000</budget:token_budget> More.'), 'Answer.More.');
assert.equal(strip('text </budget:remaining_tokens>'), 'text ');
// Mid-stream: an open tag, or what may become one, is held back.
assert.equal(strip('<budget:remaining_tokens>1500', true), '');
assert.equal(strip('Hello <bud', true), 'Hello ');
assert.equal(strip('Hello <bud'), 'Hello <bud', 'only while streaming');
// Unrelated markup stays.
for (const text of ['a < b and c > d', '<div>html</div>', 'Use `<budget>` in XML', 'x <b>bold</b>']) {
  assert.equal(strip(text), text, text);
}
console.log('leaked-context-tags: budget tags stripped (whole, stray, streaming), other text untouched');
