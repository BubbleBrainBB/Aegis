import { designPages, designPageId } from "../../shared/design-pages";
import { getDesignRepository } from "./service";
import { findDesignLayer, readDesignLayers } from "../../shared/design-layers";
import type { DesignDocument, DesignSummary } from "../../shared/design-types";
import type { DesignSelectionRef } from "../../shared/types";
import { moveDesignInstructions, takeDesignInstructions } from "./project/prompts";

/**
 * The design a conversation has open and what is in view, as the renderer
 * reports it. What is selected travels with each message instead
 * (DesignSelectionRef), so the agent gets exactly the chip the user sent.
 */
export interface DesignFocus {
  documentId: string;
  pageId?: string;
  visibleBoardIds?: string[];
  focusedBoardId?: string;
  /** A design project: the page on screen, relative to its folder. */
  path?: string;
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
  moveDesignInstructions(from, to);
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
const boardIds = (value: unknown): string[] | undefined => Array.isArray(value)
  ? [...new Set(value.map(id).filter((v): v is string => !!v))].slice(0, 32) : undefined;
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
  // Only a design this conversation can use (its own, or its project's) can be focused.
  let owned = false;
  try {
    owned = getDesignRepository().owns(sessionId, documentId);
  } catch {}
  if (!owned) {
    focus.delete(sessionId);
    return;
  }
  focus.set(sessionId, {
    documentId, pageId: id(value?.pageId), visibleBoardIds: boardIds(value?.visibleBoardIds),
    focusedBoardId: id(value?.focusedBoardId),
    path: typeof value?.path === "string" && value.path.length <= 500 ? value.path : undefined,
  });
}

// Titles and layer names are user content: one line, no markup, bounded.
const label = (v: string) => JSON.stringify(v.replace(/[<>\r\n]+/g, " ").trim().slice(0, 80));
// Layer ids come from board HTML too; print only plain ones.
const plainId = (v: string) => /^[\w:.-]{1,200}$/.test(v);

type Board = DesignDocument["boards"][number];
const describe = (b: Board) => `${label(b.name)} (boardId ${b.id}, x=${b.x}, y=${b.y}, width=${b.width}, height=${b.height})`;

/** The lines for the selection a message was sent with, against the latest saved document. */
function selectionLines(doc: DesignDocument, selection: DesignSelectionRef, openId: string | undefined): string[] {
  const where = doc.id === openId ? "" : ` in ${label(doc.title)} (documentId ${doc.id})`;
  const boards = selection.boardIds.map((id) => doc.boards.find((b) => b.id === id)).filter((b): b is Board => !!b);
  if (!boards.length) return [`Selected${where}: ${label(selection.label)}, no longer in the design.`];
  if (boards.length > 1) return [`Selected boards${where}: ${boards.map(describe).join("; ")}.`];
  const [board] = boards;
  const node = selection.nodeId ? findDesignLayer(readDesignLayers(board.html), selection.nodeId) : undefined;
  const layer = node
    ? `, layer ${label(node.name.split(" · ")[0])}${plainId(node.id) ? ` (nodeId ${node.id})` : ""}`
    : selection.nodeId ? `, a layer that is no longer in the board` : "";
  const changed =
    selection.contentRevision !== undefined && selection.contentRevision !== board.contentRevision
      ? ` The board changed after it was selected (contentRevision ${selection.contentRevision} → ${board.contentRevision}).`
      : "";
  return [`Selected${where}: board ${describe(board)}${layer}.${changed}`];
}

/**
 * The per-turn <design_context> block: which design is open, what the message
 * was sent about, and the other designs in this conversation. Facts only; the
 * tools carry the rules.
 */
export function designContextText(sessionId: string, selection?: DesignSelectionRef): string {
  let all: DesignSummary[];
  try {
    all = getDesignRepository().list(sessionId);
  } catch {
    all = [];
  }
  // The designs this conversation works on; the open one may be another of its project's.
  const designs = all.filter((d) => d.member);
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
  const f = focus.get(sessionId);
  const open = f && all.find((d) => d.id === f.documentId);
  // Only a design this conversation can use; the list is its access.
  const picked = selection && all.find((d) => d.id === selection.documentId);
  // The project prompt, once, for a chat that works on a design project.
  const instructions = takeDesignInstructions(sessionId, open?.kind === "project" || designs.some((d) => d.kind === "project"));
  if (open?.kind === "project") return instructions + projectContext(open, f!, designs, asks);
  if (!designs.length && !open && !picked)
    return instructions + (asks.length ? `\n\n<design_context>\n${asks.join("\n")}\n</design_context>` : "");
  const lines: string[] = [];
  let selected: string[] = [];
  if (picked && selection) {
    try {
      selected = selectionLines(getDesignRepository().read(sessionId, picked.id), selection, open?.id);
    } catch {}
  }
  if (open && f) {
    lines.push(`Open: ${label(open.title)} (documentId ${open.id}, ${open.boardCount} board${open.boardCount === 1 ? "" : "s"}).`);
    try {
      const doc = getDesignRepository().read(sessionId, open.id);
      const page = designPages(doc).find(page => page.id === f.pageId) ?? designPages(doc)[0];
      lines.push(`Current page: ${label(page.name)} (pageId ${page.id}). Add boards to this page with pageId unless the user requests another page.`);
      const onPage = doc.boards.filter(b => designPageId(doc, b) === page.id);
      if (f.visibleBoardIds !== undefined) {
        const visible = onPage.filter(b => f.visibleBoardIds!.includes(b.id));
        lines.push(`Visible boards: ${visible.length ? visible.map(describe).join("; ") : "none"}.`);
      }
      const focused = onPage.find(b => b.id === f.focusedBoardId);
      if (focused) lines.push(`Focused preview: ${describe(focused)}.`);
      lines.push("Positions are canvas coordinates, independent of pan and zoom. Read design_read for the latest complete layout before placing or moving boards.");
    } catch {}
  } else lines.push("No design is open.");
  lines.push(...selected);
  const others = designs.filter((d) => d.id !== open?.id).slice(0, 8);
  if (others.length)
    lines.push(
      `${open ? "Other designs" : "Designs"} in this conversation: ${others.map((d) => `${label(d.title)} (documentId ${d.id})`).join(", ")}.`,
    );
  return instructions + `\n\n<design_context>\n${[...lines, ...asks].join("\n")}\n</design_context>`;
}

/** The context for an open design project: its folder, its pages and the one on screen. */
function projectContext(open: DesignSummary, f: DesignFocus, designs: DesignSummary[], asks: string[]): string {
  const lines = [
    `Open: design project ${label(open.title)} (documentId ${open.id}) in the folder ${JSON.stringify(open.folder ?? "")}. Write its files there with your file tools.`,
    `Pages: ${open.pages?.length ? open.pages.map((p) => JSON.stringify(p)).join(", ") : "none yet"}.`,
  ];
  if (f.path) lines.push(`On screen: ${JSON.stringify(f.path)}.`);
  const others = designs.filter((d) => d.id !== open.id).slice(0, 8);
  if (others.length) lines.push(`Other designs in this conversation: ${others.map((d) => `${label(d.title)} (${d.kind === "project" ? "project" : "canvas"}, documentId ${d.id})`).join(", ")}.`);
  return `\n\n<design_context>\n${[...lines, ...asks].join("\n")}\n</design_context>`;
}
