import { create } from 'zustand';
import { REVIEW_COMMENT_LIMITS, type ReviewComment } from '../../shared/review-comments';
import { DEFAULT_REVIEW_DIFF_SELECTION } from '../utils/review-diff-selection';
import { useAppStore } from './useAppStore';

/**
 * Comments written on diff lines that have not been sent yet, per task. The
 * Changes panel draws them under their lines and the composer shows them as
 * one chip; sending a message takes them all.
 *
 * Not persisted, like the composer queue: they belong to the diff on screen.
 */
interface ReviewCommentStore {
  comments: Record<string, ReviewComment[]>;
  add: (sessionId: string, comment: ReviewComment) => void;
  updateText: (sessionId: string, commentId: string, text: string) => void;
  remove: (sessionId: string, commentId: string) => void;
  clear: (sessionId: string) => void;
}

const EMPTY: ReviewComment[] = [];

function setList(state: ReviewCommentStore, sessionId: string, list: ReviewComment[]) {
  const comments = { ...state.comments };
  if (list.length > 0) comments[sessionId] = list;
  else delete comments[sessionId];
  return { comments };
}

/** File order, then line order: the order the agent reads them in. */
function ordered(list: ReviewComment[]): ReviewComment[] {
  const fileOrder = new Map<string, number>();
  for (const comment of list) if (!fileOrder.has(comment.filePath)) fileOrder.set(comment.filePath, fileOrder.size);
  return [...list].sort((a, b) =>
    fileOrder.get(a.filePath)! - fileOrder.get(b.filePath)! || a.endLine - b.endLine || a.startLine - b.startLine);
}

export const useReviewCommentStore = create<ReviewCommentStore>((set) => ({
  comments: {},
  add: (sessionId, comment) => set((state) => {
    const current = state.comments[sessionId] ?? EMPTY;
    if (current.length >= REVIEW_COMMENT_LIMITS.comments) return state;
    return setList(state, sessionId, ordered([...current, comment]));
  }),
  updateText: (sessionId, commentId, text) => set((state) => {
    const current = state.comments[sessionId] ?? EMPTY;
    if (!current.some((comment) => comment.id === commentId)) return state;
    return setList(state, sessionId, current.map((comment) => (comment.id === commentId ? { ...comment, text } : comment)));
  }),
  remove: (sessionId, commentId) => set((state) => {
    const current = state.comments[sessionId] ?? EMPTY;
    if (!current.some((comment) => comment.id === commentId)) return state;
    return setList(state, sessionId, current.filter((comment) => comment.id !== commentId));
  }),
  clear: (sessionId) => set((state) => (state.comments[sessionId] ? setList(state, sessionId, EMPTY) : state)),
}));

/** A task's unsent comments (a stable empty list when there are none). */
export function useReviewComments(sessionId: string | null | undefined): ReviewComment[] {
  return useReviewCommentStore((state) => (sessionId ? state.comments[sessionId] : undefined) ?? EMPTY);
}

export function getReviewComments(sessionId: string): ReviewComment[] {
  return useReviewCommentStore.getState().comments[sessionId] ?? EMPTY;
}

/** Shows the comment's file in the Changes panel, on the diff that is open there. */
export function openReviewComment(comment: Pick<ReviewComment, 'filePath'>): void {
  const state = useAppStore.getState();
  state.openReviewDiff({
    ...(state.reviewDiffSelection ?? DEFAULT_REVIEW_DIFF_SELECTION),
    selectedRecordId: null,
    selectedFilePath: comment.filePath,
    requestedAt: Date.now(),
  });
}
