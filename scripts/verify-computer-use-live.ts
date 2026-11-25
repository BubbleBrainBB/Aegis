// Runs the Computer use gateway against the real cua-driver on this Mac.
//
//   npm run verify:computer-use-live
//
// It touches one app, Calculator, and nothing else: opens it in the
// background, presses 6 × 7 = through the accessibility tree, reads 42 back,
// and checks on the way that the approval card is asked for, that a grant
// stops the asking, that Plan mode and a second session are held off, that
// a session reaching the gateway over the MCP bridge (how the other
// providers do) reads and acts on the same terms and shares the lease, that
// Aegis itself is refused, and that the driver's own policy refuses what the
// gateway never sends. No file is opened, nothing is typed anywhere else, no
// pointer moves, no window comes to the front. Calculator is closed again
// only when this script was what opened it.
//
// It also checks, on the real binary, what the process host relies on:
// - the driver runs with the environment Aegis builds for it, not the one
//   this process has, and listens on nothing;
// - an input call that does not say `delivery_mode: background` is refused;
// - cancelling a call in flight stops the driver process (a slow drag across
//   Calculator's display, only when this script opened Calculator), and the
//   next call starts a new one;
// - a driver whose parent is killed outright exits by itself.
//
// macOS decides Accessibility and Screen Recording by the app at the top of
// the process chain that started this script (a terminal, or Aegis). When
// either is missing the script stops before acting and says where to turn
// it on; it never asks macOS for them itself.
//
// Screenshots and a summary land in output/computer-use-live/.

import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ComputerUseLiveFrame } from '../src/shared/computer-use';
import type { ComputerUsePermissionInput } from '../src/shared/types';
import {
  COMPUTER_USE_DENIED_TARGET_MESSAGE,
  COMPUTER_USE_LEASE_MESSAGE,
  ComputerUseLease,
  resolveComputerUseArtifact,
} from '../src/electron/libs/codex-computer-use';
import { ComputerUseGrantRegistry } from '../src/electron/libs/codex-computer-use-grants';
import { resolveCuaDriver } from '../src/electron/libs/computer-use/driver-binary';
import { COMPUTER_USE_CANCELLED_MESSAGE, CuaDriverHost, cuaDriverSocketPath } from '../src/electron/libs/computer-use/driver-host';
import { ComputerUseMcpBridge } from '../src/electron/libs/computer-use/mcp-bridge';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  COMPUTER_USE_PLAN_MESSAGE,
  ComputerUseGateway,
  type ComputerUseApprovalDecision,
  type ComputerUseSessionFacts,
  type ComputerUseToolResult,
} from '../src/electron/libs/computer-use/service';

const CALCULATOR = 'com.apple.calculator';
const OUT_DIR = path.resolve(__dirname, '..', 'output', 'computer-use-live');

function calculatorPids(): number[] {
  try {
    return execFileSync('/usr/bin/pgrep', ['-f', '/Calculator.app/Contents/MacOS/Calculator'], { encoding: 'utf8' })
      .split('\n').map((line) => Number(line.trim())).filter((pid) => pid > 0);
  } catch {
    return [];
  }
}

/** The driver processes of one home folder, found by the socket they were started on. */
function driverProcesses(homeDir: string): string[] {
  try {
    return execFileSync('/usr/bin/pgrep', ['-fl', cuaDriverSocketPath(homeDir)], { encoding: 'utf8' }).split('\n').filter((line) => line.includes('cua-driver'));
  } catch {
    return [];
  }
}

function driverPids(homeDir: string): number[] {
  return driverProcesses(homeDir).map((line) => Number(line.trim().split(' ')[0])).filter((pid) => pid > 0);
}

async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/** What this process's environment has that must not reach the driver. */
const LEAKS = {
  CUA_DRIVER_RS_MCP_HTTP_PORT: '18123',
  CUA_DRIVER_RS_MCP_HTTP_TOKEN: 'x'.repeat(40),
  CUA_DRIVER_ALLOW_BRIEF_FOREGROUND: '1',
  AEGIS_LIVE_VERIFY_SECRET: 'must-not-leak',
};

/**
 * This script again, as a child that starts a driver of its own and waits to
 * be killed: for "the driver exits when the process that started it dies".
 */
