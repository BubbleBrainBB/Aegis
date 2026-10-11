import { getDesignRepository } from "./service";
import { findDesignLayer, readDesignLayers } from "../../shared/design-layers";

/** What the right-side Design panel shows for a conversation, as the renderer reports it. */
export interface DesignFocus {
  documentId: string;
  boardId?: string;
  nodeId?: string;
}
const focus = new Map<string, DesignFocus>();
const id = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : undefined);

export function setDesignFocus(
  sessionId: string,
  value: (Partial<DesignFocus> & { open?: boolean }) | null | undefined,
) {
  const documentId = id(value?.documentId);
  // A panel that closes clears only its own design, so another visible tab keeps the focus.
  if (value?.open === false) {
    if (focus.get(sessionId)?.documentId === documentId) focus.delete(sessionId);
    return;
  }
  if (!documentId) {
    focus.delete(sessionId);
    return;
  }
  // Only a design that belongs to this conversation can be focused.
  let owned = false;
  try {
    owned = getDesignRepository().owns(sessionId, documentId);
  } catch {}
  if (!owned) {
    focus.delete(sessionId);
    return;
  }
  focus.set(sessionId, { documentId, boardId: id(value?.boardId), nodeId: id(value?.nodeId) });
}

// Titles and layer names are user content: one line, no markup, bounded.
const label = (v: string) => JSON.stringify(v.replace(/[<>\r\n]+/g, " ").trim().slice(0, 80));
// Layer ids come from board HTML too; print only plain ones.
const plainId = (v: string) => /^[\w:.-]{1,200}$/.test(v);

/**
 * The per-turn <design_context> block: which design is open, what is selected,
 * and the other designs in this conversation. Facts only; the tools carry the rules.
 */
export function designContextText(sessionId: string): string {
  let designs;
  try {
    designs = getDesignRepository().list(sessionId);
  } catch {
    return "";
  }
  if (!designs.length) return "";
  const f = focus.get(sessionId);
  const open = f && designs.find((d) => d.id === f.documentId);
  const lines: string[] = [];
  if (open && f) {
    lines.push(`Open on the right: ${label(open.title)} (documentId ${open.id}, ${open.boardCount} board${open.boardCount === 1 ? "" : "s"}).`);
    try {
      const doc = getDesignRepository().read(sessionId, open.id);
      const board = f.boardId ? doc.boards.find((b) => b.id === f.boardId) : undefined;
      if (board) {
        const node = f.nodeId ? findDesignLayer(readDesignLayers(board.html), f.nodeId) : undefined;
        lines.push(
          `Selected: board ${label(board.name)} (boardId ${board.id})` +
            (node ? `, layer ${label(node.name.split(" · ")[0])}${plainId(node.id) ? ` (nodeId ${node.id})` : ""}` : "") +
            ".",
        );
      }
    } catch {}
  } else lines.push("No design is open on the right.");
  const others = designs.filter((d) => d.id !== open?.id).slice(0, 8);
  if (others.length)
    lines.push(
      `${open ? "Other designs" : "Designs"} in this conversation: ${others.map((d) => `${label(d.title)} (documentId ${d.id})`).join(", ")}.`,
    );
  return `\n\n<design_context>\n${lines.join("\n")}\n</design_context>`;
}
