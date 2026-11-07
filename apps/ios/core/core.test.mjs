// Tests the bundled aegis-core.js the way the app uses it: load into a fresh
// global scope and call the JSON-in/JSON-out API.  node --test apps/ios/core
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../AegisKit/Sources/AegisKit/Resources/aegis-core.js", import.meta.url)), "utf8");
const context = {};
runInNewContext(source, context);
const call = (name, input) => JSON.parse(context.AegisCore[name](JSON.stringify(input)));

const prompt = (uuid, text, createdAt) => ({ id: uuid, role: "user", text, raw: { type: "user_prompt", uuid, prompt: text, createdAt } });
const toolUse = (uuid, id, command, createdAt) => ({
  id: uuid, role: "assistant", text: "",
  raw: { type: "assistant", uuid, createdAt, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } },
});
const toolResult = (uuid, id, content, createdAt, isError = false) => ({
  id: uuid, role: "tool", text: "",
  raw: { type: "user", uuid, createdAt, message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } },
});
const answer = (uuid, text, createdAt) => ({
  id: uuid, role: "assistant", text,
  raw: { type: "assistant", uuid, createdAt, message: { content: [{ type: "text", text }] } },
});

test("completed turn: prompt, collapsible work block, answer", () => {
  const model = call("renderSession", {
    messages: [prompt("p1", "Run the tests", 1000), toolUse("a1", "t1", "npm test", 2000), toolResult("r1", "t1", "ok", 3000), answer("a2", "All green.", 64000)],
    running: false,
    status: "idle",
  });
  assert.equal(model.structured, true);
  assert.deepEqual(model.items.map((i) => i.kind), ["user", "work", "answer"]);
  const work = model.items[1].work;
  assert.match(work.label, /^Worked for /);
  assert.equal(work.defaultExpanded, false);
  const stage = work.groups[0].stages[0];
  assert.equal(stage.icon, "command");
  assert.equal(stage.commands[0].text, "$ npm test\nok");
  assert.equal(model.lastAnswerText, "All green.");
});

test("running turn stays expanded and shows progress", () => {
  const model = call("renderSession", {
    messages: [prompt("p1", "Run the tests", 1000), toolUse("a1", "t1", "npm test", 2000)],
    running: true,
    status: "running",
  });
  const work = model.items.find((i) => i.kind === "work").work;
  assert.equal(work.label, null);
  assert.equal(work.defaultExpanded, true);
  assert.equal(work.groups[0].stages[0].status, "pending");
});

test("failed command is flagged", () => {
  const model = call("renderSession", {
    messages: [prompt("p1", "x", 1), toolUse("a1", "t1", "false", 2), toolResult("r1", "t1", "boom", 3, true), answer("a2", "It failed.", 4)],
    running: false,
    status: "idle",
  });
  const group = model.items.find((i) => i.kind === "work").work.groups[0];
  assert.equal(group.stages[0].commands[0].isError, true);
});

test("legacy hosts without raw fall back to text rows", () => {
  const model = call("renderSession", {
    messages: [
      { id: "1", role: "user", text: "hi" },
      { id: "2", role: "tool", text: "ls output" },
      { id: "3", role: "tool", text: "more" },
      { id: "4", role: "assistant", text: "hello" },
    ],
    running: true,
    status: "stopping",
  });
  assert.equal(model.structured, false);
  assert.deepEqual(model.items.map((i) => i.kind), ["user", "activity", "answer", "working"]);
  assert.equal(model.items[1].steps.length, 2);
  assert.equal(model.items[3].label, "Stopping…");
});

