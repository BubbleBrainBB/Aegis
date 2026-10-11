import type { DesignPromptRef } from "./types";
import type {
  DesignAnchor,
  DesignThreadMessage,
} from "./design-types";

const ID = /^[\w:.-]{1,200}$/;
const clip = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/** Validates a renderer-supplied link before it is persisted with a chat message. */
export function sanitizeDesignPromptRef(
  value: unknown,
): DesignPromptRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.kind !== "design-comment") return undefined;
  const ids = [v.documentId, v.boardId, v.commentId, v.messageId];
  if (!ids.every((x) => typeof x === "string" && ID.test(x))) return undefined;
  const layerName = clip(v.layerName, 160);
  return {
    kind: "design-comment",
    documentId: v.documentId as string,
    documentTitle: clip(v.documentTitle, 160) || "Design",
    boardId: v.boardId as string,
    boardName: clip(v.boardName, 160) || "Board",
    ...(layerName ? { layerName } : {}),
    commentId: v.commentId as string,
    messageId: v.messageId as string,
    reply: v.reply === true,
  };
}

// User text must not be able to close the context block early.
const escape = (s: string) => s.replace(/<\/?design_comment/gi, "‹design_comment");

/**
 * The model-facing prompt for a comment sent to the agent. The chat shows only
 * the comment text; the model also gets the target and how to answer.
 */
export function buildDesignCommentPrompt(input: {
  text: string;
  documentId: string;
  boardId: string;
  boardName: string;
  commentId: string;
  contentRevision: number;
  documentRevision: number;
  anchor: DesignAnchor;
  layerName?: string;
  thread?: DesignThreadMessage[];
}): string {
  const { computedStyles: _styles, ...anchor } = input.anchor;
  const attrs = [
    `documentId="${input.documentId}"`,
    `boardId="${input.boardId}"`,
    `board="${escape(input.boardName).replace(/"/g, "'")}"`,
    `commentId="${input.commentId}"`,
    `contentRevision="${input.contentRevision}"`,
    ...(input.layerName
      ? [`layer="${escape(input.layerName).replace(/"/g, "'")}"`]
      : []),
  ].join(" ");
  const thread = (input.thread ?? [])
    .slice(-6)
    .map(
      (m) =>
        `${m.author.kind === "agent" ? m.author.name || "Agent" : m.author.name || "User"}: ${escape(m.text)}`,
    );
  return [
    escape(input.text),
    "",
    `<design_comment ${attrs}>`,
    `Selected element: ${escape(JSON.stringify(anchor))}`,
    ...(thread.length ? ["Earlier in this thread:", ...thread] : []),
    "</design_comment>",
    `Read this board with design_read, apply the change with design_update (pass commentId="${input.commentId}" and a one-line summary), check it with design_preview, then answer in the thread with design_reply. The attached screenshot shows document version ${input.documentRevision}.`,
  ].join("\n");
}
