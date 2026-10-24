import assert from 'node:assert/strict';
import { computeMarkdownStyles, isMarkdownTokenActive, markdownClassName } from '../../src/ui/utils/composer-markdown';

// Readable runs: [text, 'strong marker hide', ...] with the shared `composer-md`
// prefix dropped; `hide` marks syntax that collapses while the caret is outside.
function runs(value: string, atomic: Array<{ start: number; end: number }> = []): Array<[string, string]> {
  const { flags, tokenOf } = computeMarkdownStyles(value, atomic);
  const result: Array<[string, string]> = [];
  let lastToken = -1;
  for (let index = 0; index < value.length; index += 1) {
    const style = flags[index] ? markdownClassName(flags[index]!).replace(/composer-md(--)?/g, '').trim().replace(/\s+/g, ' ') : '';
    const name = tokenOf[index]! >= 0 ? `${style} hide` : style;
    const last = result.at(-1);
    if (last && last[1] === name && tokenOf[index] === lastToken) last[0] += value[index];
    else result.push([value[index]!, name]);
    lastToken = tokenOf[index]!;
  }
  return result;
}

// Bold, italic, strike, inline code: syntax chars are hideable markers.
assert.deepEqual(runs('**加粗** ok'), [['**', 'marker hide'], ['加粗', 'strong'], ['**', 'marker hide'], [' ok', '']]);
assert.deepEqual(runs('a *em* _u_ ~~s~~'), [
  ['a ', ''], ['*', 'marker hide'], ['em', 'em'], ['*', 'marker hide'], [' ', ''], ['_', 'marker hide'], ['u', 'em'], ['_', 'marker hide'],
  [' ', ''], ['~~', 'marker hide'], ['s', 'strike'], ['~~', 'marker hide'],
]);
assert.deepEqual(runs('use `a**b**` now'), [['use ', ''], ['`', 'marker hide'], ['a**b**', 'code'], ['`', 'marker hide'], [' now', '']]);
assert.deepEqual(runs('**a *b* c**'), [
  ['**', 'marker hide'], ['a ', 'strong'], ['*', 'marker strong hide'], ['b', 'strong em'], ['*', 'marker strong hide'], [' c', 'strong'], ['**', 'marker hide'],
]);

// Unclosed or space-padded syntax and snake_case stay plain and visible.
assert.deepEqual(runs('**open'), [['**open', '']]);
assert.deepEqual(runs('2 * 3 * 4'), [['2 * 3 * 4', '']]);
assert.deepEqual(runs('snake_case_name'), [['snake_case_name', '']]);

// Block syntax: heading/quote markers hide off-line; list markers and fences stay.
assert.deepEqual(runs('# Title\n## Sub'), [['# ', 'marker h1 hide'], ['Title', 'h1'], ['\n', ''], ['## ', 'marker h2 hide'], ['Sub', 'h2']]);
assert.deepEqual(runs('# '), [['# ', 'marker h1']]);
assert.deepEqual(runs('#tag'), [['#tag', '']]);
assert.deepEqual(runs('> quote'), [['> ', 'marker quote hide'], ['quote', 'quote']]);
assert.deepEqual(runs('- item **b**\n1. one'), [
  ['- ', 'list'], ['item ', ''], ['**', 'marker hide'], ['b', 'strong'], ['**', 'marker hide'], ['\n', ''], ['1. ', 'list'], ['one', ''],
]);
assert.deepEqual(runs('```ts\nconst *a* = 1\n```\n*x*'), [
  ['```ts', 'marker codeblock'], ['\n', ''], ['const *a* = 1', 'codeblock'], ['\n', ''], ['```', 'marker codeblock'], ['\n', ''],
  ['*', 'marker hide'], ['x', 'em'], ['*', 'marker hide'],
]);

// Links hide brackets and URL.
assert.deepEqual(runs('[docs](https://x.y)'), [['[', 'marker hide'], ['docs', 'link'], ['](https://x.y)', 'marker hide']]);

// Atomic chip text never opens or closes syntax.
const mention = '@src/a_b_.ts';
const value = `_x ${mention}`;
assert.deepEqual(runs(value, [{ start: 3, end: value.length }]), [[value, '']]);

// Reveal rules: inline markers show from the opening marker up to (not
// including) the end, so the caret right after `*好*` keeps them hidden;
// block markers show anywhere on the line.
const [em] = computeMarkdownStyles('*好*').tokens;
assert.deepEqual([0, 1, 2, 3].map(caret => isMarkdownTokenActive(em!, caret)), [true, true, true, false]);
const [heading] = computeMarkdownStyles('# 标题\nnext').tokens;
assert.deepEqual([0, 4, 5].map(caret => isMarkdownTokenActive(heading!, caret)), [true, true, false]);

console.log('composer-markdown: all assertions passed');
