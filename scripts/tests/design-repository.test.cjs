const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { app } = require("electron");
const root = mkdtempSync(join(tmpdir(), "aegis-design-repository-"));
app.setPath("userData", join(root, "profile"));
const {
  DesignRepository,
} = require("../../dist-electron/electron/design/repository.js");
const {
  sanitizeDesignHtml,
  designFrameHtml,
} = require("../../dist-electron/electron/design/html.js");
const file = join(root, "design.db");
const events = [];
let repo;
try {
  repo = new DesignRepository(file, (e) => events.push(e));
  let d = repo.create("session-a", "Homepage", "brief", "create");
  assert.equal(
    repo.create("session-a", "Homepage", "brief", "create").id,
    d.id,
  );
  assert.equal(events.length, 1);
  assert.throws(
    () => repo.create("session-a", "Other", "", "create"),
    /IDEMPOTENCY/,
  );
  assert.throws(() => repo.read("session-b", d.id), /not found/);
  const add = {
    documentId: d.id,
    operationId: "add",
    operations: [
      {
        type: "add",
        name: "Home",
        html: '<h1 data-aegis-node-id="hero">Hello</h1>',
      },
      { type: "add", name: "Pricing", html: "<h1>Pricing</h1>" },
    ],
  };
  d = repo.update("session-a", add);
  assert.equal(d.boards.length, 2);
  assert.equal(repo.update("session-a", add).revision, d.revision);
  const board = d.boards[0];
  const moved = repo.update("session-a", {
    documentId: d.id,
    operationId: "move",
    operations: [
      {
        type: "placement",
        boardId: board.id,
        expectedRevision: 1,
        x: 42,
        y: 76,
      },
    ],
  });
  assert.equal(moved.boards[0].contentRevision, 1);
  d = repo.update("session-a", {
    documentId: d.id,
    operationId: "edit",
    operations: [
      {
        type: "content",
        boardId: board.id,
        expectedRevision: 1,
        html: "<h1>Updated</h1>",
      },
    ],
  });
  assert.equal(d.boards[0].x, 42);
  assert.throws(
    () =>
      repo.update("session-a", {
        documentId: d.id,
        operationId: "stale",
        operations: [
          {
            type: "content",
            boardId: board.id,
            expectedRevision: 1,
            html: "stale",
          },
        ],
      }),
    /REVISION_CONFLICT/,
  );
  assert.throws(
    () =>
      repo.update("session-a", {
        documentId: d.id,
        operationId: "atomic",
        operations: [
          { type: "add", name: "Rollback" },
          {
            type: "content",
            boardId: board.id,
            expectedRevision: 1,
            html: "stale",
          },
        ],
      }),
    /REVISION_CONFLICT/,
  );
  assert.equal(repo.read("session-a", d.id).boards.length, 2);
  const abort = new AbortController();
  abort.abort();
  assert.throws(
    () =>
      repo.update(
        "session-a",
        {
          documentId: d.id,
          operationId: "stop",
          operations: [{ type: "add", name: "Cancelled" }],
        },
        abort.signal,
      ),
    /abort/i,
  );
  assert.equal(repo.read("session-a", d.id).revision, d.revision);
  const user = { kind: "user", name: "Chengsheng" };
  const note = (over) => ({
    documentId: d.id,
    boardId: board.id,
    contentRevision: 2,
    text: "Make this smaller",
    anchor: { nodeId: "hero", computedStyles: { "font-size": "48px" } },
    id: "comment-one",
    toAgent: true,
    author: user,
    ...over,
  });
  assert.throws(
    () => repo.comment("session-a", note({ contentRevision: 1, id: "old-note" })),
    /REVISION_CONFLICT/,
  );
  const before = d.revision;
  let c = repo.comment("session-a", note());
  assert.equal(c.status, "open");
  assert.equal(c.messages.length, 1);
  assert.equal(c.author.name, "Chengsheng");
  assert.equal(c.anchor.computedStyles["font-size"], "48px");
  assert.equal(repo.comment("session-a", note()).id, c.id, "comment create is idempotent");
  assert.throws(() => repo.comment("session-a", note({ text: "Other" })), /IDEMPOTENCY/);
  assert.throws(() => repo.comment("session-b", note()), /IDEMPOTENCY|not found/);
  d = repo.read("session-a", d.id);
  assert.equal(d.revision, before, "comments never mint a document version");
  assert.equal(d.comments.length, 1);
  // Bubble picks the comment up, edits with commentId, then replies.
  repo.markWorking("session-a", d.id, c.id, c.id, 1234);
  assert.equal(repo.comments("session-a", d.id)[0].status, "working");
  d = repo.update("session-a", {
    documentId: d.id,
    operationId: "agent-edit",
    summary: "Tightened hero headline on Home",
    commentId: c.id,
    operations: [
      { type: "content", boardId: board.id, expectedRevision: 2, html: "<h1>Hello smaller</h1>" },
    ],
  });
  c = repo.reply("session-a", {
    documentId: d.id,
    commentId: c.id,
    id: "reply:call-1",
    text: "Done.",
    author: { kind: "agent", name: "Bubble" },
  });
  assert.equal(c.status, "open");
  assert.deepEqual(c.messages[1].revision, { from: before, to: d.revision });
  assert.equal(c.messages[0].chatCreatedAt, 1234);
  assert.equal(
    repo.reply("session-a", { documentId: d.id, commentId: c.id, id: "reply:call-1", text: "Done.", author: { kind: "agent", name: "Bubble" } }).messages.length,
    2,
    "agent reply is idempotent by tool call",
  );
  let history = repo.history("session-a", d.id);
  assert.equal(history[0].summary, "Tightened hero headline on Home");
  assert.equal(history[0].author.kind, "agent");
  assert.equal(history[0].commentId, c.id);
  assert.deepEqual(history[0].boardIds, [board.id]);
  assert.equal(history.find((h) => h.revision === 3).summary, "Moved Home");
  // A turn that edits with commentId but never replies still links its versions.
  repo.markWorking("session-a", d.id, c.id, c.id, 1235);
  d = repo.update("session-a", {
    documentId: d.id,
    operationId: "agent-edit-2",
    commentId: c.id,
    operations: [
      { type: "content", boardId: board.id, expectedRevision: d.boards[0].contentRevision, html: "<h1>Hello</h1>" },
    ],
  });
  repo.settleWorking("session-a");
  c = repo.comments("session-a", d.id)[0];
  assert.equal(c.status, "open");
  assert.equal(c.messages.at(-1).author.kind, "agent");
  assert.equal(c.messages.at(-1).text, "Edited Home");
  // Settling with no changes simply reopens.
  repo.markWorking("session-a", d.id, c.id, c.id, 1236);
  repo.settleWorking("session-a");
  assert.equal(repo.comments("session-a", d.id)[0].messages.length, 3);
  c = repo.resolve("session-a", d.id, c.id, true);
  assert.equal(c.status, "resolved");
  c = repo.reply("session-a", { documentId: d.id, commentId: c.id, id: "user-2", text: "One more", toAgent: true, author: user });
  assert.equal(c.status, "open", "a user reply reopens a resolved thread");
  d = repo.restore("session-a", d.id, 2, d.revision, "restore");
  assert(d.boards[0].html.includes("Hello"));
  assert(d.boards[0].contentRevision > 2);
  assert.equal(d.comments.length, 1, "restore keeps threads");
  assert.equal(repo.history("session-a", d.id)[0].summary, "Restored v2");
  // Board-only restore leaves other boards untouched.
  const pricing = d.boards[1];
  d = repo.update("session-a", {
    documentId: d.id,
    operationId: "edit-both",
    operations: [
      { type: "content", boardId: d.boards[0].id, expectedRevision: d.boards[0].contentRevision, html: "<h1>Home v2</h1>" },
      { type: "content", boardId: pricing.id, expectedRevision: pricing.contentRevision, html: "<h1>Pricing v2</h1>" },
    ],
  });
  const both = d.revision;
  d = repo.restore("session-a", d.id, 2, d.revision, "restore-home", board.id);
  assert(d.boards.find((b) => b.id === board.id).html.includes("Hello"));
  assert(d.boards.find((b) => b.id === pricing.id).html.includes("Pricing v2"));
  assert.equal(repo.history("session-a", d.id)[0].summary, "Restored Home from v2");
  assert.throws(
    () =>
      repo.update("session-a", {
        documentId: d.id,
        operationId: "stale-home",
        operations: [{ type: "content", boardId: board.id, expectedRevision: repo.read("session-a", d.id, both).boards[0].contentRevision, html: "x" }],
      }),
    /REVISION_CONFLICT/,
  );
  // Multiple writes in one transaction, followed by deletion and restoration,
  // must never revive a previously issued content version.
  const start = d.boards[0].contentRevision;
  d = repo.update("session-a", {
    documentId: d.id,
    operationId: "many-edits",
    operations: Array.from({ length: 20 }, (_, i) => ({
      type: "content",
      boardId: board.id,
      expectedRevision: start + i,
      html: "<h1>" + i + "</h1>",
    })),
  });
  const oldToken = d.boards[0].contentRevision;
  d = repo.update("session-a", {
    documentId: d.id,
    operationId: "remove",
    operations: [
      { type: "remove", boardId: board.id, expectedRevision: oldToken },
    ],
  });
  d = repo.restore("session-a", d.id, 2, d.revision, "restore-deleted");
  assert(d.boards[0].contentRevision > oldToken);
  assert.throws(
    () =>
      repo.update("session-a", {
        documentId: d.id,
        operationId: "old-token",
        operations: [
          {
            type: "content",
            boardId: board.id,
            expectedRevision: oldToken,
            html: "Stale",
          },
        ],
      }),
    /REVISION_CONFLICT/,
  );
  const count = d.revision;
  repo.close();
  repo = new DesignRepository(file);
  assert.equal(repo.read("session-a", d.id).revision, count);
  assert.equal(repo.list("session-a").length, 1);
  assert.equal(repo.list("session-b").length, 0);
  // Undo: restore several boards at once; one added later is removed again.
  {
    let u = repo.create("session-u", "Undo", "", "u-create");
    u = repo.update("session-u", { documentId: u.id, operationId: "u-add", operations: [{ type: "add", name: "A", html: "<p>a</p>" }] });
    const a = u.boards[0];
    const baseline = u.revision;
    u = repo.update("session-u", {
      documentId: u.id,
      operationId: "u-edit",
      operations: [
        { type: "placement", boardId: a.id, expectedRevision: a.placementRevision, x: 500 },
        { type: "add", name: "B" },
      ],
    });
    const b = u.boards.find((x) => x.name === "B");
    u = repo.restore("session-u", u.id, baseline, u.revision, "u-undo", [a.id, b.id], { kind: "user" }, { summary: "Undo · Moved A" });
    assert.equal(u.boards.length, 1, "board added after the baseline is removed");
    assert.equal(u.boards[0].x, a.x, "moved board returns");
    assert.equal(repo.history("session-u", u.id)[0].summary, "Undo · Moved A");
  }
  // Exclusive creates: refused while the conversation has a design, yet a retried create returns its document.
  {
    const first = repo.create("session-x", "First", "", "x-create", undefined, undefined, { exclusive: true });
    assert.equal(repo.create("session-x", "First", "", "x-create", undefined, undefined, { exclusive: true }).id, first.id, "retry returns the created design");
    assert.throws(() => repo.create("session-x", "Second", "", "x-second", undefined, undefined, { exclusive: true }), (e) => e.designs?.[0]?.id === first.id);
    assert.equal(repo.list("session-x").length, 1, "nothing written by a refused create");
    assert.equal(repo.create("session-x", "Second", "", "x-second").title, "Second", "a separate design when not exclusive");
    assert.equal(repo.owns("session-x", first.id), true);
    assert.equal(repo.owns("session-a", first.id), false);
    // New boards land right of every board, including ones placed by hand.
    let x = repo.update("session-x", { documentId: first.id, operationId: "x-add", operations: [{ type: "add", name: "A", x: 2000, y: 0, width: 390, height: 844 }] });
    x = repo.update("session-x", { documentId: first.id, operationId: "x-add-2", operations: [{ type: "add", name: "B" }] });
    assert.equal(x.boards.find((b) => b.name === "B").x, 2000 + 390 + 80);
  }
  // v0 databases: comments move out of snapshots and comment-only versions hide.
  const legacyFile = join(root, "legacy.db");
  {
    const Database = require("better-sqlite3");
    const db = new Database(legacyFile);
    db.exec(`CREATE TABLE design_documents(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE design_content(hash TEXT PRIMARY KEY, html TEXT NOT NULL);
      CREATE TABLE design_revisions(document_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(document_id,revision));
      CREATE TABLE design_receipts(session_id TEXT NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL, document_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(session_id,operation_id));`);
    db.prepare("INSERT INTO design_content VALUES(?,?)").run("h1", "<h1>Old</h1>");
    const boardRow = { id: "brd_1", name: "Home", x: 0, y: 0, width: 800, height: 600, contentRevision: 1, placementRevision: 1, contentHash: "h1" };
    const snap = (revision, comments) =>
      JSON.stringify({ id: "des_old", sessionId: "s", title: "Old", brief: "", revision, boards: [boardRow], comments, createdAt: 1, updatedAt: 1 });
    db.prepare("INSERT INTO design_documents VALUES(?,?,?,?,?)").run("des_old", "s", "Old", 2, 1);
    db.prepare("INSERT INTO design_revisions VALUES(?,?,?,?)").run("des_old", 1, snap(1, []), 1);
    db.prepare("INSERT INTO design_revisions VALUES(?,?,?,?)").run("des_old", 2, snap(2, [{ id: "old-c", boardId: "brd_1", contentRevision: 1, anchor: {}, text: "Legacy", resolved: false, createdAt: 5 }]), 2);
    db.close();
  }
  for (let open = 0; open < 2; open++) {
    const legacy = new DesignRepository(legacyFile);
    const old = legacy.read("s", "des_old");
    assert.equal(old.comments.length, 1);
    assert.equal(old.comments[0].messages[0].text, "Legacy");
    assert.deepEqual(legacy.history("s", "des_old").map((h) => h.revision), [1], "comment-only version is hidden");
    legacy.close();
  }
  const unsafe =
    '<base href="file:///"><script>alert(1)</script><iframe srcdoc="evil"></iframe><img src="https://example.com" onerror="evil()"><a href="javascript:evil()">link</a><meta http-equiv="refresh" content="0;url=https://example.com"><svg><foreignObject><script>evil()</script></foreignObject><path d="M0 0"/></svg><p style="color:red" data-aegis-node-id="safe">Safe</p>';
  const clean = sanitizeDesignHtml(unsafe);
  for (const bad of [
    "<script",
    "<iframe",
    "<base",
    "<meta",
    "onerror",
    "javascript:",
    "foreignObject",
    "https://example.com",
  ])
    assert(!clean.includes(bad), bad);
  assert(clean.includes("color:red"));
  assert(clean.includes("data-aegis-node-id"));
  assert(designFrameHtml(clean, "test-nonce").includes("default-src 'none'"));

  // Prompt cards: an agent version keeps the message that asked for it, per board.
  {
    const pr = new DesignRepository(join(root, "prompts.db"));
    const d1 = pr.create("p", "Atlas", "", "pc");
    const added = pr.update("p", { documentId: d1.id, operationId: "p1", operations: [{ type: "add", name: "Home", html: "<p>a</p>" }, { type: "add", name: "Pricing", html: "<p>b</p>" }] }, undefined, undefined, "Design a calm landing page");
    const [home, pricing] = added.boards;
    pr.update("p", { documentId: d1.id, operationId: "p2", operations: [{ type: "content", boardId: pricing.id, expectedRevision: pricing.contentRevision, html: "<p>c</p>" }] }, undefined, undefined, { prompt: "Make pricing calmer", id: "m-2" });
    // History knows which request each save answered.
    assert.deepEqual(pr.history("p", d1.id).slice(0, 2).map((h) => [h.prompt, h.requestId]), [["Make pricing calmer", "m-2"], ["Design a calm landing page", null]]);
    pr.update("p", { documentId: d1.id, operationId: "p3", operations: [{ type: "placement", boardId: home.id, expectedRevision: home.placementRevision, x: 40 }] }, undefined, { kind: "user", name: "Me" });
    const cards = pr.boardPrompts("p", d1.id);
    assert.equal(cards[home.id].prompt, "Design a calm landing page", "a hand edit keeps the board's prompt");
    assert.equal(cards[pricing.id].prompt, "Make pricing calmer", "the latest asking version wins");
    assert.throws(() => pr.boardPrompts("other", d1.id), /not found/i);
    pr.close();
    const raw = new (require("better-sqlite3"))(join(root, "prompts.db"));
    assert.equal(raw.pragma("user_version", { simple: true }), 4);
    raw.close();
  }

  // Pages and canvas objects are atomic metadata, restored independently of agent board edits.
  {
    const canvasFile = join(root, "canvas.db");
    let cr = new DesignRepository(canvasFile);
    let c = cr.create("c", "Canvas", "", "c-create");
    assert.equal(c.pages, undefined, "legacy shape does not need a page migration");
    assert.deepEqual(c.marks, []);
    c = cr.update("c", { documentId: c.id, operationId: "c-boards", operations: [{ type: "add", name: "Original" }] });
    const original = c.boards[0];
    const baseline = c.revision;
    const pages = [{ id: "page-1", name: "Page 1" }, { id: "page-2", name: "Drafts" }];
    const mark = { id: "note-1", type: "note", pageId: "page-2", x: 8, y: 12, width: 240, height: 160, fill: "#fff3b0", stroke: "#4a4220", strokeWidth: 2, text: "Keep me", fontSize: 14 };
    const canvasWrite = { documentId: c.id, operationId: "c-pages", operations: [{ type: "canvas", expectedRevision: c.revision, pages, marks: [mark] }] };
    c = cr.update("c", canvasWrite);
    assert.equal(cr.update("c", canvasWrite).revision, c.revision, "canvas write retries are idempotent");
    const withCanvas = c.revision;
    assert.equal(cr.history("c", c.id)[0].canvasChanged, true);
    assert.deepEqual(cr.history("c", c.id)[0].boardIds, []);
    const persisted = cr.read("c", c.id);
    assert.deepEqual(persisted.pages, pages);
    assert.deepEqual(persisted.marks, [mark]);
    assert.throws(() => cr.update("c", { documentId: c.id, operationId: "c-stale", operations: [{ type: "canvas", expectedRevision: baseline, pages: [] }] }), /REVISION_CONFLICT/);
    // A malformed second operation cannot leave the first board edit committed.
    for (const [suffix, metadata] of [
      ["duplicate", { pages: [pages[0], pages[0]] }],
      ["long-name", { pages: [{ id: "page-1", name: "x".repeat(121) }] }],
      ["too-many", { pages: Array.from({ length: 41 }, (_, i) => ({ id: `page-${i}`, name: "Page" })) }],
      ["bad-mark", { marks: [{ ...mark, x: Infinity }] }],
      ["duplicate-mark", { marks: [mark, mark] }],
      ["long-note", { marks: [{ ...mark, text: "x".repeat(5001) }] }],
      ["bad-path", { marks: [{ ...mark, type: "freehand", points: [{ x: 0, y: 0 }, { x: 999, y: 0 }] }] }],
    ]) {
      assert.throws(() => cr.update("c", { documentId: c.id, operationId: `c-${suffix}`, operations: [{ type: "content", boardId: original.id, expectedRevision: original.contentRevision, html: "<p>Must not save</p>" }, { type: "canvas", expectedRevision: c.revision, ...metadata }] }));
      assert.equal(cr.read("c", c.id).revision, c.revision);
    }
    c = cr.update("c", { documentId: c.id, operationId: "c-agent", operations: [{ type: "content", boardId: original.id, expectedRevision: original.contentRevision, html: "<p>New agent content</p>" }] });
    assert.equal(cr.history("c", c.id)[0].canvasChanged, false);
    const latestBoard = { ...c.boards[0] };
    assert.throws(() => cr.update("c", { documentId: c.id, operationId: "c-atomic-stale", operations: [{ type: "content", boardId: original.id, expectedRevision: latestBoard.contentRevision, html: "<p>Must roll back</p>" }, { type: "canvas", expectedRevision: baseline, pages: [] }] }), /REVISION_CONFLICT/);
    assert.deepEqual(cr.read("c", c.id).boards[0], latestBoard, "a later metadata conflict rolls back earlier board edits in the transaction");
    c = cr.restore("c", c.id, baseline, c.revision, "c-undo-canvas", undefined, { kind: "user" }, { canvas: true });
    assert.equal(c.pages, undefined);
    assert.deepEqual(c.marks, []);
    assert.deepEqual(c.boards[0], latestBoard, "metadata undo leaves unrelated board HTML and write tokens intact");
    c = cr.restore("c", c.id, withCanvas, c.revision, "c-redo-canvas", [], { kind: "user" }, { canvas: true });
    assert.deepEqual(c.pages, pages);
    assert.deepEqual(c.marks, [mark]);
    c = cr.update("c", { documentId: c.id, operationId: "c-page-board", operations: [{ type: "add", name: "Second page", pageId: "page-2" }] });
    const second = c.boards[1];
    assert.equal(second.x, 0, "new page placement ignores other pages");
    assert.equal(second.pageId, "page-2");
    assert.equal(cr.history("c", c.id)[0].canvasChanged, true, "a new board changes page membership");
    const beforeDelete = c.revision;
    c = cr.update("c", { documentId: c.id, operationId: "c-delete-page", operations: [{ type: "remove", boardId: second.id, expectedRevision: second.contentRevision }, { type: "canvas", expectedRevision: c.revision, pages: [pages[0]], marks: [] }] });
    assert.deepEqual(cr.history("c", c.id)[0].boardIds, [second.id]);
    assert.equal(cr.history("c", c.id)[0].canvasChanged, true);
    c = cr.restore("c", c.id, beforeDelete, c.revision, "c-undo-delete", [second.id], { kind: "user" }, { canvas: true });
    assert.deepEqual(c.pages, pages);
    assert.deepEqual(c.marks, [mark]);
    assert.equal(c.boards[1].pageId, "page-2");
    assert.deepEqual(c.boards[0], latestBoard);
    const restoredSecond = c.boards[1];
    c = cr.update("c", { documentId: c.id, operationId: "c-move-page", operations: [{ type: "placement", boardId: restoredSecond.id, expectedRevision: restoredSecond.placementRevision, pageId: "page-1" }] });
    assert.equal(c.boards[1].pageId, "page-1");
    assert.deepEqual(cr.history("c", c.id)[0].boardIds, [restoredSecond.id]);
    assert.equal(cr.history("c", c.id)[0].canvasChanged, true, "moving between pages is both a board and canvas conflict");
    cr.close();
    cr = new DesignRepository(canvasFile);
    assert.deepEqual(cr.read("c", c.id).marks, [mark], "metadata survives reopening");
    // A full page can be removed atomically: 32 board removals plus metadata is 33 operations.
    let full = cr.create("full", "Full", "", "full-create");
    full = cr.update("full", { documentId: full.id, operationId: "full-add", operations: Array.from({ length: 32 }, (_, i) => ({ type: "add", name: `Board ${i}` })) });
    full = cr.update("full", { documentId: full.id, operationId: "full-remove", operations: [...full.boards.map((b) => ({ type: "remove", boardId: b.id, expectedRevision: b.contentRevision })), { type: "canvas", expectedRevision: full.revision, pages: [pages[1]], marks: [] }] });
    assert.equal(full.boards.length, 0);
    assert.equal(cr.history("full", full.id)[0].boardIds.length, 32);
    cr.close();
    // Reopening a v3 database adds only the metadata history column, preserving snapshots.
    const raw = new (require("better-sqlite3"))(canvasFile);
    raw.exec("ALTER TABLE design_revisions DROP COLUMN canvas_changed");
    raw.pragma("user_version = 3");
    raw.close();
    cr = new DesignRepository(canvasFile);
    assert.deepEqual(cr.read("c", c.id).marks, [mark]);
    assert.equal(cr.history("c", c.id)[0].canvasChanged, false, "legacy history gets conservative default");
    cr.close();
  }

  // Exact local edits preserve other boards, links and revision/idempotency semantics.
  {
    let local = repo.create("patch-session", "Patch fixture", "", "patch-create");
    local = repo.update("patch-session", { documentId: local.id, operationId: "patch-add", operations: [
      { type: "add", name: "Target", html: '<h1 data-aegis-node-id="hero">Before</h1><p>same</p><p>same</p>' },
      { type: "add", name: "Other", html: '<p>Untouched</p>' },
    ] });
    const before = local;
    const edit = { documentId: local.id, operationId: "patch-edit", operations: [{ type: "patch", boardId: local.boards[0].id, expectedRevision: 1, find: 'Before', replace: 'After' }] };
    local = repo.update("patch-session", edit);
    assert.equal(local.boards[0].html, before.boards[0].html.replace('Before','After'));
    assert.deepEqual(local.boards[1], before.boards[1]);
    assert.equal(local.boards[0].contentRevision, 2);
    assert.equal(repo.history("patch-session", local.id)[0].summary, "Edited Target");
    assert.equal(repo.update("patch-session", edit).revision, local.revision, "identical retries do not write twice");
    assert.throws(() => repo.update("patch-session", { ...edit, operationId: "stale-patch" }), /REVISION_CONFLICT/);
    for (const [find, error] of [['absent', /PATCH_NOT_FOUND/], ['same', /PATCH_AMBIGUOUS/]]) {
      assert.throws(() => repo.update("patch-session", { documentId: local.id, operationId: 'bad-'+find, operations: [
        { type: "patch", boardId: local.boards[0].id, expectedRevision: 2, find: 'After', replace: 'Should roll back' },
        { type: "patch", boardId: local.boards[0].id, expectedRevision: 3, find, replace: 'No' },
      ] }), error);
      assert.deepEqual(repo.read("patch-session",local.id), local, "failed batch rolls back all local edits");
    }
    local = repo.update("patch-session", { documentId: local.id, operationId: "patch-safety", operations: [
      { type: "patch", boardId: local.boards[0].id, expectedRevision: 2, find: 'After', replace: 'Safe<script>bad()</script>' },
    ] });
    assert(!local.boards[0].html.includes('script'), "patches pass through the same HTML sanitizer");
  }

  // Session lifecycle: a draft's designs follow it, a delete takes them along.
  {
    const lifeFile = join(root, "life.db");
    const life = new DesignRepository(lifeFile);
    const kept = life.create("other", "Kept", "", "keep");
    life.update("other", { documentId: kept.id, operationId: "k1", operations: [{ type: "add", name: "Shared", html: "<p>same</p>" }] });
    const drawn = life.create("draft-1", "Drafted", "", "draft");
    life.update("draft-1", { documentId: drawn.id, operationId: "d1", operations: [{ type: "add", name: "A", html: "<p>same</p>" }, { type: "add", name: "B", html: "<p>only here</p>" }] });
    assert.deepEqual(life.listAll().map((d) => d.title).sort(), ["Drafted", "Kept"]);
    assert.equal(life.moveSession("draft-1", "real-1"), 1);
    assert.equal(life.list("draft-1").length, 0);
    assert.equal(life.list("real-1")[0].boardCount, 2);
    assert.throws(() => life.read("draft-1", drawn.id), /not found/i);
    assert.deepEqual(life.deleteSession("real-1"), [drawn.id]);
    assert.equal(life.list("real-1").length, 0);
    assert.deepEqual(life.listAll().map((d) => d.title), ["Kept"]);
    // Shared board HTML survives; HTML only the deleted design used is gone.
    assert.equal(life.read("other", kept.id).boards[0].html.includes("same"), true);
    life.close();
    const raw = new (require("better-sqlite3"))(lifeFile);
    const html = raw.prepare("SELECT html FROM design_content").all().map((r) => r.html).join("\n");
    raw.close();
    assert(!html.includes("only here"), "orphaned board HTML is removed");
  }
  console.log(
    "Design repository: persistence, atomicity, idempotency, ownership, conflict, cancellation, threads, history metadata, board restore, migration, HTML isolation and session lifecycle passed.",
  );
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  repo?.close();
  rmSync(root, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
}
