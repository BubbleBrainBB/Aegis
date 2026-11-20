// One Mac controlling another: the real gateway and relay with a fake agent runtime.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createRelay } from "../../services/relay/server.mjs";
const require = createRequire(import.meta.url);
const { RemoteGateway } = require("../../dist-electron/electron/remote/gateway.js");
const { RemoteJournal } = require("../../dist-electron/electron/remote/journal.js");
const { RemoteHostClient } = require("../../dist-electron/electron/remote/host-client.js");
const { RemoteHostBridge, permissionAnswer } = require("../../dist-electron/electron/remote/host-bridge.js");
const { agentCatalog } = require("../../dist-electron/shared/remote/agent-catalog.js");
const crypto = require("../../dist-electron/electron/remote/secure-channel.cjs");

const dir = mkdtempSync(join(tmpdir(), "aegis-host-client-"));
const relay = createRelay({ port: 0 });
const { port } = await relay.listen();
const until = async (check, label, ms = 8000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("Timed out: " + label);
    await new Promise((r) => setTimeout(r, 15));
  }
};
const text = (id, role, body) => ({ id, role, text: body, raw: role === "user" ? { type: "user_prompt", prompt: body } : { type: "assistant", uuid: id, message: { content: [{ type: "text", text: body }] } } });

const session = { id: "s1", projectId: "p1", title: "Fix relay", provider: "claude", status: "idle", updatedAt: 1, runId: null };
const big = { id: "big", projectId: "p1", title: "Long session", provider: "claude", status: "idle", updatedAt: 1, runId: null };
const bigHistory = Array.from({ length: 4000 }, (_, i) => text("m" + i, i % 2 ? "assistant" : "user", `${i} ` + "x".repeat(2000)));
// A Bubble session, as a host from before it reported Bubble's mode lists it: no permissionMode.
const bubble = { id: "b1", projectId: "p1", title: "Install deps", provider: "bubble", status: "idle", updatedAt: 1, runId: null, settings: { model: "kimi" } };
const histories = { s1: [text("a", "user", "Hello")], big: bigHistory, b1: [] };
const pending = new Set();
const calls = { send: 0, stop: 0, permission: [], create: [], settings: [] };
/** Sessions the fixture lists besides the two every controller sees first. */
const extraSessions = [];
let sendGate;
let holdSend;
let startGate;
let holdStart;
let gateway;
const runtime = () => ({
  environment: "fixture",
  lan: false,
  projects: () => [{ id: "p1", name: "coworker", path: dir, isRepo: true }],
  sessions: () => [session, big, ...extraSessions],
  history: (id) => histories[id] ?? [],
  start: async (project, provider, prompt, extras) => {
    calls.create.push({ project: project.id, provider, prompt, worktree: extras?.worktree, ...(extras?.settings ? { settings: extras.settings } : {}) });
    if (startGate) await startGate;
    return "new";
  },
  send: async (id, prompt, extras) => {
    // The Bubble session only records what each message was told to run with; it stays idle.
    if (id === "b1") {
      calls.settings.push(extras?.settings);
      if (sendGate) await sendGate;
      return true;
    }
    calls.send++;
    if (sendGate) await sendGate;
    histories[id].push(text("u" + calls.send, "user", prompt));
    session.status = "running";
    gateway.capture({ type: "stream.user_prompt", payload: { sessionId: id, prompt } });
    gateway.capture({ type: "session.status", payload: { sessionId: id, status: "running" } });
    return true;
  },
  stop: () => {
    calls.stop++;
    session.status = "idle";
    gateway.capture({ type: "session.status", payload: { sessionId: "s1", status: "idle" } });
  },
  permission: (request, decision, _resolution, scope) => {
    calls.permission.push(scope ? [request.toolName, decision, scope] : [request.toolName, decision]);
    pending.delete(request.toolUseId);
    gateway.capture({ type: "permission.dismissed", payload: { sessionId: request.sessionId, toolUseId: request.toolUseId } });
    return true;
  },
  hasPermission: (_id, tool) => pending.has(tool),
  confirm: async () => true,
});
gateway = new RemoteGateway(new RemoteJournal(join(dir, "host.enc"), (v) => v, (v) => v), runtime());
await gateway.configure(`ws://127.0.0.1:${port}`);
await until(() => gateway.status === "waiting", "gateway registered");

