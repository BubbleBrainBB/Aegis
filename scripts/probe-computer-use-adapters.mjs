#!/usr/bin/env node
// Run by hand, not in CI: a real Aegis adapter (its real SDK or CLI, a real
// model) with the app's own Computer use gateway and MCP bridge on a scripted
// driver. No desktop is touched. For the adapters that are not ACP agents
// (scripts/probe-computer-use-acp.mjs is for those):
//
//   npm run transpile:electron
//   node scripts/probe-computer-use-adapters.mjs qoder|opencode|pi
//   LIVE_MODEL=<id> node scripts/probe-computer-use-adapters.mjs opencode
//
// It makes ONE real model request on your account with that agent, in a
// temporary folder. It turns Computer use on for this process only
// (AEGIS_COMPUTER_USE_ENABLED) with a stand-in for the driver's version
// probe; your settings are not read or changed.
//
// Prints what the wiring has to get right: the tool names the transcript
// ends up with, whether each result kept its screenshot, whether the agent
// asked its own approval on top of the gateway's card (`providerCards`
// should be empty), and who held the desktop. Run it again after upgrading
// one of these SDKs or CLIs.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const kind = process.argv[2];
if (!['qoder', 'opencode', 'pi'].includes(kind)) {
  console.error('usage: node scripts/probe-computer-use-adapters.mjs qoder|opencode|pi');
  process.exit(2);
}
const temp = mkdtempSync(join(tmpdir(), 'aegis-cu-live-'));
process.env.AEGIS_BROWSER_USE_TEST_MODE = '1';
process.env.AEGIS_COMPUTER_USE_SETTINGS_PATH = join(temp, 'computer-use.json');
const standIn = join(temp, 'cua-driver');
writeFileSync(standIn, '#!/bin/sh\necho "cua-driver 0.57.0"\n'); chmodSync(standIn, 0o755);
process.env.AEGIS_CUA_DRIVER_PATH = standIn;
process.env.AEGIS_COMPUTER_USE_ENABLED = '1';
const root = resolve('.');
const lib = (name) => require(join(root, 'dist-electron/electron/libs', name));
const { initializeComputerUseGateway, getComputerUseMcpBridge, isComputerUseAvailableNow } = lib('computer-use/index.js');
const { ComputerUseTranscript } = lib('computer-use/provider-mcp.js');
const { getComputerUseGateway } = lib('computer-use/index.js');
const { computerUseLease } = lib('codex-computer-use.js');
const TREE = '- [0] AXWindow "Calculator" [id=main actions=[raise]]\n    - [20] AXButton (Equals) [id=Equals actions=[press]]';
const driverCalls = [];
const driver = {
  async start() { return 1; },
  async call(tool, args) {
    driverCalls.push(tool);
    const ok = (text, structured = null, images = []) => ({ isError: false, text, structured, images });
    switch (tool) {
      case 'check_permissions': return ok('p', { accessibility: true, screen_recording: true });
      case 'list_apps': return ok('apps', { apps: [{ name: 'Calculator', bundle_id: 'com.apple.calculator', pid: 500, running: true, launch_path: '/System/Applications/Calculator.app' }] });
      case 'list_windows': return ok('w', { windows: [{ window_id: 71, pid: args.pid, title: 'Calculator', layer: 0, is_on_screen: true, z_index: 3, bounds: { width: 230, height: 408 } }] });
      case 'get_window_state': return ok(TREE, { snapshot_id: `s${driverCalls.length}`, tree_markdown: TREE, screenshot_width: 64, screenshot_height: 64 }, [{ mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC' }]);
      default: return ok(`${tool} delivered`);
    }
  },
  isRunning: () => true, async stop() {}, stopSync() {},
};
const THREAD = `live-${kind}`;
const cards = [];
const gateway = initializeComputerUseGateway({
  getSession: (id) => (id === THREAD ? { planMode: false, fullAccess: false, readOnlyWorkflowRole: null, generation: 1 } : null),
  requestApproval: async (id, input) => { cards.push(`${id}: ${input.toolName} in ${input.app}`); return { allow: true, untilRevoked: false }; },
  emitLive: () => undefined, userDataDir: () => temp, ownProcessIds: () => [process.pid],
}, { hostBundleId: 'com.github.Electron', driver });
console.log('available:', isComputerUseAvailableNow());
const adapters = {
  qoder: () => new (lib('provider/qoder-sdk-adapter.js').QoderSdkAdapter)(),
  opencode: () => new (lib('provider/opencode-sdk-adapter.js').OpenCodeSdkAdapter)(),
  pi: () => new (lib('provider/pi-sdk-adapter.js').PiSdkAdapter)(),
};
const adapter = adapters[kind]();
const transcript = new ComputerUseTranscript(() => getComputerUseMcpBridge(), (s, t) => getComputerUseGateway()?.takeMediaRefs(s, t) ?? []);
const events = [];
const providerCards = [];
adapter.events.on('event', (event) => {
  if (event.type === 'message') events.push(transcript.annotate(THREAD, event.message));
  if (event.type === 'permission_request') {
    providerCards.push(event.toolName);
    void adapter.respondToRequest(THREAD, event.requestId, { behavior: 'allow', updatedInput: event.input?.toolCall?.rawInput ?? event.input ?? {} });
  }
  if (event.type === 'error') console.log('adapter error:', event.error?.message || event.error);
});
const results = () => events.filter((message) => message.type === 'result');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let code = 0;
try {
  await adapter.startSession({
    provider: kind, threadId: THREAD, cwd: temp,
    model: process.env.LIVE_MODEL || undefined,
    prompt: 'This is a tool wiring check. Use only the aegis-computer-use tools (their names contain "aegis-computer-use"): call get_app_state with app "Calculator", then click with app "Calculator" and element_index "20". Then answer in one line with the text of the element you clicked.',
  });
  const deadline = Date.now() + 150_000;
  while (results().length === 0 && Date.now() < deadline) await sleep(250);
  const blocks = (type) => events.flatMap((message) => message.message?.content ?? []).filter((block) => block.type === type);
  console.log(JSON.stringify({
    kind,
    result: results()[0]?.subtype ?? 'timeout',
    toolUses: blocks('tool_use').map((block) => ({ name: block.name, input: block.input })),
    toolResults: blocks('tool_result').map((block) => ({ isError: block.is_error === true, mediaRefs: (block.mediaRefs || []).length, text: String(block.content).slice(0, 90) })),
    providerCards, gatewayCards: cards, driverCalls,
    leaseOwner: computerUseLease.currentOwner()?.threadId ?? null,
    answer: blocks('text').map((block) => block.text).join(' ').slice(-200),
  }, null, 1));
} catch (error) {
  console.log('failed:', error?.message || error); code = 1;
} finally {
  await adapter.stopSession(THREAD).catch(() => undefined);
  await adapter.stopAll?.().catch(() => undefined);
  await gateway.shutdown('done').catch(() => undefined);
  rmSync(temp, { recursive: true, force: true });
  process.exit(code);
}
