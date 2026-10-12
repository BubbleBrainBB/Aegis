import { designPages } from "../../shared/design-pages";
import { getDesignRepository } from "./service";
import { findDesignLayer, readDesignLayers } from "../../shared/design-layers";
import type { DesignSummary } from "../../shared/design-types";

/** The design a conversation has open and its selection, as the renderer reports it. */
export interface DesignFocus {
  documentId: string;
  boardId?: string;
  pageId?: string;
  nodeId?: string;
}
/** What the user asked for in the design composer: a style guide and how many directions. */
export interface DesignComposerPrefs {
  styleId?: string;
  variants?: number;
  /** A template from the project's design system to start new boards from. */
  templateId?: string;
}
const focus = new Map<string, DesignFocus>();
const composer = new Map<string, DesignComposerPrefs>();

export function setDesignComposerPrefs(sessionId: string, prefs: DesignComposerPrefs | null | undefined) {
  const styleId = typeof prefs?.styleId === "string" && /^[\w.-]{1,120}$/.test(prefs.styleId) ? prefs.styleId : undefined;
  const templateId = typeof prefs?.templateId === "string" && /^[\w.-]{1,120}$/.test(prefs.templateId) ? prefs.templateId : undefined;
  const variants =
    typeof prefs?.variants === "number" && Number.isInteger(prefs.variants) && prefs.variants > 1 && prefs.variants <= 4
      ? prefs.variants
      : undefined;
  if (!styleId && !variants && !templateId) composer.delete(sessionId);
  else composer.set(sessionId, { ...(styleId ? { styleId } : {}), ...(variants ? { variants } : {}), ...(templateId ? { templateId } : {}) });
}
export function getDesignComposerPrefs(sessionId: string): DesignComposerPrefs {
  return composer.get(sessionId) ?? {};
}
/** A draft chat became a real session: what it had open and picked moves along. */
export function moveDesignFocus(from: string, to: string) {
  const f = focus.get(from);
  if (f) focus.set(to, f);
  focus.delete(from);
  const c = composer.get(from);
  if (c) composer.set(to, c);
  composer.delete(from);
}

let styleFor: (sessionId: string) => string | undefined = () => undefined;
/** The style guide in effect for a session, by name (the style registry sets this). */
export function setDesignStyleResolver(resolve: (sessionId: string) => string | undefined) {
  styleFor = resolve;
}
let templateName: (sessionId: string, templateId: string) => string | undefined = () => undefined;
/** Names a picked template (the style registry sets this). */
export function setDesignTemplateNamer(namer: (sessionId: string, templateId: string) => string | undefined) {
  templateName = namer;
}
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
  focus.set(sessionId, { documentId, pageId: id(value?.pageId), boardId: id(value?.boardId), nodeId: id(value?.nodeId) });
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
  let designs: DesignSummary[];
  try {
    designs = getDesignRepository().list(sessionId);
  } catch {
    designs = [];
  }
  const prefs = composer.get(sessionId) ?? {};
  // The project's design system applies by default, but only to design work:
  // a picked style, or a conversation that already has designs.
  const style = prefs.styleId || designs.length ? styleFor(sessionId) : undefined;
  const template = prefs.templateId ? templateName(sessionId, prefs.templateId) : undefined;
  const asks: string[] = [];
  if (style) asks.push(`Style guide: ${label(style)}. Read it with design_guide before drawing.`);
  if (template && prefs.templateId)
    asks.push(`Template: start new boards from ${label(template)} (design_resources kind "template", name "${prefs.templateId}").`);
  if (prefs.variants) asks.push(`Variations: make ${prefs.variants} distinct directions for each new board, side by side.`);
  if (!designs.length)
    return asks.length ? `\n\n<design_context>\n${asks.join("\n")}\n</design_context>` : "";
  const f = focus.get(sessionId);
  const open = f && designs.find((d) => d.id === f.documentId);
  const lines: string[] = [];
  if (open && f) {
    lines.push(`Open: ${label(open.title)} (documentId ${open.id}, ${open.boardCount} board${open.boardCount === 1 ? "" : "s"}).`);
    try {
      const doc = getDesignRepository().read(sessionId, open.id);
      const page = designPages(doc).find(page => page.id === f.pageId) ?? designPages(doc)[0];
      lines.push(`Current page: ${label(page.name)} (pageId ${page.id}). Add boards to this page with pageId unless the user requests another page.`);
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
  } else lines.push("No design is open.");
  const others = designs.filter((d) => d.id !== open?.id).slice(0, 8);
  if (others.length)
    lines.push(
      `${open ? "Other designs" : "Designs"} in this conversation: ${others.map((d) => `${label(d.title)} (documentId ${d.id})`).join(", ")}.`,
    );
  return `\n\n<design_context>\n${[...lines, ...asks].join("\n")}\n</design_context>`;
}
