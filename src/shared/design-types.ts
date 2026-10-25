import type { DesignMark } from "./design-marks";

export interface DesignPage {
  id: string;
  name: string;
}
/** What the canvas currently displays; coordinates remain authoritative in the document. */
export interface DesignCanvasAwareness {
  visibleBoardIds: string[];
  focusedBoardId?: string;
}
export interface DesignBoard {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  contentRevision: number;
  placementRevision: number;
  html: string;
  /** Missing or stale membership belongs to the first page (legacy documents). */
  pageId?: string;
}
export interface DesignAnchor {
  nodeId?: string;
  computedStyles?: Record<string, string>;
  text?: string;
  rect?: { x: number; y: number; width: number; height: number };
  /** Where the comment was clicked, relative to the layer's top-left. */
  offset?: { x: number; y: number };
  /** An area comment: `rect` is the region, `nodeIds` the layers inside it. */
  area?: boolean;
  nodeIds?: string[];
  /** A design component's repeated layer: which rendered copy (its loop index). */
  instance?: string;
}
export type DesignAuthor =
  | { kind: "user"; name?: string }
  | { kind: "agent"; name: string };
export type DesignCommentStatus = "open" | "working" | "resolved";
export interface DesignThreadMessage {
  id: string;
  author: DesignAuthor;
  text: string;
  createdAt: number;
  /** Sent to the agent rather than kept as a plain note. */
  toAgent: boolean;
  /** Agent reply that produced these document versions. */
  revision?: { from: number; to: number };
  /** Reverse link to the chat user_prompt that carried this message. */
  chatCreatedAt?: number;
}
export interface DesignComment {
  id: string;
  boardId: string;
  contentRevision: number;
  anchor: DesignAnchor;
  author: DesignAuthor;
  toAgent: boolean;
  status: DesignCommentStatus;
  /** Root message text; kept for readers that predate threads. */
  text: string;
  /** status === "resolved"; kept for readers that predate threads. */
  resolved: boolean;
  /** Document head when the agent started on the latest request. */
  baseRevision?: number;
  workingSince?: number;
  messages: DesignThreadMessage[];
  createdAt: number;
  updatedAt: number;
}
export interface DesignRevisionInfo {
  revision: number;
  createdAt: number;
  author: DesignAuthor | null;
  summary: string | null;
  commentId: string | null;
  boardIds: string[];
  /** This version changed pages, canvas annotations, or board page membership. */
  canvasChanged?: boolean;
  /** The message an agent version answered, and that message's id (one request, many saves). */
  prompt?: string | null;
  requestId?: string | null;
  /** The chat that made this version (designs have several chats). */
  sessionId?: string | null;
}
export interface DesignDocument {
  id: string;
  sessionId: string;
  title: string;
  brief: string;
  revision: number;
  boards: DesignBoard[];
  pages?: DesignPage[];
  marks?: DesignMark[];
  comments: DesignComment[];
  createdAt: number;
  updatedAt: number;
  /** The project folder the design belongs to; chats in it can work on it. */
  project?: string | null;
  /** The chats working on this design, most recently active first. */
  chats?: string[];
  /**
   * The design system its boards load: "project" (the project's
   * design-system/ folder) or a built-in style id. Unset: none, unless the
   * project has a design system.
   */
  system?: string | null;
}
export type DesignSummary = Pick<
  DesignDocument,
  "id" | "sessionId" | "title" | "revision" | "updatedAt"
> & {
  boardCount: number;
  project: string | null;
  chats: string[];
  /** In list(): whether the asking chat is one of the design's chats. */
  member?: boolean;
};
export type DesignOperation =
  | {
      type: "add";
      name?: string;
      html?: string;
      /** The board's logic (class Board extends AegisBoard …), when it is a design component. */
      js?: string;
      /** The board's props definition. */
      props?: Record<string, unknown>;
      /** Canvas position; defaults to the right of the existing boards. */
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      pageId?: string;
    }
  | { type: "patch"; boardId: string; expectedRevision: number; find: string; replace: string }
  | { type: "content"; boardId: string; expectedRevision: number; html: string; js?: string; props?: Record<string, unknown> }
  | { type: "logic"; boardId: string; expectedRevision: number; js: string }
  | { type: "logic_patch"; boardId: string; expectedRevision: number; find: string; replace: string }
  | { type: "props"; boardId: string; expectedRevision: number; props: Record<string, unknown> | null }
  | {
      type: "placement";
      boardId: string;
      expectedRevision: number;
      name?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      pageId?: string;
    }
  | { type: "remove" | "duplicate"; boardId: string; expectedRevision: number }
  | { type: "title"; title: string; expectedRevision: number }
  | { type: "system"; system: string | null; expectedRevision: number }
  | { type: "canvas"; expectedRevision: number; pages?: DesignPage[]; marks?: DesignMark[] };
export interface DesignUpdate {
  documentId: string;
  operationId: string;
  operations: DesignOperation[];
  /** One-line past-tense summary shown in version history. */
  summary?: string;
  /** The design comment this change addresses. */
  commentId?: string;
}
export interface DesignEvent {
  sessionId: string;
  documentId: string;
  title: string;
  revision: number;
  created: boolean;
  /** "comments" and "chats" changes never mint a document version. */
  scope?: "document" | "comments" | "chats";
  /** The design was deleted. */
  deleted?: boolean;
}
export interface DesignPreview {
  dataUrl: string;
  revision: number;
  boardId: string;
  width: number;
  height: number;
  warnings: string[];
}
/** A style guide the user can pick for a design (see src/electron/design/styles.ts). */
export interface DesignStyleSummary {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "project";
  featured: boolean;
  /** Background, text, accent, line; empty for the project's own guide. */
  palette: string[];
  serif: boolean;
}

