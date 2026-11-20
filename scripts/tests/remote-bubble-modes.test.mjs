// A Bubble task on another Mac keeps the permission mode it was given, end to
// end: this Mac's bridge (what the composer and the main bot's start_task /
// message_task go through), a real relay, and on the other side the real
// gateway and the real session handlers (startSession / handleSessionContinue,
// the runner, the Bubble adapter) on the real Bubble SDK with a scripted model.
// What is asserted is the mode each turn was really started in.
//
// The main bot's own start_task and message_task run for real too, in a second
// process that is "this Mac": a whole main process of its own (its handlers,
// its bot, its bridge), paired with the first over the relay.
//
// No Electron: the main process modules run under Node with `electron` stubbed.
// Run: npm run transpile:electron && node scripts/tests/remote-bubble-modes.test.mjs
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../../services/relay/server.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'aegis-remote-bubble-')));
const project = path.join(tmp, 'project');
mkdirSync(project, { recursive: true });
writeFileSync(path.join(project, 'README.md'), '# project\n');
// The handlers set up the whole app, which registers its local MCP servers in
// the agents' own configuration (Kimi's mcp.json among them), retires entries
// earlier versions wrote there, and looks for the agents' CLIs. None of that
// may reach the real home of whoever runs this.
//
// What this process inherited stands in for that real home here: sentinel
// files, in a folder the test never names again, hold exactly the entries the
// app's start-up rewrites, and the inherited environment points at them the way
// a developer's shell (or an agent Aegis started) might. They must be untouched
// at the end.
const outside = path.join(tmp, 'outside');
mkdirSync(path.join(outside, 'kimi-code'), { recursive: true });
const retired = JSON.stringify({ mcpServers: { 'aegis-delegate': { url: 'http://127.0.0.1:1/mcp' }, 'aegis-browser': { url: 'http://127.0.0.1:1/mcp' } } });
const sentinels = {
  [path.join(outside, 'codex-mcp.toml')]: '[mcp_servers.aegis-delegate]\nurl = "http://127.0.0.1:1/mcp"\n',
  [path.join(outside, 'codex-user.toml')]: '[mcp_servers.aegis-delegate]\nurl = "http://127.0.0.1:1/mcp"\n',
  [path.join(outside, 'kimi-code/mcp.json')]: retired,
  [path.join(outside, 'kimi-legacy.json')]: retired,
};
for (const [file, content] of Object.entries(sentinels)) writeFileSync(file, content);
Object.assign(process.env, {
  HOME: outside,
  AEGIS_CODEX_MCP_CONFIG_PATH: path.join(outside, 'codex-mcp.toml'),
  AEGIS_CODEX_USER_CONFIG_PATH: path.join(outside, 'codex-user.toml'),
  KIMI_CODE_HOME: path.join(outside, 'kimi-code'),
  AEGIS_KIMI_LEGACY_MCP_PATH: path.join(outside, 'kimi-legacy.json'),
});

// The isolation. Every path the main process modules resolve is sent into the
// temporary home, and nothing Aegis-specific is inherited: a path override set
// for another Aegis must not point this one outside.
for (const name of Object.keys(process.env)) if (name.startsWith('AEGIS_')) delete process.env[name];
const home = path.join(tmp, 'home');
mkdirSync(home, { recursive: true });
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  BUBBLE_HOME: path.join(tmp, 'bubble-home'),
  KIMI_CODE_HOME: path.join(home, '.kimi-code'),
  CODEX_HOME: path.join(home, '.codex'),
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local/share'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  AEGIS_KIMI_LEGACY_MCP_PATH: path.join(home, '.kimi/mcp.json'),
  AEGIS_CODEX_USER_CONFIG_PATH: path.join(home, '.codex/config.toml'),
  AEGIS_CODEX_MCP_CONFIG_PATH: path.join(home, 'aegis-codex-mcp.toml'),
  // Browser Use and the Kimi widget entry write nothing to provider configs in this mode.
  AEGIS_BROWSER_USE_TEST_MODE: '1',
  // The two sides talk through the relay, as two Macs in different places do.
  AEGIS_REMOTE_LAN: '0',
});
process.setMaxListeners(64);

