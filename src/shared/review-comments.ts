/**
 * Comments the user wrote on lines of a diff in the Changes panel. They wait
 * in the composer and go out with the next message: as plain text appended to
 * the prompt the agent reads, and as data on the message for the pills above
 * its bubble.
 */

export type ReviewCommentSide = 'additions' | 'deletions';

export interface ReviewComment {
  id: string;
  /** Path as the diff shows it (relative to the repository root). */
  filePath: string;
  /** Line numbers are the new file's on `additions`, the old file's on `deletions`. */
  startLine: number;
  startSide: ReviewCommentSide;
  endLine: number;
  endSide: ReviewCommentSide;
  /** The commented diff lines, each starting with '+', '-' or ' '. */
  code: string[];
  text: string;
  /** Name of the diff it was written on: "Last turn", "Uncommitted", a commit. */
  scope: string;
  /** Identifies that diff, so the comment is only drawn on it. Never sent to the agent. */
  scopeKey: string;
}

export const REVIEW_COMMENT_LIMITS = {
  comments: 50,
  textChars: 4000,
  codeLines: 40,
  codeLineChars: 400,
  /** Lines of code quoted to the agent for one comment. */
  quotedLines: 12,
} as const;

const SIDES: readonly ReviewCommentSide[] = ['additions', 'deletions'];

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Every line it covers was removed: the numbers are the old file's. */
export function isRemovedLineComment(comment: Pick<ReviewComment, 'startSide' | 'endSide'>): boolean {
  return comment.startSide === 'deletions' && comment.endSide === 'deletions';
}

/** "144" or "146–148" (`separator` is "-" in the text the agent reads). */
export function reviewCommentLines(
  comment: Pick<ReviewComment, 'startLine' | 'endLine'>,
  separator = '–',
): string {
  return comment.startLine === comment.endLine
    ? String(comment.startLine)
    : `${comment.startLine}${separator}${comment.endLine}`;
}

/** "automation-scheduler.ts:144", as chips and pills show it. */
export function reviewCommentLocation(comment: ReviewComment): string {
  return `${basename(comment.filePath)}:${reviewCommentLines(comment)}`;
}

/** First line of the comment, for one-line labels. */
export function reviewCommentTitle(comment: Pick<ReviewComment, 'text'>): string {
  return comment.text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || 'Comment';
}

/** The comments as the agent reads them, or '' when there are none. */
export function reviewCommentsPromptText(comments: readonly ReviewComment[]): string {
  if (comments.length === 0) return '';
  const scopes = new Set(comments.map((comment) => comment.scope));
  const oneScope = scopes.size === 1 ? comments[0].scope : '';
  const blocks = comments.map((comment, index) => {
    const marks = [
      isRemovedLineComment(comment) ? 'removed' : '',
      oneScope ? '' : comment.scope,
    ].filter(Boolean);
    const head = `${index + 1}. ${comment.filePath}:${reviewCommentLines(comment, '-')}${marks.length ? ` (${marks.join(', ')})` : ''}`;
    const quoted = comment.code.slice(0, REVIEW_COMMENT_LIMITS.quotedLines).map((line) => `   ${line}`);
    if (comment.code.length > REVIEW_COMMENT_LIMITS.quotedLines) quoted.push('   …');
    const text = comment.text.split(/\r?\n/).map((line) => `   ${line}`.trimEnd());
    return [head, ...quoted, ...text].join('\n');
  });
  const heading = oneScope ? `Review comments on the diff (${oneScope}):` : 'Review comments on the diff:';
  return `${heading}\n\n${blocks.join('\n\n')}`;
}

/** The prompt the agent reads: what the user typed, then the comments. */
export function withReviewComments(prompt: string, comments: readonly ReviewComment[]): string {
  const text = reviewCommentsPromptText(comments);
  if (!text) return prompt;
  return prompt.trim() ? `${prompt.trimEnd()}\n\n${text}` : text;
}

function lineNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 10_000_000 ? value : null;
}

/** Validates renderer-supplied comments before they are stored with a message. */
export function sanitizeReviewComments(value: unknown): ReviewComment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const comments: ReviewComment[] = [];
  for (const entry of value.slice(0, REVIEW_COMMENT_LIMITS.comments)) {
    if (!entry || typeof entry !== 'object') continue;
    const v = entry as Record<string, unknown>;
    const startLine = lineNumber(v.startLine);
    const endLine = lineNumber(v.endLine);
    if (typeof v.filePath !== 'string' || !v.filePath.trim() || startLine === null || endLine === null) continue;
    if (typeof v.text !== 'string' || !v.text.trim()) continue;
    const startSide = SIDES.includes(v.startSide as ReviewCommentSide) ? (v.startSide as ReviewCommentSide) : 'additions';
    const endSide = SIDES.includes(v.endSide as ReviewCommentSide) ? (v.endSide as ReviewCommentSide) : startSide;
    comments.push({
      id: typeof v.id === 'string' && v.id ? v.id.slice(0, 80) : `comment-${comments.length + 1}`,
      filePath: v.filePath.replace(/[\r\n]+/g, ' ').trim().slice(0, 1024),
      startLine,
      startSide,
      endLine,
      endSide,
      code: Array.isArray(v.code)
        ? v.code
            .filter((line): line is string => typeof line === 'string')
            .slice(0, REVIEW_COMMENT_LIMITS.codeLines)
            .map((line) => line.replace(/[\r\n]+/g, '').slice(0, REVIEW_COMMENT_LIMITS.codeLineChars))
        : [],
      text: v.text.trim().slice(0, REVIEW_COMMENT_LIMITS.textChars),
      scope: typeof v.scope === 'string' ? v.scope.replace(/[\r\n]+/g, ' ').trim().slice(0, 160) : '',
      scopeKey: typeof v.scopeKey === 'string' ? v.scopeKey.slice(0, 300) : '',
    });
  }
  return comments.length > 0 ? comments : undefined;
}

/**
 * A stored message as transcripts carry it (search, handoff, export,
 * read_session): what was typed, then its comments. `comments` is whatever the
 * stored row holds.
 */
export function promptWithReviewComments(prompt: string, comments: unknown): string {
  return withReviewComments(prompt, sanitizeReviewComments(comments) ?? []);
}
