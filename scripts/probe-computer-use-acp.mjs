#!/usr/bin/env node
// Run by hand, not in CI: what a real ACP agent does with the Computer use
// MCP bridge. It starts the agent's own CLI (`mcode acp`, `mimo acp`,
// `devin acp`, `grok agent stdio`), hands it the bridge's entry for one
// session the way the adapters do (ACP `session/new` mcpServers), and asks
// its model for one look and one click. The gateway behind the bridge is the
// app's real one on a scripted driver: no desktop is touched.
//
// It makes ONE real model request on your account with that agent.
//
//   npm run transpile:electron
//   node scripts/probe-computer-use-acp.mjs minimax|mimo|devin|grok [inline]
//       [--config permissionMode=default] [--mode plan]
//
// `inline` hands screenshots over as MCP image blocks instead of file paths.
// `--config id=value` sends session/set_config_option and `--mode id` sends
// session/set_mode before the prompt, to see the agent in the mode Aegis
// would put it in.
//
// Prints what the adapter has to know: how the agent names the tools in its
// tool_call updates, whether it asks its own approval for them, whether the
// calls arrive bound to the session, and whether an image block survives.
// Run it again after upgrading one of these CLIs.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve('.');
const lib = (name) => require(join(root, 'dist-electron/electron/libs', name));
const { ComputerUseGateway } = lib('computer-use/service.js');
const { ComputerUseMcpBridge } = lib('computer-use/mcp-bridge.js');
const { ComputerUseLease } = lib('codex-computer-use.js');
const { ComputerUseGrantRegistry } = lib('codex-computer-use-grants.js');
const { computerUseToolOfProviderName } = require(join(root, 'dist-electron/shared/computer-use.js'));

const AGENTS = {
  minimax: { command: process.env.MINIMAX_CLI_PATH || 'mcode', args: ['acp'], capabilities: { elicitation: { form: {} }, plan: {} } },
  mimo: { command: process.env.MIMO_CLI_PATH || 'mimo', args: ['acp'], capabilities: {} },
  devin: { command: process.env.DEVIN_CLI_PATH || 'devin', args: ['acp'], capabilities: { elicitation: { form: {} } } },
  grok: { command: process.env.GROK_CLI_PATH || 'grok', args: ['agent', 'stdio'], capabilities: {} },
};
const agentName = process.argv[2];
const agent = AGENTS[agentName];
if (!agent) {
  console.error(`usage: node scripts/probe-computer-use-acp.mjs ${Object.keys(AGENTS).join('|')} [inline] [--config id=value] [--mode id]`);
  process.exit(2);
}
const images = process.argv.includes('inline') ? 'inline' : 'file';
const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const configOption = flag('--config');
const sessionMode = flag('--mode');
const SESSION = `probe-${agentName}`;
const temp = mkdtempSync(join(tmpdir(), 'aegis-cu-acp-probe-'));

const TREE = [
  '- [0] AXWindow "Calculator" [id=main actions=[raise]]',
  '    - AXStaticText = "0" (Edit field)',
  '    - [20] AXButton (Equals) [id=Equals actions=[press]]',
].join('\n');
const SHOT = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';
const driverCalls = [];
const driver = {
  running: false,
  async start() { this.running = true; return 1; },
  async call(tool, args) {
    driverCalls.push(tool);
    const ok = (text, structured = null, shots = []) => ({ isError: false, text, structured, images: shots });
    switch (tool) {
      case 'check_permissions': return ok('permissions', { accessibility: true, screen_recording: true });
      case 'list_apps': return ok('apps', { apps: [{ name: 'Calculator', bundle_id: 'com.apple.calculator', pid: 500, running: true, launch_path: '/System/Applications/Calculator.app' }] });
      case 'list_windows': return ok('windows', { windows: [{ window_id: 71, pid: args.pid, title: 'Calculator', layer: 0, is_on_screen: true, z_index: 3, bounds: { width: 230, height: 408 } }] });
      case 'get_window_state': return ok(TREE, { snapshot_id: `s${driverCalls.length}`, tree_markdown: TREE, screenshot_width: 1, screenshot_height: 1 }, [{ mimeType: 'image/jpeg', data: SHOT }]);
      default: return ok(`${tool} delivered`);
    }
  },
  isRunning() { return this.running; },
  async stop() { this.running = false; },
  stopSync() { this.running = false; },
};
const gatewayCards = [];
const gateway = new ComputerUseGateway(
  {
    isEnabled: () => true,
    driverStatus: () => ({ state: 'ready', path: '/probe/cua-driver', version: '0', pinnedVersion: '0', message: null }),
    getSession: (sessionId) => (sessionId === SESSION ? { planMode: false, fullAccess: false, readOnlyWorkflowRole: null, generation: 1 } : null),
    requestApproval: async (_sessionId, input) => {
      gatewayCards.push(`${input.toolName} in ${input.app}`);
      return { allow: true, untilRevoked: false };
    },
    emitLive: () => undefined,
    userDataDir: () => temp,
    ownProcessIds: () => [process.pid],
  },
  driver,
  { lease: new ComputerUseLease(), grants: new ComputerUseGrantRegistry() }
);
const bridge = new ComputerUseMcpBridge({ gateway: () => gateway, userDataDir: () => temp });
const entry = await bridge.bindSession(SESSION, { images });