// ── Electron, as far as the main process modules touch it here. ──
const handlers = new Map();
const listeners = new Map();
const anything = new Proxy(function () {}, { get: (_t, key) => (key === 'then' ? undefined : anything), apply: () => anything, construct: () => anything });
const loose = (known) => new Proxy(known, { get: (target, key) => (key in target ? target[key] : anything) });
const electron = loose({
  app: loose({ getPath: () => path.join(tmp, 'profile'), isPackaged: false, getAppPath: () => root, getName: () => 'Aegis', getVersion: () => '0.0.0', on() {}, once() {}, whenReady: () => Promise.resolve() }),
  ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn), removeHandler: (name) => handlers.delete(name), removeAllListeners() {} },
  // The gateway keeps its pairings in the keychain; here they are kept as they are.
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => Buffer.from(value).toString() },
  // "Allow this device to use Aegis on this Mac?"
  dialog: loose({ showMessageBox: async () => ({ response: 1 }) }),
});
mkdirSync(path.join(tmp, 'profile'), { recursive: true });
const load = Module._load;
Module._load = function (name, ...rest) { return name === 'electron' ? electron : load.call(this, name, ...rest); };

// The handlers log every start and send in development.
const log = console.log;
console.log = (...args) => { if (!/^\[(Session|Runner|ProviderService|feishu)/.test(String(args[0]))) log(...args); };

const until = async (check, label, ms = 15000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};
const gate = () => {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
};
/** `promise`, or a failure once `ms` have passed: nothing here may wait for ever. */
const within = (promise, ms, label) => {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};
const USAGE = { type: 'usage', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } };
const text = (content) => [{ type: 'text', content }, USAGE, { type: 'done' }];
const callTool = (id, name, args) => [{ type: 'tool_call', id, name, arguments: JSON.stringify(args), isStart: true, isEnd: true }, USAGE, { type: 'done' }];

/** A window of the app, as far as the handlers need one: what it is sent, and what it sends. */
function appWindow() {
  const events = [];
  const frame = { url: 'http://127.0.0.1:10087' };
  const webContents = { id: 1, mainFrame: frame, isDestroyed: () => false, send: (_channel, json) => { try { events.push(JSON.parse(json)); } catch { /* not an event */ } }, on() {}, once() {} };
  const window = loose({ isDestroyed: () => false, webContents: loose(webContents), on() {}, once() {} });
  const invoke = (channel, ...args) => handlers.get(channel)({ sender: webContents, senderFrame: frame }, ...args);
  const send = (event) => listeners.get('client-event')({ sender: webContents, senderFrame: frame }, JSON.stringify(event));
  return { window, events, invoke, send };
}

/**
 * "This Mac", in a process of its own: the whole main process, with the composer
 * set to Full Access for Bubble. It pairs with the other Mac when told, and runs
 * the main bot's tools as the bot's conversation would call them.
 */
async function thisMac() {
  writeFileSync(path.join(tmp, 'profile', 'renderer-state.json'), JSON.stringify({
    'cowork.preferredProvider': 'bubble',
    'cowork.preferredBubblePermissionMode': 'bypassPermissions',
  }));
  require(path.join(root, 'dist-electron/electron/remote/relay-auth.js')).machineName = () => 'MacBook';
  const app = require(path.join(root, 'dist-electron/electron/ipc-handlers.js'));
  require(path.join(root, 'dist-electron/electron/libs/session-store.js')).initialize();
  const { window, invoke } = appWindow();
  app.setupIPCHandlers(window);
  const tools = require(path.join(root, 'dist-electron/electron/libs/main-bot/tools.js')).createMainBotTools();
  const actions = {
    pair: async ({ link }) => {
      const added = await invoke('remote-hosts', 'add', { link });
      await until(async () => (await invoke('remote-hosts', 'list')).find((entry) => entry.id === added.id && entry.status === 'connected' && entry.projects.length), 'this Mac sees the other Mac\'s projects');
      return (await invoke('remote-hosts', 'list')).find((entry) => entry.id === added.id);
    },
    tool: ({ name, args }) => tools.find((tool) => tool.name === name).execute(args),
    exit: async () => {
      setImmediate(() => {
        try { app.cleanup(); } catch { /* closing */ }
        rmSync(tmp, { recursive: true, force: true });
        process.exit(0);
      });
      return true;
    },
  };
  process.on('message', async ({ id, action, ...input }) => {
    try {
      process.send({ id, result: await actions[action](input) });
    } catch (failure) {
      process.send({ id, error: failure instanceof Error ? failure.stack : String(failure) });
    }
  });
  process.send({ ready: true });
  await new Promise(() => {});
}
if (process.argv.includes('--this-mac')) await thisMac();