test("a finished turn with edits gets the desktop's files-changed card", () => {
  const changes = { "/repo/a.ts": { type: "update", unified_diff: "@@ -1,2 +1,2 @@\n x\n-old\n+new\n" } };
  const edit = (uuid, id, at) => ({
    id: uuid, role: "assistant", text: "",
    raw: { type: "assistant", uuid, createdAt: at, message: { content: [{ type: "tool_use", id, name: "Edit", input: JSON.stringify({ changes }) }] } },
  });
  const turn = [prompt("p1", "fix", 1), edit("a1", "e1", 2), toolResult("r1", "e1", JSON.stringify({ output: "Done", changes }), 3), answer("a2", "Fixed.", 4)];
  const done = call("renderSession", { messages: turn, running: false, status: "idle" });
  assert.deepEqual(done.items.map((i) => i.kind), ["user", "work", "answer", "changes"]);
  const card = done.items[3];
  assert.deepEqual(card.files.map((f) => [f.path, f.additions, f.deletions]), [["/repo/a.ts", 1, 1]]);
  assert.match(card.files[0].diff, /\+new/);
  // The card waits while the turn is still running.
  const live = call("renderSession", { messages: turn.slice(0, 3), running: true, status: "running" });
  assert.ok(!live.items.some((i) => i.kind === "changes"));
  const files = call("parsePatch", { patch: "--- a/a.ts\n+++ b/a.ts\n" + card.files[0].diff });
  assert.deepEqual(files[0].lines.map((l) => l.type), ["hunk", "ctx", "del", "add"]);
});

test("keyed history: streamed text renders without resending or rebuilding the history", () => {
  const history = [prompt("p1", "Explain", 1000), toolUse("a1", "t1", "ls", 2000), toolResult("r1", "t1", "ok", 3000)];
  const plain = call("renderSession", { messages: [...history, { id: "s:live", role: "assistant", text: "Partial", streaming: true }], running: true, status: "running" });
  const first = call("renderSession", { key: "s:1", messages: history, live: "Partial", running: true, status: "running" });
  assert.deepEqual(first, plain, "same model as the unkeyed call");
  // Only the text moves on: no messages cross the bridge.
  const next = call("renderSession", { key: "s:1", live: "Partial answer", running: true, status: "running" });
  assert.equal(JSON.stringify(next).includes("Partial answer"), true);
  // Finished: running changes, so the transcript is rebuilt from the kept history.
  const done = call("renderSession", { key: "s:1", live: null, running: false, status: "idle" });
  assert.deepEqual(done, call("renderSession", { messages: history, running: false, status: "idle" }));
  // A key the core doesn't hold asks Swift to send the messages.
  assert.equal(call("renderSession", { key: "s:2", live: "x", running: true, status: "running" }).error, "STALE_HISTORY");
});

test("catalog evaluates per-model efforts and fast mode", () => {
  const codex = call("catalog", {
    provider: "codex",
    options: {
      codex: {
        defaultModel: "gpt-5-codex",
        defaultReasoningEffort: "medium",
        options: [],
        availableModels: [
          { name: "gpt-5-codex", label: "GPT-5 Codex", enabled: true, isDefault: true, supportedReasoningLevels: [{ effort: "low" }, { effort: "high" }], supportsFastMode: true },
        ],
      },
    },
  });
  assert.equal(codex.defaultModel, "gpt-5-codex");
  assert.deepEqual(codex.perModel["gpt-5-codex"].efforts.map((e) => e.value), ["low", "high"]);
  assert.equal(codex.perModel["gpt-5-codex"].fast, true);
  assert.ok(codex.permissionModes.length > 0);
  const claude = call("catalog", { provider: "claude" });
  assert.equal(claude.models[0].label, "Default");
});

test("Codex edits name the file and count lines, like the desktop", () => {
  // Shape recorded from a real Codex session: the Edit input is a JSON string and
  // the result repeats the change set next to the output text.
  const changes = { "/repo/index.html": { type: "update", unified_diff: "@@ -1,2 +1,2 @@\n a\n-old\n+new\n" } };
  const input = JSON.stringify({ changes });
  const model = call("renderSession", {
    messages: [
      prompt("p1", "Edit a file", 1),
      { id: "a1", role: "assistant", text: "", raw: { type: "assistant", uuid: "a1", createdAt: 2, message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input }] } } },
      toolResult("r1", "e1", JSON.stringify({ output: "Done", changes }), 3),
      answer("a2", "Edited.", 4),
    ],
    running: false,
    status: "idle",
  });
  const stage = model.items.find((i) => i.kind === "work").work.groups[0].stages[0];
  assert.equal(stage.title, "Edited index.html");
  assert.deepEqual(stage.files.map((f) => [f.name, f.addedLines, f.removedLines]), [["index.html", 1, 1]]);
  assert.equal(stage.genericText, "");
});

