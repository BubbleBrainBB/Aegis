// Workflows on the phone: the runs listed chats started, their member sessions
// (readable, approvals only) and the board's decisions.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { RemoteGateway } = require("../../dist-electron/electron/remote/gateway.js");
const { RemoteJournal } = require("../../dist-electron/electron/remote/journal.js");

const session = (id, extra = {}) => ({
  id,
  projectId: "p",
  title: id,
  provider: "claude",
  status: "idle",
  updatedAt: 1,
  runId: null,
  ...extra,
});
const step = (key, sessionId, state = "running") => ({
  key,
  stepId: key,
  kind: "agent",
  phase: null,
  label: `Codex · ${key}`,
  memberKey: "impl",
  iteration: null,
  group: null,
  state,
  sessionId,
  version: null,
  summary: "x".repeat(5000),
  verdict: null,
  startedAt: 1000,
  endedAt: null,
});
const run = (id, parentSessionId, extra = {}) => ({
  id,
  title: "Fix login",
  goal: "The user's whole request",
  cwd: "/Users/me/project",
  location: "current",
  status: "running",
  revision: 3,
  createdAt: 1,
  updatedAt: 10,
  description: "Fix the redirect",
  members: [
    {
      key: "impl",
      role: "implementer",
      agent: "codex",
      provider: "codex",
      model: null,
      modelLabel: null,
      effort: null,
      focus: null,
      source: "inferred",
      permissionMode: null,
      permissionModeIsDefault: true,
      readOnlyMechanism: null,
      degraded: [],
      unverified: false,
      currentSessionId: "member",
    },
  ],
  acceptance: [],
  checks: [],
  unsupported: [],
  assumptions: [],
  warnings: [],
  confirmReasons: [],
  steps: [step("implement", "member")],
  needsInput: null,
  error: null,
  finalVersion: null,
  plannerSessionId: "planner",
  isolated: { worktreePath: "/Users/me/.worktrees/x", branch: "b", implementerSessionId: null },
  includesUserChanges: false,
  spec: { name: "Login redirect fix", steps: [] },
  parent: { sessionId: parentSessionId, toolUseId: "tool-1", provider: "claude", cwd: "/Users/me/project" },
  ...extra,
});

const listed = [session("chat")];
const hidden = {
  member: session("member", { provider: "codex", status: "running" }),
  planner: session("planner"),
  other: session("other-member"),
};
let views = null;
let pending = new Set(["perm-1"]);
const actions = [];
let actionResult = null;
const permissions = [];
const runtime = {
  projects: () => [{ id: "p", name: "P", path: "/tmp" }],
  sessions: () => listed,
  history: (id) => [{ id: id + "-1", role: "assistant", text: "from " + id }],
  start: async () => "x",
  send: async () => true,
  stop: () => {},
  permission: (request, decision) => {
    permissions.push([request.sessionId, decision]);
    return true;
  },
  hasPermission: (_id, toolUseId) => pending.has(toolUseId),
  confirm: async () => true,
  workflows: () => views,
  memberSession: (id) => hidden[id] ?? null,
  workflowAction: async (action) => {
    actions.push(action);
    return actionResult ?? { ok: true, run: { ...views[0], revision: 4, status: "running" } };
  },
};
const journal = new RemoteJournal(join(mkdtempSync(join(tmpdir(), "aegis-remote-wf-")), "state"), (x) => x, (x) => x);
journal.update((s) => {
  s.config = { enabled: true };
  s.devices = [{ peerId: "phone", name: "test", pairedAt: 1 }];
});
const gateway = new RemoteGateway(journal, runtime);
let sequence = 0;
const request = (data) => gateway.dispatch({ id: String(++sequence), ...data }, "phone");
const command = (data) => ({ commandId: crypto.randomUUID(), expiresAt: Date.now() + 60000, ...data });

