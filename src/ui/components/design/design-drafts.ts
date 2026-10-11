import type { DesignBoard } from "../../../shared/design-types";
import type { DesignDraftBoard, StreamMessage } from "../../../shared/types";

export type DesignDraftMessage = Extract<StreamMessage, { type: "design_draft" }>;
export type CanvasBoard = DesignBoard & { draft?: { toolUseId: string; complete: boolean } };

/** Board id a draft board is drawn under until its real version lands. */
export const draftBoardId = (toolUseId: string, index: number) => `draft:${toolUseId}:${index}`;
export const isDraftBoardId = (id: string) => id.startsWith("draft:");

/**
 * The canvas while the agent writes: boards it is rewriting show their new
 * HTML, and boards it is adding appear where the design will place them
 * (right of every other board, at the requested or default size).
 */
export function boardsWithDrafts(boards: DesignBoard[], drafts: DesignDraftMessage[]): CanvasBoard[] {
  if (!drafts.length) return boards;
  const out: CanvasBoard[] = boards.map((board) => ({ ...board }));
  for (const draft of drafts) {
    for (const board of draft.boards) {
      if (board.op === "content") {
        const target = out.find((b) => b.id === board.boardId);
        if (target) Object.assign(target, { html: board.html, draft: { toolUseId: draft.toolUseId, complete: board.complete } });
        continue;
      }
      out.push(addedBoard(out, draft.toolUseId, board));
    }
  }
  return out;
}

function addedBoard(existing: CanvasBoard[], toolUseId: string, board: DesignDraftBoard): CanvasBoard {
  return {
    id: draftBoardId(toolUseId, board.index),
    name: board.name || "New board",
    x: existing.length ? Math.max(...existing.map((b) => b.x + b.width)) + 80 : 0,
    y: 0,
    width: board.width ?? 880,
    height: board.height ?? 640,
    contentRevision: 0,
    placementRevision: 0,
    html: board.html,
    draft: { toolUseId, complete: board.complete },
  };
}

/** "Writing Pricing": the board a draft is on now (the last one not finished). */
export function draftStatus(drafts: DesignDraftMessage[]): string | null {
  const boards = drafts.flatMap((d) => d.boards);
  if (!boards.length) return null;
  const current = [...boards].reverse().find((b) => !b.complete) ?? boards[boards.length - 1];
  return `Writing ${current.name || "a board"}`;
}