test("Devin catalog: models and thinking levels from the Mac, plan as a mode", () => {
  const devin = call("catalog", {
    provider: "devin",
    options: {
      devin: {
        defaultModel: "swe",
        availableModels: [{ id: "swe", label: "SWE" }, { id: "opus", label: "Opus" }],
        thoughtLevels: { swe: { levels: [], defaultLevel: null }, opus: { levels: [{ id: "low", label: "Low" }, { id: "high", label: "High" }], defaultLevel: "high" } },
      },
    },
  });
  assert.deepEqual(devin.models.map((m) => m.label), ["Default", "SWE", "Opus"]);
  assert.deepEqual(devin.perModel[""].efforts, []);
  assert.deepEqual(devin.perModel.opus.efforts.map((e) => e.value), ["low", "high"]);
  assert.equal(devin.perModel.opus.defaultEffort, "high");
  assert.equal(devin.defaultPermission, "accept-edits");
  assert.ok(devin.permissionModes.some((p) => p.mode === "plan"));
  assert.equal(devin.supportsPlan, false);
});

test("MiniMax Code catalog: models and thinking efforts from the Mac, plan as a mode", () => {
  const flash = "m:minimax:MiniMax-M3.1-Flash:v:thinking";
  const m3 = "m:minimax:MiniMax-M3:v:";
  const minimax = call("catalog", {
    provider: "minimax",
    options: {
      minimax: {
        defaultModel: flash,
        availableModels: [{ id: flash, label: "M3.1-Flash · thinking" }, { id: m3, label: "M3" }],
        thoughtLevels: { [flash]: { levels: [{ id: "low", label: "Low" }, { id: "max", label: "Max" }], defaultLevel: "max" }, [m3]: { levels: [], defaultLevel: null } },
      },
    },
  });
  assert.deepEqual(minimax.models.map((m) => m.label), ["Default", "M3.1-Flash · thinking", "M3"]);
  assert.deepEqual(minimax.perModel[""].efforts.map((e) => e.value), ["low", "max"], "the Default row uses the default model's efforts");
  assert.deepEqual(minimax.perModel[m3].efforts, []);
  assert.equal(minimax.perModel[flash].defaultEffort, "max");
  assert.equal(minimax.defaultPermission, "default");
  assert.ok(minimax.permissionModes.some((p) => p.mode === "plan"));
  assert.equal(minimax.supportsPlan, false);
});

test("MiMo catalog: models and variant levels from the Mac, plan as a mode", () => {
  const mimo = call("catalog", {
    provider: "mimo",
    options: {
      mimo: {
        defaultModel: "xiaomi/mimo-v2.6-pro",
        availableModels: [
          { id: "xiaomi/mimo-v2.6-pro", label: "MiMo-V2.6-Pro", reasoningEfforts: ["low", "medium", "high"] },
          { id: "anthropic/claude", label: "Claude", reasoningEfforts: [] },
        ],
      },
    },
  });
  assert.deepEqual(mimo.models.map((m) => m.label), ["Default", "MiMo-V2.6-Pro", "Claude"]);
  // The Default row offers the configured default model's levels.
  assert.deepEqual(mimo.perModel[""].efforts.map((e) => e.value), ["low", "medium", "high"]);
  assert.deepEqual(mimo.perModel["xiaomi/mimo-v2.6-pro"].efforts.map((e) => e.label), ["Low", "Medium", "High"]);
  assert.equal(mimo.perModel["xiaomi/mimo-v2.6-pro"].defaultEffort, null);
  assert.deepEqual(mimo.perModel["anthropic/claude"].efforts, []);
  assert.equal(mimo.defaultPermission, "ask");
  assert.deepEqual(mimo.permissionModes.map((p) => p.mode), ["ask", "plan", "build"]);
  assert.equal(mimo.supportsPlan, false);
});

