import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  RemoteGateway,
} = require("../../dist-electron/electron/remote/gateway.js");
const {
  RemoteJournal,
} = require("../../dist-electron/electron/remote/journal.js");
const {
  remoteTaskPayload,
} = require("../../dist-electron/electron/remote/task-payload.js");
const dir = mkdtempSync(join(tmpdir(), "aegis-remote-tests-"));
// A small project for the read-only file requests.
const projectDir = join(dir, "project");
mkdirSync(join(projectDir, "src"), { recursive: true });
mkdirSync(join(projectDir, "node_modules", "pkg"), { recursive: true });
writeFileSync(join(projectDir, "README.md"), "# Hello\n");
writeFileSync(join(projectDir, "src", "app.ts"), "export const x = 1;\n");
writeFileSync(join(projectDir, "src", "logo.bin"), Buffer.from([1, 0, 2, 3]));
writeFileSync(join(projectDir, ".env"), "SECRET=1\n");
writeFileSync(join(projectDir, "node_modules", "pkg", "app.js"), "x");
writeFileSync(join(dir, "outside.txt"), "outside\n");
symlinkSync(join(dir, "outside.txt"), join(projectDir, "escape.txt"));
let lastExtras;
let lastPermission;
let starts = 0,
  sends = 0,
  stops = 0,
  approvals = 0,
  pending = true;
const sessions = [
  {
    id: "visible",
    projectId: "allowed",
    title: "Visible",
    provider: "claude",
    status: "idle",
    updatedAt: 1,
    runId: null,
  },
  {
    id: "secret",
    projectId: "hidden",
    title: "Secret",
    provider: "claude",
    status: "running",
    updatedAt: 1,
    runId: null,
  },
];
const runtime = {
  projects: () => [
    { id: "allowed", name: "Allowed", path: projectDir },
    { id: "hidden", name: "Hidden", path: "/hidden" },
  ],
  sessions: () => sessions,
  history: () => [{ id: "one", role: "assistant", text: "hello" }],
  start: async (_project, _provider, _prompt, extras) => {
    lastExtras = extras;
    starts++;
    await new Promise((r) => setTimeout(r, 20));
    return "new";
  },
  send: async () => {
    sends++;
    return true;
  },
  stop: () => {
    stops++;
  },
  permission: (request, decision, resolution) => {
    lastPermission = { request, decision, resolution };
    approvals++;
    pending = false;
    return true;
  },
  hasPermission: () => pending,
  confirm: async () => true,
  capabilities: async (provider, cwd, sessionId) => ({ commands: [{ name: "compact", description: provider }], skills: [], cwd, sessionId }),
  options: async () => ({ codex: { defaultModel: "m", defaultReasoningEffort: null, options: ["m"], availableModels: [] } }),
  attach: async (name, data) => ({ id: "a1", path: "/tmp/" + name, name, size: data.byteLength, mimeType: "image/png", kind: "image" }),
};
const journal = new RemoteJournal(
  join(dir, "state"),
  (x) => x,
  (x) => x,
);
journal.update((s) => {
  s.config = { enabled: true };
  s.devices = [{ peerId: "phone", name: "test", pairedAt: 1 }];
});
const gateway = new RemoteGateway(journal, runtime);
let sequence = 0;
const request = (data, peer = "phone") =>
  gateway.dispatch({ id: String(++sequence), ...data }, peer);
