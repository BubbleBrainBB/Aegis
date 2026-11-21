// Comments on diff lines: which lines a gutter selection quotes, the text the
// agent reads, and what the main process keeps of renderer-supplied comments.
// Run: npx tsx scripts/tests/review-comments.test.mts
import assert from 'node:assert/strict';
import { parsePatchFiles } from '@pierre/diffs';
import {
  REVIEW_COMMENT_LIMITS,
  promptWithReviewComments,
  reviewCommentLocation,
  reviewCommentsPromptText,
  sanitizeReviewComments,
  withReviewComments,
  type ReviewComment,
} from '../../src/shared/review-comments';
import {
  hasReviewDiffLine,
  reviewCommentAnchor,
  reviewDiffRows,
  reviewScopeKey,
} from '../../src/ui/utils/review-comment-lines';

const PATCH = `diff --git a/src/scheduler.ts b/src/scheduler.ts
index 1111111..2222222 100644
--- a/src/scheduler.ts
+++ b/src/scheduler.ts
@@ -10,3 +10,4 @@ const A = 1;
 const POLL = 30_000;
 const MAX = 4;
+const GRACE = 60_000;
 const NEXT = 2;
@@ -142,5 +143,8 @@ class Scheduler {
   private async tick() {
     const now = Date.now();
-    const due = list(now).slice(0, MAX);
+    const due = list(now);
+    const paused = listPaused(now - GRACE);
+    for (const row of paused) {
+      await this.start(row);
     for (const item of due) {
       void this.run(item);
`;

const fileDiff = parsePatchFiles(PATCH)[0].files[0];
assert.ok(fileDiff, 'the patch parses to one file');

// --- rows: unified order, both line numbers ---
const rows = reviewDiffRows(fileDiff);
assert.deepEqual(
  rows.slice(0, 4).map((row) => [row.kind, row.oldLine, row.newLine, row.text]),
  [
    ['context', 10, 10, 'const POLL = 30_000;'],
    ['context', 11, 11, 'const MAX = 4;'],
    ['addition', undefined, 12, 'const GRACE = 60_000;'],
    ['context', 12, 13, 'const NEXT = 2;'],
  ],
);
const removed = rows.find((row) => row.kind === 'deletion');
assert.deepEqual([removed?.oldLine, removed?.newLine, removed?.text], [144, undefined, '    const due = list(now).slice(0, MAX);']);
assert.equal(rows.find((row) => row.text === '    const due = list(now);')?.newLine, 145);
assert.equal(hasReviewDiffLine(rows, 145, 'additions'), true);
assert.equal(hasReviewDiffLine(rows, 144, 'deletions'), true);
assert.equal(hasReviewDiffLine(rows, 145, 'deletions'), true, 'old line 145 is the context line after the change');
assert.equal(hasReviewDiffLine(rows, 147, 'deletions'), false, 'the old file has no line 147 in this diff');
assert.equal(hasReviewDiffLine(rows, 900, 'additions'), false);

// --- anchors ---
assert.deepEqual(reviewCommentAnchor(fileDiff, { start: 145, side: 'additions', end: 145, endSide: 'additions' }), {
  startLine: 145,
  startSide: 'additions',
  endLine: 145,
  endSide: 'additions',
  code: ['+    const due = list(now);'],
});
// Dragged upwards: read top to bottom.
assert.deepEqual(reviewCommentAnchor(fileDiff, { start: 148, side: 'additions', end: 146, endSide: 'additions' }), {
  startLine: 146,
  startSide: 'additions',
  endLine: 148,
  endSide: 'additions',
  code: ['+    const paused = listPaused(now - GRACE);', '+    for (const row of paused) {', '+      await this.start(row);'],
});
// From the removed line into the added ones: both kinds are quoted.
assert.deepEqual(reviewCommentAnchor(fileDiff, { start: 144, side: 'deletions', end: 145, endSide: 'additions' }).code, [
  '-    const due = list(now).slice(0, MAX);',
  '+    const due = list(now);',
]);
// A context line is found by either number.
assert.deepEqual(reviewCommentAnchor(fileDiff, { start: 143, side: 'deletions', end: 143, endSide: 'deletions' }).code, ['     const now = Date.now();']);
// A line the patch does not show quotes nothing, and keeps its position.
const outside = reviewCommentAnchor(fileDiff, { start: 900, side: 'additions', end: 900, endSide: 'additions' });
assert.deepEqual([outside.startLine, outside.endLine, outside.code], [900, 900, []]);

// --- scope keys ---
assert.equal(reviewScopeKey({ source: { kind: 'workspace', scope: 'working-tree' } }), 'workspace:working-tree');
assert.equal(reviewScopeKey({ source: { kind: 'turn', turnKey: 't1', label: 'Last turn' } }), 'turn:t1');
assert.equal(reviewScopeKey({ source: { kind: 'commit', sha: 'abc', shortSha: 'abc', label: 'abc' } }), 'commit:abc');

