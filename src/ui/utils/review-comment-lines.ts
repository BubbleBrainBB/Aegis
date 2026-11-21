import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import { REVIEW_COMMENT_LIMITS, type ReviewComment, type ReviewCommentSide } from '../../shared/review-comments';
import type { ReviewDiffSelection } from '../types';

/** One rendered line of a unified diff. */
export interface ReviewDiffRow {
  kind: 'context' | 'addition' | 'deletion';
  oldLine?: number;
  newLine?: number;
  text: string;
}

function lineText(lines: readonly string[], index: number): string {
  return (lines[index] ?? '').replace(/\r?\n$/, '');
}

/** The diff's lines in the order a unified view shows them, with both line numbers. */
export function reviewDiffRows(fileDiff: FileDiffMetadata): ReviewDiffRow[] {
  const rows: ReviewDiffRow[] = [];
  for (const hunk of fileDiff.hunks) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const block of hunk.hunkContent) {
      if (block.type === 'context') {
        for (let i = 0; i < block.lines; i += 1) {
          rows.push({
            kind: 'context',
            oldLine: oldLine++,
            newLine: newLine++,
            text: lineText(fileDiff.additionLines, block.additionLineIndex + i),
          });
        }
        continue;
      }
      for (let i = 0; i < block.deletions; i += 1) {
        rows.push({ kind: 'deletion', oldLine: oldLine++, text: lineText(fileDiff.deletionLines, block.deletionLineIndex + i) });
      }
      for (let i = 0; i < block.additions; i += 1) {
        rows.push({ kind: 'addition', newLine: newLine++, text: lineText(fileDiff.additionLines, block.additionLineIndex + i) });
      }
    }
  }
  return rows;
}

function rowIndex(rows: readonly ReviewDiffRow[], line: number, side: ReviewCommentSide): number {
  return rows.findIndex((row) =>
    side === 'additions'
      ? row.kind !== 'deletion' && row.newLine === line
      : row.kind !== 'addition' && row.oldLine === line);
}

/** True when the diff still shows that line (a refreshed diff may not). */
export function hasReviewDiffLine(rows: readonly ReviewDiffRow[], line: number, side: ReviewCommentSide): boolean {
  return rowIndex(rows, line, side) >= 0;
}

export interface ReviewCommentAnchor {
  startLine: number;
  startSide: ReviewCommentSide;
  endLine: number;
  endSide: ReviewCommentSide;
  code: string[];
}

/**
 * The lines a gutter selection covers, top to bottom, quoted the way a patch
 * writes them. A line outside the diff's hunks (expanded context) is quoted
 * from the full file when the diff carries it.
 */
export function reviewCommentAnchor(fileDiff: FileDiffMetadata, range: SelectedLineRange): ReviewCommentAnchor {
  const rows = reviewDiffRows(fileDiff);
  let start = { line: range.start, side: (range.side ?? 'additions') as ReviewCommentSide };
  let end = { line: range.end, side: (range.endSide ?? range.side ?? 'additions') as ReviewCommentSide };
  let from = rowIndex(rows, start.line, start.side);
  let to = rowIndex(rows, end.line, end.side);
  // Dragged upwards: the selection still reads top to bottom.
  if ((from >= 0 && to >= 0 && from > to) || ((from < 0 || to < 0) && start.side === end.side && start.line > end.line)) {
    [start, end] = [end, start];
    [from, to] = [to, from];
  }
  let code: string[] = [];
  if (from >= 0 && to >= 0) {
    code = rows.slice(from, to + 1).map((row) => `${row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '-' : ' '}${row.text}`);
  } else if (!fileDiff.isPartial && start.side === end.side) {
    const lines = start.side === 'additions' ? fileDiff.additionLines : fileDiff.deletionLines;
    for (let line = start.line; line <= end.line; line += 1) code.push(` ${lineText(lines, line - 1)}`);
  }
  return {
    startLine: start.line,
    startSide: start.side,
    endLine: end.line,
    endSide: end.side,
    code: code
      .slice(0, REVIEW_COMMENT_LIMITS.codeLines)
      .map((line) => line.slice(0, REVIEW_COMMENT_LIMITS.codeLineChars)),
  };
}

/** The selection that redraws a comment's lines as selected. */
export function reviewCommentRange(comment: Pick<ReviewComment, 'startLine' | 'startSide' | 'endLine' | 'endSide'>): SelectedLineRange {
  return { start: comment.startLine, side: comment.startSide, end: comment.endLine, endSide: comment.endSide };
}

/** Identifies the diff on screen: comments written on one diff are not drawn on another. */
export function reviewScopeKey(selection: Pick<ReviewDiffSelection, 'source'>): string {
  const source = selection.source;
  if (source.kind === 'turn') return `turn:${source.turnKey}`;
  if (source.kind === 'commit') return `commit:${source.sha}`;
  return `workspace:${source.scope}`;
}
