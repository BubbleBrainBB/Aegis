// Computer use on DeepSeek, end to end: the real Aegis DeepSeek adapter, the
// real Harness runtime (dev-fixtures/deepseek-harness) and its MCP client,
// the app's own Computer use gateway and MCP bridge, against a local Messages
// API mock and a scripted cua-driver. No desktop is touched and no model is
// called (scripts/verify-computer-use-live.ts runs the real driver).
//
// What it pins: the runtime is handed the gateway's nine tools under their
// transcript names, bound to its one session; a look returns the tree and the
// screenshot to the model; an action asks with the COMPUTER USE card of that
// session and takes the shared lease; another agent (Bubble's host tools)
// is shut out meanwhile; the transcript keeps the screenshots; stopping the
// session ends an open card; and a session that gets no Computer use is
// handed no server at all, not even one the user configured under that name.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeMessagesStream, toolNames, toolResults, imageBlocks, handleFilesRequest } = require('../fixtures/deepseek-messages-mock.cjs');
const root = resolve('.');
const installedProfile = process.env.AEGIS_DSH_PROFILE_DIR?.trim() || join(root, 'dev-fixtures/deepseek-harness');
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'aegis-dsh-computer-use-')));
const home = join(temp, 'home');
const cwd = join(temp, 'workspace');
const userData = join(temp, 'user-data');
// The adapter's own spawn path is used here, and it keeps a profile's
// sessions next to the profile. So the profile is a folder of this test's
// own with the installed one's files linked in: nothing is written to the
// profile a development run of the app uses.
const profile = join(temp, 'profile');
for (const dir of [home, cwd, userData, profile, join(home, '.aegis')]) mkdirSync(dir, { recursive: true });
for (const name of readdirSync(installedProfile)) {
  if (!name.startsWith('.')) symlinkSync(join(installedProfile, name), join(profile, name));
}

// Everything the main process would read from the user's home is read from
// here instead, and nothing is written to a provider's own config.
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.AEGIS_BROWSER_USE_TEST_MODE = '1';
process.env.AEGIS_DSH_PROFILE_DIR = profile;
process.env.AEGIS_DSH_ATTACHMENT_HOME = join(temp, 'attachments');
process.env.AEGIS_COMPUTER_USE_SETTINGS_PATH = join(temp, 'computer-use.json');
process.env.DEEPSEEK_API_KEY = 'local-computer-use-test';
// A stand-in that answers the version probe as the pinned driver. It is
// never started: the gateway below is given a scripted driver.
const standIn = join(temp, 'cua-driver');
writeFileSync(standIn, '#!/bin/sh\necho "cua-driver 0.57.0"\n');
chmodSync(standIn, 0o755);
process.env.AEGIS_CUA_DRIVER_PATH = standIn;
process.env.AEGIS_COMPUTER_USE_ENABLED = '1';

const supported = process.platform === 'darwin';
const lib = (name) => require(join(root, 'dist-electron/electron/libs', name));
const { DeepseekSdkAdapter } = lib('provider/deepseek-sdk-adapter.js');
const { initializeComputerUseGateway, getComputerUseMcpBridge, isComputerUseAvailableNow, disposeComputerUseMcpBridge } = lib('computer-use/index.js');
const { ComputerUseTranscript } = lib('computer-use/provider-mcp.js');
const { COMPUTER_USE_MCP_TOOL_TIMEOUT_MS } = lib('computer-use/mcp-bridge.js');
const { createDeepseekMcpRuntimeConfig } = lib('deepseek-mcp-settings.js');
const { createBubbleComputerUseTools } = lib('bubble-computer-use-tool.js');
const { computerUseLease, COMPUTER_USE_LEASE_MESSAGE } = lib('codex-computer-use.js');
const { setWorkflowSessionPolicy, clearWorkflowSessionPolicy } = lib('workflow/session-hooks.js');
const { disposeBrowserUseHttpServer } = lib('browser-use-http-server.js');
const { disposeSessionHttpServer } = lib('session-http-server.js');
const { CUA_DRIVER_VERSION } = lib('computer-use/driver-binary.js');
assert.equal(CUA_DRIVER_VERSION, '0.57.0', 'the stand-in above answers as the pinned driver');

const TREE = [
  '- [0] AXWindow "Calculator" [id=main actions=[raise]]',
  '    - AXStaticText = "0" (Edit field)',
  '    - [20] AXButton (Equals) [id=Equals actions=[press]]',
].join('\n');
const SHOT = Buffer.from(
  // A 1×1 JPEG: the runtime validates image bytes before it shows them to the model.
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=',
  'base64'
);

