import { normalizeBoardName, nextBoardName, copyBoardName } from "../../shared/design-names";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { z } from "zod";
import type {
  DesignAnchor,
  DesignAuthor,
  DesignBoard,
  DesignComment,
  DesignCommentStatus,
  DesignDocument,
  DesignEvent,
  DesignRevisionInfo,
  DesignSummary,
  DesignThreadMessage,
  DesignUpdate,
} from "../../shared/design-types";
import { summarizeOperations } from "../../shared/design-history";
import { validateDesignMarks, MAX_DESIGN_MARKS } from "../../shared/design-marks";
import { sanitizeDesignHtml } from "./html";

const boardName = z.string().transform(normalizeBoardName);
const name = z.string().trim().min(1).max(160);
const id = z.string().min(1).max(200);
const revision = z.number().int().nonnegative();
const size = z.number().int().min(100).max(4096);
const point = z.number().finite().min(-100000).max(100000);
const pagesSchema = z.array(z.object({ id, name: z.string().trim().min(1).max(120) }).strict())
  .max(40).refine((pages) => new Set(pages.map((page) => page.id)).size === pages.length, "Page IDs must be unique.");
const marksSchema = z.array(z.unknown()).max(MAX_DESIGN_MARKS).transform(validateDesignMarks);
const operations = z
  .array(
    z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("add"),
          name: boardName.optional(),
          html: z.string().optional(),
          x: point.optional(),
          y: point.optional(),
          width: size.optional(),
          height: size.optional(),
          pageId: id.optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("content"),
          boardId: id,
          expectedRevision: revision,
          html: z.string(),
        })
        .strict(),
      z.object({
        type: z.literal("patch"),
        boardId: id,
        expectedRevision: revision,
        find: z.string().min(1).max(1_000_000),
        replace: z.string().max(1_000_000),
      }).strict(),
      z
        .object({
          type: z.literal("placement"),
          boardId: id,
          expectedRevision: revision,
          name: boardName.optional(),
          x: point.optional(),
          y: point.optional(),
          width: size.optional(),
          height: size.optional(),
          pageId: id.optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("remove"),
          boardId: id,
          expectedRevision: revision,
        })
        .strict(),
      z.object({
        type: z.literal("canvas"),
        expectedRevision: revision,
        pages: pagesSchema.optional(),
        marks: marksSchema.optional(),
      }).strict(),
      z
        .object({
          type: z.literal("duplicate"),
          boardId: id,
          expectedRevision: revision,
        })
        .strict(),
      z
        .object({
          type: z.literal("title"),
          title: name,
          expectedRevision: revision,
        })
        .strict(),
    ]),
  )
  .min(1)
  .max(64);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const anchorSchema = z
  .object({
    nodeId: z.string().max(200).optional(),
    text: z.string().max(500).optional(),
    rect: z
      .object({
        x: point,
        y: point,
        width: z.number().min(0).max(100000),
        height: z.number().min(0).max(100000),
      })
      .optional(),
    computedStyles: z
      .record(z.string().max(64), z.string().max(200))
      .refine((v) => Object.keys(v).length <= 32)
      .optional(),
    offset: z.object({ x: point, y: point }).strict().optional(),
    area: z.boolean().optional(),
    nodeIds: z.array(z.string().min(1).max(200)).max(50).optional(),
  })
  .strict();
const commentText = z.string().trim().min(1).max(10000);
const authorSchema = z.union([
  z.object({ kind: z.literal("user"), name: z.string().max(120).optional() }),
  z.object({ kind: z.literal("agent"), name: z.string().min(1).max(80) }),
]);
const SCHEMA_VERSION = 1;
/** Used when a write does not say which agent made it. */
export const DEFAULT_AGENT_AUTHOR: DesignAuthor = { kind: "agent", name: "Agent" };
/** Writer identity and history text recorded with each document version. */
export interface DesignWriteMeta {
  author: DesignAuthor;
  summary?: string;
  commentId?: string;
  /** The user's message that asked for this version (agent writes). */
  prompt?: string;
  /** Which message that was: every write of one request shares it (History groups by it). */
  requestId?: string;
}

/** The request an agent write answers: the message text and its id. */
export interface DesignRequest {
  prompt?: string;
  id?: string;
}
type CommentRow = {
  id: string;
  document_id: string;
  session_id: string;
  board_id: string;
  content_revision: number;
  anchor: string;
  author: string;
  to_agent: number;
  status: DesignCommentStatus;
  base_revision: number | null;
  working_since: number | null;
  digest: string;
  created_at: number;
  updated_at: number;
};
type MessageRow = {
  id: string;
  comment_id: string;
  author: string;
  text: string;
  to_agent: number;
  revision_from: number | null;
  revision_to: number | null;
  chat_created_at: number | null;
  created_at: number;
};
/** Boards whose content, placement or name differ between two heads. */
function changedBoards(
  before: Pick<DesignBoard, "id" | "name" | "x" | "y" | "width" | "height" | "pageId">[] &
    { contentHash?: string; html?: string }[],
  after: typeof before,
) {
  const key = (b: (typeof before)[number]) =>
    JSON.stringify([
      b.name,
      b.x,
      b.y,
      b.width,
      b.height,
      b.pageId,
      b.contentHash ?? hash(b.html ?? ""),
    ]);
  const prior = new Map(before.map((b) => [b.id, key(b)]));
  const ids = after.filter((b) => prior.get(b.id) !== key(b)).map((b) => b.id);
  const kept = new Set(after.map((b) => b.id));
  return [...ids, ...before.filter((b) => !kept.has(b.id)).map((b) => b.id)];
}
/** Membership is part of canvas semantics, even when board HTML is unchanged. */
function canvasState(document?: DesignDocument) {
  return JSON.stringify([
    document?.pages ?? [],
    document?.marks ?? [],
    (document?.boards ?? []).map((board) => [board.id, board.pageId ?? null]).sort(([a], [b]) => a!.localeCompare(b!)),
  ]);
}
type Head = { id: string; session_id: string; project: string | null; revision: number };
const cleanProject = (path: string | null | undefined) => (path ? path.replace(/[\\/]+$/, "") || null : null);
const conflict = () => {
  throw new Error(
    "REVISION_CONFLICT: read the latest design, merge your change, and retry. Nothing was saved.",
  );
};