test("errors come back as values", () => {
  assert.ok(JSON.parse(context.AegisCore.renderSession("not json")).error);
});

test("a session's own model resolves even when the Mac's list doesn't carry it", () => {
  const options = { claude: { defaultModel: null, options: ["claude-sonnet-4-6"] } };
  const c = call("catalog", { provider: "claude", options, extraModels: ["claude-opus-5-5"] });
  assert.equal(c.labels["claude-opus-5-5"], "Opus 5.5");
  assert.ok(c.perModel["claude-opus-5-5"].efforts.length > 0);
  // It is not offered in the picker list for new tasks.
  assert.ok(!c.models.some((m) => m.value === "claude-opus-5-5"));
  // Listed models are not duplicated into labels.
  assert.deepEqual(call("catalog", { provider: "claude", options, extraModels: ["claude-sonnet-4-6"] }).labels, {});
});

test("composer menu: commands and skills as the desktop lists them", () => {
  const capabilities = {
    commands: [
      { name: "compact", description: "Compact the current conversation context", source: "default" },
      { name: "cost", description: "Show current token and cost usage", source: "default", submitOnSelect: true },
      { name: "plan", description: "Switch into planning mode", source: "default" },
      { name: "deploy", description: "Ship it", source: "session" },
    ],
    skills: [{ name: "brand guide", title: "Brand Guide", description: "House style", source: "project" }],
  };
  const menu = (provider, draft, supportsPlan = true) => call("composerMenu", { provider, draft, capabilities, supportsPlan });
  assert.equal(menu("claude", "fix the bug"), null);
  assert.equal(menu("claude", "fix /co"), null);

  const all = menu("claude", "/");
  assert.equal(all.title, "Commands & Skills");
  assert.deepEqual(all.groups.map((g) => g.label), ["Built-in", "Provider", "Project Skills"]);
  const items = all.groups.flatMap((g) => g.items);
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId["command:compact"].title, "Compact Context");
  assert.equal(byId["command:compact"].draft, "/compact ");
  assert.equal(byId["command:cost"].submit, true);
  assert.deepEqual([byId["command:plan"].action, byId["command:plan"].draft], ["plan", ""]);
  assert.equal(byId["skill:project:brand guide"].draft, "/brand-guide ");

  // Codex runs skills as `$name`, from either key; Plan stays a command without plan support.
  assert.equal(menu("codex", "$bra").groups[0].items[0].draft, "$brand-guide ");
  assert.equal(menu("codex", "/bra").groups.flatMap((g) => g.items)[0].draft, "$brand-guide ");
  assert.equal(menu("codex", "/pl", false).groups[0].items[0].action, null);
  // Devin lists no skills; /model opens the picker.
  assert.equal(menu("devin", "/").title, "Commands");
  assert.equal(menu("devin", "/brand").groups.length, 0);
  assert.equal(menu("claude", "/model").groups[0].items[0].action, "model");
});

