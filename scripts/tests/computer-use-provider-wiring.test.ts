// Computer use on the providers that are not Bubble or Codex, at the place
// each is wired.
//
// The ACP agents (MiniMax Code, MiMo Code, Devin, Grok Build): the four real
// adapters, each against a scripted stand-in for its CLI that speaks the
// shapes the real ones were seen to use (scripts/probe-computer-use-acp.mjs
// records them), and that makes real MCP calls to the app's own bridge and
// gateway with the entry it was handed. What it pins per adapter: the agent
// is handed the gateway's entry for its session and nothing else under that
// name; its calls run as that session's (card, lease); the transcript names
// the tools the one way the app knows them and keeps their screenshots; the
// agent's own approval for a gateway tool is answered without a second card,
// and only then: a tool of another server, and the same name in a session
// that was handed no entry, get the agent's ordinary card.
//
// The SDK runtimes (Claude, Qoder), the shared server (OpenCode) and the
// native tools (Pi): the entries and tools their adapters are given, against
// the same gateway, and the lines in each adapter that hand them over.
//
// The driver behind the gateway is scripted; no desktop is touched.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'aegis-cu-acp-')));
const home = path.join(temp, 'home');
const userData = path.join(temp, 'user-data');
const logPath = path.join(temp, 'agent.jsonl');
for (const dir of [home, userData]) mkdirSync(dir, { recursive: true });

// Nothing is read from, or written to, the user's own home.
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.AEGIS_BROWSER_USE_TEST_MODE = '1';
process.env.AEGIS_COMPUTER_USE_SETTINGS_PATH = path.join(temp, 'computer-use.json');
const standIn = path.join(temp, 'cua-driver');
writeFileSync(standIn, '#!/bin/sh\necho "cua-driver 0.57.0"\n');
chmodSync(standIn, 0o755);
process.env.AEGIS_CUA_DRIVER_PATH = standIn;
process.env.AEGIS_COMPUTER_USE_ENABLED = '1';

/**
 * One stand-in for all four CLIs; FAKE_KIND picks whose shapes it speaks.
 * On a prompt it looks for the aegis-computer-use entry of its session:
 * - with one, it calls the server (a look, then a click it first asks its
 *   own approval for), then asks approval for a tool of another server;
 * - without one, it asks approval for a tool that only shares the name.
 */