let relay;
let ipc;
let bridge;
let otherProcess;
let passed = false;
try {
  // ── The other Mac: the real handlers, on a Bubble SDK whose model is a script. ──
  const { BubbleSdk } = await import('@bubblebrain-ai/bubble');
  const { registerDynamicModelMetadata } = await import('@bubblebrain-ai/bubble/dist/model-catalog.js');
  registerDynamicModelMetadata({ providerId: 'openai', id: 'aegis-mode-test', contextWindow: 128000 });
  const loader = require(path.join(root, 'dist-electron/electron/libs/provider/bubble-sdk-loader.js'));
  const sdk = new BubbleSdk({ defaultCwd: project, mcp: false });
  sdk.getModelConfig = () => ({ defaultProviderId: 'openai', defaultModel: 'openai:aegis-mode-test', providers: [{ id: 'openai', hasApiKey: true }] });
  /** What the model answers next, in order; each entry is chunks or a function that may wait. */
  const script = [];
  let modelCalls = 0;
  sdk.resolveProvider = () => ({
    providerId: 'openai',
    model: 'aegis-mode-test',
    provider: {
      async *streamChat(messages) {
        modelCalls += 1;
        const step = script.shift();
        yield* typeof step === 'function' ? await step(messages) : step ?? text('Done.');
      },
    },
  });
  /** The options of every turn the adapter started: `mode` is the permission mode it really ran in. */
  const turns = [];
  const runTurn = sdk.runTurn.bind(sdk);
  sdk.runTurn = (sessionId, options) => {
    turns.push({ mode: options.mode, planExitMode: options.planExitMode });
    return runTurn(sessionId, options);
  };
  loader.getBubbleSdk = async () => sdk;

  ipc = require(path.join(root, 'dist-electron/electron/ipc-handlers.js'));
  const store = require(path.join(root, 'dist-electron/electron/libs/session-store.js'));
  require(path.join(root, 'dist-electron/electron/remote/relay-auth.js')).machineName = () => 'Mac mini';
  /** `hostSend`: an event from that Mac's own window, as its composer sends one. */
  const { window, events: hostEvents, invoke, send: hostSend } = appWindow();
  store.initialize();
  ipc.setupIPCHandlers(window);
  // A project appears on the other Mac's list once a session has worked in it.
  store.createSession({ title: 'Seed', cwd: project, provider: 'bubble' });

  relay = createRelay({ port: 0 });
  const { port } = await relay.listen();
  await invoke('remote-companion', 'configure', { relay: `ws://127.0.0.1:${port}`, token: '' });
  await until(async () => ['waiting', 'connected'].includes((await invoke('remote-companion', 'status')).status), 'the other Mac registered with the relay');
  const { url: link } = await invoke('remote-companion', 'pair');

  // ── This Mac: the bridge the composer and the main bot use. ──
  const crypto = require(path.join(root, 'dist-electron/electron/remote/secure-channel.cjs'));
  const { RemoteHostBridge } = require(path.join(root, 'dist-electron/electron/remote/host-bridge.js'));
  const emitted = [];
  bridge = new RemoteHostBridge({
    load: () => ({ hosts: [] }), save() {}, createIdentity: crypto.createIdentity,
    environment: 'development', emit: (event) => emitted.push(event), listChanged() {}, crypto, name: 'MacBook',
  });
  const host = await bridge.add(link);
  await until(() => bridge.list().find((entry) => entry.id === host.id)?.status === 'connected', 'this Mac is connected to the other');
  assert.equal(bridge.list().find((entry) => entry.id === host.id).transport, 'relay', 'through the relay, not a direct path');
  const overview = () => bridge.overview().find((device) => device.id === host.id);
  const projectId = (await until(() => overview()?.projects.find((entry) => entry.name === 'project'), 'the project is listed here')).id;
  const remoteId = (localId) => localId.slice(`rh-${host.id}-`.length);
  const row = (localId) => store.getSession(remoteId(localId));
  const listed = (localId) => bridge.sessions().find((session) => session.id === localId);
  const idle = (localId) => until(() => row(localId)?.status !== 'running' && overview()?.sessions.find((session) => session.id === localId)?.status !== 'running', 'the turn ended');
  // The Bubble adapter the runners use: how many agent sessions it was asked to start, and which it holds.
  const { getProviderService } = require(path.join(root, 'dist-electron/electron/libs/provider/service.js'));
  const bubbleAdapter = getProviderService().getAdapter('bubble');
  let bubbleStarts = 0;
  const startBubble = bubbleAdapter.startSession.bind(bubbleAdapter);
  bubbleAdapter.startSession = (input) => { bubbleStarts += 1; return startBubble(input); };
  /** The runner that Mac holds for a session is gone, as after its idle reaper or a restart of the app. */
  const dropRunner = async (localId) => {
    assert.equal(bubbleAdapter.hasSession(remoteId(localId)), true, 'a runner holds the session');
    hostSend({ type: 'session.stop', payload: { sessionId: remoteId(localId) } });
    await until(() => !bubbleAdapter.hasSession(remoteId(localId)), 'the runner is gone');
  };

  /** The Bubble mode that Mac's own window was last told for a session: what its composer goes by. */
  const windowMode = (sessionId) => hostEvents.filter((event) => event.type === 'session.status' && event.payload.sessionId === sessionId && event.payload.bubblePermissionMode).at(-1)?.payload.bubblePermissionMode;
  /**
   * A message from that Mac's own composer, as PromptInput builds one for Bubble: Plan while the
   * window holds the session in plan (useComposerAgentSelection), else the picker's mode, and
   * always the picker's mode as the one to leave a plan for.
   */
  const composerMessage = (sessionId, prompt, picker) => ({ type: 'session.continue', payload: {
    sessionId, prompt, provider: 'bubble',
    bubblePermissionMode: windowMode(sessionId) === 'plan' ? 'plan' : picker,
    bubblePlanExitMode: picker === 'bypassPermissions' ? 'bypassPermissions' : 'default',
  } });

  // ── 1. The main bot's start_task with Full Access, then message_task. ──
  script.push(text('Installed.'));
  const started = await bridge.createTask(host.id, { projectId, provider: 'bubble', prompt: 'npm ci', settings: { permissionMode: 'bypassPermissions' } });
  assert.ok(started.id, JSON.stringify(started));
  await until(() => turns.length === 1, 'the first turn started');
  assert.equal(turns[0].mode, 'bypassPermissions', 'the task starts in the mode the bot named');
  await idle(started.id);
  assert.equal(row(started.id).bubble_permission_mode, 'bypassPermissions', 'the session keeps its mode');
  await until(() => listed(started.id)?.remoteSettings?.permissionMode === 'bypassPermissions', 'the mode is reported to this Mac');

  // message_task names nothing: the turn runs in the session's mode.
  script.push(text('Still going.'));
  assert.deepEqual(await bridge.sendTo(started.id, 'Carry on'), { ok: true });
  await until(() => turns.length === 2, 'the second turn started');
  assert.equal(turns[1].mode, 'bypassPermissions', 'a message that names no mode keeps Full Access');
  await idle(started.id);

  // Also once the runner that held the mode is gone.
  assert.equal(bubbleStarts, 1, 'the second message reused the runner');
  await dropRunner(started.id);
  script.push(text('Back again.'));
  assert.deepEqual(await bridge.sendTo(started.id, 'And again'), { ok: true });
  await until(() => turns.length === 3, 'the third turn started');
  assert.equal(bubbleStarts, 2, 'a fresh runner took the message');
  assert.equal(turns[2].mode, 'bypassPermissions', 'a cold start runs in the session\'s mode');
  await idle(started.id);

  // A message sent on that Mac itself goes to Default. The main bot's message from here has
  // nothing to say about the mode, and whatever copy of the session's settings is here by
  // then, it is not said back: the turn runs in that Mac's current mode.
  script.push(text('Now careful.'));
  hostSend({ type: 'session.continue', payload: { sessionId: remoteId(started.id), prompt: 'Be careful from here', provider: 'bubble', bubblePermissionMode: 'default', bubblePlanExitMode: 'default' } });
  await until(() => turns.length === 4, 'the turn sent on that Mac started');
  assert.equal(turns[3].mode, 'default');
  await until(() => row(started.id)?.status !== 'running', 'that turn ended');
  script.push(text('Carefully done.'));
  assert.deepEqual(await bridge.sendTo(started.id, 'One more'), { ok: true });
  await until(() => turns.length === 5, 'the fifth turn started');
  assert.equal(turns[4].mode, 'default', 'the main bot\'s message does not put back a mode that Mac has left');
  await idle(started.id);
  await until(() => listed(started.id)?.remoteSettings?.permissionMode === 'default', 'this Mac shows the mode chosen over there');

  // Full Access picked in the composer here, nothing sent: the main bot's next message carries it.
  bridge.choose(started.id, { permissionMode: 'bypassPermissions', plan: false });
  script.push(text('Full Access again.'));
  assert.deepEqual(await bridge.sendTo(started.id, 'Faster now'), { ok: true });
  await until(() => turns.length === 6, 'the sixth turn started');
  assert.equal(turns[5].mode, 'bypassPermissions', 'a mode chosen here goes out with the next message');
  await idle(started.id);
  assert.equal(row(started.id).bubble_permission_mode, 'bypassPermissions');

  // ── 2. A mode chosen for the next turn while a plan is being worked on. ──
  // The composer here starts a task in Plan with Full Access under it.
  const reached = gate();
  const release = gate();
  script.push(async () => { reached.open(); await release.promise; return callTool('plan-1', 'exit_plan_mode', { plan: '1. Change the file' }); });
  script.push(text('Plan carried out.'));
  const before = turns.length;
  assert.equal(bridge.handleClientEvent({ type: 'session.start', payload: {
    cwd: `/aegis-remote/${host.id}/${projectId}/project`, prompt: 'Plan the change', title: 'Plan the change', provider: 'bubble', startId: 's-plan',
    remoteSettings: { permissionMode: 'bypassPermissions', plan: true },
  } }), true);
  const planned = (await until(() => emitted.find((event) => event.type === 'session.status' && event.payload.startId === 's-plan'), 'the plan task started')).payload.sessionId;
  await within(reached.promise, 15000, 'the plan turn reached its first model call');
  assert.deepEqual(turns[before], { mode: 'plan', planExitMode: 'bypassPermissions' });
  await until(() => overview()?.sessions.find((session) => session.id === planned)?.status === 'running', 'this Mac sees the turn running');
  // Before the plan comes up for approval: Default is picked here and goes out with a message into the running turn.
  bridge.choose(planned, { permissionMode: 'default', plan: false });
  assert.equal(bridge.handleClientEvent({ type: 'session.continue', payload: { sessionId: planned, prompt: 'Keep it small', remoteSettings: { permissionMode: 'default', plan: false } } }), true);
  await until(() => row(planned).bubble_permission_mode === 'default', 'the other Mac took the choice for the next turn');
  assert.equal(turns.length, before + 1, 'the message joined the running turn');
  // The plan is approved from here. The turn it belongs to goes on in Full Access, as it was started.
  release.open();
  const approval = await until(() => emitted.find((event) => event.type === 'permission.request' && event.payload.sessionId === planned), 'the plan came up for approval');
  bridge.handleClientEvent({ type: 'permission.response', payload: { sessionId: planned, toolUseId: approval.payload.toolUseId, result: { behavior: 'allow', questionAnswers: { q: { selected: ['Approve and execute'] } } } } });
  await idle(planned);
  // Default was chosen for what comes next, after that turn began: approving its plan does not undo the choice.
  assert.equal(row(planned).bubble_permission_mode, 'default', 'the choice for the next turn outlives the plan approval');
  await until(() => listed(planned)?.remoteSettings?.permissionMode === 'default' && !listed(planned).remoteSettings.plan, 'this Mac shows Default');
  script.push(text('Small change made.'));
  assert.deepEqual(await bridge.sendTo(planned, 'Go on'), { ok: true });
  await until(() => turns.length === before + 2, 'the next turn started');
  assert.equal(turns.at(-1).mode, 'default', 'the next turn runs in the mode chosen for it');
  await idle(planned);

  // ── 3. A plan approved while another plan waits behind it (REMOTE-MODE-02-QUEUED-PLAN). ──
  // On that Mac itself: A runs in Plan, to go on in Default once approved. B, with an image,
  // cannot join A: it waits behind it, in Plan too, to go on in Full Access once approved.
  const reachedA = gate();
  const releaseA = gate();
  script.push(async () => { reachedA.open(); await releaseA.promise; return callTool('plan-a', 'exit_plan_mode', { plan: '1. First plan' }); });
  script.push(text('First plan carried out.'));
  script.push(text('Second plan: still thinking.'));
  const beforeQueued = turns.length;
  hostSend({ type: 'session.start', payload: { title: 'Two plans', prompt: 'Plan A', cwd: project, provider: 'bubble', skipTitleGeneration: true, startId: 's-queued', bubblePermissionMode: 'plan', bubblePlanExitMode: 'default' } });
  const queued = (await until(() => hostEvents.find((event) => event.type === 'session.status' && event.payload.startId === 's-queued'), 'the task with two plans started')).payload.sessionId;
  await within(reachedA.promise, 15000, 'the first of the two plan turns reached its model call');
  const image = path.join(project, 'shot.png');
  writeFileSync(image, Buffer.from('iVBORw0KGgo=', 'base64'));
  hostSend({ type: 'session.continue', payload: {
    sessionId: queued, prompt: 'Plan B, see the picture', provider: 'bubble', bubblePermissionMode: 'plan', bubblePlanExitMode: 'bypassPermissions',
    attachments: [{ kind: 'image', path: image, name: 'shot.png', mimeType: 'image/png' }],
  } });
  await until(() => turns.length === beforeQueued + 2, 'B waits behind A as a turn of its own');
  assert.deepEqual(turns.slice(beforeQueued), [{ mode: 'plan', planExitMode: 'default' }, { mode: 'plan', planExitMode: 'bypassPermissions' }]);
  // A's plan is approved. That is A's business: B has not been approved, and is what the session is set to.
  releaseA.open();
  const approvalA = await until(() => hostEvents.find((event) => event.type === 'permission.request' && event.payload.sessionId === queued), 'A\'s plan came up for approval');
  hostSend({ type: 'permission.response', payload: { sessionId: queued, toolUseId: approvalA.payload.toolUseId, result: { behavior: 'allow', updatedInput: { answers: { q: 'Approve and execute' } } } } });
  await until(() => store.getSession(queued).status !== 'running', 'both turns ended');
  assert.deepEqual(
    [store.getSession(queued).bubble_permission_mode, store.getSession(queued).bubble_plan_exit_mode],
    ['plan', 'bypassPermissions'],
    'approving the plan before it does not take the waiting plan out of Plan',
  );
  // That Mac's own composer was not taken out of Plan by the approval of the plan before:
  // it shows what the session is set to, and its next message says what it shows.
  assert.equal(windowMode(queued), 'plan', 'the composer still shows Plan for the plan that waits');
  script.push(text('Thinking on.'));
  hostSend(composerMessage(queued, 'And?', 'bypassPermissions'));
  await until(() => turns.length === beforeQueued + 3, 'the turn after the two plans started');
  assert.deepEqual(turns.at(-1), { mode: 'plan', planExitMode: 'bypassPermissions' }, 'the composer\'s next message plans: not Full Access before the plan is approved');
  await until(() => store.getSession(queued).status !== 'running', 'that turn ended');
  // Now B's own kind of plan is approved, in the turn that owns the session's mode: the session follows it out.
  script.push(callTool('plan-b', 'exit_plan_mode', { plan: '1. Second plan' }));
  script.push(text('Second plan carried out.'));
  const seenApprovals = hostEvents.filter((event) => event.type === 'permission.request' && event.payload.sessionId === queued).length;
  hostSend({ type: 'session.continue', payload: { sessionId: queued, prompt: 'Plan it now' } });
  const approvalB = await until(() => hostEvents.filter((event) => event.type === 'permission.request' && event.payload.sessionId === queued)[seenApprovals], 'the later plan came up for approval');
  hostSend({ type: 'permission.response', payload: { sessionId: queued, toolUseId: approvalB.payload.toolUseId, result: { behavior: 'allow', updatedInput: { answers: { q: 'Approve and execute' } } } } });
  await until(() => store.getSession(queued).status !== 'running', 'the approved turn ended');
  assert.equal(store.getSession(queued).bubble_permission_mode, 'bypassPermissions', 'a plan approved in the turn that owns the mode takes the session with it');
  assert.equal(windowMode(queued), 'bypassPermissions', 'and the composer out of Plan');

  // A message that names no mode leaves a plan, should one come, for the mode it runs in:
  // not for the one the runner happened to be started with.
  {
    const beforeExit = turns.length;
    script.push(text('One.'), text('Two.'), text('Three.'));
    hostSend({ type: 'session.start', payload: { title: 'Exit mode', prompt: 'First', cwd: project, provider: 'bubble', skipTitleGeneration: true, startId: 's-exit', bubblePermissionMode: 'bypassPermissions', bubblePlanExitMode: 'bypassPermissions' } });
    const exitTask = (await until(() => hostEvents.find((event) => event.type === 'session.status' && event.payload.startId === 's-exit'), 'the task started')).payload.sessionId;
    const ended = (count) => until(() => turns.length === beforeExit + count && store.getSession(exitTask).status !== 'running', `turn ${count} ended`);
    await ended(1);
    hostSend(composerMessage(exitTask, 'Second, carefully', 'default'));
    await ended(2);
    hostSend({ type: 'session.continue', payload: { sessionId: exitTask, prompt: 'Third' } });
    await ended(3);
    assert.deepEqual(turns.slice(beforeExit), [
      { mode: 'bypassPermissions', planExitMode: 'bypassPermissions' },
      { mode: 'default', planExitMode: 'default' },
      { mode: 'default', planExitMode: 'default' },
    ]);
  }

  // ── 4. An agent whose runner alone knew its mode, started afresh (REMOTE-MODE-03-COLD-SETTINGS). ──
  // Devin, MiMo and MiniMax Code, each with its CLI replaced by a recorder: what a new runner
  // is told to start in. Each has a mode of its own, so one agent's stored mode reaching
  // another's runner would show.
  const acpAgents = [
    { provider: 'devin', cli: 'devin-cli.js', status: 'getDevinRuntimeStatus', field: 'devinPermissionMode', column: 'devin_permission_mode', mode: 'bypass', tighter: 'ask' },
    { provider: 'mimo', cli: 'mimo-cli.js', status: 'getMimoRuntimeStatus', field: 'mimoPermissionMode', column: 'mimo_permission_mode', mode: 'build', tighter: 'ask' },
    { provider: 'minimax', cli: 'minimax-cli.js', status: 'getMinimaxRuntimeStatus', field: 'minimaxPermissionMode', column: 'minimax_permission_mode', mode: 'bypassPermissions', tighter: 'default' },
  ];
  for (const agent of acpAgents) {
    const others = acpAgents.filter((other) => other !== agent);
    require(path.join(root, 'dist-electron/electron/libs', agent.cli))[agent.status] = async () => ({ ready: true, installed: true, authenticated: true });
    const adapter = getProviderService().getAdapter(agent.provider);
    const starts = [];
    const sends = [];
    const held = new Set();
    Object.assign(adapter, {
      startSession: async (input) => {
        starts.push(input);
        held.add(input.threadId);
        return { threadId: input.threadId, provider: agent.provider, providerSessionId: `${agent.provider}-${input.threadId}`, status: 'running' };
      },
      sendTurn: async (input) => { sends.push(input); },
      hasSession: (threadId) => held.has(threadId),
      stopSession: async (threadId) => { held.delete(threadId); },
      disposeSession: (threadId) => held.delete(threadId),
    });
    const begun = await bridge.createTask(host.id, { projectId, provider: agent.provider, prompt: 'Build it', settings: { permissionMode: agent.mode } });
    assert.ok(begun.id, `${agent.provider}: ${JSON.stringify(begun)}`);
    await until(() => starts.length === 1, `the ${agent.provider} task started`);
    assert.equal(starts[0][agent.field], agent.mode);
    assert.equal(row(begun.id)[agent.column], agent.mode);
    // That Mac says what the session has, and that it keeps it.
    const reported = await until(() => listed(begun.id)?.remoteSettings?.permissionMode === agent.mode && listed(begun.id), `${agent.provider}: the mode is reported to this Mac`);
    assert.deepEqual(reported.remoteSettings, { permissionMode: agent.mode });

    // REMOTE-MODES-WARM-STARTUP-FALLBACK. The mode is tightened from that Mac's composer while
    // the runner lives. A message that names no mode then leaves the agent in the tightened one:
    // it is not put back on the mode the runner was started with.
    hostSend({ type: 'session.continue', payload: { sessionId: remoteId(begun.id), prompt: 'Careful now', provider: agent.provider, [agent.field]: agent.tighter } });
    await until(() => sends.length === 1, `${agent.provider}: the tightening message reached the runner`);
    assert.equal(sends[0][agent.field], agent.tighter);
    hostSend({ type: 'session.continue', payload: { sessionId: remoteId(begun.id), prompt: 'Carry on' } });
    await until(() => sends.length === 2, `${agent.provider}: the message without a mode reached the runner`);
    assert.equal(sends[1][agent.field], undefined, `${agent.provider}: a message that names no mode leaves the live agent's mode alone, not back on "${agent.mode}"`);
    assert.equal(starts.length, 1, 'the same runner took both');
    assert.equal(row(begun.id)[agent.column], agent.tighter, 'the session keeps the tightened mode');

    // Its runner goes (the app restarted, the idle reaper). The main bot's message says nothing of
    // the mode, as to any session that keeps it: the fresh runner starts in the session's, which is
    // the tightened one. The session once ran the other two agents too, each in a mode of its own:
    // none of those reaches this agent's runner.
    for (const other of others) store.updateSessionAgentPermissionMode(remoteId(begun.id), other.provider, other.mode);
    hostSend({ type: 'session.stop', payload: { sessionId: remoteId(begun.id) } });
    await until(() => !held.has(remoteId(begun.id)) && row(begun.id).status !== 'running', `the ${agent.provider} runner is gone`);
    await until(() => overview()?.sessions.find((session) => session.id === begun.id)?.status !== 'running', 'this Mac sees it idle');
    assert.deepEqual(await bridge.sendTo(begun.id, 'Go on'), { ok: true });
    await until(() => starts.length === 2, `a fresh ${agent.provider} runner started`);
    assert.equal(starts[1][agent.field], agent.tighter, `${agent.provider}: a fresh runner starts in the mode the session has, not the agent's default`);
    for (const other of others) {
      assert.equal(row(begun.id)[other.column], other.mode, 'the other agent\'s mode is on the session');
      assert.equal(starts[1][other.field], undefined, `${agent.provider}: ${other.provider}'s mode does not reach its runner`);
    }
    hostSend({ type: 'session.stop', payload: { sessionId: remoteId(begun.id) } });
    await until(() => !held.has(remoteId(begun.id)) && row(begun.id).status !== 'running', `the ${agent.provider} runner is gone again`);
  }

  // ── 5. The main bot's own tools, from a Mac of its own (the reported case, from its first call). ──
  // "This Mac" has its composer on Full Access for Bubble. Its bot starts a task on the other
  // Mac and writes to it again. Neither call names a mode: the first takes the composer's, as a
  // task started on this Mac would, and the second leaves it to the session.
  {
    otherProcess = fork(fileURLToPath(import.meta.url), ['--this-mac'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    // That process may fail to start, or end early: whoever waits on it is told, and nothing waits for ever.
    const waiting = new Map();
    let gone = null;
    const ready = new Promise((resolve, reject) => {
      otherProcess.on('message', (message) => {
        if (message.ready) return resolve();
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      });
      const ended = (why) => {
        gone ??= `this Mac's process ended (${why})`;
        reject(new Error(gone));
        for (const answer of waiting.values()) answer({ error: gone });
        waiting.clear();
      };
      otherProcess.on('exit', (code, signal) => ended(signal ?? `code ${code}`));
      otherProcess.on('error', (failure) => ended(failure.message));
    });
    let calls = 0;
    const ask = (action, input = {}) => within(new Promise((resolve, reject) => {
      if (gone) return reject(new Error(gone));
      const id = ++calls;
      waiting.set(id, (message) => ('error' in message ? reject(new Error(message.error)) : resolve(message.result)));
      otherProcess.send({ id, action, ...input });
    }), 30000, `this Mac answered "${action}"`);
    await within(ready, 30000, 'this Mac\'s process started');
    const paired = await ask('pair', { link: (await invoke('remote-companion', 'pair')).url });
    assert.equal(paired.name, 'Mac mini');

    const beforeBot = turns.length;
    script.push(text('Dependencies installed.'));
    const begun = await ask('tool', { name: 'start_task', args: { title: 'Install the dependencies', goal: 'A working checkout', prompt: 'Run npm ci.', project: 'project', device: 'Mac mini', agent: 'Bubble' } });
    assert.equal(begun.isError, false, begun.content);
    await until(() => turns.length === beforeBot + 1, 'the bot\'s task started on the other Mac');
    assert.equal(turns[beforeBot].mode, 'bypassPermissions', 'start_task starts the task in the composer\'s Full Access');
    // The bot is told the task's id, as it names it from then on.
    const botTask = JSON.parse(begun.content).sessionId;
    const task = store.getSession(botTask.replace(/^rh-[a-f0-9]{12}-/, ''));
    assert.equal(task?.bubble_permission_mode, 'bypassPermissions');
    await until(() => store.getSession(task.id).status !== 'running', 'the bot\'s task finished its turn');
    // The bot sees a task it may write to once this Mac has heard that the turn ended.
    script.push(text('Tests pass.'));
    const written = await until(async () => {
      const answer = await ask('tool', { name: 'message_task', args: { task: botTask, message: 'Now run the tests.' } });
      return answer.isError ? (/still working|working on/i.test(answer.content) ? null : assert.fail(answer.content)) : answer;
    }, 'message_task reached the task');
    assert.equal(written.isError, false);
    await until(() => turns.length === beforeBot + 2, 'the bot\'s message opened a turn');
    assert.equal(turns[beforeBot + 1].mode, 'bypassPermissions', 'message_task keeps the task in Full Access');
    await until(() => store.getSession(task.id).status !== 'running', 'that turn ended');
    await ask('exit');
  }

  // Nothing outside the temporary home was written, whatever the inherited environment pointed at.
  for (const [file, content] of Object.entries(sentinels)) {
    assert.equal(readFileSync(file, 'utf8'), content, `${path.basename(file)} outside the test's home is untouched`);
  }

  passed = true;
  console.log('remote-bubble-modes: ok');
} catch (failure) {
  console.error(failure);
} finally {
  try { otherProcess?.kill(); } catch { /* closing */ }
  try { bridge?.close(); } catch { /* closing */ }
  try { ipc?.cleanup(); } catch { /* closing */ }
  try { await relay?.close(); } catch { /* closing */ }
  rmSync(tmp, { recursive: true, force: true });
  // At once: runners, the gateway's sockets and the SDK keep the process alive,
  // and what they still had queued finds the session store closed.
  process.exit(passed ? 0 : 1);
}
