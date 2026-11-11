import assert from 'node:assert/strict';
import {
  filterTaskSuggestions,
  formatTaskNumber,
  getTaskMentionState,
  insertTaskMention,
  localReferenceError,
  type TaskSuggestion,
} from '../../src/ui/utils/task-mentions';
import { extractSessionLinks } from '../../src/shared/session-links';

const at = (prompt: string, cursor = prompt.length) => getTaskMentionState(prompt, cursor);

// The `#` opens a mention at the start, after a space, and after text written without spaces.
assert.deepEqual(at('#'), { query: '', start: 0, end: 1 });
assert.deepEqual(at('see #12'), { query: '12', start: 4, end: 7 });
assert.deepEqual(at('接着#128'), { query: '128', start: 2, end: 6 });
assert.deepEqual(at('(#side'), { query: 'side', start: 1, end: 6 });
// Not inside a word, a path, an entity or a second `#`.
for (const prompt of ['C#', 'page#top', 'https://x.dev/a/#top', '&#39', '##', 'issue# 12', '#12 ', '@#12', 'see @#notes']) {
  assert.equal(at(prompt), null, prompt);
}
// A pick replaces up to the cursor; only a number the cursor is inside of is taken whole.
assert.deepEqual(at('see #128 now', 6), { query: '1', start: 4, end: 8 });
assert.deepEqual(at('see (#128) now', 9), { query: '128', start: 5, end: 9 });
assert.deepEqual(at('接着#128做完', 6), { query: '128', start: 2, end: 6 });
assert.deepEqual(at('see #side-bar', 9), { query: 'side', start: 4, end: 9 });
// Past the bracket the text is no longer a number.
assert.equal(at('see (#128)')!.query, '128)');

const tasks: TaskSuggestion[] = [
  { id: 'a', number: 1, title: 'Sidebar search row', updatedAt: 10 },
  { id: 'b', number: 12, title: 'Fix 1 flaky test', updatedAt: 40 },
  { id: 'c', number: 128, title: 'search palette', updatedAt: 30 },
  { id: 'd', number: 7, title: 'Update button', updatedAt: 50 },
];
const ids = (query: string, limit?: number) => filterTaskSuggestions(tasks, query, limit).map((task) => task.id);

// Nothing typed: the most recent tasks.
assert.deepEqual(ids(''), ['d', 'b', 'c', 'a']);
assert.deepEqual(ids('', 2), ['d', 'b']);
// Digits: the number itself, then numbers that start with them (newest first), then titles.
assert.deepEqual(ids('1'), ['a', 'b', 'c']);
assert.deepEqual(ids('12'), ['b', 'c']);
assert.deepEqual(ids('128'), ['c']);
assert.deepEqual(ids('9'), []);
// Words: titles that start with the query before titles that contain it.
assert.deepEqual(ids('Search'), ['c', 'a']);
assert.deepEqual(ids('button'), ['d']);

// Picking a task swaps the typed text for its conversation link, which the composer shows as a chip.
const id = '11111111-2222-4333-8444-555555555555';
const prompt = '接着#128';
const next = insertTaskMention(prompt, at(prompt)!, id);
assert.equal(next.prompt, `接着aegis://sessions/${id} `);
assert.equal(next.cursorIndex, next.prompt.length);
const spaced = insertTaskMention('see #12 and go', at('see #12 and go', 7)!, id);
assert.equal(spaced.prompt, `see aegis://sessions/${id} and go`);
assert.equal(spaced.prompt.slice(spaced.cursorIndex), 'and go');
assert.deepEqual(extractSessionLinks(spaced.prompt).map((link) => link.sessionId), [id]);
// Text around the number stays where it was.
const bracketed = insertTaskMention('see (#128) now', at('see (#128) now', 9)!, id);
assert.equal(bracketed.prompt, `see (aegis://sessions/${id}) now`);
assert.equal(bracketed.prompt.slice(bracketed.cursorIndex), ') now');
assert.deepEqual(extractSessionLinks(bracketed.prompt).map((link) => link.sessionId), [id]);
const inline = insertTaskMention('接着#128做完', at('接着#128做完', 6)!, id);
assert.equal(inline.prompt, `接着aegis://sessions/${id} 做完`);
assert.deepEqual(extractSessionLinks(inline.prompt).map((link) => link.sessionId), [id]);
assert.deepEqual(extractSessionLinks(next.prompt).map((link) => link.sessionId), [id]);

// After a colon the link would not be read as one, so a space goes before it.
const colon = insertTaskMention('see:#128', at('see:#128')!, id);
assert.equal(colon.prompt, `see: aegis://sessions/${id} `);
assert.equal(colon.cursorIndex, colon.prompt.length);
assert.deepEqual(extractSessionLinks(colon.prompt).map((link) => link.sessionId), [id]);

// A prompt bound for another Mac may not name a task on this one.
const known = { [id]: {}, remote: { device: { id: 'mac' } } };
assert.match(localReferenceError(`see aegis://sessions/${id}`, known)!, /another Mac/);
assert.equal(localReferenceError('see #128', known), null);
assert.equal(localReferenceError(`see aegis://sessions/${id}`, { [id]: { device: { id: 'mac' } } }), null);
assert.equal(localReferenceError('see aegis://sessions/99999999-2222-4333-8444-555555555555', known), null);

assert.equal(formatTaskNumber(128), '#128');

console.log('task-mentions.test.ts passed');
