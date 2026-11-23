import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  createUnifiedDiffHunks,
  limitDiffHunks,
  trimCommonLines,
  type UnifiedDiffHunk,
} from '../../src/shared/unified-diff';

// ── The diff this module gave before it stopped searching common lines ──────
// Kept here as the reference: a full LCS table over every line of both texts.

type Op = { type: 'equal' | 'insert' | 'delete'; text: string };

function referenceOps(oldLines: string[], newLines: string[]): Op[] {
  const cols = newLines.length + 1;
  const table = new Uint32Array((oldLines.length + 1) * cols);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      if (oldLines[i] === newLines[j]) {
        table[i * cols + j] = table[(i + 1) * cols + j + 1] + 1;
      } else {
        const down = table[(i + 1) * cols + j];
        const right = table[i * cols + j + 1];
        table[i * cols + j] = down >= right ? down : right;
      }
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'equal', text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      ops.push({ type: 'delete', text: oldLines[i] });
      i += 1;
    } else {
      ops.push({ type: 'insert', text: newLines[j] });
      j += 1;
    }
  }
  for (; i < oldLines.length; i += 1) ops.push({ type: 'delete', text: oldLines[i] });
  for (; j < newLines.length; j += 1) ops.push({ type: 'insert', text: newLines[j] });
  return ops;
}

const editCount = (ops: Op[]) => ops.filter((op) => op.type !== 'equal').length;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Deterministic pseudo-random numbers, so a failure can be reproduced. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const text = (lines: string[]) => (lines.length ? `${lines.join('\n')}\n` : '');
const WHOLE = Number.MAX_SAFE_INTEGER;

/** One hunk holding every line (`contextLines` larger than the texts). */
function wholeDiff(oldLines: string[], newLines: string[]): UnifiedDiffHunk['lines'] {
  const hunks = createUnifiedDiffHunks(text(oldLines), text(newLines), { contextLines: WHOLE });
  if (hunks.length === 0) return oldLines.map((line, index) => ({
    type: 'context' as const, oldLineNumber: index + 1, newLineNumber: index + 1, text: line,
  }));
  assert.equal(hunks.length, 1);
  return hunks[0].lines;
}

/** The diff turns the old text into the new one, and numbers every line where it really is. */
function assertValid(oldLines: string[], newLines: string[], label: string): number {
  const lines = wholeDiff(oldLines, newLines);
  assert.deepEqual(lines.filter((line) => line.type !== 'addition').map((line) => line.text), oldLines, `${label}: old side`);
  assert.deepEqual(lines.filter((line) => line.type !== 'deletion').map((line) => line.text), newLines, `${label}: new side`);
  for (const line of lines) {
    if (line.oldLineNumber !== null) assert.equal(oldLines[line.oldLineNumber - 1], line.text, `${label}: old line number`);
    if (line.newLineNumber !== null) assert.equal(newLines[line.newLineNumber - 1], line.text, `${label}: new line number`);
    assert.equal(line.oldLineNumber === null, line.type === 'addition', `${label}: additions have no old line`);
    assert.equal(line.newLineNumber === null, line.type === 'deletion', `${label}: deletions have no new line`);
  }
  return lines.filter((line) => line.type !== 'context').length;
}

function median(runs: number, work: () => void): number {
  const times: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const start = performance.now();
    work();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
}

// ── Ordinary diffs: the same result as before, line for line ────────────────
{
  const next = random(363);
  const alphabet = ['a', 'b', 'c', 'd', 'e', '', '}', '  return x;'];
  const pick = () => alphabet[Math.floor(next() * alphabet.length)];
  for (let round = 0; round < 400; round += 1) {
    const oldLines = Array.from({ length: Math.floor(next() * 40) }, pick);
    // Either an unrelated text or an edited copy: both shapes occur in practice.
    const newLines = next() < 0.3
      ? Array.from({ length: Math.floor(next() * 40) }, pick)
      : oldLines.flatMap((line) => (next() < 0.15 ? [] : next() < 0.15 ? [line, pick()] : next() < 0.1 ? [pick()] : [line]));
    const expected = referenceOps(oldLines, newLines).map((op) => ({
      type: op.type === 'equal' ? 'context' : op.type === 'insert' ? 'addition' : 'deletion',
      text: op.text,
    }));
    const actual = wholeDiff(oldLines, newLines).map((line) => ({ type: line.type, text: line.text }));
    assert.deepEqual(actual, expected, `round ${round}: same diff as the reference`);
    assertValid(oldLines, newLines, `round ${round}`);
  }
}

