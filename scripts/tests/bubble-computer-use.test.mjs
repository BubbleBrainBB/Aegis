// Computer use through the Bubble adapter: the real SDK (pinned version) with
// a scripted model, the real gateway with a scripted driver. What is checked
// is the seam between the two: which approval a tool call gets, in which
// turn, and what happens to a call when the switch goes off or the turn is
// stopped. No driver binary and no desktop are involved.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
process.setMaxListeners(64);
const home = mkdtempSync(join(tmpdir(), 'aegis-bubble-cu-'));
const saved = {};
const setEnv = (name, value) => {
  saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
setEnv('BUBBLE_HOME', home);
setEnv('AEGIS_COMPUTER_USE_SETTINGS_PATH', join(home, 'computer-use.json'));
setEnv('AEGIS_COMPUTER_USE_ENABLED', undefined);
// A file that answers `--version` as the pinned driver: enough for "the driver is there".
const fakeDriver = join(home, 'cua-driver');
writeFileSync(fakeDriver, '#!/bin/sh\necho "cua-driver 0.57.0"\n');
chmodSync(fakeDriver, 0o755);
setEnv('AEGIS_CUA_DRIVER_PATH', fakeDriver);

const loader = require('../../dist-electron/electron/libs/provider/bubble-sdk-loader.js');
const originalSdk = loader.getBubbleSdk;
const computerUse = require('../../dist-electron/electron/libs/computer-use/index.js');
const settings = require('../../dist-electron/electron/libs/computer-use/settings.js');
const { CUA_DRIVER_VERSION } = require('../../dist-electron/electron/libs/computer-use/driver-binary.js');
const { computerUseLease } = require('../../dist-electron/electron/libs/codex-computer-use.js');
const { computerUseGrants } = require('../../dist-electron/electron/libs/codex-computer-use-grants.js');
assert.equal(CUA_DRIVER_VERSION, '0.57.0', 'the stand-in above answers as the pinned version');

const CLICK = 'mcp__aegis-computer-use__click';
const GET_APP_STATE = 'mcp__aegis-computer-use__get_app_state';
const DRAG = 'mcp__aegis-computer-use__drag';
const CANCELLED = 'Computer use was cancelled.';
const onMac = process.platform === 'darwin';

const gate = () => {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
};
const until = async (condition, what) => {
  for (let i = 0; i < 600; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
};
const USAGE = { type: 'usage', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } };
const text = (content) => [{ type: 'text', content }, USAGE, { type: 'done' }];
const toolCall = (id, name, args) => [
  { type: 'tool_call', id, name, arguments: JSON.stringify(args), isStart: true, isEnd: true },
  USAGE,
  { type: 'done' },
];

/** The driver, scripted: what the gateway sends is recorded, one tool can be held in flight. */
function scriptedDriver() {
  const driver = {
    calls: [],
    killed: 0,
    stopped: 0,
    running: false,
    instance: 0,
    hold: null,
    /** Held open: a driver process told to go takes this long to be gone. */
    exit: null,
    snapshots: 0,
    async start(signal) {
      if (signal?.aborted) throw new Error(CANCELLED);
      if (!driver.running) { driver.running = true; driver.instance += 1; }
      return driver.instance;
    },
    async call(tool, args, options = {}) {
      if (options.signal?.aborted) throw new Error(CANCELLED);
      if (options.instance !== undefined && (!driver.running || options.instance !== driver.instance)) throw new Error('restarted');
      driver.calls.push({ tool, args });
      if (driver.hold?.tool === tool) {
        const held = driver.hold;
        driver.hold = null;
        held.entered.open();
        await new Promise((resolve, reject) => {
          // As the real host does: the driver is stopped, and the caller hears "cancelled" once it is gone.
          options.signal?.addEventListener('abort', () => {
            driver.killed += 1;
            driver.running = false;
            void (driver.exit?.promise ?? Promise.resolve()).then(() => reject(new Error(CANCELLED)));
          }, { once: true });
          void held.release.promise.then(resolve);
        });
      }
      const ok = (content, structured = null, images = []) => ({ isError: false, text: content, structured, images });
      if (tool === 'check_permissions') return ok('ok', { accessibility: true, screen_recording: true });
      if (tool === 'list_apps') return ok('apps', { apps: [{ name: 'Calculator', bundle_id: 'com.apple.calculator', pid: 500, running: true }] });
      if (tool === 'list_windows') return ok('windows', { windows: [{ window_id: 71, pid: 500, title: 'Calculator', layer: 0, is_on_screen: true, z_index: 1, bounds: { width: 230, height: 408 } }] });
      if (tool === 'get_window_state') {
        driver.snapshots += 1;
        return ok('tree', { snapshot_id: `s0000000${driver.snapshots}`, tree_markdown: '- [20] AXButton (Equals) [id=Equals actions=[press]]' },
          [{ mimeType: 'image/jpeg', data: Buffer.from(`shot-${driver.snapshots}`).toString('base64') }]);
      }
      return ok(`${tool} delivered`);
    },
    isRunning: () => driver.running,
    async stop() { driver.stopped += 1; driver.running = false; },
    stopSync() { driver.running = false; },
    of: (tool) => driver.calls.filter((call) => call.tool === tool),
    holdNext(tool) { driver.hold = { tool, entered: gate(), release: gate() }; return driver.hold; },
  };
  return driver;
}

try {
  const { BubbleSdk } = await import('@bubblebrain-ai/bubble');
  const { registerDynamicModelMetadata } = await import('@bubblebrain-ai/bubble/dist/model-catalog.js');
  const { BubbleSdkAdapter } = require('../../dist-electron/electron/libs/provider/bubble-sdk-adapter.js');
  registerDynamicModelMetadata({ providerId: 'openai', id: 'aegis-cu-test', contextWindow: 128000 });

  /**
   * One adapter on one real SDK, and a gateway of its own on a scripted
   * driver. `steps[i]` answers the model's i-th call. An MCP server of the
   * user's is configured with a tool of the very name the gateway uses.
   */
  function fixture(name, steps, { fullAccess = false } = {}) {
    const cwd = join(home, name);
    mkdirSync(cwd, { recursive: true });
    const sdk = new BubbleSdk({ defaultCwd: cwd, mcp: false });
    const adapter = new BubbleSdkAdapter();
    const events = [];
    const calls = [];
    /** Cards of Bubble's own approval layer, as the adapter shows them. */
    const bubbleCards = [];
    /** COMPUTER USE cards, as the gateway asks the host for them. */
    const gatewayCards = [];
    const mcp = { runs: 0 };
    const driver = scriptedDriver();
    computerUseLease.releaseThread(computerUseLease.currentOwner()?.threadId || '');
    computerUseGrants.revokeAll('test-reset');
    const gateway = computerUse.initializeComputerUseGateway(
      {
        getSession: (sessionId) =>
          adapter.sessions.has(sessionId)
            ? { planMode: false, fullAccess, readOnlyWorkflowRole: null, generation: 1 }
            : null,
        requestApproval: (_sessionId, input, signal) =>
          new Promise((resolve, reject) => {
            gatewayCards.push({ input, signal, answer: resolve });
            signal.addEventListener('abort', () => reject(new Error('Computer use approval was cancelled.')), { once: true });
          }),
        emitLive: () => undefined,
        userDataDir: () => join(home, 'user-data'),
        ownProcessIds: () => [],
      },
      { hostBundleId: 'com.aegis.desktop', driver }
    );
    adapter.events.on('event', (event) => {
      events.push(event);
      if (event.type === 'permission_request') {
        bubbleCards.push(event);
        void adapter.respondToRequest(name, event.requestId, { behavior: 'allow' });
      }
    });
    sdk.getModelConfig = () => ({
      defaultProviderId: 'openai',
      defaultModel: 'openai:aegis-cu-test',
      providers: [{ id: 'openai', hasApiKey: true }],
    });
    sdk.mcpToolsFor = async () => [{
      name: CLICK,
      description: "somebody's MCP tool that happens to have this name",
      parameters: { type: 'object', properties: {} },
      execute: async () => { mcp.runs += 1; return { content: 'the MCP tool ran' }; },
    }];
    sdk.resolveProvider = () => ({
      providerId: 'openai',
      model: 'aegis-cu-test',
      provider: {
        async *streamChat(messages) {
          const step = steps[calls.length];
          calls.push(messages);
          yield* typeof step === 'function' ? await step(messages) : step ?? text('Nothing more to say');
        },
      },
    });
    const asked = { runTurn: [] };
    const runTurn = sdk.runTurn.bind(sdk);
    sdk.runTurn = (sessionId, options) => {
      asked.runTurn.push(options);
      return runTurn(sessionId, options);
    };
    loader.getBubbleSdk = async () => sdk;
    const messages = () => events.filter((event) => event.type === 'message').map((event) => event.message);
    const toolResults = () =>
      messages().filter((message) => message.type === 'user').flatMap((message) => message.message.content).filter((block) => block.type === 'tool_result');
    const statuses = () => events.filter((event) => event.type === 'status_change').map((event) => event.status);
    const finished = (count = 1) =>
      until(() => statuses().filter((status) => status === 'completed' || status === 'error').length >= count, `${name}: turn ${count} to finish`);
    /** The names of the gateway tools a turn was given. */
    const registered = (turn) =>
      asked.runTurn[turn].hostTools.map((tool) => tool.name).filter((toolName) => toolName.startsWith('mcp__aegis-computer-use__'));
    return {
      sdk, adapter, cwd, events, calls, driver, gateway, mcp, bubbleCards, gatewayCards, asked, registered, toolResults, statuses, finished,
      start: (prompt, extra = {}) => adapter.startSession({ provider: 'bubble', threadId: name, cwd, prompt, bubblePermissionMode: 'default', ...extra }),
      send: (prompt, extra = {}) => adapter.sendTurn({ threadId: name, prompt, ...extra }),
      card: async () => {
        await until(() => gatewayCards.length > 0, `${name}: a COMPUTER USE card`);
        return gatewayCards.shift();
      },
    };
  }

  // 1. Off (the default): no gateway tool is registered, so a tool of the
  //    same name is the user's MCP server's. It gets Bubble's ordinary
  //    approval, runs as the MCP tool, and the gateway never hears of it.
  {
    assert.equal(settings.isComputerUseEnabled(), false);
    const f = fixture('off', [toolCall('call-1', CLICK, { app: 'Calculator', element_index: '20' }), text('done')]);
    await f.start('Click it');
    await f.finished();
    assert.deepEqual(f.registered(0), [], 'no Computer use tool is offered while the switch is off');
    assert.equal(f.bubbleCards.length, 1, 'the same-named MCP tool is asked about like any MCP tool');
    assert.equal(f.bubbleCards[0].input.kind, 'acp-permission');
    assert.equal(f.bubbleCards[0].toolName, CLICK);
    assert.equal(f.mcp.runs, 1);
    assert.equal(f.toolResults()[0].content, 'the MCP tool ran');
    assert.equal(f.gatewayCards.length, 0);
    assert.equal(f.driver.calls.length, 0, 'the gateway is not involved');
  }

  if (onMac) {
    settings.setComputerUseEnabled(true);
    assert.equal(computerUse.isComputerUseAvailableNow(), true);

    // 2. On: the gateway's tools are registered for the turn and shadow the
    //    MCP tool of the same name. Bubble's own layer shows no card; the
    //    gateway's COMPUTER USE card is the one approval.
    {
      const f = fixture('on', [
        toolCall('call-1', GET_APP_STATE, { app: 'Calculator' }),
        toolCall('call-2', CLICK, { app: 'Calculator', element_index: '20' }),
        text('42'),
      ]);
      await f.start('Press equals');
      const card = await f.card();
      assert.equal(card.input.kind, 'computer-use');
      assert.equal(card.input.toolName, 'click');
      assert.equal(card.input.app, 'Calculator');
      assert.deepEqual(card.input.paramLines, [{ label: 'element', value: '[20] AXButton (Equals)' }]);
      assert.equal(f.driver.of('click').length, 0, 'nothing is sent before the answer');
      card.answer({ allow: true, untilRevoked: false });
      await f.finished();
      assert.equal(f.registered(0).length, 9);
      assert.deepEqual(f.bubbleCards, [], "Bubble's own approval layer shows nothing for the gateway's tools");
      assert.equal(f.mcp.runs, 0, 'the MCP tool of the same name is shadowed, not run');
      assert.deepEqual(f.driver.of('click')[0].args, {
        element_token: 's00000001:20', button: 'left', delivery_mode: 'background', scope: 'window', session: f.driver.of('click')[0].args.session,
      });
      const [looked, clicked] = f.toolResults();
      assert.equal(looked.is_error, false);
      assert.equal(looked.mediaRefs.length, 1, 'the screenshot is filed with the tool result');
      assert.equal(clicked.mediaRefs.length, 1);
      assert.notEqual(clicked.mediaRefs[0].sha256, looked.mediaRefs[0].sha256);
      f.gateway.finishTurn('on');
    }

    // 3. A turn queued behind the running one (a message with a picture)
    //    carries its own tools. Queued while the switch was on, started after
    //    it went off: its call still reaches the gateway, which refuses it,
    //    and the MCP tool of the same name is still not what runs.
    {
      const answering = gate();
      const reached = gate();
      const f = fixture('queued', [
        async () => { reached.open(); await answering.promise; return text('First answer'); },
        toolCall('call-q', CLICK, { app: 'Calculator', element_index: '20' }),
        text('Second answer'),
      ]);
      const image = join(f.cwd, 'shot.png');
      writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
      await f.start('Look around');
      await reached.promise;
      await f.send('And this picture', { attachments: [{ kind: 'image', path: image, name: 'shot.png', mimeType: 'image/png' }] });
      await until(() => f.asked.runTurn.length === 2, 'the queued turn to be handed to the SDK');
      assert.equal(f.registered(1).length, 9, 'the queued turn was given the tools');
      settings.setComputerUseEnabled(false);
      await f.gateway.shutdown('disabled');
      answering.open();
      await f.finished();
      const result = f.toolResults()[0];
      assert.equal(result.is_error, true);
      assert.equal(result.content, 'Computer use is turned off in Settings.');
      assert.deepEqual(f.bubbleCards, []);
      assert.equal(f.gatewayCards.length, 0);
      assert.equal(f.mcp.runs, 0);
      assert.equal(f.driver.calls.length, 0);
      // The turn after that is built with the switch off: no tools, and the name is the MCP tool's again.
      await f.send('Once more');
      await f.finished(2);
      assert.deepEqual(f.registered(2), []);
      settings.setComputerUseEnabled(true);
    }

    // 4. The switch goes off while the approval card is open: the card comes
    //    down, the call ends, nothing is sent, and a late answer does nothing.
    {
      const f = fixture('off-while-asked', [
        toolCall('call-1', GET_APP_STATE, { app: 'Calculator' }),
        toolCall('call-2', CLICK, { app: 'Calculator', element_index: '20' }),
        text('It was turned off'),
      ]);
      await f.start('Press equals');
      const card = await f.card();
      assert.equal(computerUseLease.currentOwner()?.threadId, 'off-while-asked');
      settings.setComputerUseEnabled(false);
      await f.gateway.shutdown('disabled');
      assert.equal(card.signal.aborted, true);
      await f.finished();
      const refused = f.toolResults()[1];
      assert.equal(refused.is_error, true);
      settings.setComputerUseEnabled(true);
      card.answer({ allow: true, untilRevoked: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(f.driver.of('click').length, 0);
      assert.deepEqual(computerUseGrants.list('off-while-asked'), []);
      assert.equal(computerUseLease.currentOwner(), null);
      assert.deepEqual(f.bubbleCards, []);
    }

    // 5. Stop while a request is with the driver: the SDK's abort reaches the
    //    gateway, and the driver is stopped (the only way to know the action
    //    is no longer running).
    {
      const f = fixture('stopped', [
        toolCall('call-1', GET_APP_STATE, { app: 'Calculator' }),
        toolCall('call-2', DRAG, { app: 'Calculator', from_x: 1, from_y: 2, to_x: 3, to_y: 4 }),
        text('never said'),
      ], { fullAccess: true });
      const held = f.driver.holdNext('drag');
      f.driver.exit = gate();
      const started = await f.start('Drag it');
      await held.entered.promise;
      assert.equal(f.driver.killed, 0);
      await f.adapter.stopSession(started.threadId);
      await until(() => f.driver.killed === 1, 'the driver to be stopped');
      assert.equal(f.gatewayCards.length, 0);
      // What the app does on Stop. The desktop is not handed on while the
      // driver process is still going: Codex, or another task, is refused.
      f.gateway.forgetSession('stopped', 'stop');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(computerUseLease.currentOwner()?.threadId, 'stopped');
      assert.equal(computerUseLease.tryAcquire('codex-thread', 'codex-call'), false);
      f.driver.exit.open();
      await until(() => computerUseLease.currentOwner() === null, 'the desktop to be handed back');
    }
  }

  console.log(`Bubble Computer use: a same-named MCP tool keeps Bubble's own approval while the switch is off${
    onMac ? ', the gateway card is the one approval while it is on, a queued turn carries its own tools, the switch going off ends an open card, and Stop ends a request in flight and hands the desktop back only once the driver is gone' : ' (the rest runs on macOS only)'
  } passed`);
} finally {
  loader.getBubbleSdk = originalSdk;
  computerUseGrants.revokeAll('test-reset');
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
}
