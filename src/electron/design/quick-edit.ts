import { getDesignRepository } from "./service";
import { readLayerHtml, replaceLayerHtml } from "../../shared/design-layers";
import { readBoardTokens } from "../../shared/design-tokens";
import { runClaudeOneShot } from "../libs/util";

/**
 * Quick edits: one selected layer, one short instruction ("a bit smaller",
 * "make this the accent color"), answered by a fast model with new markup
 * for that layer only, in seconds. Anything bigger (other layers, new boards,
 * images, a redesign) is handed back so the full agent can take it.
 *
 * The result is not saved here: the canvas writes it as one version against
 * the board's revision, so a board that changed meanwhile is a conflict, and
 * one undo takes the edit back.
 */
export type QuickEditResult =
  | { ok: true; html: string; contentRevision: number }
  | { ok: false; handoff: string }
  | { ok: false; error: string };

export interface QuickEditRequest {
  requestId: string;
  sessionId: string;
  documentId: string;
  boardId: string;
  nodeId: string;
  instruction: string;
}

const MAX_LAYER_HTML = 30_000;
const TIMEOUT_MS = 60_000;

const SYSTEM = [
  "You make one small, precise change to one element of a static HTML design.",
  "You get the element's current HTML, the board's design tokens, and an instruction.",
  "Reply with only the new HTML for that element: one root element, no explanation, no code fence.",
  "Change only what the instruction asks. Keep the text, structure, classes and data-aegis-* attributes, and every color, size and spacing it doesn't mention.",
  "Use inline styles or the element's existing classes. For colors prefer the board's tokens as var(--name).",
  "No scripts, no event handlers, no remote images or fonts.",
  "If the instruction needs more than this element (other elements, a new board, images, data, a redesign) or is unclear, reply with exactly one line: HANDOFF: <why, in a few words>.",
].join("\n");

export type QuickEditModel = (input: { system: string; prompt: string; signal: AbortSignal }) => Promise<string>;

/** A fast model through the user's Claude Code login; one turn, no tools. */
let model: QuickEditModel = async ({ system, prompt, signal }) =>
  (await runClaudeOneShot({ prompt, systemPrompt: system, model: "haiku", signal })).text;
/** Tests swap the model. */
export function setQuickEditModel(next: QuickEditModel) {
  model = next;
}

const running = new Map<string, AbortController>();
export function cancelQuickEdit(requestId: string) {
  running.get(requestId)?.abort();
}

/** The new markup out of a reply: code fences and surrounding prose dropped. */
export function quickEditReply(text: string): { html: string } | { handoff: string } {
  const trimmed = text.trim();
  const handoff = /^HANDOFF:\s*(.*)$/im.exec(trimmed);
  if (handoff && !/^\s*</.test(trimmed)) return { handoff: handoff[1].trim() || "This needs the full agent." };
  const fenced = /```(?:html)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = (fenced ? fenced[1] : trimmed).trim();
  const start = body.indexOf("<");
  const end = body.lastIndexOf(">");
  if (start < 0 || end < start) return { handoff: "The quick edit didn't return markup." };
  return { html: body.slice(start, end + 1) };
}

export async function quickEditDesign(request: QuickEditRequest): Promise<QuickEditResult> {
  const instruction = request.instruction.trim().slice(0, 600);
  if (!instruction) return { ok: false, error: "Say what to change." };
  const doc = getDesignRepository().read(request.sessionId, request.documentId);
  const board = doc.boards.find((b) => b.id === request.boardId);
  if (!board) return { ok: false, error: "That board no longer exists." };
  let layer: string;
  try {
    layer = readLayerHtml(board.html, request.nodeId);
  } catch {
    return { ok: false, error: "That layer no longer exists." };
  }
  if (layer.length > MAX_LAYER_HTML) return { ok: false, handoff: "This layer is too large for a quick edit." };
  const tokens = readBoardTokens(board.html);
  const prompt = [
    `Instruction: ${instruction}`,
    tokens.length ? `Board tokens:\n${tokens.map((t) => `${t.name}: ${t.value}`).join("\n")}` : "Board tokens: none",
    `Element on the board "${board.name}":\n${layer}`,
  ].join("\n\n");

  const controller = new AbortController();
  running.set(request.requestId, controller);
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const reply = quickEditReply(await model({ system: SYSTEM, prompt, signal: controller.signal }));
    if (controller.signal.aborted) return { ok: false, error: "Cancelled." };
    if ("handoff" in reply) return { ok: false, handoff: reply.handoff };
    try {
      return { ok: true, html: replaceLayerHtml(board.html, request.nodeId, reply.html), contentRevision: board.contentRevision };
    } catch (error) {
      return { ok: false, handoff: `The quick edit didn't fit the board (${error instanceof Error ? error.message : String(error)}).` };
    }
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, error: "Cancelled or timed out." };
    return { ok: false, error: `Quick edit needs Claude Code: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
    running.delete(request.requestId);
  }
}