// Before workflows are set up the list has none, and a later read picks them up.
let snapshot = (await request({ method: "snapshot" })).result;
assert.deepEqual(snapshot.workflows, []);
assert.deepEqual(snapshot.members, []);
views = [run("run-1", "chat"), run("run-hidden", "not-listed", { plannerSessionId: "other-member", steps: [] })];
snapshot = (await request({ method: "snapshot" })).result;
assert.deepEqual(snapshot.workflows.map((w) => w.id), ["run-1"], "only runs a listed chat started");
const sent = snapshot.workflows[0];
assert.equal(sent.name, "Login redirect fix");
for (const key of ["spec", "goal", "cwd", "isolated"]) assert.equal(key in sent, false, `${key} stays on the Mac`);
assert.deepEqual(sent.parent, { sessionId: "chat", toolUseId: "tool-1", provider: "claude" });
assert.ok(sent.steps[0].summary.length < 2100, "long step text is bounded");
// Members are reachable but stay off the task list.
assert.deepEqual(snapshot.sessions.map((s) => s.id), ["chat"]);
assert.deepEqual(snapshot.members.map((s) => s.id).sort(), ["member", "planner"]);
assert.ok(!snapshot.members.some((s) => s.id === "other-member"), "members of runs from unlisted chats stay hidden");
const memberHistory = (await request({ method: "snapshot", sessionId: "member" })).result;
assert.equal(memberHistory.messages[0].text, "from member");
assert.equal((await request({ method: "snapshot", sessionId: "other-member" })).error, "SCOPE_DENIED");

// The workflow drives its sessions: no follow-ups or stops from the phone, but approvals go through.
assert.equal((await request(command({ method: "send", sessionId: "member", prompt: "hi" }))).error, "WORKFLOW_SESSION");
gateway.capture({ type: "stream.user_prompt", payload: { sessionId: "member", prompt: "task" } });
gateway.capture({
  type: "permission.request",
  payload: { sessionId: "member", toolUseId: "perm-1", toolName: "Bash", input: { command: "npm test" } },
});
const withApproval = gateway.snapshot();
const memberRun = withApproval.members.find((s) => s.id === "member").runId;
assert.ok(memberRun, "a running member has a run id");
const permission = withApproval.permissions.find((p) => p.sessionId === "member");
assert.ok(permission, "a member's approval reaches the phone");
assert.equal(
  (await request(command({ method: "stop", sessionId: "member", runId: memberRun }))).error,
  "WORKFLOW_SESSION",
);
const approved = await request(
  command({ method: "permission", sessionId: "member", runId: memberRun, requestId: permission.requestId, decision: "allow" }),
);
assert.equal(approved.result.state, "completed");
assert.deepEqual(permissions, [["member", "allow"]]);

// The board's decisions.
const confirm = await request(
  command({ method: "workflow", workflowId: "run-1", action: { type: "confirm", expectedRevision: 3 } }),
);
assert.equal(confirm.result.state, "completed");
assert.deepEqual(actions[0], { type: "confirm", expectedRevision: 3, runId: "run-1" });
assert.equal(gateway.snapshot().workflows[0].revision, 4, "the action's run replaces the older one");
actionResult = { ok: false, error: "The workflow changed; review it again." };
const stale = await request(
  command({ method: "workflow", workflowId: "run-1", action: { type: "cancel", expectedRevision: 3 } }),
);
assert.equal(stale.result.state, "rejected");
assert.equal(stale.result.error, "The workflow changed; review it again.");
assert.equal(
  (await request(command({ method: "workflow", workflowId: "run-hidden", action: { type: "cancel", expectedRevision: 3 } }))).error,
  "SCOPE_DENIED",
);
assert.equal(
  (await request(command({ method: "workflow", workflowId: "run-1", action: { type: "answer", expectedRevision: 4 } }))).error,
  "INVALID_REQUEST",
  "an answer is an option or text",
);
assert.equal(
  (await request(command({ method: "workflow", workflowId: "run-1", action: { type: "archive" } }))).error,
  "INVALID_REQUEST",
  "only the board's own decisions",
);
actionResult = null;
const answer = await request(
  command({ method: "workflow", workflowId: "run-1", action: { type: "answer", expectedRevision: 4, text: "Use the current files" } }),
);
assert.equal(answer.result.state, "completed");
assert.equal(actions.at(-1).text, "Use the current files");

// Desktop updates keep the list current, never with an older revision.
gateway.capture({ type: "workflow.updated", payload: { ...views[0], revision: 9, status: "succeeded" } });
assert.equal(gateway.snapshot().workflows[0].status, "succeeded");
gateway.capture({ type: "workflow.updated", payload: { ...views[0], revision: 5, status: "running" } });
assert.equal(gateway.snapshot().workflows[0].status, "succeeded");
gateway.close();
console.log("gateway workflow tests passed");