const seen = { statuses: [], state: null, history: [], live: "", replaced: 0 };
const identity = await crypto.createIdentity();
const makeClient = (pairing, id = identity, into = seen) => new RemoteHostClient({
  pairing, identity: id.privateKey, name: "MacBook Pro", crypto,
  events: {
    status: (s) => into.statuses.push(s),
    state: (s) => (into.state = s),
    history: (_id, messages, change) => {
      if (change.replace) { into.history = [...messages]; into.replaced++; into.before = change.before; }
      else into.history.push(...messages);
    },
    live: (_id, change) => {
      if (change.append !== undefined) into.live += change.append;
      else into.live = change.text ?? "";
    },
  },
});

// Pairing, then the session list.
const client = makeClient(gateway.pairing());
client.connect();
await until(() => client.status === "connected", "paired");
assert.equal(gateway.describe().devices[0].name, "MacBook Pro");
await until(() => seen.state?.sessions.length === 2, "session list");

// Opening a session.
await client.subscribe("s1");
await until(() => seen.history.length === 1, "history");
assert.equal(seen.history[0].raw.prompt, "Hello");

// A new task on that Mac.
const created = await client.command("create", { projectId: "p1", provider: "codex", prompt: "List files", worktree: true });
assert.equal(created.state, "completed", JSON.stringify(created));
assert.equal(created.sessionId, "new");
assert.deepEqual(calls.create, [{ project: "p1", provider: "codex", prompt: "List files", worktree: true }]);
assert.deepEqual(seen.state.projects, [{ id: "p1", name: "coworker", isRepo: true }]);

// Live output.
for (const chunk of ["Work", "ing"]) gateway.capture({ type: "stream.message", payload: { sessionId: "s1", message: { type: "stream_event", event: { delta: { type: "text_delta", text: chunk } } } } });
await until(() => seen.live === "Working", "live text");

// Sending, with the prompt coming back through the history.
const sent = await client.command("send", { sessionId: "s1", prompt: "Run the tests" });
assert.equal(sent.state, "completed");
assert.equal(calls.send, 1);
await until(() => seen.history.some((m) => m.text === "Run the tests"), "prompt in history");
await until(() => seen.state.sessions.find((s) => s.id === "s1").runId, "running");

// An approval carries the tool input, answers once and disappears.
pending.add("t1");
gateway.capture({ type: "permission.request", payload: { sessionId: "s1", toolUseId: "t1", toolName: "Bash", input: { command: "npm test" } } });
await until(() => seen.state.permissions.length === 1, "approval shown");
const permission = seen.state.permissions[0];
assert.deepEqual(permission.input, { command: "npm test" });
const answered = await client.command("permission", { sessionId: "s1", runId: permission.runId, requestId: permission.requestId, decision: "allow" });
assert.equal(answered.state, "completed");
assert.deepEqual(calls.permission, [["Bash", "allow"]]);
await until(() => seen.state.permissions.length === 0, "approval gone");
pending.add("t2");
gateway.capture({ type: "permission.request", payload: { sessionId: "s1", toolUseId: "t2", toolName: "Bash", input: { command: "npm test" } } });
await until(() => seen.state.permissions.length === 1, "second approval shown");
const forSession = seen.state.permissions[0];
assert.equal((await client.command("permission", { sessionId: "s1", runId: forSession.runId, requestId: forSession.requestId, decision: "allow", scope: "session" })).state, "completed");
assert.deepEqual(calls.permission.at(-1), ["Bash", "allow", "session"]);
await until(() => seen.state.permissions.length === 0, "second approval gone");

// A message into the running turn gets through; without saying so it's refused.
const beforeSteer = calls.send;
assert.equal((await client.command("send", { sessionId: "s1", prompt: "No steer" })).error, "SESSION_BUSY");
const steered = await client.command("send", { sessionId: "s1", prompt: "Into the turn", steer: true });
assert.equal(steered.state, "completed", JSON.stringify(steered));
assert.equal(calls.send, beforeSteer + 1);
// The fake runtime opens a new turn for every send; stop below needs that turn's id.
await new Promise((r) => setTimeout(r, 300));

// Stop.
const runId = seen.state.sessions.find((s) => s.id === "s1").runId;
assert.equal((await client.command("stop", { sessionId: "s1", runId })).state, "completed");
assert.equal(calls.stop, 1);
await until(() => seen.state.sessions.find((s) => s.id === "s1").status === "idle", "stopped");