// Workflows: the start_workflow call's board, prompts Aegis sent, and result blocks.
const workflowCall = (uuid, id, createdAt) => ({
  id: uuid, role: "assistant", text: "",
  raw: { type: "assistant", uuid, createdAt, message: { content: [{ type: "tool_use", id, name: "mcp__aegis-sessions__start_workflow", input: { request: "Have Codex fix it and Claude review" } }] } },
});
const member = (key, provider, role, extra = {}) => ({
  key, role, agent: provider, provider, model: null, modelLabel: null, effort: null, focus: null, source: "inferred",
  permissionMode: null, permissionModeIsDefault: true, readOnlyMechanism: null, degraded: [], unverified: false, currentSessionId: null, ...extra,
});
const wfStep = (key, memberKey, state, extra = {}) => ({
  key, stepId: key, kind: "agent", phase: null, label: `x · ${key}`, memberKey, iteration: null, group: null, state,
  sessionId: null, version: null, summary: null, verdict: null, startedAt: null, endedAt: null, ...extra,
});
const workflowRun = (extra = {}) => ({
  id: "run-1", title: "workflow", location: "current", status: "running", revision: 2, createdAt: 1, updatedAt: 9000,
  description: "Fix the login redirect", name: "Login redirect fix",
  members: [member("impl", "codex", "implementer", { currentSessionId: "s-impl" }), member("review", "claude", "reviewer")],
  acceptance: [], checks: [], unsupported: [], assumptions: ["Tests live in src/auth"], warnings: [], confirmReasons: [],
  steps: [
    wfStep("implement", "impl", "succeeded", { label: "Codex · implement", sessionId: "s-impl", startedAt: 1000, endedAt: 61000 }),
    wfStep("review", "review", "running", { label: "Claude · review", sessionId: "s-review", startedAt: 61000 }),
    wfStep("fix", "impl", "pending", { label: "Codex · fix" }),
  ],
  needsInput: null, error: null, finalVersion: null, plannerSessionId: "s-plan", includesUserChanges: false,
  parent: { sessionId: "chat", toolUseId: "wf1", provider: "claude" },
  ...extra,
});
const startedTurn = [
  prompt("p1", "Have Codex fix it and Claude review", 1000),
  workflowCall("a1", "wf1", 2000),
  toolResult("r1", "wf1", JSON.stringify({ workflowId: "run-1" }), 2500),
  answer("a2", "Started a workflow.", 3000),
];

test("start_workflow: a running turn draws the board in its trace", () => {
  const model = call("renderSession", {
    messages: startedTurn.slice(0, 3),
    running: true,
    status: "running",
    workflows: [workflowRun()],
    approvals: { "s-review": 1 },
  });
  const groups = model.items.find((i) => i.kind === "work").work.groups;
  const board = groups.find((g) => g.kind === "workflow").board;
  assert.equal(board.phase, "run");
  assert.equal(board.title, "Login redirect fix");
  assert.deepEqual(board.status, { word: "1 of 3", tone: "muted", spinning: true });
  assert.deepEqual(board.time, { start: 1000, end: null });
  assert.equal(board.canStop, true);
  assert.equal(board.open, true);
  assert.deepEqual(board.assumptions, ["Tests live in src/auth"]);
  assert.deepEqual(board.steps.map((s) => [s.title, s.state, s.provider, s.sessionId]), [
    ["Codex · implement", "succeeded", "codex", "s-impl"],
    ["Claude · review", "running", "claude", "s-review"],
    ["Codex · fix", "pending", "codex", null],
  ]);
  assert.equal(board.steps[1].approvals, 1);
  assert.ok(!groups.some((g) => g.kind === "stages" && g.stages.some((s) => s.kind === "subagents")), "no subagent lane for the call");
});

test("start_workflow: a finished turn keeps the board outside its folded trace", () => {
  const done = workflowRun({
    status: "succeeded",
    steps: [
      wfStep("implement", "impl", "succeeded", { sessionId: "s-impl", startedAt: 1000, endedAt: 61000 }),
      wfStep("review", "review", "succeeded", { sessionId: "s-review", startedAt: 61000, endedAt: 91000, verdict: "approved" }),
      wfStep("fix", "impl", "pending"),
    ],
    acceptance: [{ id: "a", description: "Login returns to the page", kind: "review", source: "user", status: "satisfied" }],
    unsupported: ["Real browser check"],
  });
  const model = call("renderSession", { messages: startedTurn, running: false, status: "idle", workflows: [done] });
  const work = model.items.find((i) => i.kind === "work").work;
  assert.ok(work.label);
  assert.ok(!work.groups.some((g) => g.kind === "workflow"));
  const [board] = work.pinned;
  assert.deepEqual(board.status, { word: "Approved", tone: "success", spinning: false });
  assert.deepEqual(board.time, { start: 1000, end: 91000 });
  assert.equal(board.open, false);
  assert.equal(board.steps.length, 2, "unreached steps drop out once it ends");
  assert.deepEqual(board.steps[1].verdict, { word: "Approved", tone: "success" });
  assert.deepEqual(board.outcome.map((o) => o.status), ["met", "open"]);
});