const proc = spawn(agent.command, agent.args, { cwd: temp, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
let stderrTail = '';
proc.stderr.setEncoding('utf8');
proc.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-2000); });
let nextId = 1;
const waiting = new Map();
const send = (message) => proc.stdin.write(`${JSON.stringify(message)}\n`);
const request = (method, params) => new Promise((resolveRequest, reject) => {
  const id = nextId++;
  waiting.set(id, { resolveRequest, reject });
  send({ jsonrpc: '2.0', id, method, params });
});

const toolCalls = new Map();
const providerApprovals = [];
let answer = '';
createInterface({ input: proc.stdout }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && message.method === undefined) {
    const pending = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) pending?.reject(new Error(JSON.stringify(message.error)));
    else pending?.resolveRequest(message.result);
    return;
  }
  if (message.method === 'session/request_permission') {
    const toolCall = message.params?.toolCall || {};
    const options = message.params?.options || [];
    providerApprovals.push({
      name: toolCall.name, title: toolCall.title, kind: toolCall.kind, toolCallId: toolCall.toolCallId,
      rawInput: toolCall.rawInput, meta: toolCall._meta, options: options.map((option) => `${option.kind}:${option.optionId}`),
    });
    const allow = options.find((option) => option.kind === 'allow_once') || options[0];
    send({ jsonrpc: '2.0', id: message.id, result: { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } } });
    return;
  }
  if (message.id !== undefined && message.method) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `probe: ${message.method} is not supported` } });
    return;
  }
  if (message.method !== 'session/update') return;
  const update = message.params?.update || {};
  if (update.sessionUpdate === 'agent_message_chunk') answer += update.content?.text || '';
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    const id = update.toolCallId;
    const known = toolCalls.get(id) || {};
    toolCalls.set(id, {
      ...known,
      ...(update.name ? { name: update.name } : {}),
      ...(update.title ? { title: update.title } : {}),
      ...(update.kind ? { kind: update.kind } : {}),
      ...(update._meta ? { meta: update._meta } : {}),
      ...(update.rawInput ? { rawInput: update.rawInput } : {}),
      ...(update.status ? { status: update.status } : {}),
      ...(update.rawOutput ? { rawOutput: JSON.stringify(update.rawOutput).slice(0, 400) } : {}),
      ...(update.content ? { content: JSON.stringify(update.content).slice(0, 400) } : {}),
    });
  }
});

const timeout = setTimeout(() => {
  console.error('probe: timed out after 180 s');
  console.error(stderrTail);
  finish(1);
}, 180_000);
function finish(code) {
  clearTimeout(timeout);
  proc.kill('SIGTERM');
  bridge.dispose();
  rmSync(temp, { recursive: true, force: true });
  process.exit(code);
}

try {
  await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'aegis', title: 'Aegis', version: '0.0.0' },
    clientCapabilities: agent.capabilities,
  });
  const session = await request('session/new', {
    cwd: temp,
    mcpServers: [{
      type: 'http',
      name: 'aegis-computer-use',
      url: entry.url,
      headers: Object.entries(entry.headers).map(([name, value]) => ({ name, value })),
    }],
  });
  if (configOption) {
    const [configId, value] = configOption.split('=');
    await request('session/set_config_option', { sessionId: session.sessionId, configId, value });
  }
  if (sessionMode) await request('session/set_mode', { sessionId: session.sessionId, modeId: sessionMode });
  const result = await request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{
      type: 'text',
      text: 'This is a tool wiring check. Use the aegis-computer-use tools and nothing else: first call get_app_state with app "Calculator", then call click with app "Calculator" and element_index "20". Then answer in one line with the text of the element you clicked'
        + (images === 'inline' ? ' and say whether you were shown a screenshot image.' : '.'),
    }],
  });
  const calls = [...toolCalls.values()];
  const summary = {
    agent: agentName,
    images,
    ...(configOption ? { configOption } : {}),
    ...(sessionMode ? { sessionMode } : {}),
    stopReason: result?.stopReason,
    toolCalls: calls.map((call) => ({
      name: call.name, title: call.title, kind: call.kind, meta: call.meta, rawInput: call.rawInput, status: call.status,
      recognisedAs: computerUseToolOfProviderName(call.name) || computerUseToolOfProviderName(call.title) || null,
      output: call.rawOutput || call.content,
    })),
    providerApprovals,
    gatewayCards,
    driverCalls,
    answer: answer.trim().slice(0, 400),
  };
  console.log(JSON.stringify(summary, null, 2));
  finish(0);
} catch (error) {
  console.error('probe failed:', error instanceof Error ? error.message : error);
  console.error(stderrTail);
  finish(1);
}