// The connection dies while the host runs a send. It runs once, and the answer still arrives.
let open;
sendGate = new Promise((r) => (open = r));
const before = calls.send;
const interrupted = client.command("send", { sessionId: "s1", prompt: "Survive reconnect" });
await until(() => calls.send === before + 1, "send reached the host");
client.socket.terminate();
await until(() => client.status !== "connected", "dropped");
open();
sendGate = undefined;
const recovered = await interrupted;
assert.equal(recovered.state, "completed", JSON.stringify(recovered));
assert.equal(calls.send, before + 1, "the send ran exactly once");
assert.equal(client.status, "connected");
await until(() => seen.history.some((m) => m.text === "Survive reconnect"), "prompt after reconnect");

// A command written while offline goes out once the connection is back.
session.status = "idle";
gateway.capture({ type: "session.status", payload: { sessionId: "s1", status: "idle" } });
client.socket.terminate();
await until(() => client.status !== "connected", "dropped again");
const queued = client.command("send", { sessionId: "s1", prompt: "Written offline" });
assert.equal((await queued).state, "completed");
assert.ok(seen.history.length);

// A long session: first page fast, the rest pages in order, nothing lost.
const started = Date.now();
seen.replaced = 0;
await client.subscribe("big");
await until(() => seen.replaced === 1, "big first page", 15000);
const firstPageMs = Date.now() - started;
const newest = [...seen.history];
let cursor = seen.before;
assert.ok(cursor > 0, "more pages exist");
let collected = newest;
let pages = 1;
while (cursor != null && cursor > 0) {
  const page = await client.older("big", cursor);
  collected = [...page.messages, ...collected];
  cursor = page.before;
  pages++;
}
const allMs = Date.now() - started;
assert.equal(collected.length, 4000);
assert.deepEqual(collected.map((m) => m.id), bigHistory.map((m) => m.id));
console.log(`long session: ${(JSON.stringify(bigHistory).length / 1048576).toFixed(1)} MiB, first page ${firstPageMs} ms, all ${pages} pages ${allMs} ms`);

// A second controller beside this one (a phone): both stay connected and both get events.
const secondSeen = { statuses: [], state: null, history: [], live: "", replaced: 0 };
await new Promise((r) => setTimeout(r, 300));
const second = makeClient(gateway.pairing(), await crypto.createIdentity(), secondSeen);
second.connect();
await until(() => second.status === "connected", "second controller", 15000);
assert.equal(client.status, "connected", "the first controller stays connected");
await until(() => secondSeen.state?.sessions.length === 2, "second controller's list");
await second.subscribe("s1");
await client.subscribe("s1");
await until(() => secondSeen.history.length > 0 && seen.history.some((m) => m.text === "Written offline"), "both opened");
const beforeBoth = secondSeen.history.length;
const shared = await second.command("send", { sessionId: "s1", prompt: "From the second" }).then(async (result) => {
  if (result.error !== "SESSION_BUSY") return result;
  session.status = "idle";
  gateway.capture({ type: "session.status", payload: { sessionId: "s1", status: "idle" } });
  return second.command("send", { sessionId: "s1", prompt: "From the second" });
});
assert.equal(shared.state, "completed", JSON.stringify(shared));
await until(() => seen.history.some((m) => m.text === "From the second"), "first sees the second's message");
await until(() => secondSeen.history.length > beforeBoth, "second sees its own message");
second.close();
await new Promise((r) => setTimeout(r, 200));
assert.equal(client.status, "connected", "the first controller outlives the second");
await until(() => gateway.status === "connected", "gateway still connected");

// What the approval, question and plan cards answer becomes the host's command fields.
{
  const base = { requestId: "r", sessionId: "s", runId: "x", toolName: "Bash", detail: "", canApprove: true };
  assert.deepEqual(permissionAnswer(base, { behavior: "allow", scope: "once" }), { decision: "allow" });
  assert.deepEqual(permissionAnswer(base, { behavior: "allow", scope: "session" }), { decision: "allow", scope: "session" });
  assert.deepEqual(permissionAnswer(base, { behavior: "deny", scope: "session" }), { decision: "deny" });
  const question = { ...base, questions: [{ question: "Color?", options: [] }] };
  const answers = { "Color?": { selected: ["Blue"], other: "or teal" } };
  assert.deepEqual(permissionAnswer(question, { behavior: "allow", questionAnswers: answers }), { decision: "allow", answers });
  assert.deepEqual(permissionAnswer(question, { behavior: "deny" }), { decision: "deny" });
  const plan = { ...base, plan: { markdown: "x" } };
  const pick = (label) => ({ behavior: "allow", questionAnswers: { q: { selected: [label] } } });
  assert.deepEqual(permissionAnswer(plan, pick("Approve and execute")), { decision: "allow" });
  assert.deepEqual(permissionAnswer(plan, pick("Stay in plan mode")), { decision: "deny" });
  assert.deepEqual(permissionAnswer(plan, { behavior: "deny" }), { decision: "deny" });
}