/** SQLite owns both immutable snapshots and content: one atomic commit. */
export class DesignRepository {
  private db: Database.Database;
  /**
   * Designs the user opened in a chat's panel or dock this run: that chat's
   * agent may work on them too (the panel tells it which one is open).
   */
  private opened = new Map<string, Set<string>>();
  /** Strictly increasing activity times, so two chats active in one millisecond still order. */
  private lastActive = 0;
  private activeAt() {
    this.lastActive = Math.max(Date.now(), this.lastActive + 1);
    return this.lastActive;
  }
  constructor(
    file: string,
    private notify: (event: DesignEvent) => void = () => {},
    /** The project folder a chat works in; designs are shared within a project. */
    private projectOf: (sessionId: string) => string | null | undefined = () => null,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS design_documents(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS design_content(hash TEXT PRIMARY KEY, html TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS design_revisions(document_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(document_id,revision));
      CREATE TABLE IF NOT EXISTS design_receipts(session_id TEXT NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL, document_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(session_id,operation_id));
      CREATE INDEX IF NOT EXISTS design_by_session ON design_documents(session_id);`);
    this.migrate();
    this.migratePrompts();
    this.migrateCanvas();
    this.migrateChats();
  }
  /**
   * v5: a design is no longer one chat's. It keeps the project it was made in,
   * and any number of chats work on it (design_chats); each existing design
   * starts with the chat that made it.
   */
  private migrateChats() {
    if ((this.db.pragma("user_version", { simple: true }) as number) >= 5) return;
    this.db.transaction(() => {
      const columns = this.db.prepare("PRAGMA table_info(design_documents)").all() as { name: string }[];
      if (!columns.some((c) => c.name === "project"))
        this.db.exec("ALTER TABLE design_documents ADD COLUMN project TEXT");
      // Which chat made each version (history names it when it isn't the one on screen).
      const revisionColumns = this.db.prepare("PRAGMA table_info(design_revisions)").all() as { name: string }[];
      if (!revisionColumns.some((c) => c.name === "session_id"))
        this.db.exec("ALTER TABLE design_revisions ADD COLUMN session_id TEXT");
      this.db.exec(`CREATE TABLE IF NOT EXISTS design_chats(document_id TEXT NOT NULL, session_id TEXT NOT NULL, joined_at INTEGER NOT NULL, active_at INTEGER NOT NULL, PRIMARY KEY(document_id, session_id));
        CREATE INDEX IF NOT EXISTS design_chats_by_session ON design_chats(session_id);
        INSERT OR IGNORE INTO design_chats SELECT id, session_id, updated_at, updated_at FROM design_documents;`);
      this.db.pragma("user_version = 5");
    })();
  }
  /** v4 records canvas metadata edits separately from board content edits. */
  private migrateCanvas() {
    if ((this.db.pragma("user_version", { simple: true }) as number) >= 4) return;
    this.db.transaction(() => {
      const columns = this.db.prepare("PRAGMA table_info(design_revisions)").all() as { name: string }[];
      if (!columns.some((column) => column.name === "canvas_changed"))
        this.db.exec("ALTER TABLE design_revisions ADD COLUMN canvas_changed INTEGER NOT NULL DEFAULT 0");
      this.db.pragma("user_version = 4");
    })();
  }
  /**
   * v2: versions remember the message that asked for them (prompt cards).
   * v3: and which message it was, so History shows one version per request.
   */
  private migratePrompts() {
    if ((this.db.pragma("user_version", { simple: true }) as number) >= 3) return;
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(design_revisions)").all() as { name: string }[]).map((c) => c.name),
    );
    this.db.transaction(() => {
      if (!columns.has("prompt")) this.db.exec("ALTER TABLE design_revisions ADD COLUMN prompt TEXT");
      if (!columns.has("request_id")) this.db.exec("ALTER TABLE design_revisions ADD COLUMN request_id TEXT");
      this.db.pragma("user_version = 3");
    })();
  }
  /**
   * v1: comment threads leave revision snapshots, and versions record their
   * author, summary and touched boards. Old comment-only versions are hidden.
   */
  private migrate() {
    if ((this.db.pragma("user_version", { simple: true }) as number) >= 1)
      return;
    this.db.transaction(() => {
      const columns = new Set(
        (
          this.db.prepare("PRAGMA table_info(design_revisions)").all() as {
            name: string;
          }[]
        ).map((c) => c.name),
      );
      for (const [column, type] of [
        ["author", "TEXT"],
        ["summary", "TEXT"],
        ["comment_id", "TEXT"],
        ["board_ids", "TEXT"],
        ["hidden", "INTEGER NOT NULL DEFAULT 0"],
      ])
        if (!columns.has(column))
          this.db.exec(
            `ALTER TABLE design_revisions ADD COLUMN ${column} ${type}`,
          );
      this.db.exec(`CREATE TABLE IF NOT EXISTS design_comments(id TEXT PRIMARY KEY, document_id TEXT NOT NULL, session_id TEXT NOT NULL, board_id TEXT NOT NULL, content_revision INTEGER NOT NULL, anchor TEXT NOT NULL, author TEXT NOT NULL, to_agent INTEGER NOT NULL, status TEXT NOT NULL, base_revision INTEGER, working_since INTEGER, digest TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS design_comments_by_document ON design_comments(document_id, created_at);
        CREATE TABLE IF NOT EXISTS design_comment_messages(comment_id TEXT NOT NULL, id TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, to_agent INTEGER NOT NULL, revision_from INTEGER, revision_to INTEGER, chat_created_at INTEGER, digest TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(comment_id, id));`);
      const documents = this.db
        .prepare("SELECT id, session_id, revision FROM design_documents")
        .all() as { id: string; session_id: string; revision: number }[];
      for (const doc of documents) {
        const rows = this.db
          .prepare(
            "SELECT revision, snapshot FROM design_revisions WHERE document_id=? ORDER BY revision",
          )
          .all(doc.id) as { revision: number; snapshot: string }[];
        let previous: { title: string; boards: [] } | undefined;
        for (const row of rows) {
          const snap = JSON.parse(row.snapshot);
          const ids = previous ? changedBoards(previous.boards, snap.boards) : [];
          const hidden =
            !!previous && previous.title === snap.title && ids.length === 0;
          this.db
            .prepare(
              "UPDATE design_revisions SET board_ids=?, hidden=? WHERE document_id=? AND revision=?",
            )
            .run(JSON.stringify(ids), hidden ? 1 : 0, doc.id, row.revision);
          previous = snap;
          if (row.revision !== doc.revision) continue;
          for (const c of (snap.comments ?? []) as {
            id: string;
            boardId: string;
            contentRevision: number;
            anchor: DesignAnchor;
            text: string;
            resolved: boolean;
            createdAt: number;
          }[]) {
            const author = JSON.stringify({ kind: "user" });
            this.db
              .prepare(
                "INSERT OR IGNORE INTO design_comments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                c.id,
                doc.id,
                doc.session_id,
                c.boardId,
                c.contentRevision,
                JSON.stringify(c.anchor ?? {}),
                author,
                0,
                c.resolved ? "resolved" : "open",
                null,
                null,
                "migrated",
                c.createdAt,
                c.createdAt,
              );
            this.db
              .prepare(
                "INSERT OR IGNORE INTO design_comment_messages VALUES(?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                c.id,
                c.id,
                author,
                c.text,
                0,
                null,
                null,
                null,
                "migrated",
                c.createdAt,
              );
          }
        }
      }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }
  close() {
    this.db.close();
  }
  /**
   * The designs a chat can work on: its own first (the ones it has worked on
   * or was opened in), then the others in its project, newest first.
   */
  list(sessionId: string): DesignSummary[] {
    id.parse(sessionId);
    const project = cleanProject(this.projectOf(sessionId));
    const rows = this.db
      .prepare(
        "SELECT d.id, d.session_id, d.project, d.revision, (c.session_id IS NOT NULL) AS member FROM design_documents d LEFT JOIN design_chats c ON c.document_id=d.id AND c.session_id=? ORDER BY member DESC, d.updated_at DESC",
      )
      .all(sessionId) as (Head & { member: number })[];
    return rows
      .filter((row) => row.member || this.opened.get(sessionId)?.has(row.id) || (!!project && this.projectFor(row) === project))
      .map((row) => ({ ...this.summary(row), member: !!row.member }));
  }
  /** Every design, newest first: the Design section's library. */
  listAll(limit = 200): DesignSummary[] {
    return (
      this.db
        .prepare("SELECT id, session_id, project, revision FROM design_documents ORDER BY updated_at DESC LIMIT ?")
        .all(Math.max(1, Math.min(limit, 1000))) as Head[]
    ).map((row) => this.summary(row));
  }
  /** The chats working on a design, most recently active first. */
  chats(documentId: string): string[] {
    return (
      this.db
        .prepare("SELECT session_id FROM design_chats WHERE document_id=? ORDER BY active_at DESC, joined_at DESC")
        .all(id.parse(documentId)) as { session_id: string }[]
    ).map((row) => row.session_id);
  }
  /** A chat joins a design: its agent works on it, and it shows in the design's chats. */
  join(sessionId: string, documentId: string) {
    this.access(sessionId, documentId);
    const now = this.activeAt();
    const added =
      this.db
        .prepare("INSERT INTO design_chats VALUES(?,?,?,?) ON CONFLICT(document_id, session_id) DO UPDATE SET active_at=excluded.active_at")
        .run(documentId, sessionId, now, now).changes > 0;
    if (added) this.emit(sessionId, documentId, "chats");
  }
  /** The user opened this design in a chat's panel: that chat may use it this run. */
  allow(sessionId: string, documentId: string) {
    const ids = this.opened.get(sessionId) ?? new Set<string>();
    ids.add(documentId);
    this.opened.set(sessionId, ids);
  }
  read(sessionId: string, documentId: string, rev?: number): DesignDocument {
    const head = this.access(sessionId, documentId);
    return this.load(head, rev);
  }
  private load(head: Head, rev?: number): DesignDocument {
    const documentId = head.id;
    const row = this.db
      .prepare(
        "SELECT snapshot FROM design_revisions WHERE document_id=? AND revision=?",
      )
      .get(
        documentId,
        rev === undefined ? head.revision : revision.parse(rev),
      ) as { snapshot: string } | undefined;
    if (!row) throw new Error("Design version not found.");
    const d = JSON.parse(row.snapshot);
    d.boards = d.boards.map((board: { contentHash: string }) => {
      const { contentHash, ...rest } = board;
      const content = this.db
        .prepare("SELECT html FROM design_content WHERE hash=?")
        .get(contentHash) as { html: string } | undefined;
      if (!content) throw new Error("Design content missing.");
      return { ...rest, html: content.html };
    });
    d.comments = this.listComments(documentId);
    d.marks ??= [];
    d.sessionId = head.session_id;
    d.project = this.projectFor(head);
    d.chats = this.chats(documentId);
    return d;
  }
  private summary(head: Head): DesignSummary {
    const d = this.load(head);
    return {
      id: d.id,
      // The chat to open it with: the most recently active one.
      sessionId: d.chats?.[0] ?? head.session_id,
      title: d.title,
      revision: d.revision,
      updatedAt: d.updatedAt,
      boardCount: d.boards.length,
      project: d.project ?? null,
      chats: d.chats ?? [],
    };
  }
  private head(documentId: string) {
    return this.db
      .prepare("SELECT id, session_id, project, revision FROM design_documents WHERE id=?")
      .get(id.parse(documentId)) as Head | undefined;
  }
  /**
   * A chat can use a design it works on, one the user opened in it, or any
   * design in its project. Anything else stays invisible to it.
   */
  private access(sessionId: string, documentId: string): Head {
    id.parse(sessionId);
    const head = this.head(documentId);
    if (!head) throw new Error("Design not found.");
    if (
      head.session_id === sessionId ||
      this.opened.get(sessionId)?.has(head.id) ||
      this.db.prepare("SELECT 1 FROM design_chats WHERE document_id=? AND session_id=?").get(head.id, sessionId)
    )
      return head;
    const project = this.projectFor(head);
    if (project && cleanProject(this.projectOf(sessionId)) === project) return head;
    throw new Error("Design not found in this conversation's project.");
  }
  /** The design's project; older designs learn it from the chat that made them. */
  private projectFor(head: Head): string | null {
    if (head.project) return head.project;
    const project = cleanProject(this.projectOf(head.session_id));
    if (project) {
      this.db.prepare("UPDATE design_documents SET project=? WHERE id=?").run(project, head.id);
      head.project = project;
    }
    return project;
  }
  private owner(sessionId: string, documentId: string) {
    return this.access(sessionId, documentId).revision;
  }
  private listComments(documentId: string): DesignComment[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM design_comments WHERE document_id=? ORDER BY created_at, rowid",
      )
      .all(documentId) as CommentRow[];
    return rows.map((row) => this.toComment(row));
  }
  private toComment(row: CommentRow): DesignComment {
    const messages = (
      this.db
        .prepare(
          "SELECT * FROM design_comment_messages WHERE comment_id=? ORDER BY created_at, rowid",
        )
        .all(row.id) as MessageRow[]
    ).map(
      (m): DesignThreadMessage => ({
        id: m.id,
        author: JSON.parse(m.author),
        text: m.text,
        createdAt: m.created_at,
        toAgent: !!m.to_agent,
        ...(m.revision_from !== null && m.revision_to !== null
          ? { revision: { from: m.revision_from, to: m.revision_to } }
          : {}),
        ...(m.chat_created_at !== null
          ? { chatCreatedAt: m.chat_created_at }
          : {}),
      }),
    );
    return {
      id: row.id,
      boardId: row.board_id,
      contentRevision: row.content_revision,
      anchor: JSON.parse(row.anchor),
      author: JSON.parse(row.author),
      toAgent: !!row.to_agent,
      status: row.status,
      text: messages[0]?.text ?? "",
      resolved: row.status === "resolved",
      ...(row.base_revision !== null ? { baseRevision: row.base_revision } : {}),
      ...(row.working_since !== null
        ? { workingSince: row.working_since }
        : {}),
      messages,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  private commentRow(sessionId: string, documentId: string, commentId: string) {
    this.owner(sessionId, documentId);
    const row = this.db
      .prepare("SELECT * FROM design_comments WHERE id=? AND document_id=?")
      .get(id.parse(commentId), documentId) as CommentRow | undefined;
    if (!row) throw new Error("Comment not found.");
    return row;
  }
  /** Comment writes never mint a document version. */
  private commentTx<T>(
    sessionId: string,
    documentId: string,
    action: () => { result: T; changed: boolean },
  ): T {
    const { result, changed } = this.db.transaction(action)();
    if (changed) this.emit(sessionId, documentId, "comments");
    return result;
  }
  private emit(
    sessionId: string,
    documentId: string,
    scope: "document" | "comments" | "chats",
    created = false,
  ) {
    try {
      const row = this.db
        .prepare("SELECT title, revision FROM design_documents WHERE id=?")
        .get(documentId) as { title: string; revision: number } | undefined;
      if (!row) return;
      this.notify({
        sessionId,
        documentId,
        title: row.title,
        revision: row.revision,
        created,
        scope,
      });
    } catch (error) {
      // A closed renderer must not turn a committed write into a reported failure.
      console.warn("[design] Change notification failed", error);
    }
  }
  private mutate(
    sessionId: string,
    operationId: string,
    input: unknown,
    meta: DesignWriteMeta,
    action: () => DesignDocument,
    signal?: AbortSignal,
  ): DesignDocument {
    authorSchema.parse(meta.author);
    id.parse(sessionId);
    id.parse(operationId);
    const digest = hash(JSON.stringify(input));
    let committed = false;
    const d = this.db.transaction(() => {
      signal?.throwIfAborted();
      const prior = this.db
        .prepare(
          "SELECT * FROM design_receipts WHERE session_id=? AND operation_id=?",
        )
        .get(sessionId, operationId) as
        | { digest: string; document_id: string; revision: number }
        | undefined;
      if (prior) {
        if (prior.digest !== digest)
          throw new Error(
            "IDEMPOTENCY_KEY_REUSED: use a new operationId for a different change.",
          );
        return this.read(sessionId, prior.document_id, prior.revision);
      }
      const next = action();
      const head = this.db
        .prepare("SELECT revision FROM design_documents WHERE id=?")
        .get(next.id) as { revision: number } | undefined;
      const before = head ? this.read(sessionId, next.id) : undefined;
      if (meta.commentId) {
        const c = this.commentRow(sessionId, next.id, meta.commentId);
        if (c.base_revision === null)
          this.db
            .prepare("UPDATE design_comments SET base_revision=? WHERE id=?")
            .run(head?.revision ?? 0, c.id);
      }
      if (next.boards.length > 32)
        throw new Error("A design supports up to 32 boards.");
      if (
        next.boards.reduce((n, b) => n + Buffer.byteLength(b.html), 0) >
        12_000_000
      )
        throw new Error(
          "Design exceeds 12 MB. Split it into separate documents.",
        );
      signal?.throwIfAborted();
      next.revision++;
      next.updatedAt = Date.now();
      const { comments: _comments, ...content } = next;
      const stored = {
        ...content,
        boards: next.boards.map(({ html, ...b }) => {
          const contentHash = hash(html);
          this.db
            .prepare("INSERT OR IGNORE INTO design_content VALUES(?,?)")
            .run(contentHash, html);
          return { ...b, contentHash };
        }),
      };
      // The chat that made a design and its project stay; other chats only move it on.
      this.db
        .prepare(
          "INSERT INTO design_documents(id,session_id,title,revision,updated_at,project) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, revision=excluded.revision, updated_at=excluded.updated_at",
        )
        .run(next.id, sessionId, next.title, next.revision, next.updatedAt, cleanProject(this.projectOf(sessionId)));
      // Making a design, or an agent changing one, makes the chat one of its chats.
      if (!head || meta.author.kind === "agent")
        this.db
          .prepare("INSERT INTO design_chats VALUES(?,?,?,?) ON CONFLICT(document_id, session_id) DO UPDATE SET active_at=excluded.active_at")
          .run(next.id, sessionId, next.updatedAt, this.activeAt());
      const summary = meta.summary?.trim().slice(0, 160) || null;
      this.db
        .prepare(
          "INSERT INTO design_revisions(document_id,revision,snapshot,created_at,author,summary,comment_id,board_ids,hidden,prompt,request_id,canvas_changed,session_id) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?)",
        )
        .run(
          next.id,
          next.revision,
          JSON.stringify(stored),
          next.updatedAt,
          JSON.stringify(meta.author),
          summary,
          meta.commentId ?? null,
          JSON.stringify(before ? changedBoards(before.boards, next.boards) : []),
          meta.prompt?.trim().slice(0, 2000) || null,
          meta.requestId?.slice(0, 200) || null,
          canvasState(before) !== canvasState(next) ? 1 : 0,
          sessionId,
        );
      this.db
        .prepare("INSERT INTO design_receipts VALUES(?,?,?,?,?)")
        .run(sessionId, operationId, digest, next.id, next.revision);
      committed = true;
      return next;
    })();
    if (committed) this.emit(sessionId, d.id, "document", d.revision === 1);
    return d;
  }
  create(
    sessionId: string,
    title: string,
    brief: string,
    operationId: string,
    signal?: AbortSignal,
    author: DesignAuthor = DEFAULT_AGENT_AUTHOR,
    options: { exclusive?: boolean; request?: DesignRequest } = {},
  ) {
    return this.mutate(
      sessionId,
      operationId,
      { title, brief },
      { author, summary: `Created ${title.trim()}`, prompt: options.request?.prompt, requestId: options.request?.id },
      () => {
        // Checked after the receipt lookup, inside the transaction: a retried
        // create returns its document, and parallel creates can't both pass.
        if (options.exclusive) {
          const existing = this.db
            .prepare("SELECT d.id, d.title FROM design_documents d JOIN design_chats c ON c.document_id=d.id WHERE c.session_id=? ORDER BY d.updated_at DESC")
            .all(sessionId) as { id: string; title: string }[];
          if (existing.length)
            throw Object.assign(new Error("DESIGN_EXISTS"), { designs: existing });
        }
        return {
        id: `des_${randomUUID()}`,
        sessionId,
        title: name.parse(title),
        brief: z.string().max(20000).parse(brief),
        revision: 0,
        boards: [],
        marks: [],
        comments: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        };
      },
      signal,
    );
  }
  /** Whether this conversation can use a design, without reading its boards. */
  owns(sessionId: string, documentId: string): boolean {
    try {
      this.access(sessionId, documentId);
      return true;
    } catch {
      return false;
    }
  }
  update(
    sessionId: string,
    input: DesignUpdate,
    signal?: AbortSignal,
    author: DesignAuthor = DEFAULT_AGENT_AUTHOR,
    request?: string | DesignRequest,
  ) {
    const ops = operations.parse(input.operations);
    const asked = typeof request === "string" ? { prompt: request } : request;
    const meta: DesignWriteMeta = {
      author,
      summary: z.string().max(500).optional().parse(input.summary),
      commentId: id.optional().parse(input.commentId),
      prompt: asked?.prompt,
      requestId: asked?.id,
    };
    return this.mutate(
      sessionId,
      input.operationId,
      { documentId: input.documentId, operations: input.operations, summary: input.summary, commentId: input.commentId },
      meta,
      () => {
        const d = this.read(sessionId, input.documentId);
        if (!meta.summary?.trim()) meta.summary = summarizeOperations(ops, d);
        for (const op of ops) {
          if (op.type === "canvas") {
            if (d.revision !== op.expectedRevision) conflict();
            if (op.pages !== undefined) d.pages = op.pages;
            if (op.marks !== undefined) d.marks = op.marks;
            continue;
          }
          if (op.type === "title") {
            if (d.revision !== op.expectedRevision) conflict();
            d.title = op.title;
            continue;
          }
          if (op.type === "add") {
            const firstPage = d.pages?.[0]?.id ?? "page-1";
            const pageOf = (pageId?: string) => d.pages?.some((page) => page.id === pageId) ? pageId : firstPage;
            const siblings = d.boards.filter((board) => pageOf(board.pageId) === pageOf(op.pageId));
            d.boards.push({
              id: `brd_${randomUUID()}`,
              name: op.name ?? nextBoardName(d.boards),
              ...(op.pageId !== undefined ? { pageId: op.pageId } : {}),
              // Each page has its own world: place after that page's boards.
              x: op.x ?? (siblings.length ? Math.max(...siblings.map((b) => b.x + b.width)) + 80 : 0),
              y: op.y ?? (siblings.length ? Math.min(...siblings.map(b => b.y)) : 0),
              width: op.width ?? 880,
              height: op.height ?? 640,
              contentRevision: 1,
              placementRevision: 1,
              html: sanitizeDesignHtml(
                op.html ??
                  '<main style="padding:48px;color:#999;font:16px system-ui">Waiting for design…</main>',
              ),
            });
            continue;
          }
          const b = d.boards.find((b) => b.id === op.boardId);
          if (!b) throw new Error("Board not found.");
          if (
            (op.type === "placement"
              ? b.placementRevision
              : b.contentRevision) !== op.expectedRevision
          )
            conflict();
          if (op.type === "content") {
            b.html = sanitizeDesignHtml(op.html);
            b.contentRevision++;
          }
          if (op.type === "patch") {
            const at = b.html.indexOf(op.find);
            if (at < 0) throw new Error("PATCH_NOT_FOUND: read the board and use its exact current HTML.");
            if (b.html.indexOf(op.find, at + 1) >= 0)
              throw new Error("PATCH_AMBIGUOUS: include more surrounding HTML for a unique match.");
            b.html = sanitizeDesignHtml(b.html.slice(0, at) + op.replace + b.html.slice(at + op.find.length));
            b.contentRevision++;
          }
          if (op.type === "placement") {
            const { type, boardId, expectedRevision, ...patch } = op;
            if (patch.name === undefined) delete patch.name;
            Object.assign(b, patch);
            b.placementRevision++;
          }
          if (op.type === "remove")
            d.boards = d.boards.filter((board) => board.id !== b.id);
          if (op.type === "duplicate")
            d.boards.push({
              ...b,
              id: `brd_${randomUUID()}`,
              name: copyBoardName(b.name, d.boards),
              x: b.x + b.width + 80,
              contentRevision: 1,
              placementRevision: 1,
            });
        }
        return d;
      },
      signal,
    );
  }
  /**
   * The message behind each board's latest agent version, for the canvas's
   * prompt cards: boardId → prompt, the version and who made it.
   */
  boardPrompts(sessionId: string, documentId: string): Record<string, { prompt: string; revision: number; author: DesignAuthor | null }> {
    this.owner(sessionId, documentId);
    const rows = this.db
      .prepare(
        "SELECT revision, prompt, author, board_ids FROM design_revisions WHERE document_id=? AND prompt IS NOT NULL AND hidden=0 ORDER BY revision DESC LIMIT 200",
      )
      .all(documentId) as { revision: number; prompt: string; author: string | null; board_ids: string | null }[];
    const out: Record<string, { prompt: string; revision: number; author: DesignAuthor | null }> = {};
    for (const row of rows) {
      for (const boardId of row.board_ids ? (JSON.parse(row.board_ids) as string[]) : []) {
        out[boardId] ??= { prompt: row.prompt, revision: row.revision, author: row.author ? JSON.parse(row.author) : null };
      }
    }
    return out;
  }
  history(sessionId: string, documentId: string): DesignRevisionInfo[] {
    this.owner(sessionId, documentId);
    return (
      this.db
        .prepare(
          "SELECT revision, created_at, author, summary, comment_id, board_ids, prompt, request_id, canvas_changed, session_id FROM design_revisions WHERE document_id=? AND hidden=0 ORDER BY revision DESC LIMIT 300",
        )
        .all(documentId) as {
        revision: number;
        created_at: number;
        author: string | null;
        summary: string | null;
        comment_id: string | null;
        board_ids: string | null;
        prompt: string | null;
        request_id: string | null;
        canvas_changed: number;
        session_id: string | null;
      }[]
    ).map((r) => ({
      revision: r.revision,
      createdAt: r.created_at,
      author: r.author ? JSON.parse(r.author) : null,
      summary: r.summary,
      commentId: r.comment_id,
      boardIds: r.board_ids ? JSON.parse(r.board_ids) : [],
      prompt: r.prompt,
      requestId: r.request_id,
      canvasChanged: r.canvas_changed === 1,
      sessionId: r.session_id,
    }));
  }
  restore(
    sessionId: string,
    documentId: string,
    rev: number,
    expectedRevision: number,
    operationId: string,
    boardId?: string | string[],
    author: DesignAuthor = { kind: "user" },
    options: { summary?: string; title?: boolean; canvas?: boolean } = {},
  ) {
    const meta: DesignWriteMeta = { author };
    const boardIds = boardId === undefined ? undefined : z.array(id).max(32).parse([boardId].flat());
    return this.mutate(
      sessionId,
      operationId,
      { documentId, rev, expectedRevision, boardIds, title: options.title, canvas: options.canvas, summary: options.summary },
      meta,
      () => {
        const current = this.read(sessionId, documentId);
        if (current.revision !== expectedRevision) conflict();
        const previous = this.read(sessionId, documentId, rev);
        if ((!boardIds && (options.title || options.canvas)) || boardIds?.length === 0) {
          if (options.title) current.title = previous.title;
          if (options.canvas) {
            current.pages = previous.pages;
            current.marks = previous.marks ?? [];
          }
          meta.summary = options.summary ?? `Restored ${options.canvas ? "canvas" : options.title ? "title" : "selection"} from v${rev}`;
          return current;
        }
        // Never reuse old content versions: previously issued write tokens must fail.
        const snapshots = this.db
          .prepare("SELECT snapshot FROM design_revisions WHERE document_id=?")
          .all(documentId) as { snapshot: string }[];
        let nextVersion = current.revision + 1;
        for (const row of snapshots)
          for (const b of JSON.parse(row.snapshot).boards) {
            nextVersion = Math.max(
              nextVersion,
              b.contentRevision + 1,
              b.placementRevision + 1,
            );
          }
        if (boardIds) {
          // Board-scoped restore (also undo): each board returns to its state
          // in `rev` — re-added if it was deleted since, removed if it did not exist yet.
          const names: string[] = [];
          for (const target of boardIds) {
            const old = previous.boards.find((b) => b.id === target);
            const index = current.boards.findIndex((b) => b.id === target);
            if (!old) {
              if (index < 0) throw new Error("That board does not exist in this version.");
              names.push(current.boards[index].name);
              current.boards.splice(index, 1);
              continue;
            }
            old.contentRevision = nextVersion;
            old.placementRevision = nextVersion;
            if (index < 0) {
              const oldIndex = previous.boards.findIndex((b) => b.id === target);
              const next = previous.boards.slice(oldIndex + 1).find((b) => current.boards.some((live) => live.id === b.id));
              const at = next ? current.boards.findIndex((b) => b.id === next.id) : current.boards.length;
              current.boards.splice(at, 0, old);
            }
            else current.boards[index] = old;
            names.push(old.name);
          }
          if (options.title) current.title = previous.title;
          if (options.canvas) {
            current.pages = previous.pages;
            current.marks = previous.marks ?? [];
          }
          meta.summary =
            options.summary ??
            (boardIds.length === 1 ? `Restored ${names[0]} from v${rev}` : `Restored ${names.length} boards from v${rev}`);
          return current;
        }
        previous.revision = current.revision;
        for (const b of previous.boards) {
          b.contentRevision = nextVersion;
          b.placementRevision = nextVersion;
        }
        meta.summary = options.summary ?? `Restored v${rev}`;
        return previous;
      },
    );
  }
  comment(
    sessionId: string,
    input: {
      documentId: string;
      boardId: string;
      contentRevision: number;
      text: string;
      anchor: DesignAnchor;
      id: string;
      toAgent?: boolean;
      author: DesignAuthor;
    },
  ): DesignComment {
    const anchor = anchorSchema.parse(input.anchor);
    const text = commentText.parse(input.text);
    const author = authorSchema.parse(input.author) as DesignAuthor;
    const toAgent = !!input.toAgent;
    const commentId = id.parse(input.id);
    const digest = hash(
      JSON.stringify([input.documentId, input.boardId, input.contentRevision, text, anchor, toAgent]),
    );
    return this.commentTx(sessionId, input.documentId, () => {
      const prior = this.db
        .prepare("SELECT * FROM design_comments WHERE id=?")
        .get(commentId) as CommentRow | undefined;
      if (prior) {
        if (
          prior.digest !== digest ||
          prior.document_id !== input.documentId ||
          prior.session_id !== sessionId
        )
          throw new Error(
            "IDEMPOTENCY_KEY_REUSED: use a new id for a different comment.",
          );
        return { result: this.toComment(prior), changed: false };
      }
      const d = this.read(sessionId, input.documentId);
      const b = d.boards.find((b) => b.id === input.boardId);
      if (!b || b.contentRevision !== input.contentRevision) conflict();
      if (d.comments.length >= 500)
        throw new Error("This document already has 500 comments.");
      const now = Date.now();
      this.db
        .prepare(
          "INSERT INTO design_comments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          commentId,
          input.documentId,
          sessionId,
          input.boardId,
          input.contentRevision,
          JSON.stringify(anchor),
          JSON.stringify(author),
          toAgent ? 1 : 0,
          "open",
          null,
          null,
          digest,
          now,
          now,
        );
      this.insertMessage(commentId, commentId, author, text, toAgent, now, digest);
      return {
        result: this.toComment(
          this.commentRow(sessionId, input.documentId, commentId),
        ),
        changed: true,
      };
    });
  }
  private insertMessage(
    commentId: string,
    messageId: string,
    author: DesignAuthor,
    text: string,
    toAgent: boolean,
    createdAt: number,
    digest: string,
    revision?: { from: number; to: number },
  ) {
    this.db
      .prepare(
        "INSERT INTO design_comment_messages VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        commentId,
        messageId,
        JSON.stringify(author),
        text,
        toAgent ? 1 : 0,
        revision?.from ?? null,
        revision?.to ?? null,
        null,
        digest,
        createdAt,
      );
  }
  /**
   * Adds a thread message. An agent reply links the versions produced since
   * the request started; a user reply reopens a resolved thread.
   */
  reply(
    sessionId: string,
    input: {
      documentId: string;
      commentId: string;
      id: string;
      text: string;
      toAgent?: boolean;
      author: DesignAuthor;
    },
  ): DesignComment {
    const text = commentText.parse(input.text);
    const author = authorSchema.parse(input.author) as DesignAuthor;
    const messageId = id.parse(input.id);
    const toAgent = author.kind === "user" && !!input.toAgent;
    const digest = hash(JSON.stringify([text, author.kind, toAgent]));
    return this.commentTx(sessionId, input.documentId, () => {
      const row = this.commentRow(sessionId, input.documentId, input.commentId);
      const prior = this.db
        .prepare(
          "SELECT digest FROM design_comment_messages WHERE comment_id=? AND id=?",
        )
        .get(row.id, messageId) as { digest: string } | undefined;
      if (prior) {
        if (prior.digest !== digest)
          throw new Error(
            "IDEMPOTENCY_KEY_REUSED: use a new id for a different reply.",
          );
        return { result: this.toComment(row), changed: false };
      }
      const count = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM design_comment_messages WHERE comment_id=?",
          )
          .get(row.id) as { n: number }
      ).n;
      if (count >= 200) throw new Error("This thread already has 200 messages.");
      const now = Date.now();
      const head = this.owner(sessionId, input.documentId);
      const revision =
        author.kind === "agent" &&
        row.base_revision !== null &&
        head > row.base_revision
          ? { from: row.base_revision, to: head }
          : undefined;
      this.insertMessage(row.id, messageId, author, text, toAgent, now, digest, revision);
      const status: DesignCommentStatus =
        author.kind === "agent" ? "open" : row.status === "resolved" ? "open" : row.status;
      this.db
        .prepare(
          "UPDATE design_comments SET status=?, updated_at=?, to_agent=MAX(to_agent,?), base_revision=CASE WHEN ? THEN NULL ELSE base_revision END, working_since=CASE WHEN ? THEN NULL ELSE working_since END WHERE id=?",
        )
        .run(
          status,
          now,
          toAgent ? 1 : 0,
          author.kind === "agent" ? 1 : 0,
          author.kind === "agent" ? 1 : 0,
          row.id,
        );
      return {
        result: this.toComment(this.commentRow(sessionId, input.documentId, row.id)),
        changed: true,
      };
    });
  }
  comments(sessionId: string, documentId: string) {
    this.owner(sessionId, documentId);
    return this.listComments(documentId);
  }
  resolve(
    sessionId: string,
    documentId: string,
    commentId: string,
    resolved: boolean,
  ): DesignComment {
    const status: DesignCommentStatus = z.boolean().parse(resolved)
      ? "resolved"
      : "open";
    return this.commentTx(sessionId, documentId, () => {
      const row = this.commentRow(sessionId, documentId, commentId);
      if (row.status === status)
        return { result: this.toComment(row), changed: false };
      this.db
        .prepare(
          "UPDATE design_comments SET status=?, working_since=NULL, base_revision=NULL, updated_at=? WHERE id=?",
        )
        .run(status, Date.now(), row.id);
      return {
        result: this.toComment(this.commentRow(sessionId, documentId, row.id)),
        changed: true,
      };
    });
  }
  /** A thread message was sent to the agent: the comment is in progress from the current head. */
  markWorking(
    sessionId: string,
    documentId: string,
    commentId: string,
    messageId: string,
    chatCreatedAt: number,
  ) {
    return this.commentTx(sessionId, documentId, () => {
      const row = this.commentRow(sessionId, documentId, commentId);
      const head = this.owner(sessionId, documentId);
      const now = Date.now();
      this.db
        .prepare(
          "UPDATE design_comments SET status='working', working_since=?, base_revision=?, to_agent=1, updated_at=? WHERE id=?",
        )
        .run(now, head, now, row.id);
      this.db
        .prepare(
          "UPDATE design_comment_messages SET chat_created_at=?, to_agent=1 WHERE comment_id=? AND id=?",
        )
        .run(chatCreatedAt, row.id, id.parse(messageId));
      return { result: undefined, changed: true };
    });
  }
  /**
   * The turn ended (complete, error or stop). Threads still marked working get
   * the agent's changes linked even without an explicit reply, then reopen.
   */
  settleWorking(sessionId: string, author: DesignAuthor = DEFAULT_AGENT_AUTHOR) {
    const rows = this.db
      .prepare(
        "SELECT * FROM design_comments WHERE session_id=? AND status='working'",
      )
      .all(id.parse(sessionId)) as CommentRow[];
    const touched = new Set<string>();
    this.db.transaction(() => {
      for (const row of rows) {
        const head = this.owner(sessionId, row.document_id);
        const latest = this.db
          .prepare(
            "SELECT revision, summary FROM design_revisions WHERE document_id=? AND comment_id=? AND revision>? ORDER BY revision DESC LIMIT 1",
          )
          .get(row.document_id, row.id, row.base_revision ?? head) as
          | { revision: number; summary: string | null }
          | undefined;
        const now = Date.now();
        if (latest && row.base_revision !== null)
          this.insertMessage(
            row.id,
            `settle:${row.working_since ?? now}`,
            author,
            latest.summary || `Updated to v${head}`,
            false,
            now,
            "settled",
            { from: row.base_revision, to: head },
          );
        this.db
          .prepare(
            "UPDATE design_comments SET status='open', working_since=NULL, base_revision=NULL, updated_at=? WHERE id=?",
          )
          .run(now, row.id);
        touched.add(row.document_id);
      }
    })();
    for (const documentId of touched) this.emit(sessionId, documentId, "comments");
    return [...touched];
  }
  /** No turn survives a restart. */
  resetWorking() {
    this.db
      .prepare(
        "UPDATE design_comments SET status='open', working_since=NULL, base_revision=NULL WHERE status='working'",
      )
      .run();
  }
  /**
   * A deleted conversation leaves its designs: they belong to their project
   * and their other chats. Only its place among their chats goes.
   */
  deleteSession(sessionId: string): string[] {
    const ids = (
      this.db.prepare("SELECT document_id FROM design_chats WHERE session_id=?").all(sessionId) as { document_id: string }[]
    ).map((r) => r.document_id);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM design_chats WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM design_receipts WHERE session_id=?").run(sessionId);
    })();
    this.opened.delete(sessionId);
    for (const documentId of ids) this.emit(sessionId, documentId, "chats");
    return ids;
  }
  /**
   * Deleting a design: its versions, comments and chat links, and board HTML
   * no remaining version points at. The chats themselves stay.
   */
  deleteDocument(documentId: string) {
    const head = this.head(documentId);
    if (!head) return false;
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM design_comment_messages WHERE comment_id IN (SELECT id FROM design_comments WHERE document_id=?)")
        .run(documentId);
      this.db.prepare("DELETE FROM design_comments WHERE document_id=?").run(documentId);
      this.db.prepare("DELETE FROM design_revisions WHERE document_id=?").run(documentId);
      this.db.prepare("DELETE FROM design_receipts WHERE document_id=?").run(documentId);
      this.db.prepare("DELETE FROM design_chats WHERE document_id=?").run(documentId);
      this.db.prepare("DELETE FROM design_documents WHERE id=?").run(documentId);
      this.db
        .prepare(
          "DELETE FROM design_content WHERE hash NOT IN (SELECT json_extract(b.value,'$.contentHash') FROM design_revisions r, json_each(r.snapshot,'$.boards') b)",
        )
        .run();
    })();
    for (const ids of this.opened.values()) ids.delete(documentId);
    try {
      this.notify({ sessionId: head.session_id, documentId, title: "", revision: head.revision, created: false, scope: "document", deleted: true });
    } catch (error) {
      console.warn("[design] Change notification failed", error);
    }
    return true;
  }
  /** A draft chat became a real session: its designs move to the new id. */
  moveSession(from: string, to: string): number {
    if (from === to) return 0;
    return this.db.transaction(() => {
      const moved = this.db
        .prepare("UPDATE design_documents SET session_id=? WHERE session_id=?")
        .run(to, from).changes;
      this.db.prepare("UPDATE OR IGNORE design_chats SET session_id=? WHERE session_id=?").run(to, from);
      this.db.prepare("DELETE FROM design_chats WHERE session_id=?").run(from);
      const opened = this.opened.get(from);
      if (opened) {
        this.opened.set(to, new Set([...(this.opened.get(to) ?? []), ...opened]));
        this.opened.delete(from);
      }
      this.db.prepare("UPDATE design_comments SET session_id=? WHERE session_id=?").run(to, from);
      this.db.prepare("UPDATE design_receipts SET session_id=? WHERE session_id=?").run(to, from);
      return moved;
    })();
  }
}
