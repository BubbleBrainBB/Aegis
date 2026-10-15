import type { DesignSelectionRef } from "./types";

const ID = /^[\w:.-]{1,200}$/;

/** Validates a renderer-supplied canvas selection before it is used or persisted with a message. */
export function sanitizeDesignSelectionRef(value: unknown): DesignSelectionRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.documentId !== "string" || !ID.test(v.documentId) || !Array.isArray(v.boardIds)) return undefined;
  const boardIds = [...new Set(v.boardIds.filter((id): id is string => typeof id === "string" && ID.test(id)))].slice(0, 32);
  if (!boardIds.length) return undefined;
  const single = boardIds.length === 1;
  const nodeId = single && typeof v.nodeId === "string" && ID.test(v.nodeId) ? v.nodeId : undefined;
  const contentRevision =
    single && typeof v.contentRevision === "number" && Number.isInteger(v.contentRevision) && v.contentRevision >= 0
      ? v.contentRevision
      : undefined;
  const label = typeof v.label === "string" ? v.label.replace(/[\r\n]+/g, " ").trim().slice(0, 160) : "";
  return {
    documentId: v.documentId,
    boardIds,
    ...(nodeId ? { nodeId } : {}),
    label: label || (single ? "Board" : `${boardIds.length} boards`),
    ...(contentRevision !== undefined ? { contentRevision } : {}),
  };
}

/** Two snapshots name the same selection (queued messages batch only within one). */
export function sameDesignSelection(a?: DesignSelectionRef, b?: DesignSelectionRef): boolean {
  if (!a || !b) return a === b;
  return (
    a.documentId === b.documentId &&
    a.nodeId === b.nodeId &&
    a.contentRevision === b.contentRevision &&
    a.label === b.label &&
    a.boardIds.length === b.boardIds.length &&
    a.boardIds.every((id, i) => id === b.boardIds[i])
  );
}