// What another Mac offers, in one shape whatever the agent.
{
  const catalog = agentCatalog({
    claude: { defaultModel: "sonnet", options: ["sonnet", "haiku"] },
    codex: { defaultModel: "gpt", defaultReasoningEffort: "high", options: [], availableModels: [
      { name: "gpt", label: "GPT", enabled: true, isDefault: true, supportedReasoningLevels: [{ effort: "high" }], supportsFastMode: true },
      { name: "off", enabled: false, isDefault: false },
    ] },
    devin: { defaultModel: null, availableModels: [{ id: "d", label: "D" }], thoughtLevels: { d: { levels: [{ id: "deep", label: "Deep" }] } } },
  });
  assert.deepEqual(catalog.map((e) => e.provider), ["claude", "codex", "devin"]);
  assert.deepEqual(catalog[1].models, [{ id: "gpt", label: "GPT", efforts: ["high"], fast: true }]);
  assert.deepEqual(catalog[2].models[0].efforts, ["deep"]);
}

// Starting a task on a Mac that isn't connected fails at once and hands the message back.
{
  const emitted = [];
  const offline = new RemoteHostBridge({
    load: () => ({ hosts: [] }), save: () => {}, createIdentity: crypto.createIdentity,
    environment: "fixture", emit: (event) => emitted.push(event), listChanged: () => {}, crypto,
  });
  const dead = { ...gateway.pairing(), relay: "ws://127.0.0.1:9/" };
  const view = await offline.add(JSON.stringify(dead));
  assert.equal(offline.handleClientEvent({ type: "session.start", payload: { cwd: `/aegis-remote/${view.id}/p1/coworker`, prompt: "x", title: "x", provider: "codex", startId: "s-1" } }), true);
  const failure = emitted.find((event) => event.type === "runner.error");
  assert.equal(failure?.payload.startId, "s-1");
  assert.equal(offline.handleClientEvent({ type: "session.start", payload: { cwd: "/Users/me/project", prompt: "x", title: "x" } }), false, "local starts stay local");
  offline.close();
}