// ── Hunks keep their real position in the file ──────────────────────────────
{
  const oldLines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
  const newLines = [...oldLines];
  newLines[119] = 'line 120 changed';
  newLines.splice(150, 0, 'an added line');
  const hunks = createUnifiedDiffHunks(text(oldLines), text(newLines));
  assert.deepEqual(
    hunks.map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]),
    [[117, 7, 117, 7], [148, 6, 148, 7]]
  );
  assert.deepEqual(hunks[0].lines[3], { type: 'deletion', oldLineNumber: 120, newLineNumber: null, text: 'line 120' });
  assert.deepEqual(hunks[0].lines[4], { type: 'addition', oldLineNumber: null, newLineNumber: 120, text: 'line 120 changed' });
  assert.deepEqual(hunks[1].lines[3], { type: 'addition', oldLineNumber: null, newLineNumber: 151, text: 'an added line' });
  assert.deepEqual(createUnifiedDiffHunks(text(oldLines), text(oldLines)), [], 'equal texts have no hunks');
  assert.deepEqual(createUnifiedDiffHunks('', ''), []);
}

// ── Large texts: the search beyond the table gives a shortest diff too ──────
{
  const next = random(14000);
  const base = Array.from({ length: 2300 }, (_, index) => `const value${index % 97} = compute(${index});`);
  for (let round = 0; round < 4; round += 1) {
    const oldLines = [...base];
    const newLines = [...base];
    // First and last lines differ, so nothing can be set aside as common.
    newLines[0] = `// header ${round}`;
    newLines[newLines.length - 1] = `// footer ${round}`;
    for (let edit = 0; edit < 12; edit += 1) {
      const at = 1 + Math.floor(next() * (newLines.length - 2));
      const kind = next();
      if (kind < 0.34) newLines.splice(at, 1);
      else if (kind < 0.67) newLines.splice(at, 0, `inserted ${round}-${edit}`, base[Math.floor(next() * base.length)]);
      else newLines[at] = `replaced ${round}-${edit}`;
    }
    const edits = assertValid(oldLines, newLines, `large ${round}`);
    assert.equal(edits, editCount(referenceOps(oldLines, newLines)), `large ${round}: as few changed lines as the reference`);
    // Removed lines come before added ones inside every changed block.
    const lines = wholeDiff(oldLines, newLines);
    for (let index = 1; index < lines.length; index += 1) {
      assert.equal(lines[index - 1].type === 'addition' && lines[index].type === 'deletion', false, `large ${round}: block order`);
    }
  }

  // Texts with more changed lines than the search allows: one replaced span, still a correct diff.
  const oldLines = Array.from({ length: 2300 }, (_, index) => `old ${index}`);
  const newLines = Array.from({ length: 2300 }, (_, index) => `new ${index}`);
  assert.equal(assertValid(oldLines, newLines, 'unrelated large texts'), 4600);
}