/** cua-driver as the gateway talks to it, with one Calculator window. */
const driver = {
  calls: [],
  running: false,
  instance: 0,
  async start() {
    if (!this.running) { this.running = true; this.instance += 1; }
    return this.instance;
  },
  async call(tool, args) {
    await this.start();
    this.calls.push({ tool, args });
    const ok = (text, structured = null, images = []) => ({ isError: false, text, structured, images });
    switch (tool) {
      case 'check_permissions': return ok('permissions', { accessibility: true, screen_recording: true });
      case 'list_apps': return ok('apps', { apps: [
        { name: 'Calculator', bundle_id: 'com.apple.calculator', pid: 500, running: true, launch_path: '/System/Applications/Calculator.app' },
      ] });
      case 'list_windows': return ok('windows', { windows: [
        { window_id: 71, pid: args.pid, title: 'Calculator', layer: 0, is_on_screen: true, z_index: 3, bounds: { width: 230, height: 408 } },
      ] });
      case 'get_window_state': return ok(TREE, { snapshot_id: `s${this.calls.length}`, tree_markdown: TREE, screenshot_width: 1, screenshot_height: 1 },
        [{ mimeType: 'image/jpeg', data: SHOT.toString('base64') }]);
      default: return ok(`${tool} delivered`);
    }
  },
  isRunning() { return this.running; },
  async stop() { this.running = false; },
  stopSync() { this.running = false; },
  of(tool) { return this.calls.filter((call) => call.tool === tool); },
};

// What ipc-handlers gives the gateway, cut down to this test: which sessions
// exist and in which mode, and an approval card the test answers.
const sessions = new Map();
const cards = [];
const frames = [];
let answerCard = () => ({ allow: true, untilRevoked: false });
const gateway = initializeComputerUseGateway(
  {
    getSession: (sessionId) => sessions.get(sessionId) ?? null,
    requestApproval: (sessionId, input, signal) => new Promise((resolveCard, reject) => {
      const card = { sessionId, input, signal, answer: resolveCard };
      cards.push(card);
      signal.addEventListener('abort', () => reject(new Error('Computer use approval was cancelled.')), { once: true });
      const decision = answerCard(card);
      if (decision) resolveCard(decision);
    }),
    emitLive: (sessionId, frame) => frames.push({ sessionId, frame }),
    userDataDir: () => userData,
    ownProcessIds: () => [process.pid],
  },
  { hostBundleId: 'com.github.Electron', driver }
);
const facts = (over = {}) => ({ planMode: false, fullAccess: false, readOnlyWorkflowRole: null, generation: 1, ...over });

// The model: each scenario queues what it answers to its requests, in order.
let responses = [];
const requests = [];
// Screenshots the runtime uploads for the model (/v1/files).
const uploads = new Map();
const api = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const bytes = Buffer.concat(chunks);
    if (handleFilesRequest(req, res, bytes, uploads)) return;
    const body = JSON.parse(bytes.toString());
    requests.push(body);
    const next = responses.shift() ?? { text: 'unexpected extra request' };
    void writeMessagesStream(res, { model: body.model, usage: { input_tokens: 10, output_tokens: 1 }, ...next });
  });
});
await new Promise((ready) => api.listen(0, '127.0.0.1', ready));
process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${api.address().port}`;

// A server the user configured under the gateway's name. It must never be
// handed to a runtime: a tool named mcp__aegis-computer-use__… is the gateway's.
let decoyRequests = 0;
const decoy = http.createServer((_req, res) => { decoyRequests += 1; res.writeHead(500).end(); });
await new Promise((ready) => decoy.listen(0, '127.0.0.1', ready));
writeFileSync(join(home, '.aegis', 'deepseek-mcp.json'), JSON.stringify({
  mcpServers: { 'aegis-computer-use': { type: 'http', url: `http://127.0.0.1:${decoy.address().port}/mcp` } },
}));

const GATEWAY_TOOLS = ['list_apps', 'get_app_state', 'click', 'perform_secondary_action', 'set_value', 'scroll', 'drag', 'press_key', 'type_text']
  .map((tool) => `mcp__aegis-computer-use__${tool}`);
const adapter = new DeepseekSdkAdapter();
// The transcript as ipc-handlers gets it: through the agent loop's annotator.
const transcript = new ComputerUseTranscript(() => getComputerUseMcpBridge());
const messages = new Map();
adapter.events.on('event', (event) => {
  if (event.type !== 'message') return;
  const list = messages.get(event.threadId) ?? [];
  messages.set(event.threadId, list);
  list.push(transcript.annotate(event.threadId, event.message));
});
const blocksOf = (threadId, type) => (messages.get(threadId) ?? [])
  .flatMap((message) => message.message?.content ?? [])
  .filter((block) => block.type === type);