// A session's settings chosen on this Mac: the next message from here carries them,
// the composer's and the main bot's, and after that the other Mac's word counts.
{
  const emitted = [];
  let lists = 0;
  /** The list as the window holds it: what the bridge had when it last said the list changed. */
  let published = [];
  const bridge = new RemoteHostBridge({
    load: () => ({ hosts: [] }), save: () => {}, createIdentity: crypto.createIdentity,
    environment: "fixture", emit: (event) => emitted.push(event), crypto, name: "MacBook Air",
    listChanged: () => { lists++; published = bridge.sessions(); },
  });
  extraSessions.push(bubble);
  const view = await bridge.add(JSON.stringify(gateway.pairing()));
  const localId = `rh-${view.id}-b1`;
  const listed = () => bridge.sessions().find((s) => s.id === localId);
  /** What a composer open on the session shows, and so sends in full with its next message. */
  const shown = () => published.find((s) => s.id === localId)?.remoteSettings;
  const titleHere = () => bridge.overview()[0]?.sessions.find((s) => s.id === localId)?.title;
  /** The host says what it has for the session now; resolves once this Mac has heard it. */
  let reports = 0;
  const report = async (settings) => {
    if (settings) bubble.settings = settings;
    bubble.title = `Install deps ${++reports}`;
    // The session row changed over there: every report of a newer host says so.
    bubble.updatedAt += 1;
    gateway.capture({ type: "session.status", payload: { sessionId: "b1", status: "idle" } });
    await until(() => titleHere() === bubble.title, "this Mac heard the host's report", 15000);
  };
  const composer = async (prompt, remoteSettings) => {
    const before = calls.settings.length;
    assert.equal(bridge.handleClientEvent({ type: "session.continue", payload: { sessionId: localId, prompt, ...(remoteSettings ? { remoteSettings } : {}) } }), true);
    await until(() => calls.settings.length === before + 1, "the composer's message reached the host");
    // The answer to the command follows what the host recorded.
    await new Promise((r) => setTimeout(r, 100));
    return calls.settings.at(-1);
  };
  const mainBot = async (prompt) => {
    assert.deepEqual(await bridge.sendTo(localId, prompt), { ok: true });
    return calls.settings.at(-1);
  };
  await until(() => listed(), "the bridge lists the Bubble session", 15000);

  // ── An older host: it reports no mode for Bubble and reads a missing one as its default. ──
  assert.deepEqual(listed().remoteSettings, { model: "kimi" });
  // The main bot's message before anything was chosen says what this Mac knows, in full.
  assert.deepEqual(await mainBot("Carry on"), { model: "kimi" });

  // Full Access picked in the composer, and nothing sent yet: the session shows it, also to a composer opened later.
  const before = lists;
  bridge.choose(localId, { permissionMode: "bypassPermissions", plan: false });
  assert.ok(lists > before, "the session list is sent again with the choice");
  assert.equal(listed().remoteSettings.permissionMode, "bypassPermissions");
  // The main bot's next message runs with it, and so does every one after: this host never says it took it.
  assert.deepEqual(await mainBot("npm ci"), { model: "kimi", permissionMode: "bypassPermissions", plan: false });
  assert.deepEqual(await mainBot("npm test"), { model: "kimi", permissionMode: "bypassPermissions", plan: false });
  // So does a message from a composer that says nothing itself.
  assert.equal((await composer("Again")).permissionMode, "bypassPermissions");
  // The host's list arriving again with the same settings changes nothing.
  await report();
  assert.equal(listed().remoteSettings.permissionMode, "bypassPermissions");
  // What the composer sends with a message is the choice from then on.
  assert.equal((await composer("Careful now", { model: "kimi", permissionMode: "default", plan: false })).permissionMode, "default");
  assert.equal((await mainBot("Still careful")).permissionMode, "default");

  // REMOTE-MODES-UNDEFINED-CLEAR, on this older host. Another model is picked in the composer,
  // which clears the effort there. A message cannot say "no effort", so the host keeps its own:
  // once the message has gone, this Mac shows what the host reports again, not the clear.
  await report({ model: "kimi", effort: "high" });
  bridge.choose(localId, { model: "kimi-2", effort: undefined, fast: undefined });
  assert.equal(listed().remoteSettings.effort, undefined, "cleared in the composer");
  const switched = await composer("On the other model", { model: "kimi-2", permissionMode: "default", plan: false });
  assert.deepEqual([switched.model, switched.effort], ["kimi-2", undefined]);
  assert.equal(listed().remoteSettings.effort, "high", "the effort the host still runs with is shown");
  assert.equal(listed().remoteSettings.model, "kimi-2");
  assert.equal((await mainBot("Same model")).effort, "high", "and said back to a host that keeps nothing");

  // ── A host that reports the mode and keeps what a message leaves out. ──
  bubble.keepsSettings = ["model", "permissionMode", "plan"];
  await report({ model: "kimi", permissionMode: "default" });
  assert.equal(listed().remoteSettings.permissionMode, "default");

  // REMOTE-MODE-03. Nothing is chosen here, and this Mac's copy of the session's settings is
  // behind: the host has since gone to Full Access (a message sent on that Mac itself) and its
  // report is not here yet. The main bot's message must not say the stale Default back.
  bubble.settings = { model: "kimi", permissionMode: "bypassPermissions" };
  assert.equal(listed().remoteSettings.permissionMode, "default", "this Mac's copy is behind");
  assert.deepEqual(await mainBot("Go on"), {}, "nothing chosen here: the host runs the message with its own settings");
  await report();
  assert.equal(listed().remoteSettings.permissionMode, "bypassPermissions");
  // A choice made here is said once, and only it; after that the host has it.
  await report({ model: "kimi", permissionMode: "default" });
  bridge.choose(localId, { permissionMode: "bypassPermissions", plan: false });
  assert.deepEqual(await mainBot("With Full Access"), { permissionMode: "bypassPermissions", plan: false });
  assert.deepEqual(await mainBot("And on"), {}, "said once");
  await report({ model: "kimi", permissionMode: "bypassPermissions" });
  assert.equal(listed().remoteSettings.permissionMode, "bypassPermissions");
  // The session moves on over there (an approved plan, a message from that Mac): this Mac follows.
  await report({ model: "kimi", permissionMode: "default" });
  assert.equal(listed().remoteSettings.permissionMode, "default");
  assert.deepEqual(await mainBot("After the change"), {});
  // And back there to what was once chosen here: still the host's word, not the old choice.
  await report({ model: "kimi", permissionMode: "bypassPermissions" });
  assert.equal(listed().remoteSettings.permissionMode, "bypassPermissions");

  // REMOTE-MODE-01. The host is at Default. Full Access is picked and goes out with a message;
  // before that message's report is back, Default is picked again. The report, when it comes,
  // is of the earlier message: it must not undo the later choice.
  await report({ model: "kimi", permissionMode: "default" });
  bridge.choose(localId, { permissionMode: "bypassPermissions", plan: false });
  assert.equal((await composer("First", { model: "kimi", permissionMode: "bypassPermissions", plan: false })).permissionMode, "bypassPermissions");
  bridge.choose(localId, { permissionMode: "default", plan: false });
  await report({ model: "kimi", permissionMode: "bypassPermissions" });
  assert.equal(listed().remoteSettings.permissionMode, "default", "the later choice outlives the earlier message's report");
  assert.equal((await mainBot("Second")).permissionMode, "default", "the main bot's next message carries the later choice");
  // The same when the earlier message is still on its way as the later choice is made (an upload takes a while).
  await report({ model: "kimi", permissionMode: "default" });
  bridge.choose(localId, { permissionMode: "bypassPermissions", plan: false });
  sendGate = new Promise((r) => (holdSend = r));
  const sentBefore = calls.settings.length;
  bridge.handleClientEvent({ type: "session.continue", payload: { sessionId: localId, prompt: "Slow one", remoteSettings: { model: "kimi", permissionMode: "bypassPermissions", plan: false } } });
  await until(() => calls.settings.length === sentBefore + 1, "the slow message reached the host");
  bridge.choose(localId, { permissionMode: "default", plan: false });
  holdSend();
  sendGate = undefined;
  await new Promise((r) => setTimeout(r, 150));
  await report({ model: "kimi", permissionMode: "bypassPermissions" });
  assert.equal(listed().remoteSettings.permissionMode, "default");
  assert.equal((await mainBot("Third")).permissionMode, "default");
  await report({ model: "kimi", permissionMode: "default" });

  // REMOTE-MODE-01-ACK-ORDER. Default goes out with a message whose answer is late (a dropped
  // connection). The host takes it and is then put back on Full Access over there, and that
  // report is here before the answer. The answer is about the past: what this Mac shows, and
  // what the next message runs with, is the host's newer word.
  await report({ model: "kimi", permissionMode: "bypassPermissions" });
  bridge.choose(localId, { permissionMode: "default", plan: false });
  sendGate = new Promise((r) => (holdSend = r));
  const lateBefore = calls.settings.length;
  const late = bridge.sendTo(localId, "Careful");
  await until(() => calls.settings.length === lateBefore + 1, "the message with Default reached the host");
  assert.equal(calls.settings.at(-1).permissionMode, "default");
  await report({ model: "kimi", permissionMode: "bypassPermissions" });
  holdSend();
  sendGate = undefined;
  assert.deepEqual(await late, { ok: true });
  assert.equal(listed().remoteSettings.permissionMode, "bypassPermissions", "the late answer does not put an older choice over the host's newer report");
  // The window is told at once: no report need follow the answer, and a composer still
  // showing the ended choice would say it back to the host with its next message.
  assert.equal(shown().permissionMode, "bypassPermissions", "the window hears that the choice ended");
  assert.deepEqual(await mainBot("After the late answer"), {});
  // The other way round, which is the one that gives access back: Full Access goes out, the
  // host takes it and is then put back on Default, and that report is here before the answer.
  await report({ model: "kimi", permissionMode: "default" });
  bridge.choose(localId, { permissionMode: "bypassPermissions", plan: false });
  sendGate = new Promise((r) => (holdSend = r));
  const widerBefore = calls.settings.length;
  bridge.handleClientEvent({ type: "session.continue", payload: { sessionId: localId, prompt: "Faster", remoteSettings: { model: "kimi", permissionMode: "bypassPermissions", plan: false } } });
  await until(() => calls.settings.length === widerBefore + 1, "the message with Full Access reached the host");
  await report({ model: "kimi", permissionMode: "default" });
  assert.equal(shown().permissionMode, "bypassPermissions", "the choice waits while its message is unanswered");
  holdSend();
  sendGate = undefined;
  await until(() => listed().remoteSettings.permissionMode === "default", "the answer ended the choice");
  assert.equal(shown().permissionMode, "default", "the window shows the host's Default once the answer is in");
  // The composer's next message, in full as it shows it, leaves the host on Default.
  assert.equal((await composer("Next", shown())).permissionMode, "default", "a withdrawn Full Access is not sent back");

  // REMOTE-MODE-ACK-SAME-VALUE-REPICK. Messages join a turn that runs there, so a second can go
  // while the first is unanswered. Default goes out, and its answer is late. Full Access is
  // picked and goes out, and the host says it has it. Default is picked again, and has not
  // gone out when the first answer arrives. That answer is to the first Default: the one
  // picked since still waits, and the main bot's next message says it.
  bubble.status = "running";
  await report({ model: "kimi", permissionMode: "bypassPermissions" });
  bridge.choose(localId, { permissionMode: "default", plan: false });
  sendGate = new Promise((r) => (holdSend = r));
  const firstDefault = holdSend;
  const repickBefore = calls.settings.length;
  bridge.handleClientEvent({ type: "session.continue", payload: { sessionId: localId, prompt: "Carefully", remoteSettings: { model: "kimi", permissionMode: "default", plan: false } } });
  await until(() => calls.settings.length === repickBefore + 1, "the first Default reached the host");
  sendGate = undefined;
  bridge.choose(localId, { permissionMode: "bypassPermissions", plan: false });
  assert.equal((await composer("Faster after all", { model: "kimi", permissionMode: "bypassPermissions", plan: false })).permissionMode, "bypassPermissions");
  await report({ model: "kimi", permissionMode: "bypassPermissions" });
  bridge.choose(localId, { permissionMode: "default", plan: false });
  firstDefault();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(listed().remoteSettings.permissionMode, "default", "the late answer to the first Default does not settle the Default picked since");
  assert.equal(shown().permissionMode, "default");
  bubble.status = "idle";
  await report();
  assert.equal((await mainBot("Carefully again")).permissionMode, "default", "the host, on Full Access, is told the Default that was picked last");
  await report({ model: "kimi", permissionMode: "default" });

  // A task started from here: the host is told the mode, and the new session shows
  // it at once, before that Mac lists the session.
  const started = await bridge.createTask(view.id, { projectId: "p1", provider: "bubble", prompt: "Build it", settings: { model: undefined, permissionMode: "bypassPermissions" } });
  assert.deepEqual(started, { id: `rh-${view.id}-new` });
  assert.deepEqual(calls.create.at(-1).settings, { permissionMode: "bypassPermissions" });
  assert.equal(bridge.handleClientEvent({ type: "session.start", payload: { cwd: `/aegis-remote/${view.id}/p1/coworker`, prompt: "From the composer", title: "From the composer", provider: "bubble", startId: "s-2", remoteSettings: { permissionMode: "bypassPermissions", plan: false } } }), true);
  await until(() => emitted.some((event) => event.type === "session.status" && event.payload.startId === "s-2"), "composer start confirmed");
  const status = emitted.find((event) => event.type === "session.status" && event.payload.startId === "s-2");
  assert.deepEqual(status.payload.remoteSettings, { permissionMode: "bypassPermissions", plan: false });
  assert.deepEqual(calls.create.at(-1).settings, { permissionMode: "bypassPermissions", plan: false });
  // The session is listed by now: its row carries the choice too, while an older host reports no mode for it.
  extraSessions.push({ id: "new", projectId: "p1", title: "From the composer", provider: "bubble", status: "idle", updatedAt: 2, runId: null, settings: {} });
  await report();
  await until(() => bridge.sessions().some((s) => s.id === `rh-${view.id}-new`), "the new session is listed");
  assert.equal(bridge.sessions().find((s) => s.id === `rh-${view.id}-new`).remoteSettings.permissionMode, "bypassPermissions");

  // The answer to a start is late, and the session is listed here before it: a mode picked for
  // it in the meantime is the newer word, not what the start said.
  startGate = new Promise((r) => (holdStart = r));
  const createdBefore = calls.create.length;
  const slowStart = bridge.createTask(view.id, { projectId: "p1", provider: "bubble", prompt: "Slow start", settings: { permissionMode: "bypassPermissions" } });
  await until(() => calls.create.length === createdBefore + 1, "the start reached the host");
  bridge.choose(`rh-${view.id}-new`, { permissionMode: "default" });
  holdStart();
  startGate = undefined;
  assert.deepEqual(await slowStart, { id: `rh-${view.id}-new` });
  assert.equal(bridge.sessions().find((s) => s.id === `rh-${view.id}-new`).remoteSettings.permissionMode, "default", "the start's late answer does not replace a choice made since");

  // A choice for a session that isn't there is dropped quietly.
  bridge.choose("rh-000000000000-nope", { permissionMode: "bypassPermissions" });
  bridge.close();
  extraSessions.length = 0;
  gateway.capture({ type: "session.status", payload: { sessionId: "b1", status: "idle" } });
}