// ── A one-line change to a 14,000-line file costs what the change is worth ──
{
  const fileLines = Array.from({ length: 14_000 }, (_, index) => `  const entry${index} = table[${index}] ?? fallback;`);
  const oldText = text(fileLines);

  const middle = [...fileLines];
  middle[7_000] = '  const entry7000 = changed;';
  const middleText = text(middle);
  let hunks: UnifiedDiffHunk[] = [];
  const middleMs = median(5, () => {
    hunks = createUnifiedDiffHunks(oldText, middleText, { contextLines: 3 });
  });
  assert.deepEqual(hunks.map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]), [[6998, 7, 6998, 7]]);
  assert.equal(hunks[0].lines[3].oldLineNumber, 7001);
  assert.equal(hunks[0].lines[4].text, '  const entry7000 = changed;');
  // The full table took about half a second and 730 MB for this.
  assert.ok(middleMs < 150, `a one-line change to a 14,000-line file took ${middleMs.toFixed(1)} ms`);

  // Changes at both ends leave 14,000 lines between them for the search.
  const ends = [...fileLines];
  ends[0] = '// first';
  ends[ends.length - 1] = '// last';
  ends.splice(9_000, 2);
  const endsText = text(ends);
  const endsMs = median(5, () => {
    hunks = createUnifiedDiffHunks(oldText, endsText, { contextLines: 3 });
  });
  assert.deepEqual(hunks.map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]), [
    [1, 4, 1, 4],
    [8998, 8, 8998, 6],
    [13997, 4, 13995, 4],
  ]);
  assert.ok(endsMs < 250, `changes at both ends of a 14,000-line file took ${endsMs.toFixed(1)} ms`);

  // Two unrelated 14,000-line texts: the search gives up early instead of filling memory.
  const other = text(Array.from({ length: 14_000 }, (_, index) => `unrelated ${index}`));
  const unrelatedMs = median(3, () => {
    hunks = createUnifiedDiffHunks(oldText, other, { contextLines: 3 });
  });
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].lines.length, 28_000);
  assert.ok(unrelatedMs < 1500, `two unrelated 14,000-line texts took ${unrelatedMs.toFixed(1)} ms`);
}

// ── trimCommonLines: a whole-file pair cut down to the passage that changed ─
{
  const fileLines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
  const changed = [...fileLines];
  changed[24] = 'line 25 changed';
  const trimmed = trimCommonLines(text(fileLines), text(changed));
  assert.equal(trimmed.oldText, 'line 22\nline 23\nline 24\nline 25\nline 26\nline 27\nline 28\n');
  assert.equal(trimmed.newText, 'line 22\nline 23\nline 24\nline 25 changed\nline 26\nline 27\nline 28\n');
  assert.ok(text(fileLines).includes(trimmed.oldText), 'a run of whole lines of the old text');
  assert.ok(text(changed).includes(trimmed.newText), 'a run of whole lines of the new text');
  // The trimmed pair gives the same change as the whole files did.
  const strip = (hunks: UnifiedDiffHunk[]) => hunks.flatMap((hunk) => hunk.lines.map((line) => [line.type, line.text]));
  assert.deepEqual(
    strip(createUnifiedDiffHunks(trimmed.oldText, trimmed.newText)),
    strip(createUnifiedDiffHunks(text(fileLines), text(changed)))
  );

  // An insertion keeps lines around it, so there is a passage to anchor it to.
  const inserted = [...fileLines];
  inserted.splice(10, 0, 'new line');
  assert.deepEqual(trimCommonLines(text(fileLines), text(inserted)), {
    oldText: 'line 8\nline 9\nline 10\nline 11\nline 12\nline 13\n',
    newText: 'line 8\nline 9\nline 10\nnew line\nline 11\nline 12\nline 13\n',
  });
  // An edit of the last line of a file without a final line break.
  assert.deepEqual(trimCommonLines('a\nb\nc\nd\ne', 'a\nb\nc\nd\nE', 1), { oldText: 'd\ne', newText: 'd\nE' });
  // Windows line endings stay as they are.
  assert.deepEqual(trimCommonLines('a\r\nb\r\nc\r\nd\r\n', 'a\r\nb\r\nX\r\nd\r\n', 0), { oldText: 'c\r\n', newText: 'X\r\n' });
  // Nothing in common, a new file, equal texts: returned as given.
  assert.deepEqual(trimCommonLines('one\ntwo', 'three\nfour'), { oldText: 'one\ntwo', newText: 'three\nfour' });
  assert.deepEqual(trimCommonLines('', 'hello\n'), { oldText: '', newText: 'hello\n' });
  assert.deepEqual(trimCommonLines('same\n', 'same\n'), { oldText: 'same\n', newText: 'same\n' });

  // 14,000 lines, one of them changed: 1 MB in, a few lines out.
  const big = Array.from({ length: 14_000 }, (_, index) => `  const entry${index} = table[${index}] ?? fallback;`);
  const bigChanged = [...big];
  bigChanged[9_000] = 'changed';
  const cut = trimCommonLines(text(big), text(bigChanged));
  assert.equal(cut.oldText.split('\n').length, 8);
  assert.ok(cut.oldText.length + cut.newText.length < 1000);
}

