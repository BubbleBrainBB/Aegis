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
const histories = { s1: [text("a", "user", "Hello")], big: bigHistory };
const pending = new Set();
const calls = { send: 0, stop: 0, permission: [], create: [] };
let sendGate;
let gateway;
const runtime = () => ({
  environment: "fixture",
  lan: false,
  projects: () => [{ id: "p1", name: "coworker", path: dir, isRepo: true }],
  sessions: () => [session, big],
  history: (id) => histories[id] ?? [],
  start: async (project, provider, prompt, extras) => {
    calls.create.push({ project: project.id, provider, prompt, worktree: extras?.worktree });
    return "new";
  },
  send: async (id, prompt) => {
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
