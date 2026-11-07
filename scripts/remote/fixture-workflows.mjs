// Workflow chats for the UI fixture: one per board state (running with a
// member waiting on approval, a plan to start, a question, finished), their
// member sessions, and the board's decisions. Shapes follow WorkflowRunView
// and the desktop's stream messages; nothing runs.
const minute = 60000;

const prompt = (uuid, text, at, workflowPrompt) => ({
  id: uuid, role: "user", text, at,
  raw: { type: "user_prompt", uuid, prompt: text, createdAt: at, ...(workflowPrompt ? { workflowPrompt } : {}) },
});
const toolUse = (uuid, id, name, input, at) => ({
  id: uuid, role: "assistant", text: "", at,
  raw: { type: "assistant", uuid, createdAt: at, message: { content: [{ type: "tool_use", id, name, input }] } },
});
const toolResult = (uuid, id, content, at) => ({
  id: uuid, role: "tool", text: "", at,
  raw: { type: "user", uuid, createdAt: at, message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] } },
});
const answer = (uuid, text, at) => ({
  id: uuid, role: "assistant", text, at,
  raw: { type: "assistant", uuid, createdAt: at, message: { content: [{ type: "text", text }] } },
});
const startCall = (chat, at, request) => [
  toolUse(`${chat}-call`, `${chat}-wf`, "mcp__aegis-sessions__start_workflow", { request }, at),
  toolResult(`${chat}-res`, `${chat}-wf`, JSON.stringify({ workflowId: `run-${chat}` }), at + 800),
];

const member = (key, provider, role, extra = {}) => ({
  key, role, agent: provider, provider, model: null, modelLabel: null, effort: null, focus: null, source: "inferred",
  permissionMode: null, permissionModeIsDefault: true, readOnlyMechanism: null, degraded: [], unverified: false,
  currentSessionId: null, ...extra,
});
const step = (key, memberKey, label, state, extra = {}) => ({
  key, stepId: key, kind: "agent", phase: null, label, memberKey, iteration: null, group: null, state,
  sessionId: null, version: null, summary: null, verdict: null, startedAt: null, endedAt: null, ...extra,
});
const run = (chat, extra) => ({
  id: `run-${chat}`, title: "workflow", goal: "", cwd: "/fixture/coworker", location: "current", revision: 1,
  createdAt: Date.now() - 20 * minute, updatedAt: Date.now(), description: null, acceptance: [], checks: [], unsupported: [],
  assumptions: [], warnings: [], confirmReasons: [], needsInput: null, error: null, finalVersion: null, plannerSessionId: null,
  isolated: null, includesUserChanges: false, spec: null,
  parent: { sessionId: chat, toolUseId: `${chat}-wf`, provider: "claude", cwd: "/fixture/coworker" },
  ...extra,
});