const fakeAgentPath = path.join(temp, 'fake-agent.cjs');
writeFileSync(
  fakeAgentPath,
  `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
// Only the ACP server is stood in for; any other subcommand (a model
// listing, a version probe) answers nothing and exits.
if (!['acp', 'agent'].includes(process.argv[2])) process.exit(0);
const KIND = process.env.FAKE_KIND;
const LOG = ${JSON.stringify(logPath)};
const log = (entry) => appendFileSync(LOG, JSON.stringify({ kind: KIND, ...entry }) + '\\n');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const update = (sessionId, payload) => send({ method: 'session/update', params: { sessionId, update: payload } });
const pending = new Map();
let asked = 0;
const ask = (method, params) => new Promise((resolve) => {
  const id = 'ask-' + (++asked);
  pending.set(id, resolve);
  send({ id, method, params });
});
let servers = [];

// How each agent names an MCP tool in a tool_call, and in its approval request.
function toolCall(id, tool, args) {
  const base = { sessionUpdate: 'tool_call', toolCallId: id, status: 'pending' };
  switch (KIND) {
    case 'minimax': return { ...base, name: 'mcp__aegis-computer-use__' + tool, title: 'mcp__aegis-computer-use__' + tool, kind: 'other', rawInput: args };
    case 'mimo': return { ...base, title: 'aegis-computer-use_' + tool, kind: 'other', rawInput: args };
    case 'devin': return { ...base, title: 'Called ' + tool + ' from aegis-computer-use', rawInput: args, _meta: { 'cognition.ai/inferenceToolName': 'mcp__aegis-computer-use__' + tool } };
    case 'grok': return { ...base, title: 'use_tool', kind: 'other', rawInput: { tool_name: 'aegis-computer-use__' + tool, tool_input: args }, _meta: { 'x.ai/tool': { name: 'use_tool' } } };
  }
}
function approval(id, server, tool, args) {
  switch (KIND) {
    case 'minimax': return { toolCallId: 'perm_' + id, name: 'mcp__' + server + '__' + tool, title: 'mcp__' + server + '__' + tool, kind: 'other', rawInput: args };
    case 'mimo': return { toolCallId: id, title: server + '_' + tool, kind: 'other', rawInput: args };
    case 'devin': return { toolCallId: id, _meta: { 'cognition.ai/permissionRule': 'mcp__' + server + '__' + tool } };
    case 'grok': return { toolCallId: id, title: 'use_tool', rawInput: { tool_name: server + '__' + tool, tool_input: args } };
  }
}
const OPTIONS = [
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_server_always', name: 'Always allow this server', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];
function done(id, text, failed) {
  const content = [{ type: 'content', content: { type: 'text', text } }];
  return { sessionUpdate: 'tool_call_update', toolCallId: id, status: failed ? 'failed' : 'completed', content, rawOutput: { content: [{ type: 'text', text }], output: text } };
}

async function mcp(server, method, params) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  for (const header of server.headers) headers[header.name] = header.value;
  const response = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!response.ok) return { status: response.status };
  return (await response.json()).result;
}
const textOf = (result) => (result?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\\n');

async function prompt(id, params) {
  const sid = params.sessionId;
  const server = servers.find((entry) => entry.name === 'aegis-computer-use');
  log({ event: 'servers', names: servers.map((entry) => entry.name), type: server?.type });
  if (!server) {
    // No entry: a tool of this name is somebody else's.
    update(sid, toolCall('call-x', 'click', { app: 'Calculator', element_index: '20' }));
    const decision = await ask('session/request_permission', { sessionId: sid, toolCall: approval('call-x', 'aegis-computer-use', 'click', {}), options: OPTIONS });
    log({ event: 'approval', of: 'same-name', outcome: decision?.outcome });
    update(sid, done('call-x', 'not the gateway'));
  } else {
    // An approval before the agent has reached the server at all.
    const early = await ask('session/request_permission', { sessionId: sid, toolCall: approval('call-0', 'aegis-computer-use', 'click', {}), options: OPTIONS });
    log({ event: 'approval', of: 'before-connecting', outcome: early?.outcome });

    const listed = await mcp(server, 'tools/list', {});
    log({ event: 'tools', names: (listed.tools || []).map((tool) => tool.name) });
    update(sid, toolCall('call-1', 'get_app_state', { app: 'Calculator' }));
    const look = await mcp(server, 'tools/call', { name: 'get_app_state', arguments: { app: 'Calculator' } });
    log({ event: 'look', isError: look.isError === true, text: textOf(look), blocks: (look.content || []).map((block) => block.type) });
    update(sid, done('call-1', textOf(look), look.isError));

    update(sid, toolCall('call-2', 'click', { app: 'Calculator', element_index: '20' }));
    const own = await ask('session/request_permission', { sessionId: sid, toolCall: approval('call-2', 'aegis-computer-use', 'click', { app: 'Calculator', element_index: '20' }), options: OPTIONS });
    log({ event: 'approval', of: 'gateway', outcome: own?.outcome });
    if (own?.outcome?.outcome === 'selected') {
      const click = await mcp(server, 'tools/call', { name: 'click', arguments: { app: 'Calculator', element_index: '20' } });
      log({ event: 'click', isError: click.isError === true, text: textOf(click) });
      update(sid, done('call-2', textOf(click), click.isError));
    } else {
      update(sid, done('call-2', 'declined', true));
    }

    // A tool of another server keeps the agent's own approval.
    const other = await ask('session/request_permission', { sessionId: sid, toolCall: approval('call-3', 'other-server', 'click', {}), options: OPTIONS });
    log({ event: 'approval', of: 'other-server', outcome: other?.outcome });
  }
  update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DONE' } });
  send({ id, result: { stopReason: 'end_turn', usage: { totalTokens: 2, inputTokens: 1, outputTokens: 1 } } });
}

async function handle(message) {
  if (message.id !== undefined && !message.method) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message.result);
    return;
  }
  const { id, method, params } = message;
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: {} }, authMethods: [] } });
  } else if (method === 'session/new') {
    servers = params.mcpServers || [];
    send({ id, result: { sessionId: 'cu-' + KIND, modes: { currentModeId: 'default', availableModes: [] }, configOptions: [] } });
  } else if (method === 'session/prompt') {
    await prompt(id, params);
  } else if (id !== undefined) {
    send({ id, result: {} });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) void handle(JSON.parse(line));
  }
});
`
);
chmodSync(fakeAgentPath, 0o755);

