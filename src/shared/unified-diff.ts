export type UnifiedDiffLineType = 'context' | 'addition' | 'deletion';

export interface UnifiedDiffLine {
  type: UnifiedDiffLineType;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  text: string;
}

export interface UnifiedDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: UnifiedDiffLine[];
}

export interface UnifiedDiffOptions {
  contextLines?: number;
}

type DiffOp =
  | { type: 'equal'; text: string }
  | { type: 'insert'; text: string }
  | { type: 'delete'; text: string };

type AnnotatedDiffOp = DiffOp & {
  oldLineNumber: number;
  newLineNumber: number;
};

const DEFAULT_CONTEXT_LINES = 3;

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function splitLines(text: string): string[] {
  if (!text) return [];

  const lines = normalizeText(text).split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines;
}

/**
 * The table below is quadratic in the lines it compares: two versions of a
 * 14,000-line file would need 196 million cells. It is built only while it
 * stays under this many cells (2,000 by 2,000 lines).
 */
const LCS_TABLE_MAX_CELLS = 4_000_000;

/**
 * How many changed lines the search for larger texts looks for before it gives
 * up and reports the differing span as replaced. Its memory grows with the
 * square of this (about 17 MB at the limit), not with the size of the texts.
 */
const MYERS_MAX_EDITS = 2_048;

function fitsLcsTable(oldCount: number, newCount: number): boolean {
  return (oldCount + 1) * (newCount + 1) <= LCS_TABLE_MAX_CELLS;
}

/** A common subsequence is at most 2,000 lines under the cell limit, so 16 bits hold it. */
function buildLcsTable(oldLines: string[], newLines: string[]): Uint16Array {
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const table = new Uint16Array(rows * cols);

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const current = oldIndex * cols + newIndex;
      if (oldLines[oldIndex] === newLines[newIndex]) {
        table[current] = table[(oldIndex + 1) * cols + (newIndex + 1)] + 1;
      } else {
        const down = table[(oldIndex + 1) * cols + newIndex];
        const right = table[oldIndex * cols + (newIndex + 1)];
        table[current] = down >= right ? down : right;
      }
    }
  }

  return table;
}

