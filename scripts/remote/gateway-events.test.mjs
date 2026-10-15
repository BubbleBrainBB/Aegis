// Event phones: pushed state/history/live events, tail sync, the direct (same network)
// listener and the handover between a relay and a direct connection.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createRelay } from "../../services/relay/server.mjs";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const { RemoteGateway, lanToken } = require("../../dist-electron/electron/remote/gateway.js");
const { RemoteJournal } = require("../../dist-electron/electron/remote/journal.js");
const { createIdentity, secureChannel } = require("../../dist-electron/electron/remote/secure-channel.cjs");

const dir = mkdtempSync(join(tmpdir(), "aegis-remote-events-"));
const relay = createRelay({ port: 0 });
const { port } = await relay.listen();
const host = await createIdentity();
const phoneId = await createIdentity();
const stranger = await createIdentity();
const sessions = [
  { id: "s1", projectId: "p", title: "One", provider: "claude", status: "idle", updatedAt: 1, runId: null },
  { id: "s2", projectId: "p", title: "Two", provider: "claude", status: "idle", updatedAt: 1, runId: null },
];
const history = {
  s1: Array.from({ length: 3 }, (_, i) => ({ id: "m" + i, role: i % 2 ? "assistant" : "user", text: "message " + i })),
  s2: [{ id: "x0", role: "user", text: "other" }],
};
let historyReads = 0;
const runtime = {
  lan: { host: "127.0.0.1" },
  projects: () => [{ id: "p", name: "P", path: dir }],
  sessions: () => sessions,
  history: (id) => {
    historyReads++;
    return history[id] ?? [];
  },
  start: async () => null,
  send: async () => true,
  stop: () => {},
  permission: () => true,
  hasPermission: () => true,
  confirm: async () => true,
};
const journal = new RemoteJournal(join(dir, "state"), (x) => x, (x) => x);
journal.update((s) => {
  s.config = {
    enabled: true,
    relay: `ws://127.0.0.1:${port}/`,
    room: "0".repeat(32),
    routeToken: "r".repeat(64),
    identity: host.privateKey,
    peerId: host.peerId,
  };
  s.devices = [{ peerId: phoneId.peerId, name: "Phone", pairedAt: 1 }];
});
const gateway = new RemoteGateway(journal, runtime);
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (data) => (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString();

/** A phone-side connection: hello, Noise as initiator pinning the Mac, then auth. */
async function open(url, { identity = phoneId, direct = false, token, auth = {} } = {}) {
  const socket = new WebSocket(url, { perMessageDeflate: false });
  socket.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const routeToken = journal.state.config.routeToken;
  // Directly, the phone proves a token derived from the route token, never the route token itself.
  socket.send(JSON.stringify(direct ? { role: "phone", token: token ?? lanToken(routeToken) } : { role: "phone", room: journal.state.config.room, token: token ?? routeToken }));
  const control = await new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(text(data))));
    socket.once("close", () => resolve({ type: "closed" }));
  });
  if (control.type !== "peer") return { refused: control };
  const channel = await secureChannel(socket, identity.privateKey, true, host.peerId);
  const inbox = [];
  const waiters = [];
  void (async () => {
    try {
      for await (const message of channel.messages) {
        inbox.push(message);
        for (const waiter of [...waiters]) waiter();
      }
    } catch {}
    inbox.push({ type: "closed" });
    for (const waiter of [...waiters]) waiter();
  })();
  /** Resolves with the first message (after `from`) matching `test`. */
  const next = (test, timeout = 3000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const index = inbox.findIndex(test);
        if (index < 0) return false;
        waiters.splice(waiters.indexOf(check), 1);
        clearTimeout(timer);
        resolve(inbox.splice(index, 1)[0]);
        return true;
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(check), 1);
        reject(new Error("timed out waiting; inbox: " + JSON.stringify(inbox).slice(0, 400)));
      }, timeout);
      waiters.push(check);
      check();
    });
  let sequence = 0;
  const request = async (body) => {
    const id = "q" + ++sequence + Math.random();
    channel.send({ id, ...body });
    return next((m) => m.type === "response" && m.id === id);
  };
  channel.send({ type: "auth", protocol: "aegis.remote.v1", environment: "development", name: "Phone", ...auth });
  const first = await next((m) => m.type === "authenticated" || m.type === "auth-rejected");
  return { channel, socket, inbox, next, request, first, seq: first.snapshot?.seq ?? 0 };
}
const event = (phone) => phone.next((m) => m.type === "event");
/** Events until each named part arrived, merged; checks they're numbered without gaps. */
async function take(phone, ...parts) {
  const merged = {};
  while (!parts.every((part) => part in merged)) {
    const e = await event(phone);
    assert.equal(e.seq, phone.seq + 1, "events are numbered without gaps");
    phone.seq = e.seq;
    for (const key of ["state", "history", "live"]) if (key in e) merged[key] = e[key];
  }
  return { ...merged, seq: phone.seq };
}

