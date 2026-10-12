import type { DesignDocument } from './design-types';

export const DEFAULT_DESIGN_PAGE = { id: 'page-1', name: 'Page 1' };
export function designPages(doc: Pick<DesignDocument, 'pages'>) {
  return doc.pages?.length ? doc.pages : [DEFAULT_DESIGN_PAGE];
}
/** Legacy and invalid memberships belong to the first page, like Claude Design. */
export function designPageId(doc: Pick<DesignDocument, 'pages'>, item: { pageId?: string }) {
  const pages = designPages(doc);
  return pages.some(page => page.id === item.pageId) ? item.pageId! : pages[0].id;
}

/** Export one page without leaking other pages' boards, annotations or comments. */
export function designForPage(doc: DesignDocument, pageId: string): DesignDocument {
  const page = designPages(doc).find(page => page.id === pageId);
  if (!page) throw new Error('Page no longer exists.');
  const boards = doc.boards.filter(board => designPageId(doc, board) === pageId);
  const boardIds = new Set(boards.map(board => board.id));
  return { ...doc, pages: [page], boards, marks: (doc.marks ?? []).filter(mark => designPageId(doc, mark) === pageId), comments: doc.comments.filter(comment => boardIds.has(comment.boardId)) };
}
