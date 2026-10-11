import type {
  DesignBoard,
  DesignOperation,
  DesignRevisionInfo,
} from "../../../shared/design-types";

/** One user change: restoring `from` for these boards (and title) undoes it. */
export interface UndoEntry {
  from: number;
  to: number;
  boardIds: string[];
  title: boolean;
  summary: string;
}

/** Per-document undo and redo stacks of the person's own canvas edits. */
export class DesignUndo {
  undo: UndoEntry[] = [];
  redo: UndoEntry[] = [];
  record(entry: UndoEntry) {
    this.undo.push(entry);
    if (this.undo.length > 100) this.undo.shift();
    this.redo = [];
  }
}

/** Boards a write touched: operation targets plus boards it created. */
export function touchedBoards(
  ops: DesignOperation[],
  before: Pick<DesignBoard, "id">[],
  after: Pick<DesignBoard, "id">[],
) {
  const ids = new Set<string>();
  for (const op of ops) if ("boardId" in op) ids.add(op.boardId);
  const existed = new Set(before.map((b) => b.id));
  for (const b of after) if (!existed.has(b.id)) ids.add(b.id);
  return [...ids];
}

/**
 * Someone else (usually the agent) changed the same boards after this entry:
 * restoring would discard their work, so undo must stop and defer to History.
 */
export function blockedBy(entry: UndoEntry, history: DesignRevisionInfo[]) {
  return history.some(
    (r) =>
      r.revision > entry.to &&
      (entry.title || r.boardIds.some((id) => entry.boardIds.includes(id))),
  );
}

/** ⌘Z / ⌘⇧Z on macOS; Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z elsewhere. */
export function undoKey(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  mac: boolean,
): "undo" | "redo" | undefined {
  if (e.altKey || (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey)) return undefined;
  const key = e.key.toLowerCase();
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y" && !mac && !e.shiftKey) return "redo";
  return undefined;
}