test("start_workflow: plan, question, starting and failed boards", () => {
  const board = (workflows, messages = startedTurn.slice(0, 3)) =>
    call("renderSession", { messages, running: true, status: "running", workflows })
      .items.find((i) => i.kind === "work").work.groups.find((g) => g.kind === "workflow").board;
  const plan = board([workflowRun({ status: "awaiting_confirmation", steps: [wfStep("implement", "impl", "pending")], checks: [{ stepId: "c", argv: ["npm", "test"], authorization: "confirm", basis: null, highlight: false, reasons: [] }] })]);
  assert.deepEqual(plan.status, { word: "Waiting for you", tone: "warning", spinning: false });
  assert.equal(plan.time, null);
  assert.deepEqual(plan.plan.members.map((m) => [m.name, m.detail]), [["Codex", "writes code"], ["Claude", "reviewer, read-only"]]);
  assert.deepEqual(plan.plan.checks, [{ text: "npm test", highlight: false }]);
  assert.deepEqual(plan.steps, [], "nothing has run yet");
  const asked = board([workflowRun({ status: "needs_input", needsInput: { reason: "ask", detail: null, instanceKey: null, stepId: null, question: "Which branch?", options: [{ id: "o1", label: "main" }] } })]);
  assert.equal(asked.needs.title, "A question for you");
  assert.deepEqual(asked.needs.options, [{ id: "o1", label: "main", answer: "text" }]);
  assert.equal(asked.needs.freeText, false);
  const drift = board([workflowRun({ status: "needs_input", needsInput: { reason: "workspace-drift", detail: "hash mismatch", instanceKey: null, stepId: null, question: null, options: [{ id: "use-current", label: "Use current files" }] } })]);
  assert.match(drift.needs.detail, /^Files no longer match/);
  assert.equal(drift.needs.options[0].answer, "option");
  assert.equal(board([]).phase, "starting");
  // Found by the call id when the result isn't in yet.
  assert.equal(board([workflowRun()], startedTurn.slice(0, 2)).runId, "run-1");
  const refused = board([], [startedTurn[0], startedTurn[1], toolResult("r1", "wf1", "Workflows need a project folder", 2500, true)]);
  assert.equal(refused.phase, "failed");
  assert.equal(refused.failure, "Workflow could not start: Workflows need a project folder");
});

test("prompts the workflow sent are not user bubbles; result blocks fold", () => {
  const sent = (uuid, text, kind, createdAt) => ({ id: uuid, role: "user", text, raw: { type: "user_prompt", uuid, prompt: text, workflowPrompt: kind, createdAt } });
  const result = '```json\n{"schemaVersion":1,"status":"completed","summary":"Fixed it","details":"x"}\n```';
  const model = call("renderSession", {
    messages: [
      sent("t1", "Fix the login redirect.\n\nEnd with a result block.", "task", 1000),
      answer("a1", "Fixed the redirect.\n\n" + result, 2000),
      sent("e1", "Workflow: Codex finished implement", "event", 3000),
      sent("e2", "Workflow finished · result sent to this chat", "event", 4000),
      sent("f1", "Follow-up result: Update the docs", "follow-up", 5000),
    ],
    running: false,
    status: "idle",
  });
  assert.deepEqual(model.items.map((i) => i.kind), ["brief", "answer", "notice", "notice"]);
  assert.equal(model.items[0].title, "Task from workflow");
  assert.equal(model.items[1].markdown, "Fixed the redirect.");
  assert.match(model.items[1].result, /"summary":"Fixed it"/);
  assert.deepEqual([model.items[2].text, model.items[2].style], ["Workflow: Codex finished implement", "center"]);
  assert.deepEqual([model.items[3].text, model.items[3].style], ["Update the docs", "chip"]);
  assert.equal(model.lastAnswerText, "Fixed the redirect.");
});