// Revoking ends the first controller's access for good.
const peer = gateway.describe().devices[0].peerId;
gateway.revoke(peer);
await until(() => client.status === "revoked", "revoked");

client.close();
gateway.close();
await relay.close();

// A relay that only takes one controller still works for one, across reconnects.
{
  const oldRelay = createRelay({ port: 0, maxTunnels: 0 });
  const { port: oldPort } = await oldRelay.listen();
  const oldGateway = new RemoteGateway(new RemoteJournal(join(dir, "old.enc"), (v) => v, (v) => v), runtime());
  await oldGateway.configure(`ws://127.0.0.1:${oldPort}`);
  await until(() => oldGateway.status === "waiting", "registered on the old relay");
  const into = { statuses: [], state: null, history: [], live: "", replaced: 0 };
  const oldClient = makeClient(oldGateway.pairing(), identity, into);
  oldClient.connect();
  await until(() => oldClient.status === "connected", "connected over the old relay");
  await until(() => into.state, "state over the old relay");
  oldClient.socket.terminate();
  await until(() => oldClient.status !== "connected", "dropped from the old relay");
  await until(() => oldClient.status === "connected", "back on the old relay", 15000);
  oldClient.close();
  oldGateway.close();
  await oldRelay.close();
}

// Direct path: found after the first relay connection, preferred from then on, and
// the relay takes over when it stops answering.
{
  const directRelay = createRelay({ port: 0 });
  const { port: directPort } = await directRelay.listen();
  const directGateway = new RemoteGateway(new RemoteJournal(join(dir, "direct.enc"), (v) => v, (v) => v), { ...runtime(), lan: { host: "127.0.0.1" } });
  await directGateway.configure(`ws://127.0.0.1:${directPort}`);
  await until(() => directGateway.status === "waiting", "registered for direct");
  const into = { statuses: [], state: null, history: [], live: "", replaced: 0 };
  const learned = [];
  const pairing = directGateway.pairing();
  const direct = new RemoteHostClient({
    pairing, identity: identity.privateKey, name: "MacBook Pro", crypto,
    events: {
      status: () => {}, lan: (lan) => learned.push(lan), state: (s) => (into.state = s),
      history: () => {}, live: () => {},
    },
  });
  direct.connect();
  await until(() => direct.status === "connected" && direct.transport === "direct", "moved to direct");
  assert.ok(learned.length > 0, "the address was reported for saving");
  await until(() => into.state, "state over direct");
  const answer = await direct.command("stop", { sessionId: "s1", runId: "stale" });
  assert.equal(answer.state, "rejected", "commands work over direct");
  direct.close();
  // Started again with the saved address: straight to direct, no relay needed.
  await directRelay.close();
  const { invite: _i, expiresAt: _e, ...paired } = pairing;
  const again = new RemoteHostClient({
    pairing: paired, identity: identity.privateKey, name: "MacBook Pro", crypto, lan: learned.at(-1),
    events: { status: () => {}, state: () => {}, history: () => {}, live: () => {} },
  });
  again.connect();
  await until(() => again.status === "connected" && again.transport === "direct", "direct with the relay down");
  again.close();
  directGateway.close();
}
rmSync(dir, { recursive: true, force: true });
console.log("host client: ok");
process.exit(0);