function diffLinesByTable(oldLines: string[], newLines: string[]): DiffOp[] {
  const cols = newLines.length + 1;
  const table = buildLcsTable(oldLines, newLines);
  const ops: DiffOp[] = [];

  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      ops.push({ type: 'equal', text: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    const down = table[(oldIndex + 1) * cols + newIndex];
    const right = table[oldIndex * cols + (newIndex + 1)];
    if (down >= right) {
      ops.push({ type: 'delete', text: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      ops.push({ type: 'insert', text: newLines[newIndex] });
      newIndex += 1;
    }
  }

  while (oldIndex < oldLines.length) {
    ops.push({ type: 'delete', text: oldLines[oldIndex] });
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    ops.push({ type: 'insert', text: newLines[newIndex] });
    newIndex += 1;
  }

  return ops;
}

/**
 * Myers' O(ND) search for a shortest edit script: its time and memory follow
 * the number of changed lines, not the size of the texts. Null when the texts
 * differ by more than MYERS_MAX_EDITS lines.
 */
function diffLinesByMyers(oldLines: string[], newLines: string[]): DiffOp[] | null {
  // Lines become numbers so the search compares integers, not strings.
  const ids = new Map<string, number>();
  const intern = (lines: string[]): Int32Array => {
    const out = new Int32Array(lines.length);
    for (let index = 0; index < lines.length; index += 1) {
      let id = ids.get(lines[index]);
      if (id === undefined) {
        id = ids.size;
        ids.set(lines[index], id);
      }
      out[index] = id;
    }
    return out;
  };
  const oldIds = intern(oldLines);
  const newIds = intern(newLines);
  const oldCount = oldIds.length;
  const newCount = newIds.length;

  const maxEdits = Math.min(oldCount + newCount, MYERS_MAX_EDITS);
  // furthest[offset + k]: how far into the old lines a path on diagonal k
  // (old index minus new index) gets with the edits spent so far.
  const offset = maxEdits + 1;
  const furthest = new Int32Array(2 * maxEdits + 3);
  // rounds[d]: the diagonals -d-1..d+1 as they stood before round d.
  const rounds: Int32Array[] = [];
  let edits = -1;

  search: for (let round = 0; round <= maxEdits; round += 1) {
    rounds.push(furthest.slice(offset - round - 1, offset + round + 2));
    for (let k = -round; k <= round; k += 2) {
      const insert = k === -round || (k !== round && furthest[offset + k - 1] < furthest[offset + k + 1]);
      let oldIndex = insert ? furthest[offset + k + 1] : furthest[offset + k - 1] + 1;
      let newIndex = oldIndex - k;
      while (oldIndex < oldCount && newIndex < newCount && oldIds[oldIndex] === newIds[newIndex]) {
        oldIndex += 1;
        newIndex += 1;
      }
      furthest[offset + k] = oldIndex;
      if (oldIndex >= oldCount && newIndex >= newCount) {
        edits = round;
        break search;
      }
    }
  }
  if (edits < 0) return null;

  // Walk the rounds back from the end; the script comes out last line first.
  const reversed: DiffOp[] = [];
  let oldIndex = oldCount;
  let newIndex = newCount;
  for (let round = edits; round > 0; round -= 1) {
    const before = rounds[round];
    const at = (k: number) => before[k + round + 1];
    const k = oldIndex - newIndex;
    const insert = k === -round || (k !== round && at(k - 1) < at(k + 1));
    const previousK = insert ? k + 1 : k - 1;
    const previousOld = at(previousK);
    const previousNew = previousOld - previousK;
    while (oldIndex > previousOld && newIndex > previousNew) {
      oldIndex -= 1;
      newIndex -= 1;
      reversed.push({ type: 'equal', text: oldLines[oldIndex] });
    }
    if (insert) {
      newIndex -= 1;
      reversed.push({ type: 'insert', text: newLines[newIndex] });
    } else {
      oldIndex -= 1;
      reversed.push({ type: 'delete', text: oldLines[oldIndex] });
    }
  }
  while (oldIndex > 0 && newIndex > 0) {
    oldIndex -= 1;
    newIndex -= 1;
    reversed.push({ type: 'equal', text: oldLines[oldIndex] });
  }

  // Within one changed block, removed lines come before added ones.
  const ops: DiffOp[] = [];
  let inserts: DiffOp[] = [];
  for (let index = reversed.length - 1; index >= 0; index -= 1) {
    const op = reversed[index];
    if (op.type === 'insert') {
      inserts.push(op);
      continue;
    }
    if (op.type === 'equal' && inserts.length > 0) {
      for (const insert of inserts) ops.push(insert);
      inserts = [];
    }
    ops.push(op);
  }
  for (const insert of inserts) ops.push(insert);
  return ops;
}

/**
 * Line diff of two texts. The lines both texts start with are never searched,
 * so an edit to a large file costs what the edit is worth, not the file:
 * - what follows the common head goes through the table while it fits, with
 *   the result this function has always given;
 * - larger than that, the common tail is set aside too, and the rest goes
 *   through the table if it now fits, else through Myers' search;
 * - texts that differ by more lines than that search allows are reported as
 *   one replaced span, which is still a correct diff.
 */
function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const shorter = Math.min(oldLines.length, newLines.length);
  let head = 0;
  while (head < shorter && oldLines[head] === newLines[head]) head += 1;

  let tail = 0;
  if (!fitsLcsTable(oldLines.length - head, newLines.length - head)) {
    while (
      tail < shorter - head &&
      oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
    ) {
      tail += 1;
    }
  }

  const ops: DiffOp[] = [];
  for (let index = 0; index < head; index += 1) {
    ops.push({ type: 'equal', text: oldLines[index] });
  }

  const oldMiddle = head === 0 && tail === 0 ? oldLines : oldLines.slice(head, oldLines.length - tail);
  const newMiddle = head === 0 && tail === 0 ? newLines : newLines.slice(head, newLines.length - tail);
  const middle = fitsLcsTable(oldMiddle.length, newMiddle.length)
    ? diffLinesByTable(oldMiddle, newMiddle)
    : diffLinesByMyers(oldMiddle, newMiddle);
  if (middle) {
    for (const op of middle) ops.push(op);
  } else {
    for (const text of oldMiddle) ops.push({ type: 'delete', text });
    for (const text of newMiddle) ops.push({ type: 'insert', text });
  }

  for (let index = oldLines.length - tail; index < oldLines.length; index += 1) {
    ops.push({ type: 'equal', text: oldLines[index] });
  }
  return ops;
}

function annotateOps(ops: DiffOp[]): AnnotatedDiffOp[] {
  const annotated: AnnotatedDiffOp[] = [];
  let oldLineNumber = 1;
  let newLineNumber = 1;

  for (const op of ops) {
    annotated.push({
      ...op,
      oldLineNumber,
      newLineNumber,
    });

    if (op.type === 'equal') {
      oldLineNumber += 1;
      newLineNumber += 1;
    } else if (op.type === 'delete') {
      oldLineNumber += 1;
    } else {
      newLineNumber += 1;
    }
  }

  return annotated;
}

function countConsumedLines(ops: AnnotatedDiffOp[]): { oldLines: number; newLines: number } {
  let oldLines = 0;
  let newLines = 0;

  for (const op of ops) {
    if (op.type !== 'insert') {
      oldLines += 1;
    }
    if (op.type !== 'delete') {
      newLines += 1;
    }
  }

  return { oldLines, newLines };
}

function createHunk(ops: AnnotatedDiffOp[]): UnifiedDiffHunk {
  const { oldLines, newLines } = countConsumedLines(ops);
  const first = ops[0];

  return {
    oldStart: first.oldLineNumber,
    oldLines,
    newStart: first.newLineNumber,
    newLines,
    lines: ops.map((op) => ({
      type: op.type === 'equal' ? 'context' : op.type === 'insert' ? 'addition' : 'deletion',
      oldLineNumber: op.type === 'insert' ? null : op.oldLineNumber,
      newLineNumber: op.type === 'delete' ? null : op.newLineNumber,
      text: op.text,
    })),
  };
}

function splitIntoHunks(ops: AnnotatedDiffOp[], contextLines: number): UnifiedDiffHunk[] {
  const hunks: UnifiedDiffHunk[] = [];
  const editIndexes: number[] = [];

  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index].type !== 'equal') {
      editIndexes.push(index);
    }
  }

  if (editIndexes.length === 0) {
    return hunks;
  }

  let groupStart = editIndexes[0];
  let groupEnd = editIndexes[0];

  const finalizeGroup = () => {
    const start = Math.max(0, groupStart - contextLines);
    const end = Math.min(ops.length - 1, groupEnd + contextLines);
    hunks.push(createHunk(ops.slice(start, end + 1)));
  };

  for (let index = 1; index < editIndexes.length; index += 1) {
    const nextEditIndex = editIndexes[index];
    const gap = nextEditIndex - groupEnd - 1;

    // Keep nearby edits together when the surrounding context would overlap.
    if (gap <= contextLines * 2) {
      groupEnd = nextEditIndex;
    } else {
      finalizeGroup();
      groupStart = nextEditIndex;
      groupEnd = nextEditIndex;
    }
  }

  finalizeGroup();
  return hunks;
}