// ── Large inputs built to make the search work hardest ──────────────────────
// Nothing in common at either end, a long stretch between that matches on
// many diagonals, and more changed lines than the search allows: it gives up
// at its limit, having cost little more than reading the texts.
{
  const oldTail = Array.from({ length: 1_200 }, (_, index) => `old ${index}`);
  const newTail = Array.from({ length: 1_200 }, (_, index) => `new ${index}`);
  const cases: Array<[string, (index: number) => string, (index: number) => string]> = [
    ['one line repeated', () => 'x', () => 'x'],
    ['two lines alternating, shifted by one', (index) => (index % 2 ? 'x' : 'y'), (index) => (index % 2 ? 'y' : 'x')],
    ['equal blocks split by changed lines', (index) => (index % 100 ? 'same' : `old ${index}`), (index) => (index % 100 ? 'same' : `new ${index}`)],
  ];
  for (const [label, oldLine, newLine] of cases) {
    const oldText = text(['a', ...Array.from({ length: 100_000 }, (_, index) => oldLine(index)), ...oldTail]);
    const newText = text(['b', ...Array.from({ length: 100_000 }, (_, index) => newLine(index)), ...newTail]);
    let hunks: UnifiedDiffHunk[] = [];
    const ms = median(3, () => {
      hunks = createUnifiedDiffHunks(oldText, newText, { contextLines: 3 });
    });
    assert.equal(hunks.length, 1, `${label}: one replaced span`);
    assert.ok(ms < 2000, `${label}: 100,000 lines took ${ms.toFixed(0)} ms`);
  }
}

// ── limitDiffHunks: a preview draws the start of a large diff, and counts the rest ─
{
  const oldLines = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`);
  const newLines = oldLines.map((line, index) => (index === 9 || index === 199 ? `${line} changed` : line));
  const hunks = createUnifiedDiffHunks(text(oldLines), text(newLines));
  assert.deepEqual(hunks.map((hunk) => hunk.lines.length), [8, 8]);
  // Small enough: the same hunks, untouched.
  assert.equal(limitDiffHunks(hunks, 16).hunks, hunks);
  assert.equal(limitDiffHunks(hunks, 16).hiddenLines, 0);
  // Cut inside the second hunk: its header counts what is left of it.
  const cut = limitDiffHunks(hunks, 11);
  assert.equal(cut.hiddenLines, 5);
  assert.deepEqual(cut.hunks.map((hunk) => hunk.lines.length), [8, 3]);
  assert.equal(cut.hunks[0], hunks[0]);
  assert.deepEqual([cut.hunks[1].oldStart, cut.hunks[1].oldLines, cut.hunks[1].newStart, cut.hunks[1].newLines], [197, 3, 197, 3]);
  // Cut at a hunk's end, and at nothing.
  assert.deepEqual(limitDiffHunks(hunks, 8).hunks, [hunks[0]]);
  assert.deepEqual(limitDiffHunks(hunks, 0), { hunks: [], hiddenLines: 16 });
  // A rewritten 14,000-line file: 2,000 rows drawn, 26,000 counted.
  const rewritten = createUnifiedDiffHunks(
    text(Array.from({ length: 14_000 }, (_, index) => `old ${index}`)),
    text(Array.from({ length: 14_000 }, (_, index) => `new ${index}`))
  );
  const preview = limitDiffHunks(rewritten, 2_000);
  assert.equal(preview.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0), 2_000);
  assert.equal(preview.hiddenLines, 26_000);
  assert.deepEqual([preview.hunks[0].oldLines, preview.hunks[0].newLines], [2_000, 0]);
}

console.log('unified-diff: all checks passed');