export interface DesignAPI {
  list(sessionId: string): Promise<DesignSummary[]>;
  /** Designs across every conversation, newest first. */
  listAll(): Promise<DesignSummary[]>;
  create(input: {
    sessionId: string;
    title: string;
    brief?: string;
    operationId: string;
  }): Promise<DesignDocument>;
  read(input: {
    sessionId: string;
    documentId: string;
    revision?: number;
  }): Promise<DesignDocument>;
  update(input: DesignUpdate & { sessionId: string }): Promise<DesignDocument>;
  /** Each board's latest agent version and the message that asked for it. */
  prompts(input: { sessionId: string; documentId: string }): Promise<Record<string, { prompt: string; revision: number; author: DesignAuthor | null }>>;
  history(input: {
    sessionId: string;
    documentId: string;
  }): Promise<DesignRevisionInfo[]>;
  restore(input: {
    sessionId: string;
    documentId: string;
    revision: number;
    expectedRevision: number;
    operationId: string;
    /** Restore only this board's content and placement. */
    boardId?: string;
    /** Restore only these boards (undo / redo); deleted ones come back, newer ones go. */
    boardIds?: string[];
    /** With boardIds (or alone): also restore the document title. */
    title?: boolean;
    /** Restore pages and canvas annotations without replacing unrelated boards. */
    canvas?: boolean;
    /** History line for this version, e.g. "Undo · Moved Home". */
    summary?: string;
  }): Promise<DesignDocument>;
  comment(input: {
    sessionId: string;
    documentId: string;
    boardId: string;
    contentRevision: number;
    text: string;
    anchor: DesignAnchor;
    id: string;
    toAgent?: boolean;
  }): Promise<DesignComment>;
  reply(input: {
    sessionId: string;
    documentId: string;
    commentId: string;
    id: string;
    text: string;
    toAgent?: boolean;
  }): Promise<DesignComment>;
  comments(input: {
    sessionId: string;
    documentId: string;
  }): Promise<DesignComment[]>;
  resolve(input: {
    sessionId: string;
    documentId: string;
    commentId: string;
    resolved: boolean;
  }): Promise<DesignComment>;
  /** The design open in the right panel and what is in view; the next turn tells the agent. */
  focus(input: {
    sessionId: string;
    documentId?: string;
    pageId?: string;
    visibleBoardIds?: string[];
    focusedBoardId?: string;
    /** false: this panel closed; clears the focus only if it is still this design. */
    open?: boolean;
  }): Promise<void>;
  preview(input: {
    sessionId: string;
    documentId: string;
    boardId: string;
    revision: number;
  }): Promise<DesignPreview>;
  export(input: {
    sessionId: string;
    documentId: string;
    revision: number;
    format: "html" | "png" | "pdf" | "pptx";
    pageId?: string;
    /** PNG: the board to render. PDF and HTML: only this board. */
    boardId?: string;
    /** PDF and HTML: only these boards. */
    boardIds?: string[];
    /** PNG pixel ratio; defaults to 1. */
    scale?: number;
  }): Promise<{ saved: boolean; path?: string }>;
  /** Style guides to offer in a conversation: built in, then the project's DESIGN.md. */
  styles(input: { sessionId: string; cwd?: string | null }): Promise<DesignStyleSummary[]>;
  /**
   * A quick edit of one layer by a fast model: new board HTML to save as one
   * version (against `contentRevision`), or a reason to hand it to the agent.
   */
  quickEdit(input: { requestId: string; sessionId: string; documentId: string; boardId: string; nodeId: string; instruction: string }): Promise<
    { ok: true; html: string; contentRevision: number } | { ok: false; handoff: string } | { ok: false; error: string }
  >;
  quickEditCancel(input: { requestId: string }): Promise<void>;
  /**
   * A sandboxed frame (by its name) stopped answering: end the sandbox
   * process it runs in. Every sandboxed frame of the window shares it, so
   * the renderer remounts them all afterwards.
   */
  recoverFrame(input: { frameName: string }): Promise<{ recovered: boolean }>;
  /** Adds an image (dropped or pasted) to a design; boards use it as aegis-asset:<id>. */
  addAsset(input: { sessionId: string; documentId: string; bytes: Uint8Array; mime: string; name: string }): Promise<{ id: string; name: string; mime: string; width: number | null; height: number | null; size: number }>;
  /** A design's images as data URLs, by id; `have` skips ids the caller already holds. */
  assets(input: { sessionId: string; documentId: string; have?: string[] }): Promise<Record<string, string>>;
  /** The design system the design's boards load, or null. */
  system(input: { sessionId: string; documentId: string; signature?: string }): Promise<import("./design-system-pack").DesignSystemPack | { unchanged: true; signature: string } | null>;
  /** A chat joins a design (a new chat started on it). */
  join(input: { sessionId: string; documentId: string }): Promise<void>;
  /** Deletes a design for good; its chats stay. */
  remove(input: { documentId: string }): Promise<boolean>;
  /** Writes chosen boards and a README into the project (.aegis/design/<design>/) for implementing. */
  handoff(input: { sessionId: string; documentId: string; boardIds?: string[] }): Promise<{
    folder: string;
    files: string[];
    boards: { name: string; file: string; width: number; height: number }[];
  }>;
  /** The project's templates (design-system/templates), sanitized for thumbnails. */
  templates(input: { sessionId: string; cwd?: string | null }): Promise<{ id: string; name: string; summary: string; html: string }[]>;
  /** The design composer's picks for a conversation: style guide, variations (1 = none) and a template. */
  composer(input: { sessionId: string; styleId?: string; variants?: number; templateId?: string }): Promise<void>;
  onChanged(callback: (event: DesignEvent) => void): () => void;
}