export function createUnifiedDiffHunks(
  oldText: string,
  newText: string,
  options: UnifiedDiffOptions = {}
): UnifiedDiffHunk[] {
  const contextLines = Math.max(0, Math.floor(options.contextLines ?? DEFAULT_CONTEXT_LINES));
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length === 0 && newLines.length === 0) {
    return [];
  }

  const ops = diffLines(oldLines, newLines);
  const annotated = annotateOps(ops);
  return splitIntoHunks(annotated, contextLines);
}

/**
 * Two versions of a file, cut down to the lines that differ plus a few lines
 * of context on each side. Each result is a run of whole lines of its text, so
 * it still reads as "this passage became that passage". Texts that share no
 * leading or trailing lines come back as they are.
 */
export function trimCommonLines(
  oldText: string,
  newText: string,
  contextLines = DEFAULT_CONTEXT_LINES
): { oldText: string; newText: string } {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const shorter = Math.min(oldLines.length, newLines.length);

  let head = 0;
  while (head < shorter && oldLines[head] === newLines[head]) head += 1;
  let tail = 0;
  while (
    tail < shorter - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const context = Math.max(0, Math.floor(contextLines));
  const start = Math.max(0, head - context);
  const kept = Math.max(0, tail - context);
  if (start === 0 && kept === 0) return { oldText, newText };

  // A run that stops before the last line keeps that line's own line break.
  const cut = (lines: string[]) => {
    const end = lines.length - kept;
    return lines.slice(start, end).join('\n') + (end < lines.length ? '\n' : '');
  };
  return { oldText: cut(oldLines), newText: cut(newLines) };
}

/**
 * The first `maxLines` lines of a diff, for a preview that draws one row per
 * line: a rewritten 14,000-line file is 28,000 rows otherwise. The hunk that
 * is cut says how many lines it now holds; `hiddenLines` is what was left out.
 */
export function limitDiffHunks(
  hunks: UnifiedDiffHunk[],
  maxLines: number
): { hunks: UnifiedDiffHunk[]; hiddenLines: number } {
  const total = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  if (total <= maxLines) return { hunks, hiddenLines: 0 };

  const shown: UnifiedDiffHunk[] = [];
  let room = Math.max(0, Math.floor(maxLines));
  for (const hunk of hunks) {
    if (room <= 0) break;
    if (hunk.lines.length <= room) {
      shown.push(hunk);
      room -= hunk.lines.length;
      continue;
    }
    const lines = hunk.lines.slice(0, room);
    shown.push({
      ...hunk,
      oldLines: lines.filter((line) => line.type !== 'addition').length,
      newLines: lines.filter((line) => line.type !== 'deletion').length,
      lines,
    });
    room = 0;
  }
  return { hunks: shown, hiddenLines: total - Math.max(0, Math.floor(maxLines)) };
}

function formatHunkHeader(hunk: UnifiedDiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

export function formatUnifiedDiffHunks(hunks: UnifiedDiffHunk[]): string {
  return hunks
    .map((hunk) => {
      const lines = hunk.lines.map((line) => {
        if (line.type === 'context') return ` ${line.text}`;
        if (line.type === 'addition') return `+${line.text}`;
        return `-${line.text}`;
      });

      return [formatHunkHeader(hunk), ...lines].join('\n');
    })
    .join('\n');
}

export function extractUnifiedDiffFilePath(diffContent: string): string | null {
  const normalized = normalizeText(diffContent);

  const decodeQuotedPath = (value: string): string => {
    const content = value.slice(1, -1);
    const bytes: number[] = [];
    const encoder = new TextEncoder();
    const appendText = (text: string) => bytes.push(...encoder.encode(text));
    const escapes: Record<string, string> = {
      a: '\x07',
      b: '\b',
      t: '\t',
      n: '\n',
      v: '\v',
      f: '\f',
      r: '\r',
      '"': '"',
      '\\': '\\',
    };

    let cursor = 0;
    while (cursor < content.length) {
      const slash = content.indexOf('\\', cursor);
      if (slash < 0) {
        appendText(content.slice(cursor));
        break;
      }
      appendText(content.slice(cursor, slash));

      const escaped = content[slash + 1];
      if (escaped === undefined) {
        appendText('\\');
        break;
      }

      if (/[0-7]/.test(escaped)) {
        const octal = content.slice(slash + 1).match(/^[0-7]{1,3}/)?.[0] || escaped;
        bytes.push(Number.parseInt(octal, 8));
        cursor = slash + 1 + octal.length;
        continue;
      }

      appendText(escapes[escaped] ?? escaped);
      cursor = slash + 2;
    }

    return new TextDecoder().decode(Uint8Array.from(bytes));
  };

  const normalizeCandidate = (
    value: string | undefined,
    stripGitPrefix = false
  ): string | null => {
    if (!value) return null;
    const withoutTimestamp = value.split('\t', 1)[0]?.trim() || '';
    let unquoted = withoutTimestamp;
    if (withoutTimestamp.startsWith('"') && withoutTimestamp.endsWith('"')) {
      unquoted = decodeQuotedPath(withoutTimestamp);
    } else {
      unquoted = withoutTimestamp.replace(/^["']+|["']+$/g, '');
    }
    unquoted = unquoted.trim();
    if (!unquoted || unquoted === '/dev/null') return null;
    return stripGitPrefix ? unquoted.replace(/^[ab]\//, '') : unquoted;
  };

  const indexMatch = normalized.match(/^Index:\s+(.+)$/m);
  const indexPath = normalizeCandidate(indexMatch?.[1]);
  if (indexPath) {
    return indexPath;
  }

  const plusMatch = normalized.match(/^\+\+\+\s+(.+)$/m);
  const plusPath = normalizeCandidate(plusMatch?.[1], true);
  if (plusPath) {
    return plusPath;
  }

  const minusMatch = normalized.match(/^---\s+(.+)$/m);
  const minusPath = normalizeCandidate(minusMatch?.[1], true);
  if (minusPath) {
    return minusPath;
  }

  const renameToMatch = normalized.match(/^rename to\s+(.+)$/m);
  const renameToPath = normalizeCandidate(renameToMatch?.[1]);
  if (renameToPath) {
    return renameToPath;
  }

  const renameFromMatch = normalized.match(/^rename from\s+(.+)$/m);
  const renameFromPath = normalizeCandidate(renameFromMatch?.[1]);
  if (renameFromPath) {
    return renameFromPath;
  }

  const diffHeaderMatch = normalized.match(
    /^diff --git\s+(?:"(?:[^"\\]|\\.)*"|\S+)\s+("(?:[^"\\]|\\.)*"|\S+)$/m
  );
  const diffHeaderPath = normalizeCandidate(diffHeaderMatch?.[1], true);
  if (diffHeaderPath) {
    return diffHeaderPath;
  }

  return null;
}

export function parseUnifiedDiff(diffContent: string): UnifiedDiffHunk[] {
  const lines = normalizeText(diffContent).split('\n');
  const hunks: UnifiedDiffHunk[] = [];
  let currentHunk: UnifiedDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const pushCurrentHunk = () => {
    if (currentHunk) {
      hunks.push(currentHunk);
      currentHunk = null;
    }
  };

  for (const line of lines) {
    const headerMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (headerMatch) {
      pushCurrentHunk();
      oldLine = Number(headerMatch[1]);
      newLine = Number(headerMatch[3]);
      currentHunk = {
        oldStart: oldLine,
        oldLines: Number(headerMatch[2] || 1),
        newStart: newLine,
        newLines: Number(headerMatch[4] || 1),
        lines: [],
      };
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentHunk.lines.push({
        type: 'addition',
        oldLineNumber: null,
        newLineNumber: newLine,
        text: line.slice(1),
      });
      newLine += 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      currentHunk.lines.push({
        type: 'deletion',
        oldLineNumber: oldLine,
        newLineNumber: null,
        text: line.slice(1),
      });
      oldLine += 1;
      continue;
    }

    if (line.startsWith(' ')) {
      currentHunk.lines.push({
        type: 'context',
        oldLineNumber: oldLine,
        newLineNumber: newLine,
        text: line.slice(1),
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }
  }

  pushCurrentHunk();
  return hunks;
}
