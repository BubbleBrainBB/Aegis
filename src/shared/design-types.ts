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
  /** The message an agent version answered, and that message's id (one request, many saves). */
  prompt?: string | null;
  requestId?: string | null;
}
export interface DesignDocument {
  id: string;
  sessionId: string;
  title: string;
  brief: string;
  revision: number;
  boards: DesignBoard[];
  comments: DesignComment[];
  createdAt: number;
  updatedAt: number;
}
export type DesignSummary = Pick<
  DesignDocument,
  "id" | "sessionId" | "title" | "revision" | "updatedAt"
> & { boardCount: number };
export type DesignOperation =
  | {
      type: "add";
      name: string;
      html?: string;
      /** Canvas position; defaults to the right of the existing boards. */
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    }
  | { type: "content"; boardId: string; expectedRevision: number; html: string }
  | {
      type: "placement";
      boardId: string;
      expectedRevision: number;
      name?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    }
  | { type: "remove" | "duplicate"; boardId: string; expectedRevision: number }
  | { type: "title"; title: string; expectedRevision: number };
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
  /** "comments" changes never mint a document version. */
  scope?: "document" | "comments";
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
  /** The design open in the right panel and its selection; the next turn tells the agent. */
  focus(input: {
    sessionId: string;
    documentId?: string;
    boardId?: string;
    nodeId?: string;
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
    format: "html" | "png";
    boardId?: string;
    /** PNG pixel ratio; defaults to 1. */
    scale?: number;
  }): Promise<{ saved: boolean; path?: string }>;
  /** Style guides to offer in a conversation: built in, then the project's DESIGN.md. */
  styles(input: { sessionId: string; cwd?: string | null }): Promise<DesignStyleSummary[]>;
  /** The design composer's picks for a conversation: style guide and variations (1 = none). */
  composer(input: { sessionId: string; styleId?: string; variants?: number }): Promise<void>;
  onChanged(callback: (event: DesignEvent) => void): () => void;
}