export function workflowFixture(capture) {
  const now = Date.now();
  const t = now - 14 * minute;
  const sessions = [
    { id: "wf-run", projectId: "project", title: "Fix the login redirect with a review", provider: "claude", status: "idle", updatedAt: now, runId: null },
    { id: "wf-plan", projectId: "project", title: "Rate-limit the public API", provider: "claude", status: "idle", updatedAt: now - minute, runId: null },
    { id: "wf-ask", projectId: "project", title: "Migrate settings to the new store", provider: "claude", status: "idle", updatedAt: now - 2 * minute, runId: null },
    { id: "wf-done", projectId: "project", title: "Add retry to the sync client", provider: "claude", status: "idle", updatedAt: now - 3 * minute, runId: null },
  ];
  const members = {
    "wf-review": { id: "wf-review", projectId: "project", title: "Fix the login redirect · review", provider: "codex", status: "running", updatedAt: now, runId: null },
    "wf-done-impl": { id: "wf-done-impl", projectId: "project", title: "Add retry · implement", provider: "codex", status: "idle", updatedAt: now - 3 * minute, runId: null },
  };
  const result = '```json\n{"schemaVersion":1,"status":"completed","summary":"Read the return target before the session refresh","details":"redirect.ts, redirect.test.ts"}\n```';
  const history = {
    "wf-run": [
      prompt("wr-p1", "Fix the login redirect so people land where they were, then have Codex review it.", t),
      ...startCall("wf-run", t + 3000, "Fix the login redirect; Codex reviews"),
      answer("wr-a1", "Started a workflow: this chat implements the fix, Codex reviews it. Its board above shows each step.", t + 5000),
      prompt("wr-e1", "Workflow asked this chat to implement the task", t + 20000, "event"),
      toolUse("wr-t1", "wr-read", "Read", { file_path: "/fixture/coworker/src/auth/redirect.ts" }, t + 24000),
      toolResult("wr-r1", "wr-read", "export function resolveReturnTo(req) { … }", t + 25000),
      toolUse("wr-t2", "wr-edit", "Edit", { file_path: "/fixture/coworker/src/auth/redirect.ts", old_string: "a", new_string: "b" }, t + 60000),
      toolResult("wr-r2", "wr-edit", "Updated", t + 61000),
      answer("wr-a2", "The return target is now read before the session refresh clears its cookie, and `sanitizeReturnTo` keeps it on this site.\n\n" + result, t + 140000),
    ],
    "wf-review": [
      prompt("rv-p1", "Review the change to src/auth/redirect.ts against the task below.\n\n**Task:** keep the page people came from after signing in.\n\nEnd with a review result block.", t + 150000, "task"),
      toolUse("rv-t1", "rv-diff", "Bash", { command: "git diff -- src/auth" }, t + 156000),
      toolResult("rv-r1", "rv-diff", "diff --git a/src/auth/redirect.ts …", t + 158000),
      answer("rv-a1", "The fix reads the target first. Running the auth tests before I give a verdict.", t + 170000),
    ],
    "wf-plan": [
      prompt("wp-p1", "Add rate limiting to the public API. Use a workflow: Codex builds it, Claude reviews.", now - 4 * minute),
      ...startCall("wf-plan", now - 4 * minute + 3000, "Rate-limit the public API"),
      answer("wp-a1", "I drafted a workflow for this. Check the plan and start it when it looks right.", now - 4 * minute + 30000),
    ],
    "wf-ask": [
      prompt("wa-p1", "Move the settings to the new store, keep old values working.", now - 30 * minute),
      ...startCall("wf-ask", now - 30 * minute + 3000, "Migrate settings"),
      answer("wa-a1", "Started a workflow for the migration.", now - 30 * minute + 6000),
    ],
    "wf-done": [
      prompt("wd-p1", "Add retries to the sync client and get it reviewed.", now - 60 * minute),
      ...startCall("wf-done", now - 60 * minute + 3000, "Retry in the sync client"),
      answer("wd-a1", "Started a workflow: Codex implements, Claude reviews.", now - 60 * minute + 6000),
      answer("wd-a2", "The workflow finished and Claude approved the change. Retries back off from 250 ms to 8 s and stop after five tries; the one open item is a real network check, which no agent could run.", now - 30 * minute),
    ],
    "wf-done-impl": [
      prompt("di-p1", "Implement retries with backoff in src/sync/client.ts.", now - 59 * minute, "task"),
      answer("di-a1", "Added `withRetry` around fetch: backoff from 250 ms to 8 s, five tries, no retry on 4xx.\n\n" + result, now - 50 * minute),
    ],
  };
  const reviewStart = t + 150000;
  const runs = {
    "wf-run": run("wf-run", {
      status: "running", description: "Fix the login redirect", spec: { name: "Login redirect fix" },
      members: [member("chat", "claude", "implementer", { agent: "current" }), member("review", "codex", "reviewer", { currentSessionId: "wf-review", model: "gpt-5-codex", modelLabel: "GPT-5 Codex", effort: "high" })],
      assumptions: ["The redirect tests live in src/auth", "Only same-site paths are valid targets"],
      steps: [
        step("implement", "chat", "This chat · implement", "succeeded", { sessionId: "wf-run", startedAt: t + 20000, endedAt: t + 140000 }),
        step("review", "review", "Codex · review", "running", { sessionId: "wf-review", startedAt: reviewStart }),
        step("fix", "chat", "This chat · fix", "pending"),
      ],
    }),
    "wf-plan": run("wf-plan", {
      status: "awaiting_confirmation", description: "Rate-limit the public API", spec: { name: "API rate limiting" },
      members: [member("impl", "codex", "implementer", { model: "gpt-5-codex", modelLabel: "GPT-5 Codex" }), member("review", "claude", "reviewer", { source: "user" })],
      checks: [
        { stepId: "test", argv: ["npm", "run", "test", "--", "api/limits"], authorization: "confirm", basis: null, highlight: false, reasons: [] },
        { stepId: "lint", argv: ["npm", "run", "lint"], authorization: "confirm", basis: null, highlight: false, reasons: [] },
      ],
      assumptions: ["Limits are per API key, not per IP"],
      steps: [step("implement", "impl", "Codex · implement", "pending"), step("review", "review", "Claude · review", "pending")],
    }),
    "wf-ask": run("wf-ask", {
      status: "needs_input", description: "Migrate settings to the new store", spec: { name: "Settings migration" },
      members: [member("impl", "codex", "implementer"), member("review", "claude", "reviewer")],
      steps: [
        step("implement", "impl", "Codex · implement", "succeeded", { startedAt: now - 29 * minute, endedAt: now - 21 * minute }),
        step("review", "review", "Claude · review", "needs_input", { startedAt: now - 21 * minute, endedAt: now - 18 * minute }),
      ],
      needsInput: {
        reason: "workspace-drift", detail: "hash mismatch", instanceKey: "review", stepId: "review", question: null,
        options: [{ id: "use-current", label: "Use the current files" }, { id: "stop", label: "Stop the workflow" }],
      },
    }),
    "wf-done": run("wf-done", {
      status: "succeeded", description: "Retry in the sync client", spec: { name: "Sync client retries" },
      members: [member("impl", "codex", "implementer", { currentSessionId: "wf-done-impl" }), member("review", "claude", "reviewer")],
      steps: [
        step("implement", "impl", "Codex · implement", "succeeded", { sessionId: "wf-done-impl", startedAt: now - 59 * minute, endedAt: now - 50 * minute }),
        step("review", "review", "Claude · review", "succeeded", { startedAt: now - 50 * minute, endedAt: now - 46 * minute, verdict: "approved" }),
      ],
      acceptance: [
        { id: "a1", description: "Failed requests retry with backoff and stop after five tries", kind: "review", source: "user", status: "satisfied" },
        { id: "a2", description: "Client errors (4xx) are not retried", kind: "check", source: "inferred", status: "satisfied" },
      ],
      unsupported: ["A check against a real flaky network"],
    }),
  };
  const update = (chat, patch) => {
    const current = runs[chat];
    runs[chat] = { ...current, ...patch, revision: current.revision + 1, updatedAt: Date.now() };
    capture({ type: "workflow.updated", payload: runs[chat] });
    return runs[chat];
  };
  return {
    sessions,
    history,
    // The review step waits on approval of its test command.
    permission: { sessionId: "wf-review", toolUseId: "wf-approve", toolName: "Bash", input: { command: "npm run test -- src/auth", cwd: "/fixture/coworker" } },
    views: () => Object.values(runs),
    memberSession: (id) => members[id] ?? null,
    act: async (action) => {
      const chat = Object.keys(runs).find((key) => runs[key].id === action.runId);
      if (!chat) return { ok: false, error: "This workflow no longer exists." };
      if (action.expectedRevision !== undefined && action.expectedRevision !== runs[chat].revision)
        return { ok: false, error: "The workflow changed; review it again.", run: runs[chat] };
      console.log("fixture workflow", chat, JSON.stringify(action));
      if (action.type === "cancel") return { ok: true, run: update(chat, { status: "cancelled" }) };
      if (action.type === "confirm") {
        const started = Date.now();
        return {
          ok: true,
          run: update(chat, {
            status: "running",
            steps: runs[chat].steps.map((s, i) => (i === 0 ? { ...s, state: "running", startedAt: started } : s)),
          }),
        };
      }
      if (action.type === "answer")
        return {
          ok: true,
          run: update(chat, {
            status: action.optionId === "stop" ? "cancelled" : "running",
            needsInput: null,
            steps: runs[chat].steps.map((s) => (s.state === "needs_input" ? { ...s, state: "running", startedAt: Date.now(), endedAt: null } : s)),
          }),
        };
      return { ok: false, error: "Not in the fixture." };
    },
  };
}