const command = (data) => ({
  commandId: crypto.randomUUID(),
  expiresAt: Date.now() + 60000,
  ...data,
});
try {
  assert.equal(
    (await request({ method: "snapshot" }, "attacker")).error,
    "UNAUTHORIZED",
  );
  // A paired phone sees every project and session the desktop lists.
  const snapshot = (await request({ method: "snapshot" })).result;
  assert.deepEqual(snapshot.sessions.map((s) => s.id).sort(), ["secret", "visible"]);
  assert.equal(snapshot.projects.length, 2);
  assert.ok((await request({ method: "snapshot", sessionId: "secret" })).result.messages);
  assert.equal(
    (await request({ method: "snapshot", sessionId: "unknown" })).error,
    "SCOPE_DENIED",
  );
  assert.equal(
    (await request({ method: "session.delete", sessionId: "visible" })).error,
    "INVALID_REQUEST",
  );
  assert.equal(
    (
      await request(
        command({
          method: "create",
          projectId: "unknown",
          provider: "claude",
          prompt: "x",
        }),
      )
    ).error,
    "SCOPE_DENIED",
  );
  const create = command({
    method: "create",
    projectId: "allowed",
    provider: "claude",
    prompt: "Run once",
  });
  const [first, duplicate] = await Promise.all([
    request(create),
    request(create),
  ]);
  assert.equal(starts, 1);
  assert.equal(first.result.state, "completed");
  assert.equal(duplicate.result.state, "accepted");
  assert.equal(
    (await request({ ...create, prompt: "Different" })).error,
    "COMMAND_MISMATCH",
  );
  assert.equal(
    (await request({ method: "command.get", commandId: create.commandId }))
      .result.state,
    "completed",
  );
  // The phone re-sends a command it never got an answer for: the Mac answers with
  // the first result and runs nothing again.
  assert.equal((await request(create)).result.state, "completed");
  assert.equal(starts, 1);
  // Polls that already have the current snapshot get a short "unchanged" answer.
  const full = (await request({ method: "snapshot", sessionId: "visible" })).result;
  const same = (await request({ method: "snapshot", sessionId: "visible", knownRevision: full.revision })).result;
  assert.deepEqual(Object.keys(same).sort(), ["revision", "serverTime", "unchanged"]);
  assert.equal(same.revision, full.revision);
  assert.ok((await request({ method: "snapshot", sessionId: "visible", knownRevision: "stale" })).result.sessions);
  assert.equal(
    (
      await request(
        command({
          method: "send",
          sessionId: "visible",
          prompt: "x",
          expiresAt: 1,
        }),
      )
    ).error,
    "COMMAND_EXPIRED",
  );
  sessions[0].status = "running";
  gateway.capture({
    type: "stream.user_prompt",
    payload: { sessionId: "visible", prompt: "Run" },
  });
  const runId = gateway.snapshot().sessions[0].runId;
  assert.equal(
    (
      await request(
        command({ method: "send", sessionId: "visible", prompt: "x" }),
      )
    ).error,
    "SESSION_BUSY",
  );
  assert.equal(
    (
      await request(
        command({ method: "stop", sessionId: "visible", runId: "old" }),
      )
    ).error,
    "STALE_RUN",
  );
  await request(command({ method: "stop", sessionId: "visible", runId }));
  assert.equal(stops, 1);
  gateway.capture({
    type: "permission.request",
    payload: {
      sessionId: "visible",
      toolUseId: "tool",
      toolName: "Bash",
      input: { command: "pwd" },
    },
  });
  const permission = gateway.snapshot().permissions[0];
  assert(permission);
  const approve = command({
    method: "permission",
    sessionId: "visible",
    runId,
    requestId: permission.requestId,
    decision: "allow",
  });
  await Promise.all([request(approve), request(approve)]);
  assert.equal(approvals, 1);
  assert.equal(gateway.snapshot().permissions.length, 0);
  pending = true;
  gateway.capture({
    type: "permission.request",
    payload: {
      sessionId: "visible", toolUseId: "long-tool", toolName: "Bash",
      input: { command: "x".repeat(25000) },
    },
  });
  const longPermission = gateway.snapshot().permissions[0];
  assert.equal(longPermission.canApprove, false);
  assert.equal((await request(command({
    method: "permission", sessionId: "visible", runId,
    requestId: longPermission.requestId, decision: "allow",
  }))).error, "DESKTOP_REQUIRED");
  assert.equal(approvals, 1, "A truncated request must never be approved remotely");

  // Questions: options and multi-select reach the phone; answers come back as the desktop card sends them.
  const questionInput = {
    questions: [
      { question: "Which database?", header: "Storage", options: [{ label: "SQLite", description: "File" }, { label: "Postgres, managed" }] },
      { question: "Which checks?", options: [{ label: "Lint" }, { label: "Tests" }], multiSelect: true },
    ],
  };
  gateway.capture({
    type: "permission.request",
    payload: { sessionId: "visible", toolUseId: "ask", toolName: "AskUserQuestion", input: questionInput },
  });
  const question = gateway.snapshot().permissions.find((p) => p.toolName === "AskUserQuestion");
  assert.equal(question.canApprove, false, "Older phones keep sending questions to the Mac");
  assert.deepEqual(question.questions, [
    { question: "Which database?", header: "Storage", options: [{ label: "SQLite", description: "File" }, { label: "Postgres, managed" }] },
    { question: "Which checks?", options: [{ label: "Lint" }, { label: "Tests" }], multiSelect: true },
  ]);
  assert.equal(question.plan, undefined);
  const answer = (answers) => command({
    method: "permission", sessionId: "visible", runId, requestId: question.requestId, decision: "allow", ...(answers ? { answers } : {}),
  });
  for (const bad of [
    undefined,
    { "Which database?": { selected: ["SQLite"] } },
    { "Which database?": { selected: ["MySQL"] }, "Which checks?": { selected: ["Lint"] } },
    { "Which database?": { selected: ["SQLite", "Postgres, managed"] }, "Which checks?": { selected: ["Lint"] } },
    { "Which database?": { selected: ["SQLite"], other: "Both" }, "Which checks?": { selected: ["Lint"] } },
    { "Which database?": { selected: ["SQLite"] }, "Which checks?": { selected: ["Lint"] }, "Extra?": { selected: [] } },
  ])
    assert.equal((await request(answer(bad))).error, "INVALID_ANSWER", JSON.stringify(bad));
  assert.equal(approvals, 1);
  assert.equal((await request(command({
    method: "permission", sessionId: "visible", runId, requestId: longPermission.requestId, decision: "deny",
    answers: { x: { selected: [] } },
  }))).error, "INVALID_ANSWER", "Only question requests take answers");
  const answered = await request(answer({
    "Which database?": { selected: ["Postgres, managed"] },
    "Which checks?": { selected: ["Tests", "Lint"], other: " Types " },
  }));
  assert.equal(answered.result.state, "completed");
  assert.equal(lastPermission.decision, "allow");
  assert.deepEqual(lastPermission.resolution, {
    behavior: "allow",
    updatedInput: { ...questionInput, answers: { "Which database?": "Postgres, managed", "Which checks?": "Tests,Lint,Types" } },
    questionAnswers: {
      "Which database?": { selected: ["Postgres, managed"] },
      "Which checks?": { selected: ["Tests", "Lint"], other: "Types" },
    },
  });
  assert.equal((await request(command({
    method: "permission", sessionId: "visible", runId, requestId: question.requestId, decision: "deny",
  }))).error, "PERMISSION_EXPIRED", "An answered question is gone");

  // Plans: Claude asks with the approval card only; the plan comes from the ExitPlanMode call.
  pending = true;
  const planCard = {
    questions: [{
      header: "Plan approval",
      question: "Approve this plan and let Claude start implementing it?",
      options: [{ label: "Approve and execute", description: "Go" }, { label: "Stay in plan mode", description: "Wait" }],
    }],
  };
  gateway.capture({
    type: "stream.message",
    payload: {
      sessionId: "visible",
      message: { type: "assistant", uuid: "m", message: { content: [{ type: "tool_use", id: "plan-call", name: "ExitPlanMode", input: { plan: "## Plan\n\n1. Do it" } }] } },
    },
  });
  gateway.capture({
    type: "permission.request",
    payload: { sessionId: "visible", toolUseId: "plan", toolName: "ExitPlanMode", input: planCard },
  });
  const plan = gateway.snapshot().permissions.find((p) => p.toolName === "ExitPlanMode");
  assert.equal(plan.canApprove, false);
  assert.deepEqual(plan.plan, { markdown: "## Plan\n\n1. Do it" });
  assert.equal(plan.questions, undefined, "The phone shows a plan, not the approval card");
  assert.equal((await request(command({
    method: "permission", sessionId: "visible", runId, requestId: plan.requestId, decision: "allow",
    answers: { [planCard.questions[0].question]: { selected: ["Approve and execute"] } },
  }))).error, "INVALID_ANSWER");
  await request(command({ method: "permission", sessionId: "visible", runId, requestId: plan.requestId, decision: "allow" }));
  assert.deepEqual(lastPermission.resolution, {
    behavior: "allow",
    updatedInput: { ...planCard, answers: { [planCard.questions[0].question]: "Approve and execute" } },
    questionAnswers: { [planCard.questions[0].question]: { selected: ["Approve and execute"] } },
  });
  // Keep planning is the card's "Stay in plan mode"; Bubble sends its plan with the request.
  pending = true;
  gateway.capture({
    type: "permission.request",
    payload: { sessionId: "visible", toolUseId: "plan2", toolName: "ExitPlanMode", input: { ...planCard, plan: "Bubble plan" } },
  });
  const bubblePlan = gateway.snapshot().permissions.find((p) => p.toolName === "ExitPlanMode");
  assert.deepEqual(bubblePlan.plan, { markdown: "Bubble plan" });
  await request(command({ method: "permission", sessionId: "visible", runId, requestId: bubblePlan.requestId, decision: "deny" }));
  assert.equal(lastPermission.resolution.behavior, "allow");
  assert.deepEqual(lastPermission.resolution.questionAnswers, { [planCard.questions[0].question]: { selected: ["Stay in plan mode"] } });
  // A plan too long to show in full is approved on the Mac; keeping on planning still works here.
  pending = true;
  gateway.capture({
    type: "permission.request",
    payload: { sessionId: "visible", toolUseId: "plan3", toolName: "ExitPlanMode", input: { ...planCard, plan: "p".repeat(50000) } },
  });
  const longPlan = gateway.snapshot().permissions.find((p) => p.toolName === "ExitPlanMode");
  assert.equal(longPlan.plan.truncated, true);
  assert.equal(longPlan.plan.markdown.length, 48000);
  assert.equal((await request(command({
    method: "permission", sessionId: "visible", runId, requestId: longPlan.requestId, decision: "allow",
  }))).error, "DESKTOP_REQUIRED");
  await request(command({ method: "permission", sessionId: "visible", runId, requestId: longPlan.requestId, decision: "deny" }));
  assert.deepEqual(lastPermission.resolution.questionAnswers, { [planCard.questions[0].question]: { selected: ["Stay in plan mode"] } });
  // A new turn forgets the streamed plan.
  gateway.capture({ type: "stream.user_prompt", payload: { sessionId: "visible", prompt: "again" } });
  pending = true;
  gateway.capture({
    type: "permission.request",
    payload: { sessionId: "visible", toolUseId: "plan4", toolName: "ExitPlanMode", input: planCard },
  });
  assert.deepEqual(gateway.snapshot().permissions.find((p) => p.toolName === "ExitPlanMode").plan, { markdown: "" });
  gateway.capture({ type: "permission.dismissed", payload: { sessionId: "visible", toolUseId: "plan4" } });
  pending = false;
  journal.update((s) => {
    s.commands.crashed = {
      fingerprint: "hash",
      result: { commandId: "crashed", state: "accepted" },
      expiresAt: Date.now() + 1000,
    };
  });
  const restored = new RemoteJournal(
    join(dir, "state"),
    (x) => x,
    (x) => x,
  );
  assert.equal(restored.state.commands.crashed.result.state, "unknown");
  // Agent catalog and chunked uploads.
  assert.equal((await request({ method: "options" })).result.codex.defaultModel, "m");
  assert.equal((await request({ method: "options" }, "attacker")).error, "UNAUTHORIZED");
  const chunk = (data) => request({ method: "attachment.chunk", name: "shot.png", ...data });
  assert.equal((await chunk({ uploadId: "u1", index: 1, total: 2, data: "AAAA" })).error, "UPLOAD_EXPIRED");
  assert.deepEqual((await chunk({ uploadId: "u1", index: 0, total: 2, data: "AAAA" })).result, { received: 1 });
  assert.equal((await request({ method: "attachment.chunk", name: "shot.png", uploadId: "u1", index: 1, total: 2, data: "AAAA" }, "attacker")).error, "UNAUTHORIZED");
  assert.equal((await chunk({ uploadId: "u1", index: 0, total: 2, data: "AAAA" })).error, "UPLOAD_OUT_OF_ORDER");
  const done = (await chunk({ uploadId: "u1", index: 1, total: 2, data: "AAAA" })).result;
  assert.equal(done.size, 6);
  assert.ok(done.attachmentId);
  const withAttachment = await request(
    command({ method: "create", projectId: "allowed", provider: "claude", prompt: "Look", settings: { effort: "high", plan: true }, worktree: true, attachmentIds: [done.attachmentId] }),
  );
  assert.equal(withAttachment.result.state, "completed");
  assert.equal(lastExtras.attachments[0].name, "shot.png");
  assert.equal(lastExtras.settings.effort, "high");
  assert.equal(lastExtras.worktree, true);
  assert.equal(
    (await request(command({ method: "create", projectId: "allowed", provider: "claude", prompt: "x", attachmentIds: ["missing"] }))).error,
    "ATTACHMENT_EXPIRED",
  );
  const big = "A".repeat(131072);
  let tooLarge;
  for (let i = 0; i < 120 && !tooLarge; i++) {
    const r = await chunk({ uploadId: "u2", index: i, total: 120, data: big });
    if (r.error) tooLarge = r.error;
  }
  assert.equal(tooLarge, "ATTACHMENT_TOO_LARGE");
  // Composer commands: a session answers for its own agent and project.
  const caps = (await request({ method: "capabilities", provider: "codex", sessionId: "visible" })).result;
  assert.deepEqual([caps.commands[0].description, caps.cwd, caps.sessionId], ["claude", projectDir, "visible"]);
  const fresh = (await request({ method: "capabilities", provider: "codex", projectId: "allowed" })).result;
  assert.deepEqual([fresh.commands[0].description, fresh.sessionId], ["codex", undefined]);
  assert.equal((await request({ method: "capabilities", provider: "codex", sessionId: "missing" })).error, "SCOPE_DENIED");
  assert.equal((await request({ method: "capabilities", provider: "codex", projectId: "unknown" })).error, "SCOPE_DENIED");
  assert.equal((await request({ method: "capabilities", provider: "codex" })).error, "SCOPE_DENIED");
  assert.equal((await request({ method: "capabilities", provider: "codex", projectId: "allowed" }, "attacker")).error, "UNAUTHORIZED");
  // Read-only project files: scoped, no dot entries, no escapes.
  const files = (data, peer) => request(data, peer);
  const root = (await files({ method: "files.list", projectId: "allowed" })).result;
  assert.deepEqual(root.map((e) => `${e.kind}:${e.path}`), ["dir:node_modules", "dir:src", "file:README.md"]);
  assert.deepEqual((await files({ method: "files.list", projectId: "allowed", path: "src" })).result.map((e) => e.path), ["src/app.ts", "src/logo.bin"]);
  assert.equal((await files({ method: "files.read", projectId: "allowed", path: "src/app.ts" })).result.text, "export const x = 1;\n");
  assert.equal((await files({ method: "files.read", projectId: "allowed", path: join(projectDir, "README.md") })).result.path, "README.md");
  assert.equal((await files({ method: "files.read", projectId: "allowed", path: "src/logo.bin" })).result.text, null);
  assert.equal((await files({ method: "files.read", projectId: "allowed", path: "../outside.txt" })).error, "SCOPE_DENIED");
  assert.equal((await files({ method: "files.read", projectId: "allowed", path: "escape.txt" })).error, "SCOPE_DENIED");
  assert.equal((await files({ method: "files.read", projectId: "allowed", path: ".env" })).error, "SCOPE_DENIED");
  assert.equal((await files({ method: "files.read", projectId: "allowed", path: "missing.ts" })).error, "NOT_FOUND");
  assert.equal((await files({ method: "files.list", projectId: "unknown" })).error, "SCOPE_DENIED");
  assert.equal((await files({ method: "files.list", projectId: "allowed" }, "attacker")).error, "UNAUTHORIZED");
  assert.deepEqual((await files({ method: "files.search", projectId: "allowed", query: "APP" })).result.map((e) => e.path), ["src/app.ts"]);
  // Phone settings map onto the desktop composer's payload fields.
  assert.deepEqual(remoteTaskPayload("codex", { settings: { model: "m", effort: "high", fast: true, permissionMode: "fullAccess", plan: true } }), {
    model: "m", attachments: undefined, codexPermissionMode: "fullAccess", codexExecutionMode: "plan", codexReasoningEffort: "high", codexFastMode: true,
  });
  assert.equal(remoteTaskPayload("claude", { settings: { permissionMode: "yolo", effort: "ultra" } }).claudeAccessMode, "default");
  assert.equal(remoteTaskPayload("claude", { settings: { effort: "ultra" } }).claudeReasoningEffort, undefined);
  const bubble = remoteTaskPayload("bubble", { settings: { permissionMode: "bypassPermissions", plan: true, effort: "max" } });
  assert.equal(bubble.bubblePermissionMode, "plan");
  assert.equal(bubble.bubblePlanExitMode, "bypassPermissions");
  assert.equal(bubble.bubbleThinkingLevel, "max");
  const devin = remoteTaskPayload("devin", { settings: { model: "swe-1.5", permissionMode: "plan", effort: "high" } });
  assert.deepEqual(devin, { model: "swe-1.5", attachments: undefined, devinPermissionMode: "plan", devinThoughtLevel: "high" });
  assert.equal(remoteTaskPayload("devin", { settings: { permissionMode: "yolo" } }).devinPermissionMode, "accept-edits");
  const mimo = remoteTaskPayload("mimo", { settings: { model: "xiaomi/mimo-v2.6-pro", permissionMode: "plan", effort: "high" } });
  assert.deepEqual(mimo, { model: "xiaomi/mimo-v2.6-pro", attachments: undefined, mimoPermissionMode: "plan", mimoReasoningEffort: "high" });
  assert.equal(remoteTaskPayload("mimo", { settings: { permissionMode: "bypass" } }).mimoPermissionMode, "ask");
  const minimax = remoteTaskPayload("minimax", { settings: { model: "m:minimax:MiniMax-M3:v:thinking", permissionMode: "plan", effort: "high" } });
  assert.deepEqual(minimax, { model: "m:minimax:MiniMax-M3:v:thinking", attachments: undefined, minimaxPermissionMode: "plan", minimaxThinkingEffort: "high" });
  assert.equal(remoteTaskPayload("minimax", { settings: { permissionMode: "yolo" } }).minimaxPermissionMode, "default");
  // Phone approvals must not swap the tool's real input for the approval card's fields.
  const ipcSource = (await import("node:fs")).readFileSync(join(process.cwd(), "src/electron/ipc-handlers.ts"), "utf8");
  assert(!ipcSource.includes("updatedInput: request.input"), "phone approvals keep the tool's own input");
  gateway.revoke("phone");
  assert.equal((await request({ method: "snapshot" })).error, "UNAUTHORIZED");
  console.log(
    "Gateway: authorization, scope isolation, whitelist, deduplication, payload conflicts, expiry, stale-run stop, approval race, questions and plans, crash recovery, agent catalog, chunked uploads, task settings and revocation passed",
  );
} finally {
  gateway.close();
  rmSync(dir, { recursive: true, force: true });
}