try {
  gateway.connect();
  for (let i = 0; i < 100 && gateway.status !== "waiting"; i++) await settle();
  assert.equal(gateway.status, "waiting");
  const relayUrl = `ws://127.0.0.1:${port}/`;

  // An event phone gets its first snapshot with the answer, plus where to reach the Mac directly.
  const viaRelay = await open(relayUrl, { auth: { features: ["events"], sessionId: "s1" } });
  const auth = viaRelay.first;
  assert.equal(auth.type, "authenticated");
  assert.equal(auth.snapshot.sessionId, "s1");
  assert.deepEqual(auth.snapshot.messages.map((m) => m.id), ["m0", "m1", "m2"]);
  assert.equal(auth.snapshot.historyCount, 3);
  assert.equal(auth.snapshot.seq, 0);
  assert.deepEqual(auth.lan.addresses, ["127.0.0.1"]);
  assert.equal(gateway.status, "connected");
  const lanUrl = `ws://127.0.0.1:${auth.lan.port}/`;

  // Streamed text arrives as events: the whole text first, then only what was added.
  const delta = (sessionId, chunk) =>
    gateway.capture({ type: "stream.message", payload: { sessionId, message: { type: "stream_event", event: { delta: { type: "text_delta", text: chunk } } } } });
  const reads = historyReads;
  delta("s1", "Hel");
  let e = await take(viaRelay, "live");
  assert.deepEqual(e.live, { sessionId: "s1", text: "Hel" });
  delta("s1", "lo");
  delta("s1", " there");
  e = await take(viaRelay, "live");
  assert.deepEqual(e.live, { sessionId: "s1", append: "lo there" });
  assert.equal(e.history, undefined);
  assert.equal(historyReads, reads, "streamed text never re-reads the history");
  // Another session's text isn't sent to a phone looking at s1.
  delta("s2", "elsewhere");
  await settle(120);
  assert.equal(viaRelay.inbox.filter((m) => m.type === "event").length, 0);
  // Unstored in-progress assistant messages (older Codex, Kimi) don't re-read the history either.
  gateway.capture({ type: "stream.message", payload: { sessionId: "s1", message: { type: "assistant", streaming: true, message: { content: [] } } } });
  gateway.capture({ type: "stream.tool_output_delta", payload: { sessionId: "s1", toolUseId: "t", delta: "..." } });
  await settle(120);
  assert.equal(historyReads, reads);
  assert.equal(viaRelay.inbox.filter((m) => m.type === "event").length, 0);

  // A committed reply: the history grows by one and the live text clears, in one event.
  history.s1.push({ id: "m3", role: "assistant", text: "Hello there" });
  gateway.capture({ type: "stream.message", payload: { sessionId: "s1", message: { type: "assistant" } } });
  e = await event(viaRelay);
  viaRelay.seq = e.seq;
  assert.equal(e.history.appendFrom, 3);
  assert.deepEqual(e.history.messages.map((m) => m.id), ["m3"]);
  assert.equal(e.history.count, 4);
  assert.deepEqual(e.live, { sessionId: "s1", text: null });
  const head = e.history.revision;

  // A status change reaches the list as a state event.
  sessions[0] = { ...sessions[0], status: "running" };
  gateway.capture({ type: "session.status", payload: { sessionId: "s1", status: "running" } });
  e = await take(viaRelay, "state");
  assert.equal(e.state.sessions.find((s) => s.id === "s1").status, "running");
  assert.ok(e.state.sessions.find((s) => s.id === "s1").runId);

  // History rewritten before the phone's tail: it gets the page again, not an append.
  history.s1[1] = { ...history.s1[1], text: "edited" };
  gateway.capture({ type: "session.status", payload: { sessionId: "s1", status: "running" } });
  e = await take(viaRelay, "history");
  assert.equal(e.history.appendFrom, undefined);
  assert.deepEqual(e.history.messages.map((m) => m.id), ["m0", "m1", "m2", "m3"]);
  assert.equal(e.history.before, null);
  const rewritten = e.history.revision;
  assert.notEqual(rewritten, head);

  // A burst of commits: the history is re-read at most every 150 ms, not per commit.
  const burst = historyReads;
  for (let i = 0; i < 5; i++) gateway.capture({ type: "session.status", payload: { sessionId: "s1", status: "running" } });
  await settle(250);
  assert.ok(historyReads - burst <= 2, `re-read ${historyReads - burst} times`);

  // Tail sync: a matching tail gets only what follows it; a stale one the whole page.
  history.s1.push({ id: "m4", role: "user", text: "next" });
  gateway.capture({ type: "stream.user_prompt", payload: { sessionId: "s1", prompt: "next" } });
  e = await take(viaRelay, "history");
  assert.deepEqual(e.history.messages.map((m) => m.id), ["m4"]);
  let r = await viaRelay.request({ method: "snapshot", sessionId: "s1", tail: { count: 4, hash: rewritten } });
  assert.equal(r.result.appendFrom, 4);
  assert.deepEqual(r.result.messages.map((m) => m.id), ["m4"]);
  assert.equal(r.result.seq, viaRelay.seq);
  r = await viaRelay.request({ method: "snapshot", sessionId: "s1", tail: { count: 4, hash: head } });
  assert.equal(r.result.appendFrom, undefined);
  assert.equal(r.result.messages.length, 5);
  r = await viaRelay.request({ method: "snapshot", sessionId: "s1", tail: { count: 9, hash: head } });
  assert.equal(r.result.messages.length, 5);
  // Older pages check the tail too.
  r = await viaRelay.request({ method: "snapshot", sessionId: "s1", before: 2, tail: { count: 5, hash: r.result.historyRevision } });
  assert.deepEqual(r.result.messages.map((m) => m.id), ["m0", "m1"]);
  r = await viaRelay.request({ method: "snapshot", sessionId: "s1", before: 2, tail: { count: 4, hash: head } });
  assert.equal(r.error, "HISTORY_CHANGED");
  // Subscribing elsewhere moves the events with it.
  await viaRelay.request({ method: "snapshot", sessionId: "s2" });
  delta("s1", "not for s2");
  delta("s2", "for s2");
  e = await take(viaRelay, "live");
  assert.deepEqual(e.live, { sessionId: "s2", append: "for s2" }, "the s2 snapshot already carried its earlier text");

  // The direct listener: wrong token and unpaired phones are turned away.
  assert.equal(lanToken("r".repeat(64)), "3bad58f0c6097c530dac4d10368bc56cf3d636a778ecd06595a6fe3a02724233", "same vector as the Swift test");
  assert.equal((await open(lanUrl, { direct: true, token: "x".repeat(64) })).refused.type, "closed");
  assert.equal((await open(lanUrl, { direct: true, token: journal.state.config.routeToken })).refused.type, "closed", "the route token itself is not accepted directly");
  assert.equal((await open(lanUrl, { direct: true, identity: stranger })).first.type, "auth-rejected");
  // Malformed hellos close the socket instead of throwing and leaving it open.
  for (const hello of ["null", "[]", JSON.stringify({ role: "phone", token: "é".repeat(64) })]) {
    const socket = new WebSocket(lanUrl);
    await new Promise((resolve) => socket.once("open", resolve));
    const closed = new Promise((resolve) => socket.once("close", resolve));
    socket.send(hello);
    await Promise.race([closed, settle(2000).then(() => assert.fail("socket left open after " + hello))]);
  }
  // A paired phone connecting directly takes over the events from its relay connection.
  const direct = await open(lanUrl, { direct: true, auth: { features: ["events"], sessionId: "s2" } });
  assert.equal(direct.first.type, "authenticated");
  assert.equal(direct.first.snapshot.seq, 0);
  delta("s2", " again");
  e = await take(direct, "live");
  assert.deepEqual([e.seq, e.live], [1, { sessionId: "s2", append: " again" }]);
  await settle(120);
  assert.equal(viaRelay.inbox.filter((m) => m.type === "event").length, 0, "only the newest connection gets events");
  // Requests still work on the older connection while the phone drains it.
  assert.ok((await viaRelay.request({ method: "ping" })).result.serverTime);
  // Presence from the phone covers all its connections: a lingering one never holds back pushes.
  await direct.request({ method: "presence", background: true });
  assert.ok([...gateway.links].every((l) => l.away));
  await viaRelay.request({ method: "presence", background: false });
  assert.ok([...gateway.links].every((l) => !l.away));
  assert.equal(gateway.status, "connected");
  // The direct one ends: the relay connection gets the events again, from what it last had.
  direct.channel.close();
  for (let i = 0; i < 50 && gateway.links.size > 1; i++) await settle();
  // At once, without waiting for another change, it catches up on what it missed.
  e = await take(viaRelay, "live");
  assert.deepEqual(e.live, { sessionId: "s2", append: " again" });
  delta("s2", "!");
  e = await take(viaRelay, "live");
  assert.deepEqual(e.live, { sessionId: "s2", append: "!" });
  // Archived while the phone looks at it: the list drops it and its history stops coming.
  const archived = sessions.splice(1, 1)[0];
  gateway.capture({ type: "session.status", payload: { sessionId: "s2", status: "idle" } });
  e = await take(viaRelay, "state");
  assert.equal(e.state.sessions.some((s) => s.id === "s2"), false);
  assert.equal(e.history, undefined);
  sessions.push(archived);

  // An older phone (no events feature) still gets "changed" and polls.
  viaRelay.channel.close();
  for (let i = 0; i < 100 && gateway.links.size; i++) await settle();
  // The relay restarts the Mac's side when its phone leaves; it comes straight back.
  await settle(300);
  for (let i = 0; i < 100 && gateway.status !== "waiting"; i++) await settle();
  const legacy = await open(relayUrl);
  assert.equal(legacy.first.type, "authenticated");
  assert.equal(legacy.first.snapshot, undefined);
  delta("s2", "?");
  await legacy.next((m) => m.type === "changed");
  r = await legacy.request({ method: "snapshot", sessionId: "s2" });
  assert.equal(r.result.seq, undefined);
  assert.equal(r.result.messages.at(-1).text, "?", "the idle status cleared the earlier text");
  legacy.channel.close();
  console.log("Gateway events: first snapshot on auth, live deltas, committed appends, state events, rewrites, tail sync, subscriptions, direct listener gating, handover and older phones passed");
} finally {
  gateway.close();
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
}