type AgentKind = 'minimax' | 'mimo' | 'devin' | 'grok';
type LogEntry = { kind: AgentKind; event: string; [key: string]: unknown };
type Event = { type: string; threadId?: string; [key: string]: unknown };

function readLog(kind: AgentKind): LogEntry[] {
  try {
    return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as LogEntry).filter((entry) => entry.kind === kind);
  } catch {
    return [];
  }
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const TREE = [
  '- [0] AXWindow "Calculator" [id=main actions=[raise]]',
  '    - [20] AXButton (Equals) [id=Equals actions=[press]]',
].join('\n');

type Shared = {
  offered: boolean;
  cards: Array<{ sessionId: string; toolName: string; app: string | null }>;
  driverCalls: Array<{ tool: string; args: Record<string, unknown> }>;
  known: Set<string>;
  gateway: { finishTurn(sessionId: string): void };
};

/** One MCP request to an entry, the way a runtime makes it: its URL and headers. */
async function post(entry: { url: string; headers: Record<string, string> }, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(entry.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...entry.headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, result: response.ok ? ((await response.json()) as { result: Record<string, unknown> }).result : null };
}

/** What Claude, Qoder, OpenCode and Pi are given, against the app's own gateway. */
async function testSdkRuntimesAndNativeTools({ offered, cards, driverCalls, known, gateway }: Shared): Promise<void> {
  const {
    createComputerUseProviderMcpEntry,
    createComputerUseSessionEntry,
    createPiComputerUseTools,
    forgetComputerUseMcpSession,
    isComputerUseOfferedTo,
    piComputerUseToolNames,
    releaseComputerUseSessionEntry,
  } = await import('../../src/electron/libs/computer-use/provider-mcp');
  const { setWorkflowSessionPolicy, clearWorkflowSessionPolicy } = await import('../../src/electron/libs/workflow/session-hooks');
  const { COMPUTER_USE_MCP_UNBOUND_MESSAGE } = await import('../../src/electron/libs/computer-use/mcp-bridge');
  const { computerUseLease, COMPUTER_USE_LEASE_MESSAGE } = await import('../../src/electron/libs/codex-computer-use');

  if (!offered) {
    assert.equal(await createComputerUseSessionEntry('claude-1'), null);
    assert.equal(await createComputerUseProviderMcpEntry(() => 'opencode-1'), null);
    assert.deepEqual(createPiComputerUseTools('pi-1'), []);
    assert.deepEqual(piComputerUseToolNames('pi-1'), []);
    return;
  }

  // ── Claude / Qoder: one entry per session, for its one runtime ───────────
  known.add('claude-1');
  const first = (await createComputerUseSessionEntry('claude-1', { images: 'inline' }))!;
  assert.ok(first, 'a chat session is handed an entry');
  assert.equal((await post(first, 'tools/list')).status, 200);
  assert.equal(first.connected(), true);
  const look = await post(first, 'tools/call', { name: 'get_app_state', arguments: { app: 'Calculator' } });
  const blocks = (look.result!.content as Array<{ type: string }>).map((block) => block.type);
  assert.deepEqual(blocks, ['text', 'image'], 'Claude is handed the screenshot itself');
  // The runtime is replaced (a respawn): the entry of the one before it ends.
  const second = (await createComputerUseSessionEntry('claude-1'))!;
  assert.notEqual(second.headers['x-aegis-computer-use-session'], first.headers['x-aegis-computer-use-session']);
  assert.equal((await post(first, 'tools/list')).status, 403, 'the earlier runtime speaks for nobody now');
  assert.equal(first.connected(), false);
  assert.equal((await post(second, 'tools/list')).status, 200);
  // The earlier runtime's teardown arrives late: it does not take the new entry down.
  releaseComputerUseSessionEntry('claude-1', first);
  assert.equal((await post(second, 'tools/list')).status, 200);
  releaseComputerUseSessionEntry('claude-1', second);
  assert.equal((await post(second, 'tools/list')).status, 403, 'released with its runtime');
  // Deleting the session ends whatever it had.
  const third = (await createComputerUseSessionEntry('claude-1'))!;
  forgetComputerUseMcpSession('claude-1');
  assert.equal((await post(third, 'tools/list')).status, 403);
  // A read-only workflow member is handed nothing.
  setWorkflowSessionPolicy('reviewer-1', { runId: 'run', role: 'reviewer', readOnly: true });
  assert.equal(isComputerUseOfferedTo('reviewer-1'), false);
  assert.equal(await createComputerUseSessionEntry('reviewer-1'), null);
  assert.deepEqual(createPiComputerUseTools('reviewer-1'), []);
  clearWorkflowSessionPolicy('reviewer-1');

  // ── OpenCode: one server for all its sessions; each call names its own ───
  known.add('opencode-a');
  const shared = (await createComputerUseProviderMcpEntry(async (meta) => {
    const id = String(meta?.['ai.opencode/sessionID'] ?? '');
    return id === 'ses_a' ? 'opencode-a' : null;
  }))!;
  const named = await post(shared, 'tools/call', { name: 'list_apps', arguments: {}, _meta: { 'ai.opencode/sessionID': 'ses_a' } });
  assert.equal(named.result!.isError ?? false, false);
  for (const meta of [undefined, { 'ai.opencode/sessionID': 'ses_unknown' }]) {
    const lost = await post(shared, 'tools/call', { name: 'list_apps', arguments: {}, ...(meta ? { _meta: meta } : {}) });
    assert.equal(lost.result!.isError, true);
    assert.equal((lost.result!.content as Array<{ text: string }>)[0].text, COMPUTER_USE_MCP_UNBOUND_MESSAGE, 'a call that names no session is not run, and not guessed');
  }
  shared.dispose();
  assert.equal((await post(shared, 'tools/list')).status, 403);

  // ── Pi: the gateway's tools as custom tools bound to the session ─────────
  known.add('pi-1');
  const names = piComputerUseToolNames('pi-1');
  const tools = createPiComputerUseTools('pi-1');
  assert.equal(tools.length, 9);
  assert.deepEqual(tools.map((tool) => tool.name), names);
  assert.ok(names.every((name) => name.startsWith('mcp__aegis-computer-use__')), 'named as the transcript, the cards and the HUD know them');
  const tool = (name: string) => tools.find((item) => item.name === `mcp__aegis-computer-use__${name}`)!;
  assert.deepEqual(Object.keys((tool('click').parameters as { properties: object }).properties), ['app', 'element_index', 'x', 'y', 'click_count', 'mouse_button']);
  const state = await tool('get_app_state').execute('pi-call-1', { app: 'Calculator' });
  assert.deepEqual(state.content.map((block) => block.type), ['text', 'image'], 'Pi hands tool images to the model');
  const cardsBefore = cards.length;
  const clicksBefore = driverCalls.filter((call) => call.tool === 'click').length;
  await tool('click').execute('pi-call-2', { app: 'Calculator', element_index: '20' });
  assert.deepEqual(cards.slice(cardsBefore), [{ sessionId: 'pi-1', toolName: 'click', app: 'Calculator' }], 'Pi has no approval of its own: the gateway asks');
  assert.equal(driverCalls.filter((call) => call.tool === 'click').length, clicksBefore + 1);
  assert.equal(computerUseLease.currentOwner()?.threadId, 'pi-1');
  // Another agent's session is told the desktop is taken; Pi reads a failure as a thrown error.
  known.add('pi-2');
  await assert.rejects(
    createPiComputerUseTools('pi-2').find((item) => item.name.endsWith('__list_apps'))!.execute('pi-call-3', {}),
    (error: Error) => error.message === COMPUTER_USE_LEASE_MESSAGE
  );
  await assert.rejects(tool('click').execute('pi-call-4', { app: 'Calculator' }), /element_index, or both x and y/);
  gateway.finishTurn('pi-1');
  for (let i = 0; i < 100 && computerUseLease.currentOwner(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(computerUseLease.currentOwner(), null);
}

/**
 * The lines that hand the entry over, in the adapters this file cannot run
 * (they need a real CLI or Electron). scripts/probe-computer-use-adapters.mjs
 * runs Qoder, OpenCode and Pi for real.
 */
function testAdapterSources(): void {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
  const runner = read('src/electron/libs/runner.ts');
  assert.ok(
    runner.includes('delete (mcpServers as Record<string, unknown>)[AEGIS_COMPUTER_USE_SERVER_NAME];') &&
      runner.includes("computerUseEntry = await createComputerUseSessionEntry(session.id, { images: 'inline' });") &&
      runner.includes('releaseComputerUseSessionEntry(session.id, computerUseEntry);'),
    "Claude: the reserved name is never the user's, the entry is the session's, and it ends with the CLI"
  );
  const qoder = read('src/electron/libs/provider/qoder-sdk-adapter.ts');
  assert.ok(
    qoder.includes('const computerUse = await createComputerUseSessionEntry(input.threadId);') &&
      qoder.includes('if (isGatewayToolCall(session.computerUse, toolName)) {') &&
      qoder.includes('releaseComputerUseSessionEntry(session.threadId, session.computerUse);'),
    'Qoder: a session entry, its own approval answered for the gateway only, released with the session'
  );
  assert.ok(
    qoder.indexOf('if (session.denyAsks) {') < qoder.indexOf('if (isGatewayToolCall(session.computerUse, toolName)) {'),
    "Qoder: Don't Ask denies before anything is let through"
  );
  const opencode = read('src/electron/libs/provider/opencode-serve-manager.ts');
  assert.ok(
    opencode.includes('const computerUse = resolve ? await createComputerUseProviderMcpEntry((meta) => resolve(meta)) : null;') &&
      opencode.includes("[AEGIS_COMPUTER_USE_SERVER_NAME]: { type: 'remote', url: computerUse.url, headers: computerUse.headers, codemode: false }") &&
      opencode.includes('Boolean(running.computerUse) !== isComputerUseAvailableNow()') &&
      opencode.includes('state.computerUse?.dispose();'),
    'OpenCode: the shared entry reads the session from the request meta, follows the switch, and ends with the server'
  );
  const pi = read('src/electron/libs/provider/pi-sdk-adapter.ts');
  assert.ok(
    pi.includes('...piComputerUseToolNames(input.threadId)') && pi.includes('...createPiComputerUseTools(input.threadId)'),
    'Pi: the tools are listed and registered for the session'
  );
  const deepseek = read('src/electron/libs/provider/deepseek-sdk-adapter.ts');
  assert.ok(
    deepseek.includes('delete servers[AEGIS_COMPUTER_USE_SERVER_NAME];') &&
      deepseek.includes("const computerUse = await createComputerUseMcpEntry(threadId, { images: 'inline' });") &&
      deepseek.includes('disposeComputerUseEntry();'),
    'DeepSeek: the reserved name, the session entry, and its end with the runtime'
  );
  // Kimi takes MCP servers only from its global mcp.json, where a call cannot
  // be bound to a session: it is given no Computer use, by nobody.
  for (const file of ['src/electron/libs/provider/kimi-server-adapter.ts', 'src/electron/libs/provider/kimi-server-manager.ts', 'src/electron/libs/kimi-mcp-settings.ts']) {
    assert.ok(!/computer-use/i.test(read(file)), `${file}: no Computer use entry for Kimi`);
  }
  // No provider reaches the driver except through the gateway.
  for (const file of ['runner.ts', 'provider/qoder-sdk-adapter.ts', 'provider/opencode-serve-manager.ts', 'provider/pi-sdk-adapter.ts', 'provider/deepseek-sdk-adapter.ts',
    'provider/minimax-acp-adapter.ts', 'provider/mimo-acp-adapter.ts', 'provider/devin-acp-adapter.ts', 'provider/grok-acp-adapter.ts', 'computer-use/mcp-bridge.ts', 'computer-use/provider-mcp.ts']) {
    const source = read(path.join('src/electron/libs', file));
    assert.ok(!/driver-host|CuaDriverHost/.test(source), `${file}: no driver of its own`);
  }
}

async function main(): Promise<void> {
  const { initializeComputerUseGateway, getComputerUseMcpBridge, isComputerUseAvailableNow, disposeComputerUseMcpBridge } = await import('../../src/electron/libs/computer-use');
  const { ComputerUseTranscript } = await import('../../src/electron/libs/computer-use/provider-mcp');
  const { computerUseLease } = await import('../../src/electron/libs/codex-computer-use');
  const { disposeBrowserUseHttpServer } = await import('../../src/electron/libs/browser-use-http-server');
  const { disposeSessionHttpServer } = await import('../../src/electron/libs/session-http-server');
  const { MinimaxAcpAdapter } = await import('../../src/electron/libs/provider/minimax-acp-adapter');
  const { MimoAcpAdapter } = await import('../../src/electron/libs/provider/mimo-acp-adapter');
  const { DevinAcpAdapter } = await import('../../src/electron/libs/provider/devin-acp-adapter');
  const { GrokAcpAdapter } = await import('../../src/electron/libs/provider/grok-acp-adapter');

  const driverCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let running = false;
  const driver = {
    async start() { running = true; return 1; },
    async call(tool: string, args: Record<string, unknown>) {
      driverCalls.push({ tool, args });
      const ok = (text: string, structured: Record<string, unknown> | null = null, images: Array<{ mimeType: string; data: string }> = []) =>
        ({ isError: false, text, structured, images });
      switch (tool) {
        case 'check_permissions': return ok('permissions', { accessibility: true, screen_recording: true });
        case 'list_apps': return ok('apps', { apps: [{ name: 'Calculator', bundle_id: 'com.apple.calculator', pid: 500, running: true, launch_path: '/System/Applications/Calculator.app' }] });
        case 'list_windows': return ok('windows', { windows: [{ window_id: 71, pid: args.pid, title: 'Calculator', layer: 0, is_on_screen: true, z_index: 3, bounds: { width: 230, height: 408 } }] });
        case 'get_window_state': return ok(TREE, { snapshot_id: `s${driverCalls.length}`, tree_markdown: TREE, screenshot_width: 460, screenshot_height: 816 },
          [{ mimeType: 'image/jpeg', data: Buffer.from(`shot-${driverCalls.length}`).toString('base64') }]);
        default: return ok(`${tool} delivered`);
      }
    },
    isRunning: () => running,
    async stop() { running = false; },
    stopSync() { running = false; },
  };
  const cards: Array<{ sessionId: string; toolName: string; app: string | null }> = [];
  const known = new Set<string>();
  const gateway = initializeComputerUseGateway(
    {
      getSession: (sessionId) => (known.has(sessionId) ? { planMode: false, fullAccess: false, readOnlyWorkflowRole: null, generation: 1 } : null),
      requestApproval: async (sessionId, input) => {
        cards.push({ sessionId, toolName: input.toolName, app: input.app });
        return { allow: true, untilRevoked: false };
      },
      emitLive: () => undefined,
      userDataDir: () => userData,
      ownProcessIds: () => [process.pid],
    },
    { hostBundleId: 'com.github.Electron', driver }
  );
  const transcript = new ComputerUseTranscript(() => getComputerUseMcpBridge());
  const offered = isComputerUseAvailableNow();
  assert.equal(offered, process.platform === 'darwin', 'Computer use is offered on macOS only');

  const agents: Array<{ kind: AgentKind; env: string; make: () => { events: NodeJS.EventEmitter; [key: string]: unknown } }> = [
    { kind: 'minimax', env: 'MINIMAX_CLI_PATH', make: () => new MinimaxAcpAdapter() as never },
    { kind: 'mimo', env: 'MIMO_CLI_PATH', make: () => new MimoAcpAdapter() as never },
    { kind: 'devin', env: 'DEVIN_CLI_PATH', make: () => new DevinAcpAdapter() as never },
    { kind: 'grok', env: 'GROK_CODE_PATH', make: () => new GrokAcpAdapter() as never },
  ];
  type Adapter = {
    events: NodeJS.EventEmitter;
    startSession(input: unknown): Promise<unknown>;
    sendTurn(input: unknown): Promise<void>;
    stopSession(threadId: string): Promise<void>;
    respondToRequest(threadId: string, requestId: string, decision: unknown): Promise<void>;
  };

  /** One session of one adapter through a turn; what the chat saw of it. */
  async function run(kind: AgentKind, make: () => unknown, threadId: string) {
    const adapter = make() as Adapter;
    const messages: Array<Record<string, unknown>> = [];
    const providerCards: Array<{ toolName: string }> = [];
    adapter.events.on('event', (event: Event) => {
      if (event.threadId !== threadId) return;
      if (event.type === 'message') {
        messages.push(transcript.annotate(threadId, event.message as never) as never);
      }
      if (event.type === 'permission_request') {
        // The agent's own card: the user allows it.
        providerCards.push({ toolName: String(event.toolName) });
        void adapter.respondToRequest(threadId, String(event.requestId), { behavior: 'allow', updatedInput: {} });
      }
    });
    known.add(threadId);
    await withTimeout(adapter.startSession({ provider: kind, threadId, cwd: temp, prompt: '' }), `${kind} startSession`);
    await withTimeout(adapter.sendTurn({ threadId, prompt: 'Press equals in Calculator.' }), `${kind} turn`);
    const blocks = (type: string) => messages
      .flatMap((message) => ((message.message as { content?: Array<Record<string, unknown>> } | undefined)?.content ?? []))
      .filter((block) => block.type === type);
    return { adapter, providerCards, uses: blocks('tool_use'), results: blocks('tool_result') };
  }

  try {
    for (const { kind, env, make } of agents) {
      process.env[env] = fakeAgentPath;
      process.env.FAKE_KIND = kind;
      const threadId = `${kind}-1`;
      const cardsBefore = cards.length;
      const clicksBefore = driverCalls.filter((call) => call.tool === 'click').length;
      const { adapter, providerCards, uses, results } = await run(kind, make, threadId);
      const log = readLog(kind);
      const entry = (event: string, of?: string) => log.find((item) => item.event === event && (of === undefined || item.of === of));

      if (!offered) {
        // Off (here: not macOS): the agent is handed no server of that name,
        // and its question about a tool that shares the name is the user's to answer.
        assert.ok(!(entry('servers')!.names as string[]).includes('aegis-computer-use'), `${kind}: no entry when Computer use is not offered`);
        assert.deepEqual(entry('approval', 'same-name')!.outcome, { outcome: 'selected', optionId: 'allow_once' });
        assert.equal(providerCards.length, 1, `${kind}: the same name without an entry gets the agent's ordinary card`);
        await adapter.stopSession(threadId);
        continue;
      }

      // The agent got the gateway's entry for this session, as an http server.
      assert.ok((entry('servers')!.names as string[]).includes('aegis-computer-use'), `${kind}: handed the entry`);
      assert.equal(entry('servers')!.type, 'http');
      assert.equal((entry('tools')!.names as string[]).length, 9, `${kind}: the nine tools`);

      // Its calls ran as this session's: the look, then the click behind the gateway's card.
      assert.equal(entry('look')!.isError, false, String(entry('look')!.text));
      assert.match(String(entry('look')!.text), /\[20\] AXButton \(Equals\)/);
      assert.match(String(entry('look')!.text), /Screenshot saved to .*computer-use-artifacts/, `${kind}: the screenshot as a file path`);
      assert.deepEqual(entry('look')!.blocks, ['text'], `${kind}: no image block for an agent not known to take them`);
      assert.equal(entry('click')!.isError, false, String(entry('click')!.text));
      assert.deepEqual(cards.slice(cardsBefore), [{ sessionId: threadId, toolName: 'click', app: 'Calculator' }], `${kind}: one Computer use card, in its session`);
      assert.equal(driverCalls.filter((call) => call.tool === 'click').length, clicksBefore + 1);
      assert.equal(computerUseLease.currentOwner()?.threadId, threadId, `${kind}: the desktop is its session's`);

      // The agent's own approval for the gateway's tool was answered once,
      // with nothing wider than "once", and without a card.
      assert.deepEqual(entry('approval', 'gateway')!.outcome, { outcome: 'selected', optionId: 'allow_once' }, `${kind}: its own approval is answered`);
      // Not before it had reached the server, and not for another server's tool.
      assert.deepEqual(entry('approval', 'before-connecting')!.outcome, { outcome: 'selected', optionId: 'allow_once' });
      assert.deepEqual(entry('approval', 'other-server')!.outcome, { outcome: 'selected', optionId: 'allow_once' });
      assert.equal(providerCards.length, 2, `${kind}: before it connected, and for another server, the user is asked: ${JSON.stringify(providerCards)}`);

      // The transcript: one name for the tools, and each result with its screenshot.
      assert.deepEqual(
        [...new Set(uses.map((block) => block.name))],
        ['mcp__aegis-computer-use__get_app_state', 'mcp__aegis-computer-use__click'],
        `${kind}: tool names as the app knows them`
      );
      const click = uses.find((block) => block.name === 'mcp__aegis-computer-use__click')!;
      assert.equal((click.input as Record<string, unknown>).app, 'Calculator', `${kind}: the tool's own input`);
      const withShots = results.filter((block) => Array.isArray(block.mediaRefs) && (block.mediaRefs as unknown[]).length > 0);
      assert.equal(new Set(withShots.map((block) => block.tool_use_id)).size, 2, `${kind}: both results keep their screenshot: ${JSON.stringify(results)}`);

      // The agent's process is gone: its entry names nobody, and the turn's
      // end (ipc-handlers calls this for every provider) frees the desktop.
      await adapter.stopSession(threadId);
      gateway.finishTurn(threadId);
      for (let i = 0; i < 100 && computerUseLease.currentOwner(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(computerUseLease.currentOwner(), null, `${kind}: the desktop is free after its turn`);
    }

    if (offered) {
      // The switch off: no agent is handed the entry, and a tool that only
      // shares the name keeps the agent's own approval.
      delete process.env.AEGIS_COMPUTER_USE_ENABLED;
      assert.equal(isComputerUseAvailableNow(), false);
      writeFileSync(logPath, '');
      for (const { kind, make } of agents) {
        process.env.FAKE_KIND = kind;
        const threadId = `${kind}-off`;
        const cardsBefore = cards.length;
        const { adapter, providerCards } = await run(kind, make, threadId);
        const log = readLog(kind);
        assert.ok(!(log.find((item) => item.event === 'servers')!.names as string[]).includes('aegis-computer-use'), `${kind}: no entry with the switch off`);
        assert.equal(providerCards.length, 1, `${kind}: the same name without an entry gets the agent's ordinary card`);
        assert.equal(cards.length, cardsBefore);
        await adapter.stopSession(threadId);
      }
    }
    process.env.AEGIS_COMPUTER_USE_ENABLED = '1';
    await testSdkRuntimesAndNativeTools({ offered, cards, driverCalls, known, gateway });
    testAdapterSources();
    console.log(`computer use provider wiring tests passed (${offered ? 'entry, calls, approvals and transcript for MiniMax, MiMo, Devin and Grok; session entries, the shared-server entry and Pi tools' : 'not offered on this platform: no entry, no tools, ordinary approvals'})`);
  } finally {
    await gateway.shutdown('test-over').catch(() => undefined);
    disposeComputerUseMcpBridge();
    disposeBrowserUseHttpServer();
    disposeSessionHttpServer();
    rmSync(temp, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