function turnSettled(threadId) {
  return new Promise((done) => {
    const onEvent = (event) => {
      if (event.threadId !== threadId || event.type !== 'status_change') return;
      if (event.status !== 'completed' && event.status !== 'error') return;
      adapter.events.off('event', onEvent); done(event.status);
    };
    adapter.events.on('event', onEvent);
  });
}
async function until(condition, what) {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((tick) => setTimeout(tick, 25));
  }
}
const start = (threadId, prompt, extra = {}) =>
  adapter.startSession({ provider: 'deepseek', threadId, cwd, model: 'deepseek-flash', prompt, ...extra });

try {
  // The entry the runtime gets waits longer than the approval card does.
  const generated = createDeepseekMcpRuntimeConfig(profile, cwd, {
    'aegis-computer-use': { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer x' } },
  });
  try {
    const yaml = require('node:fs').readFileSync(generated.configPath, 'utf8');
    assert.ok(yaml.includes('serverName: aegis-computer-use'), yaml);
    assert.ok(yaml.includes(`toolCallTimeoutMs: ${COMPUTER_USE_MCP_TOOL_TIMEOUT_MS}`), 'a call may wait on a person reading the card');
  } finally {
    generated.dispose();
  }

  if (!supported) {
    // Computer use is macOS only: elsewhere a DeepSeek runtime is handed no
    // Computer use server, the gateway's or anybody's.
    assert.equal(isComputerUseAvailableNow(), false);
    sessions.set('ds-other-os', facts());
    responses = [{ text: 'NO_TOOLS' }];
    const settled = turnSettled('ds-other-os');
    await start('ds-other-os', 'Say hi.');
    assert.equal(await settled, 'completed');
    assert.ok(!toolNames(requests.at(-1)).some((name) => name.includes('aegis-computer-use')));
    assert.equal(decoyRequests, 0);
    await adapter.stopSession('ds-other-os');
    console.log('DeepSeek Computer use: not offered off macOS, and the reserved server name is never handed over');
  } else {
    assert.equal(isComputerUseAvailableNow(), true, 'the switch is on and the pinned driver answers');

    // ── 1. A look, then an action, in one turn ──────────────────────────────
    sessions.set('ds-1', facts());
    responses = [
      { toolCalls: [{ id: 'look', name: 'mcp__aegis-computer-use__get_app_state', input: { app: 'Calculator' } }] },
      { toolCalls: [{ id: 'press', name: 'mcp__aegis-computer-use__click', input: { app: 'Calculator', element_index: '20' } }] },
      { text: 'COMPUTER_USE_OK' },
    ];
    let leaseAtCard = null;
    let bubbleWhileHeld = null;
    answerCard = (card) => {
      // The desktop is this session's from the card on. Another agent
      // (Bubble's host tools, bound to another session) gets nothing meanwhile.
      leaseAtCard = computerUseLease.currentOwner();
      sessions.set('bubble-1', facts());
      const bubbleLook = createBubbleComputerUseTools('bubble-1').find((tool) => tool.name.endsWith('__list_apps'));
      bubbleWhileHeld = bubbleLook.execute({}, { toolCall: { id: 'bubble-call-1' } });
      return { allow: true, untilRevoked: false };
    };
    const settled = turnSettled('ds-1');
    await start('ds-1', 'Press equals in Calculator.');
    assert.equal(await settled, 'completed');

    // The model was offered the nine tools, named as the transcript names them.
    const offered = toolNames(requests[0]);
    for (const name of GATEWAY_TOOLS) assert.ok(offered.includes(name), `offered ${name}: ${offered.join(', ')}`);
    assert.equal(offered.filter((name) => name.includes('aegis-computer-use')).length, GATEWAY_TOOLS.length, 'and no other tool of that server');
    assert.equal(decoyRequests, 0, "the user's server of the same name was never contacted");

    // The look reached the model as the tree, with the screenshot as an image.
    const look = toolResults(requests[1]).find((result) => result.toolUseId === 'look');
    assert.ok(look, 'the look came back to the model');
    assert.match(look.text, /App: Calculator \[com\.apple\.calculator\]/);
    assert.match(look.text, /\[20\] AXButton \(Equals\)/);
    assert.match(look.text, /Screenshot also saved to /);
    assert.ok(imageBlocks(requests[1]).length >= 1, 'the screenshot reaches a model that takes images');

    // The action asked the user, in this session, with the Computer use card.
    assert.equal(cards.length, 1);
    assert.equal(cards[0].sessionId, 'ds-1');
    assert.equal(cards[0].input.kind, 'computer-use');
    assert.equal(cards[0].input.toolName, 'click');
    assert.equal(cards[0].input.app, 'Calculator');
    assert.deepEqual(cards[0].input.paramLines, [{ label: 'element', value: '[20] AXButton (Equals)' }]);
    assert.equal(leaseAtCard?.threadId, 'ds-1', 'the lease is taken before the user is asked');
    const refusedBubble = await bubbleWhileHeld;
    assert.equal(refusedBubble.isError, true);
    assert.equal(refusedBubble.content, COMPUTER_USE_LEASE_MESSAGE, 'an agent of another provider is shut out while DeepSeek holds the desktop');
    // It ran once, against the window the look found, in the background.
    assert.equal(driver.of('click').length, 1);
    assert.match(String(driver.of('click')[0].args.element_token), /^s\d+:20$/, 'the element of the snapshot the look returned');
    assert.equal(driver.of('click')[0].args.delivery_mode ?? 'background', 'background');
    const pressed = toolResults(requests[2]).find((result) => result.toolUseId === 'press');
    assert.match(pressed.text, /click delivered/);
    assert.match(pressed.text, /\[20\] AXButton \(Equals\)/, 'an action returns the window as it is afterwards');

    // The transcript: tool cards under the gateway's names, each result with its screenshot.
    const uses = blocksOf('ds-1', 'tool_use');
    assert.deepEqual([...new Set(uses.map((block) => block.name))], [
      'mcp__aegis-computer-use__get_app_state',
      'mcp__aegis-computer-use__click',
    ]);
    const results = blocksOf('ds-1', 'tool_result');
    const withShots = results.filter((block) => Array.isArray(block.mediaRefs) && block.mediaRefs.length > 0);
    assert.equal(new Set(withShots.map((block) => block.tool_use_id)).size, 2, `both results keep their screenshot: ${JSON.stringify(results)}`);
    for (const block of withShots) {
      assert.equal(block.mediaRefs[0].sessionId, 'ds-1');
      assert.ok(existsSync(join(userData, 'computer-use-artifacts', 'ds-1', `${block.mediaRefs[0].sha256}.jpg`)));
    }
    // The HUD followed along, for this session only.
    assert.ok(frames.some(({ sessionId, frame }) => sessionId === 'ds-1' && frame.tool === 'click' && frame.mutating));
    assert.ok(frames.some(({ sessionId, frame }) => sessionId === 'ds-1' && frame.hasFreshMedia && frame.media));
    assert.ok(frames.every(({ sessionId }) => sessionId === 'ds-1'));

    // The turn is over (ipc-handlers calls this on every provider's result): the desktop is free.
    assert.equal(computerUseLease.currentOwner()?.threadId, 'ds-1', 'held until the turn ends');
    gateway.finishTurn('ds-1');
    await until(() => computerUseLease.currentOwner() === null, 'the lease to go back');
    const bubbleLook = createBubbleComputerUseTools('bubble-1').find((tool) => tool.name.endsWith('__list_apps'));
    assert.equal((await bubbleLook.execute({}, { toolCall: { id: 'bubble-call-2' } })).isError, false, 'and the other agent can have it');

    // ── 2. Bubble holds the desktop: DeepSeek is told so, and nobody is asked ──
    const bubbleState = createBubbleComputerUseTools('bubble-1').find((tool) => tool.name.endsWith('__get_app_state'));
    const bubbleClick = createBubbleComputerUseTools('bubble-1').find((tool) => tool.name.endsWith('__click'));
    await bubbleState.execute({ app: 'Calculator' }, { toolCall: { id: 'bubble-call-3' } });
    answerCard = () => ({ allow: true, untilRevoked: false });
    assert.equal((await bubbleClick.execute({ app: 'Calculator', element_index: '20' }, { toolCall: { id: 'bubble-call-4' } })).isError, false);
    assert.equal(computerUseLease.currentOwner()?.threadId, 'bubble-1');
    const cardsBefore = cards.length;
    const clicksBefore = driver.of('click').length;
    responses = [
      { toolCalls: [{ id: 'look-2', name: 'mcp__aegis-computer-use__get_app_state', input: { app: 'Calculator' } }] },
      { text: 'DESKTOP_TAKEN' },
    ];
    const requestsBefore = requests.length;
    const second = turnSettled('ds-1');
    await adapter.sendTurn({ threadId: 'ds-1', prompt: 'Look at Calculator again.' });
    assert.equal(await second, 'completed');
    const taken = toolResults(requests[requestsBefore + 1]).find((result) => result.toolUseId === 'look-2');
    // The runtime hands a failed MCP call to the model as an error with the gateway's words.
    assert.ok(taken.text.endsWith(COMPUTER_USE_LEASE_MESSAGE), `DeepSeek cannot even look while Bubble holds the desktop: ${taken.text}`);
    assert.equal(taken.block.is_error, true);
    assert.equal(cards.length, cardsBefore, 'no card for a desktop that is taken');
    assert.equal(driver.of('click').length, clicksBefore);
    gateway.finishTurn('ds-1');
    gateway.finishTurn('bubble-1');

    // ── 3. Stop with a card open: the card is taken down, the desktop is free ──
    responses = [
      { toolCalls: [{ id: 'look-3', name: 'mcp__aegis-computer-use__get_app_state', input: { app: 'Calculator' } }] },
      { toolCalls: [{ id: 'press-3', name: 'mcp__aegis-computer-use__click', input: { app: 'Calculator', element_index: '20' } }] },
      { text: 'never reached' },
    ];
    answerCard = () => null;
    const openBefore = cards.length;
    // The turn stays open on its card, so its send is not waited for.
    const third = adapter.sendTurn({ threadId: 'ds-1', prompt: 'Press equals once more.' });
    third.catch(() => undefined);
    await until(() => cards.length > openBefore, 'the approval card of the third turn');
    const open = cards.at(-1);
    assert.equal(computerUseLease.currentOwner()?.threadId, 'ds-1');
    // Stop: the adapter closes the runtime (DeepSeek has no cancel on the wire),
    // and ipc-handlers tells the gateway the session was stopped.
    await adapter.stopSession('ds-1');
    gateway.forgetSession('ds-1', 'stop');
    await until(() => open.signal.aborted, 'the open card to be taken down');
    await until(() => computerUseLease.currentOwner() === null, 'the desktop to be free');
    assert.equal(driver.of('click').length, clicksBefore, 'the click behind the card never ran');
    await third.catch(() => undefined);

    // ── 4. Sessions that get no Computer use are handed no server ───────────
    // A read-only workflow member.
    sessions.set('ds-reviewer', facts({ readOnlyWorkflowRole: 'reviewer' }));
    setWorkflowSessionPolicy('ds-reviewer', { runId: 'run-1', role: 'reviewer', readOnly: true });
    responses = [{ text: 'REVIEWED' }];
    let done = turnSettled('ds-reviewer');
    await start('ds-reviewer', 'Review.');
    assert.equal(await done, 'completed');
    assert.ok(!toolNames(requests.at(-1)).some((name) => name.includes('aegis-computer-use')), 'a read-only member is offered none of the tools');
    await adapter.stopSession('ds-reviewer');
    clearWorkflowSessionPolicy('ds-reviewer');

    // The switch off: no tools, and still not the user's server of that name.
    delete process.env.AEGIS_COMPUTER_USE_ENABLED;
    assert.equal(isComputerUseAvailableNow(), false);
    sessions.set('ds-off', facts());
    responses = [{ text: 'OFF' }];
    done = turnSettled('ds-off');
    await start('ds-off', 'Say hi.');
    assert.equal(await done, 'completed');
    assert.ok(!toolNames(requests.at(-1)).some((name) => name.includes('aegis-computer-use')), 'off: no Computer use tools');
    assert.ok(toolNames(requests.at(-1)).some((name) => name.startsWith('mcp__aegis-sessions__')), "Aegis's other tools are still there");
    await adapter.stopSession('ds-off');
    assert.equal(decoyRequests, 0, "the user's server under the reserved name is never handed to a runtime");

    console.log('DeepSeek Computer use: tools bound to the session, look and action through the gateway, approval card, shared lease across agents, screenshots in the transcript, stop with a card open, and no server for sessions without it — passed');
  }
} finally {
  for (const id of [...adapter.sessions.keys()]) await adapter.stopSession(id).catch(() => undefined);
  await gateway.shutdown('test-over').catch(() => undefined);
  disposeComputerUseMcpBridge();
  disposeBrowserUseHttpServer();
  disposeSessionHttpServer();
  api.closeAllConnections(); await new Promise((done) => api.close(done));
  decoy.closeAllConnections(); await new Promise((done) => decoy.close(done));
  rmSync(temp, { recursive: true, force: true });
}