async function runAsOrphan(homeDir: string): Promise<void> {
  const status = resolveCuaDriver();
  const host = new CuaDriverHost({ resolveBinary: () => status.path!, homeDir, hostBundleId: 'com.aegis.desktop' });
  await host.start();
  console.log('driver-up');
  // It waits to be killed, but not for ever: it goes by itself when the
  // script that started it is gone, and in any case after a minute.
  const parent = process.ppid;
  const leave = () => {
    host.stopSync();
    process.exit(0);
  };
  setInterval(() => {
    if (process.ppid !== parent) leave();
  }, 500);
  setTimeout(leave, 60_000);
}

/** The index of a Calculator button, by the identifier it has in every system language. */
function buttonIndex(tree: string, id: string): string {
  const match = new RegExp(`\\[(\\d+)\\] AXButton[^\\n]*\\[id=${id}\\b`).exec(tree);
  assert.ok(match, `Calculator has no ${id} button in:\n${tree}`);
  return match[1];
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log('Computer use runs on macOS only for now; nothing to verify here.');
    return;
  }
  if (process.env.AEGIS_CU_LIVE_ORPHAN_HOME) return runAsOrphan(process.env.AEGIS_CU_LIVE_ORPHAN_HOME);
  const status = resolveCuaDriver();
  if (status.state !== 'ready' || !status.path) {
    console.error(status.message);
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'aegis-cu-live-'));
  const homeDir = path.join(userDataDir, 'computer-use', 'driver');
  const driver = new CuaDriverHost({
    resolveBinary: () => status.path!,
    homeDir,
    hostBundleId: 'com.aegis.desktop',
    // As if Aegis itself had been started with these set.
    env: { ...process.env, ...LEAKS },
  });
  const summary: Record<string, unknown> = { driver: { version: status.version, path: status.path } };
  const calculatorsBefore = calculatorPids();
  let opened: number[] = [];
  /** The child this script starts for the parent-death check; never left behind, whatever fails. */
  let helper: ChildProcess | null = null;

  try {
    // ── The macOS grants, read without asking for anything ────────────────
    const permissions = await driver.call('check_permissions', { prompt: false });
    const source = (permissions.structured?.source || {}) as Record<string, unknown>;
    summary.permissions = {
      accessibility: permissions.structured?.accessibility,
      screenRecording: permissions.structured?.screen_recording,
      attribution: source.attribution,
      responsibleApp: source.responsible_bundle_id ?? source.responsible_executable,
    };
    console.log('permissions', JSON.stringify(summary.permissions));
    assert.equal(source.attribution, 'host', 'the driver answers for the app that started it');
    const missing = [
      permissions.structured?.accessibility === true ? null : 'Accessibility (System Settings → Privacy & Security → Accessibility)',
      permissions.structured?.screen_recording === true ? null : 'Screen Recording (System Settings → Privacy & Security → Screen & System Audio Recording)',
    ].filter(Boolean);
    if (missing.length > 0) {
      console.error(
        `Stopped before acting. "${summary.permissions && (summary.permissions as { responsibleApp?: unknown }).responsibleApp}" needs:\n- ${missing.join('\n- ')}\nTurn them on there, then run this again.`
      );
      process.exitCode = 3;
      return;
    }

    // ── The environment the two driver processes really run with ──────────
    const firstPids = driverPids(homeDir);
    assert.equal(firstPids.length, 2, 'the daemon and its MCP proxy');
    let environmentReadable = 0;
    for (const pid of firstPids) {
      const shown = execFileSync('/bin/ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
      // macOS may not show another process's environment; then only the listener check below speaks.
      if (!shown.includes('CUA_DRIVER_EMBEDDED=1')) continue;
      environmentReadable += 1;
      assert.match(shown, /CUA_DRIVER_RS_TELEMETRY_ENABLED=false/);
      assert.match(shown, /CUA_DRIVER_RS_UPDATE_CHECK=false/);
      assert.ok(shown.includes(`CUA_DRIVER_RS_HOME=${homeDir}`));
      for (const name of [...Object.keys(LEAKS), 'HTTPS_PROXY', 'https_proxy', 'NODE_OPTIONS']) {
        assert.ok(!shown.includes(`${name}=`), `${name} must not reach the driver (pid ${pid})`);
      }
      assert.match(shown, /--parent-liveness-stdio|mcp --embedded/);
    }
    assert.equal(await portOpen(Number(LEAKS.CUA_DRIVER_RS_MCP_HTTP_PORT)), false, 'no HTTP listener was switched on from the environment');
    const listening = firstPids.flatMap((pid) => {
      try {
        return execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').slice(1).filter(Boolean);
      } catch {
        return [];
      }
    });
    assert.deepEqual(listening, [], 'the driver listens on no TCP port');
    summary.environment = {
      processesWithReadableEnvironment: environmentReadable,
      leaked: 'none of ' + Object.keys(LEAKS).join(', '),
      tcpListeners: 0,
    };

    // ── The driver's own policy: what the gateway never sends is refused ──
    for (const [tool, args, why] of [
      ['get_screen_size', {}, /not allowed/],
      ['clipboard_read', {}, /not allowed/],
      ['kill_app', { pid: 0 }, /not allowed/],
      // Input must say it is delivered in the background, inside one window. (No such pid: nothing can happen.)
      ['click', { pid: 999999, window_id: 1, x: 1, y: 1 }, /missing required argument 'delivery_mode'/],
      ['click', { pid: 999999, window_id: 1, x: 1, y: 1, delivery_mode: 'foreground', scope: 'window' }, /'delivery_mode' is not in the allowed values/],
      ['click', { x: 1, y: 1, delivery_mode: 'background', scope: 'desktop' }, /'scope' is not in the allowed values/],
      ['drag', { pid: 999999, window_id: 1, from_x: 1, from_y: 1, to_x: 2, to_y: 2 }, /missing required argument 'delivery_mode'/],
      ['type_text', { pid: 999999, text: 'x', delivery_mode: 'background' }, /missing required argument 'scope'/],
    ] as const) {
      const refused = await driver.call(tool, args);
      assert.equal(refused.isError, true, `${tool} must be refused by the policy`);
      assert.match(refused.text, /Permission denied/, `${tool}: ${refused.text}`);
      assert.match(refused.text, why, `${tool}: ${refused.text}`);
    }
    summary.policy = 'unlisted tools and input without delivery_mode: background / scope: window are refused by the driver';

    // ── The gateway, with a host that answers the approval card from a script ──
    const lease = new ComputerUseLease();
    const grants = new ComputerUseGrantRegistry();
    const cards: ComputerUsePermissionInput[] = [];
    const frames: ComputerUseLiveFrame[] = [];
    const facts: Record<string, ComputerUseSessionFacts> = {
      main: { planMode: false, fullAccess: false, readOnlyWorkflowRole: null, generation: 1 },
      plan: { planMode: true, fullAccess: false, readOnlyWorkflowRole: null, generation: 1 },
      second: { planMode: false, fullAccess: false, readOnlyWorkflowRole: null, generation: 1 },
      // A session of a provider that reaches the gateway over the MCP bridge.
      'mcp-agent': { planMode: false, fullAccess: false, readOnlyWorkflowRole: null, generation: 1 },
    };
    let answer: ComputerUseApprovalDecision = { allow: true, untilRevoked: false };
    const gateway = new ComputerUseGateway(
      {
        isEnabled: () => true,
        driverStatus: () => status,
        getSession: (sessionId) => facts[sessionId] ?? null,
        requestApproval: async (_sessionId, input) => {
          cards.push(input);
          return answer;
        },
        emitLive: (_sessionId, frame) => frames.push(frame),
        userDataDir: () => userDataDir,
        ownProcessIds: () => [process.pid],
      },
      driver,
      { lease, grants }
    );
    let n = 0;
    const call = (sessionId: string, tool: string, args: Record<string, unknown> = {}): Promise<ComputerUseToolResult> =>
      gateway.call({ sessionId, tool, args, toolUseId: `live-${++n}` });
    const save = (name: string, result: ComputerUseToolResult) => {
      const image = result.images[0];
      if (!image) return;
      writeFileSync(path.join(OUT_DIR, `${name}.${image.mimeType.includes('png') ? 'png' : 'jpg'}`), Buffer.from(image.data, 'base64'));
    };

    const apps = await call('main', 'list_apps');
    assert.equal(apps.isError, false, apps.text);
    assert.match(apps.text, /\[com\.apple\.calculator\]/);

    // Aegis itself is never looked at.
    assert.equal((await call('main', 'get_app_state', { app: 'com.aegis.desktop' })).text, COMPUTER_USE_DENIED_TARGET_MESSAGE);

    // Open: an app that is not running is opened only after the card.
    const wasRunning = calculatorsBefore.length > 0;
    let state = await call('main', 'get_app_state', { app: CALCULATOR });
    opened = calculatorPids().filter((pid) => !calculatorsBefore.includes(pid));
    assert.equal(state.isError, false, state.text);
    if (wasRunning) {
      assert.equal(cards.length, 0, 'looking at a running app asks nothing');
    } else {
      assert.equal(cards.length, 1, 'opening Calculator asked first');
      assert.match(cards[0].question, /^Open /);
      assert.equal(opened.length, 1, 'Calculator was started');
    }
    summary.opened = { wasRunning, card: wasRunning ? null : cards[0].question };
    assert.equal(state.images.length, 1, 'a screenshot came back');
    assert.match(state.text, /AXButton[^\n]*\[id=Equals\b/, 'the accessibility tree came back');
    save('1-opened', state);
    const first = frames.filter((frame) => frame.hasFreshMedia).pop()!;
    assert.ok(resolveComputerUseArtifact(userDataDir, 'main', first.media!.sha256), 'the screenshot is filed for the session');
    summary.snapshot = { elements: (state.text.match(/- \[\d+\]/g) || []).length, screenshotBytes: Buffer.from(state.images[0].data, 'base64').length };

    // Click: 6 × 7 =, by element index. The first click asks; "until revoked" covers the rest.
    const cardsBefore = cards.length;
    answer = { allow: true, untilRevoked: true };
    for (const id of ['AllClear', 'Six', 'Multiply', 'Seven', 'Equals']) {
      state = await call('main', 'click', { app: 'Calculator', element_index: buttonIndex(state.text, id) });
      assert.equal(state.isError, false, `${id}: ${state.text}`);
    }
    assert.equal(cards.length, cardsBefore + 1, 'one card, then the grant');
    assert.equal(cards[cardsBefore].toolName, 'click');
    assert.equal(cards[cardsBefore].question, `Allow Computer use to click in ${cards[cardsBefore].app}?`);
    assert.equal(grants.list('main').length, 1);
    summary.approval = { card: cards[cardsBefore].question, paramLines: cards[cardsBefore].paramLines, grant: grants.list('main')[0] };

    // Read the result.
    save('2-result', state);
    assert.match(state.text, /AXStaticText = "[^"]*42"/, `Calculator should show 42:\n${state.text}`);
    summary.result = /AXStaticText = "([^"]*42)"/.exec(state.text)?.[1];
    console.log('Calculator shows', summary.result);

    // One session at a time: "main" holds the desktop until its turn ends,
    // and until then another session gets nothing, not even a look.
    assert.equal(lease.currentOwner()?.threadId, 'main');
    answer = { allow: true, untilRevoked: false };
    const blockedCards = cards.length;
    for (const [tool, args] of [
      ['get_app_state', { app: CALCULATOR }],
      ['list_apps', {}],
      ['click', { app: CALCULATOR, element_index: '2' }],
    ] as const) {
      assert.equal((await call('second', tool, args)).text, COMPUTER_USE_LEASE_MESSAGE, tool);
    }
    assert.equal(cards.length, blockedCards, 'no card for a desktop that is taken');
    gateway.finishTurn('main');

    // Plan mode looks, and does not act (and looking does not take the desktop).
    const planLook = await call('plan', 'get_app_state', { app: CALCULATOR });
    assert.equal(planLook.isError, false, planLook.text);
    assert.equal((await call('plan', 'click', { app: CALCULATOR, element_index: buttonIndex(planLook.text, 'AllClear') })).text, COMPUTER_USE_PLAN_MESSAGE);
    assert.equal(lease.currentOwner(), null);

    const afterLook = await call('second', 'get_app_state', { app: CALCULATOR });
    const cleared = await call('second', 'click', { app: CALCULATOR, element_index: buttonIndex(afterLook.text, 'AllClear') });
    assert.equal(cleared.isError, false, cleared.text);
    assert.equal(cards.length, blockedCards + 1, "the second session asks for itself: main's grant is not its own");
    assert.match(cleared.text, /AXStaticText = "0"/, 'Calculator is back at 0');
    save('3-cleared', cleared);
    summary.lease = 'second session refused everything while main held the desktop, allowed after main finished';

    // A session's next turn works like its first (the driver session of the last turn has ended).
    gateway.finishTurn('second');
    const nextTurn = await call('second', 'get_app_state', { app: CALCULATOR });
    assert.equal(nextTurn.isError, false, nextTurn.text);
    assert.match(nextTurn.text, /AXStaticText = "0"/);
    summary.nextTurn = 'the same session read Calculator again in a new turn';

    // ── An agent of another provider, over the MCP bridge ─────────────────
    // What DeepSeek, the ACP agents, Claude, Qoder and OpenCode get: the
    // same gateway and the same driver, reached with an entry bound to one
    // session. The real tree and screenshot come back over MCP, an action
    // asks with the same card, and the lease is the one "second" stands before.
    gateway.finishTurn('second');
    const bridge = new ComputerUseMcpBridge({ gateway: () => gateway, userDataDir: () => userDataDir });
    const entry = await bridge.bindSession('mcp-agent', { images: 'inline' });
    const client = new Client({ name: 'live-check', version: '0.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }));
      type Answer = { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };
      const viaMcp = (name: string, args: Record<string, unknown> = {}) =>
        client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }) as Promise<Answer>;
      const text = (answer: Answer) => answer.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      assert.equal((await client.listTools()).tools.length, 13);
      const mcpLook = await viaMcp('get_app_state', { app: CALCULATOR });
      assert.equal(mcpLook.isError ?? false, false, text(mcpLook));
      assert.match(text(mcpLook), /AXStaticText = "0"/, 'the real tree, over MCP');
      const shot = mcpLook.content.find((block) => block.type === 'image');
      assert.ok(shot?.data && Buffer.from(shot.data, 'base64').length > 1000, 'the real screenshot, as an image block');
      const savedTo = /Screenshot also saved to (\S+\.(?:jpg|png))\./.exec(text(mcpLook))?.[1];
      assert.ok(savedTo && savedTo.includes(path.join('computer-use-artifacts', 'mcp-agent')), 'and as a file of that session');
      const mcpCards = cards.length;
      const seven = await viaMcp('click', { app: CALCULATOR, element_index: buttonIndex(text(mcpLook), 'Seven') });
      assert.equal(seven.isError ?? false, false, text(seven));
      assert.equal(cards.length, mcpCards + 1, 'the same card asks, for the session the entry names');
      assert.equal(cards[cards.length - 1].toolName, 'click');
      assert.match(text(seven), /AXStaticText = "7"/, 'Calculator shows 7');
      assert.equal(lease.currentOwner()?.threadId, 'mcp-agent', 'the lease is the bridge session\'s');
      // The session on the other transport gets nothing meanwhile, and the other way round.
      assert.equal((await call('second', 'get_app_state', { app: CALCULATOR })).text, COMPUTER_USE_LEASE_MESSAGE);
      gateway.finishTurn('mcp-agent');
      const direct = await call('second', 'get_app_state', { app: CALCULATOR });
      // With a digit entered the button is "Clear"; with nothing, "All Clear".
      const clearId = /\[id=Clear\b/.test(direct.text) ? 'Clear' : 'AllClear';
      const clearedAgain = await call('second', 'click', { app: CALCULATOR, element_index: buttonIndex(direct.text, clearId) });
      assert.equal(clearedAgain.isError, false, clearedAgain.text);
      assert.match(clearedAgain.text, /AXStaticText = "0"/, 'Calculator is back at 0');
      assert.equal(lease.currentOwner()?.threadId, 'second');
      const shutOut = await viaMcp('list_apps');
      assert.equal(shutOut.isError, true);
      assert.equal(text(shutOut), COMPUTER_USE_LEASE_MESSAGE);
      // The runtime goes away: its entry speaks for nobody.
      entry.dispose();
      await assert.rejects(viaMcp('list_apps'));
      summary.mcpBridge = 'an entry-bound MCP client read Calculator, pressed 7 behind the card, and shared the lease with a direct session both ways';
    } finally {
      await client.close().catch(() => undefined);
      bridge.dispose();
    }

    // ── Cancelling a call in flight stops the driver process ──────────────
    // A drag that takes six seconds, across Calculator's display where a drag
    // does nothing, cancelled after a moment. Only on a Calculator this
    // script opened.
    gateway.finishTurn('second');
    if (opened.length > 0) {
      const listed = await driver.call('list_windows', { pid: opened[0], session: 'cancel' });
      const target = ((listed.structured?.windows as Array<Record<string, unknown>>) || []).find((item) => item.layer === 0);
      assert.ok(target, 'Calculator has a window');
      const windowId = target.window_id as number;
      await driver.call('get_window_state', { pid: opened[0], window_id: windowId, screenshot_format: 'jpeg', session: 'cancel' });
      const before = driverPids(homeDir);
      const stop = new AbortController();
      const startedAt = Date.now();
      const dragging = driver.call(
        'drag',
        { pid: opened[0], window_id: windowId, from_x: 120, from_y: 150, to_x: 300, to_y: 150, duration_ms: 6000, steps: 60, delivery_mode: 'background', scope: 'window', session: 'cancel' },
        { signal: stop.signal }
      );
      await new Promise((resolve) => setTimeout(resolve, 700));
      stop.abort();
      await assert.rejects(dragging, new RegExp(COMPUTER_USE_CANCELLED_MESSAGE));
      const cancelledAfter = Date.now() - startedAt;
      assert.ok(cancelledAfter < 4000, `cancelled well before the drag would have ended (${cancelledAfter} ms)`);
      assert.deepEqual(driverPids(homeDir).filter((pid) => before.includes(pid)), [], 'the driver processes are gone when "cancelled" is heard');
      assert.equal(driver.isRunning(), false);
      // The next call starts a new driver, and the app is read through it.
      const again = await call('second', 'get_app_state', { app: CALCULATOR });
      assert.equal(again.isError, false, again.text);
      assert.match(again.text, /AXButton[^\n]*\[id=Equals\b/);
      const after = driverPids(homeDir);
      assert.equal(after.length, 2);
      assert.ok(after.every((pid) => !before.includes(pid)), 'another driver process');
      summary.cancel = { cancelledAfterMs: cancelledAfter, restarted: true, displayAfter: /AXStaticText = "([^"]*)"/.exec(again.text)?.[1] };
      gateway.finishTurn('second');
    } else {
      summary.cancel = 'skipped: Calculator was already running, and this script only drags in one it opened itself';
    }

    // ── A driver whose parent is killed outright exits by itself ──────────
    const orphanHome = path.join(userDataDir, 'orphan');
    const child = (helper = spawn(process.execPath, [...process.execArgv, __filename], {
      env: { ...process.env, AEGIS_CU_LIVE_ORPHAN_HOME: orphanHome },
      stdio: ['ignore', 'pipe', 'inherit'],
    }));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('driver-up')) resolve(); });
      child.once('exit', (code) => reject(new Error(`the child exited early (${code})`)));
      setTimeout(() => reject(new Error('the child never started its driver')), 30_000).unref();
    });
    const orphans = driverPids(orphanHome);
    assert.equal(orphans.length, 2, 'the child has a daemon and a proxy of its own');
    child.removeAllListeners('exit');
    const killedAt = Date.now();
    child.kill('SIGKILL');
    const gone = await until(() => driverPids(orphanHome).length === 0, 8000);
    assert.equal(gone, true, `the driver outlived its parent: ${driverProcesses(orphanHome).join(' | ')}`);
    summary.parentDeath = { driverProcesses: orphans.length, goneAfterMs: Date.now() - killedAt };

    gateway.finishTurn('plan');
    await gateway.shutdown('verify-done');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(driver.isRunning(), false);
    assert.deepEqual(driverProcesses(homeDir), [], 'no driver process is left');
    summary.cards = cards.map((card) => card.question);
    summary.frames = frames.length;
    summary.outDir = OUT_DIR;
    writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    console.log('computer use live verification passed');
  } finally {
    await driver.stop().catch(() => undefined);
    // The helper, if a failure above left it running.
    if (helper && helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL');
    // A driver left by a child that was killed (it should have gone by itself).
    for (const pid of driverPids(path.join(userDataDir, 'orphan'))) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    // Calculator goes away only if this script started it.
    for (const pid of opened) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