// --- the text the agent reads ---
const first: ReviewComment = {
  id: 'c1',
  filePath: 'src/scheduler.ts',
  startLine: 145,
  startSide: 'additions',
  endLine: 145,
  endSide: 'additions',
  code: ['+    const due = list(now);'],
  text: 'Keep the cap here.\nA backlog starts everything at once.',
  scope: 'Last turn',
  scopeKey: 'turn:t1',
};
const second: ReviewComment = {
  ...first,
  id: 'c2',
  startLine: 146,
  endLine: 148,
  code: ['+    const paused = listPaused(now - GRACE);', '+    for (const row of paused) {', '+      await this.start(row);'],
  text: 'Resume in the session\'s own permission mode.',
};
assert.equal(reviewCommentLocation(first), 'scheduler.ts:145');
assert.equal(reviewCommentLocation(second), 'scheduler.ts:146–148');
assert.equal(reviewCommentsPromptText([]), '');
assert.equal(withReviewComments('Fix these two.', []), 'Fix these two.');
assert.equal(
  withReviewComments('Fix these two.\n', [first, second]),
  [
    'Fix these two.',
    '',
    'Review comments on the diff (Last turn):',
    '',
    '1. src/scheduler.ts:145',
    '   +    const due = list(now);',
    '   Keep the cap here.',
    '   A backlog starts everything at once.',
    '',
    '2. src/scheduler.ts:146-148',
    '   +    const paused = listPaused(now - GRACE);',
    '   +    for (const row of paused) {',
    '   +      await this.start(row);',
    '   Resume in the session\'s own permission mode.',
  ].join('\n'),
);
// Nothing typed: the comments are the whole message.
assert.ok(withReviewComments('  ', [first]).startsWith('Review comments on the diff (Last turn):'));
// Comments from two diffs name theirs; removed lines say so.
const onRemoved: ReviewComment = {
  ...first,
  id: 'c3',
  startLine: 144,
  startSide: 'deletions',
  endLine: 144,
  endSide: 'deletions',
  code: ['-    const due = list(now).slice(0, MAX);'],
  text: 'Why was the cap removed?',
  scope: 'Uncommitted',
  scopeKey: 'workspace:working-tree',
};
const mixed = reviewCommentsPromptText([first, onRemoved]);
assert.ok(mixed.startsWith('Review comments on the diff:\n\n1. src/scheduler.ts:145 (Last turn)\n'));
assert.ok(mixed.includes('2. src/scheduler.ts:144 (removed, Uncommitted)\n   -    const due = list(now).slice(0, MAX);\n   Why was the cap removed?'));
// A long selection is quoted up to a limit.
const long = reviewCommentsPromptText([{ ...first, code: Array.from({ length: 30 }, (_, i) => `+line ${i}`) }]);
assert.equal(long.split('\n').filter((line) => line.startsWith('   +line')).length, REVIEW_COMMENT_LIMITS.quotedLines);
assert.ok(long.includes('\n   …\n'));

// --- what the main process keeps ---
assert.equal(sanitizeReviewComments(undefined), undefined);
assert.equal(sanitizeReviewComments('x'), undefined);
assert.equal(sanitizeReviewComments([]), undefined);
assert.equal(sanitizeReviewComments([{ filePath: 'a.ts', startLine: 1, endLine: 1, text: '   ' }]), undefined, 'an empty comment is dropped');
assert.equal(sanitizeReviewComments([{ filePath: '', startLine: 1, endLine: 1, text: 'x' }]), undefined);
assert.equal(sanitizeReviewComments([{ filePath: 'a.ts', startLine: '1', endLine: 1, text: 'x' }]), undefined);
assert.deepEqual(sanitizeReviewComments([first, null, { nope: true }]), [first]);
const cleaned = sanitizeReviewComments([{
  filePath: 'a\nb.ts',
  startLine: 3,
  endLine: 4,
  startSide: 'sideways',
  code: ['+ok', 7, `+${'x'.repeat(1000)}`, '+two\nlines'],
  text: ` ${'y'.repeat(REVIEW_COMMENT_LIMITS.textChars + 50)} `,
  extra: 'dropped',
}])!;
assert.equal(cleaned.length, 1);
assert.equal(cleaned[0].filePath, 'a b.ts');
assert.deepEqual([cleaned[0].startSide, cleaned[0].endSide], ['additions', 'additions']);
assert.equal(cleaned[0].text.length, REVIEW_COMMENT_LIMITS.textChars);
assert.deepEqual(cleaned[0].code.map((line) => line.length), [3, REVIEW_COMMENT_LIMITS.codeLineChars, 9]);
assert.equal('extra' in cleaned[0], false);
assert.equal(
  sanitizeReviewComments(Array.from({ length: 80 }, (_, i) => ({ ...first, id: `c${i}` })))!.length,
  REVIEW_COMMENT_LIMITS.comments,
);

// --- transcripts: a stored message reads as text with its comments ---
assert.equal(promptWithReviewComments('Fix it.', undefined), 'Fix it.');
assert.equal(promptWithReviewComments('', [first]), reviewCommentsPromptText([first]));
assert.equal(promptWithReviewComments('Fix it.', [{ junk: true }]), 'Fix it.');

console.log('review-comments: ok');
