// The Computer use gateway against a scripted driver: what it refuses, what
// it asks, what it sends to cua-driver, what it leaves for the HUD, and what
// ends a call that is waiting. No driver binary and no desktop are involved
// (scripts/verify-computer-use-live.ts runs the real one); the process host
// is run against a stand-in executable written by this test.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computerUseGatewayTool,
  computerUseToolName,
  COMPUTER_USE_GATEWAY_TOOLS,
  type ComputerUseLiveFrame,
} from '../../src/shared/computer-use';
import type { ComputerUsePermissionInput } from '../../src/shared/types';
import {
  COMPUTER_USE_DENIED_TARGET_MESSAGE,
  COMPUTER_USE_LEASE_MESSAGE,
  ComputerUseLease,
  resolveComputerUseArtifact,
} from '../../src/electron/libs/codex-computer-use';
import { ComputerUseGrantRegistry, type ComputerUseGrantTarget } from '../../src/electron/libs/codex-computer-use-grants';
import { CUA_DRIVER_VERSION, readCuaDriverVersion, resolveCuaDriver } from '../../src/electron/libs/computer-use/driver-binary';
import {
  buildCuaDriverEnv,
  COMPUTER_USE_CANCELLED_MESSAGE,
  COMPUTER_USE_DRIVER_RESTARTED_MESSAGE,
  cuaDriverDaemonArgs,
  CuaDriverHost,
  cuaDriverSocketPath,
  type ComputerUseDriver,
  type DriverCallOptions,
  type DriverToolResult,
} from '../../src/electron/libs/computer-use/driver-host';
import { buildCuaDriverPolicy, DRIVER_INPUT_TOOLS } from '../../src/electron/libs/computer-use/policy';
import {
  COMPUTER_USE_OFF_MESSAGE,
  COMPUTER_USE_PLAN_MESSAGE,
  COMPUTER_USE_TURN_OVER_MESSAGE,
  ComputerUseGateway,
  computerUsePermissionsMessage,
  type ComputerUseApprovalDecision,
  type ComputerUseSessionFacts,
} from '../../src/electron/libs/computer-use/service';
import {
  COMPUTER_USE_TOOL_DEFINITIONS,
  normalizeSecondaryAction,
  parseXdotoolKey,
} from '../../src/electron/libs/computer-use/tools';
import {
  bubbleComputerUseToolNames,
  createBubbleComputerUseTools,
  isBubbleComputerUseApproval,
} from '../../src/electron/libs/bubble-computer-use-tool';
import { isComputerUseAvailableNow } from '../../src/electron/libs/computer-use';
import {
  getComputerUseSettings,
  isComputerUseEnabled,
  isComputerUseForcedOn,
  setComputerUseDriverPath,
  setComputerUseEnabled,
} from '../../src/electron/libs/computer-use/settings';

const TREE = [
  '- [0] AXWindow "Calculator" [id=main actions=[raise]]',
  '    - AXStaticText = "0" (Edit field)',
  '    - [6] AXButton (8) [id=Eight actions=[press]]',
  '    - [20] AXButton (Equals) [id=Equals actions=[press]]',
].join('\n');

const AEGIS_PID = 4242;

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Long enough for everything queued on promises to have run. */
const settle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

class ScriptedDriver implements ComputerUseDriver {
  calls: Array<{ tool: string; args: Record<string, unknown>; instance?: number }> = [];
  /** Like the real driver: a session it ended cannot be named again. */
  ended = new Set<string>();
  started = false;
  stopped = 0;
  /** Times a call in flight was cancelled: the real host stops the driver process for that. */
  killed = 0;
  instance = 0;
  accessibility = true;
  /** How many window listings of a freshly opened app (pid 600) come back empty first. */
  lateWindow = 0;
  /** How many reads of a window come back as of an app still starting: another size, no tree. */
  unsettledReads = 0;
  /** Held open: a cold start that takes a while. */
  startGate: Gate | null = null;
  /** Held open: the next call of this tool stays in flight until released. */
  hold: { tool: string; gate: Gate; entered: Gate } | null = null;
  /** Held open: a driver process that was told to go takes this long to be gone. */
  exitGate: Gate | null = null;
  /** The window each next listing shows, by id (null: none); after these, window 71. */
  windowIds: Array<number | null> = [];
  /** How many next reads of a window fail outright. */
  failedReads = 0;
  /** What happened to the driver, in order: `start:1`, `list_apps@1`, `stop`. */
  log: string[] = [];
  private snapshots = 0;

  async start(signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) throw new Error(COMPUTER_USE_CANCELLED_MESSAGE);
    if (!this.started) {
      const held = this.startGate;
      if (held) await held.promise;
      if (!this.started) {
        this.started = true;
        this.instance += 1;
        this.log.push(`start:${this.instance}`);
      }
    }
    if (signal?.aborted) throw new Error(COMPUTER_USE_CANCELLED_MESSAGE);
    return this.instance;
  }

  /** The driver process died and a new one will start on the next call. */
  crash(): void {
    this.started = false;
  }

  async call(tool: string, args: Record<string, unknown>, options: DriverCallOptions = {}): Promise<DriverToolResult> {
    if (options.signal?.aborted) throw new Error(COMPUTER_USE_CANCELLED_MESSAGE);
    if (options.instance !== undefined && (!this.started || options.instance !== this.instance)) {
      throw new Error(COMPUTER_USE_DRIVER_RESTARTED_MESSAGE);
    }
    if (options.instance === undefined) await this.start(options.signal);
    this.calls.push({ tool, args, instance: options.instance });
    this.log.push(`${tool}@${this.instance}`);
    const held = this.hold?.tool === tool ? this.hold : null;
    if (held) {
      this.hold = null;
      held.entered.open();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          // What CuaDriverHost does: the driver process is stopped, and the
          // caller hears "cancelled" once it is gone, not before.
          this.killed += 1;
          this.started = false;
          void (this.exitGate?.promise ?? Promise.resolve()).then(() => reject(new Error(COMPUTER_USE_CANCELLED_MESSAGE)));
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        void held.gate.promise.then(() => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    }
    const ok = (text: string, structured: Record<string, unknown> | null = null, images: DriverToolResult['images'] = []) => ({
      isError: false,
      text,
      structured,
      images,
    });
    const session = String(args.session);
    if (tool === 'end_session') {
      this.ended.add(session);
      return ok('ended');
    }
    if (this.ended.has(session)) {
      return { isError: true, text: `session '${session}' has ended`, structured: null, images: [] };
    }
    switch (tool) {
      case 'check_permissions':
        assert.deepEqual(args.prompt, false, 'the gateway never asks macOS for anything');
        return ok('permissions', { accessibility: this.accessibility, screen_recording: true });
      case 'list_apps':
        return ok('apps', {
          apps: [
            { name: 'Aegis', bundle_id: 'com.aegis.desktop', pid: AEGIS_PID, running: true, launch_path: '/Applications/Aegis.app' },
            { name: 'Calculator', bundle_id: 'com.apple.calculator', pid: 500, running: true, launch_path: '/System/Applications/Calculator.app' },
            { name: '文本编辑', bundle_id: 'com.apple.TextEdit', pid: 0, running: false, launch_path: '/System/Applications/TextEdit.app' },
            { name: 'Sneaky', bundle_id: 'com.example.sneaky', pid: AEGIS_PID + 1, running: true, launch_path: '/Applications/Sneaky.app' },
            // Two apps of one name, and one the driver knows no bundle identifier for.
            { name: 'Notes', bundle_id: 'com.apple.Notes', pid: 700, running: true, launch_path: '/System/Applications/Notes.app' },
            { name: 'Notes', bundle_id: 'com.example.notes', pid: 701, running: true, launch_path: '/Applications/Other/Notes.app' },
            { name: 'Loose', pid: 702, running: true, launch_path: '/Applications/Loose.app' },
          ],
        });
      case 'list_windows':
        if (args.pid === 600 && this.lateWindow > 0) {
          this.lateWindow -= 1;
          return ok('windows', { windows: [] });
        }
        {
          const windowId = this.windowIds.length > 0 ? this.windowIds.shift()! : 71;
          return ok('windows', {
            windows: [
              { window_id: 9, pid: args.pid, title: 'menu', layer: 25, is_on_screen: true, z_index: 9, bounds: { width: 10, height: 10 } },
              ...(windowId === null
                ? []
                : [{ window_id: windowId, pid: args.pid, title: 'Calculator', layer: 0, is_on_screen: true, z_index: 3, bounds: { width: 230, height: 408 } }]),
            ],
          });
        }
      case 'launch_app':
        return ok('launched', { pid: 600 });
      case 'get_window_state': {
        if (this.failedReads > 0) {
          this.failedReads -= 1;
          return { isError: true, text: 'window_id_not_found', structured: null, images: [] };
        }
        this.snapshots += 1;
        const id = `s${String(this.snapshots).padStart(8, '0')}`;
        if (this.unsettledReads > 0) {
          this.unsettledReads -= 1;
          return ok(`window_id=71 pid=500 snapshot_id=${id}`, {
            snapshot_id: id,
            tree_markdown: '',
            degraded_reason: 'ax_app_launching',
            screenshot_width: 936,
            screenshot_height: 202,
          }, [{ mimeType: 'image/jpeg', data: Buffer.from(`placeholder-${this.snapshots}`).toString('base64') }]);
        }
        return ok(`window_id=71 pid=500 snapshot_id=${id}\n${TREE}`, {
          snapshot_id: id,
          tree_markdown: TREE,
          screenshot_width: 460,
          screenshot_height: 816,
        }, [{ mimeType: 'image/jpeg', data: Buffer.from(`shot-${this.snapshots}`).toString('base64') }]);
      }
      default:
        return ok(`${tool} delivered`);
    }
  }

  isRunning(): boolean {
    return this.started;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    this.started = false;
    this.log.push('stop');
  }

  stopSync(): void {
    this.stopped += 1;
    this.started = false;
  }

  of(tool: string) {
    return this.calls.filter((call) => call.tool === tool);
  }

  /** Holds the next call of a tool in flight; `entered` opens when it got there. */
  holdNext(tool: string) {
    this.hold = { tool, gate: gate(), entered: gate() };
    return this.hold;
  }
}

type Card = {
  input: ComputerUsePermissionInput;
  signal: AbortSignal;
  answer: (decision: ComputerUseApprovalDecision) => void;
};

function harness(overrides: {
  enabled?: boolean;
  facts?: Record<string, Partial<ComputerUseSessionFacts> | null>;
  /** Answers a card at once; left out, cards wait in `open` to be answered by the test. */
  answer?: (input: ComputerUsePermissionInput) => ComputerUseApprovalDecision;
  /** A host that does not take its card down when the call ends (the gateway must not depend on it). */
  cardsIgnoreAbort?: boolean;
} = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'aegis-cu-test-'));
  const driver = new ScriptedDriver();
  const lease = new ComputerUseLease();
  const grants = new ComputerUseGrantRegistry();
  const cards: ComputerUsePermissionInput[] = [];
  const open: Card[] = [];
  const frames: ComputerUseLiveFrame[] = [];
  const refused: string[] = [];
  const facts: Record<string, Partial<ComputerUseSessionFacts> | null> = { ...(overrides.facts || {}) };
  let enabled = overrides.enabled ?? true;
  let answer = overrides.answer;
  const gateway = new ComputerUseGateway(
    {
      isEnabled: () => enabled,
      driverStatus: () => ({ state: 'ready', path: '/x/cua-driver', version: CUA_DRIVER_VERSION, pinnedVersion: CUA_DRIVER_VERSION, message: null }),
      getSession: (sessionId) => {
        const own = facts[sessionId];
        if (own === null) return null;
        return { planMode: false, fullAccess: false, readOnlyWorkflowRole: null, generation: 1, ...(own || {}) };
      },
      requestApproval: (_sessionId, input, signal) => {
        cards.push(input);
        if (answer) return Promise.resolve(answer(input));
        return new Promise<ComputerUseApprovalDecision>((resolve, reject) => {
          open.push({ input, signal, answer: resolve });
          if (!overrides.cardsIgnoreAbort) {
            signal.addEventListener('abort', () => reject(new Error('Computer use approval was cancelled.')), { once: true });
          }
        });
      },
      emitLive: (_sessionId, frame) => frames.push(frame),
      userDataDir: () => userDataDir,
      ownProcessIds: () => [AEGIS_PID, AEGIS_PID + 1],
      onRefused: (sessionId, tool) => refused.push(`${sessionId}:${tool}`),
    },
    driver,
    { lease, grants },
    // A window that is not readable yet is looked at again almost at once.
    2
  );
  let n = 0;
  const call = (sessionId: string, tool: string, args: Record<string, unknown> = {}, signal?: AbortSignal) =>
    gateway.call({ sessionId, tool, args, toolUseId: `call-${++n}`, signal });
  return {
    gateway, driver, lease, grants, cards, open, frames, refused, userDataDir, call, facts,
    lastToolUseId: () => `call-${n}`,
    setEnabled: (value: boolean) => { enabled = value; },
    setAnswer: (next: typeof answer) => { answer = next; },
    /** Until a card is waiting to be answered. */
    card: async () => {
      for (let i = 0; i < 200 && open.length === 0; i += 1) await tick();
      assert.ok(open.length > 0, 'a card is open');
      return open.shift()!;
    },
    dispose: () => rmSync(userDataDir, { recursive: true, force: true }),
  };
}

const ALLOW: ComputerUseApprovalDecision = { allow: true, untilRevoked: false };
const ALLOW_UNTIL_REVOKED: ComputerUseApprovalDecision = { allow: true, untilRevoked: true };
const DECLINE: ComputerUseApprovalDecision = { allow: false, untilRevoked: false };

function testSettings() {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-cu-settings-'));
  const saved = { path: process.env.AEGIS_COMPUTER_USE_SETTINGS_PATH, on: process.env.AEGIS_COMPUTER_USE_ENABLED };
  process.env.AEGIS_COMPUTER_USE_SETTINGS_PATH = join(dir, 'computer-use.json');
  delete process.env.AEGIS_COMPUTER_USE_ENABLED;
  try {
    assert.deepEqual(getComputerUseSettings(), { enabled: false, driverPath: '' }, 'off until the user turns it on');
    assert.equal(isComputerUseEnabled(), false);
    assert.equal(isComputerUseAvailableNow(), false, 'off: no agent is offered the tools');
    setComputerUseEnabled(true);
    setComputerUseDriverPath('  /opt/cua-driver ');
    assert.deepEqual(getComputerUseSettings(), { enabled: true, driverPath: '/opt/cua-driver' });
    assert.equal(isComputerUseEnabled(), process.platform === 'darwin', 'macOS only for now');
    // On, but this process never set a gateway up: still nothing to offer.
    assert.equal(isComputerUseAvailableNow(), false);
    setComputerUseEnabled(false);
    assert.equal(isComputerUseEnabled(), false);
    writeFileSync(process.env.AEGIS_COMPUTER_USE_SETTINGS_PATH, '{ not json');
    assert.equal(isComputerUseEnabled(), false, 'an unreadable file means off');
    // A development run can turn it on from outside; that is told apart from
    // the stored switch, so the settings page can say what is in effect.
    assert.equal(isComputerUseForcedOn(), false);
    process.env.AEGIS_COMPUTER_USE_ENABLED = '1';
    assert.equal(isComputerUseForcedOn(), process.platform === 'darwin');
    assert.equal(isComputerUseEnabled(), process.platform === 'darwin');
    assert.equal(getComputerUseSettings().enabled, false, 'the stored switch is not what is in effect');
  } finally {
    if (saved.path === undefined) delete process.env.AEGIS_COMPUTER_USE_SETTINGS_PATH;
    else process.env.AEGIS_COMPUTER_USE_SETTINGS_PATH = saved.path;
    if (saved.on === undefined) delete process.env.AEGIS_COMPUTER_USE_ENABLED;
    else process.env.AEGIS_COMPUTER_USE_ENABLED = saved.on;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testSwitchAndSession() {
  const h = harness({ enabled: false, facts: { gone: null, reviewer: { readOnlyWorkflowRole: 'reviewer' } } });
  const off = await h.call('s1', 'list_apps');
  assert.equal(off.isError, true);
  assert.equal(off.text, COMPUTER_USE_OFF_MESSAGE);
  assert.equal(h.driver.calls.length, 0, 'off: the driver is never reached');
  assert.equal(h.driver.started, false);

  h.setEnabled(true);
  const gone = await h.call('gone', 'list_apps');
  assert.equal(gone.isError, true);
  assert.match(gone.text, /no longer open/);

  const member = await h.call('reviewer', 'get_app_state', { app: 'Calculator' });
  assert.equal(member.isError, true);
  assert.match(member.text, /workflow reviewer is read-only/);
  assert.deepEqual(h.refused, ['reviewer:get_app_state']);
  assert.equal(h.driver.calls.length, 0, 'a read-only member does not even observe');
  assert.equal(h.driver.started, false, 'and does not start the driver');

  for (const tool of ['kill_app', 'select_text']) {
    const unknown = await h.call('s1', tool, { app: 'Calculator' });
    assert.match(unknown.text, /Unknown Computer use tool/, tool);
  }
  h.dispose();
}

async function testObserveAndDeniedTargets() {
  const h = harness();
  const apps = await h.call('s1', 'list_apps');
  assert.equal(apps.isError, false);
  assert.match(apps.text, /- Calculator \[com\.apple\.calculator\]/);
  assert.doesNotMatch(apps.text, /Aegis/, 'Aegis itself is not listed');
  assert.doesNotMatch(apps.text, /Sneaky/, 'nor is anything running as one of its processes');
  assert.match(apps.text, /Installed, not running \(1\)/);

  for (const app of ['Aegis', 'com.aegis.desktop', 'Electron', 'com.github.Electron']) {
    const denied = await h.call('s1', 'get_app_state', { app });
    assert.equal(denied.text, COMPUTER_USE_DENIED_TARGET_MESSAGE, app);
  }
  // By process id: a name that is not on the list but is one of Aegis's own processes.
  const byPid = await h.call('s1', 'get_app_state', { app: 'Sneaky' });
  assert.equal(byPid.text, COMPUTER_USE_DENIED_TARGET_MESSAGE);
  assert.equal(h.driver.of('get_window_state').length, 0, 'Aegis is never read');

  const state = await h.call('s1', 'get_app_state', { app: 'calculator' });
  assert.equal(state.isError, false);
  assert.equal(h.cards.length, 0, 'looking at a running app asks nothing');
  assert.match(state.text, /^App: Calculator \[com\.apple\.calculator\]/);
  assert.match(state.text, /screenshot 460×816 px/);
  assert.match(state.text, /\[20\] AXButton \(Equals\)/);
  assert.doesNotMatch(state.text, /snapshot_id|element_token/, "the driver's own handles stay inside the gateway");
  assert.equal(state.images.length, 1);
  assert.deepEqual(h.driver.of('get_window_state')[0].args, {
    pid: 500, window_id: 71, screenshot_format: 'jpeg', session: 'aegis-s1-1',
  }, 'the layer-0 window, read as this session');
  assert.equal(h.lease.currentOwner(), null, 'looking does not take the desktop');

  // The screenshot is on disk for the session, announced to the HUD, and handed to the adapter once.
  const fresh = h.frames.filter((frame) => frame.hasFreshMedia);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].label, 'Looked at Calculator');
  assert.equal(fresh[0].threadId, 's1');
  assert.ok(resolveComputerUseArtifact(h.userDataDir, 's1', fresh[0].media!.sha256));
  assert.equal(h.frames[h.frames.length - 2].label, 'Looking at Calculator');
  const refs = h.gateway.takeMediaRefs('s1', h.lastToolUseId());
  assert.equal(refs.length, 1);
  assert.equal(refs[0].sha256, fresh[0].media!.sha256);
  assert.deepEqual(h.gateway.takeMediaRefs('s1', h.lastToolUseId()), []);

  const missing = await h.call('s1', 'get_app_state', { app: 'Nope' });
  assert.match(missing.text, /No app named "Nope"/);
  h.dispose();
}

async function testMissingMacPermission() {
  const h = harness();
  h.driver.accessibility = false;
  const refused = await h.call('s1', 'get_app_state', { app: 'Calculator' });
  assert.equal(refused.isError, true);
  assert.equal(refused.text, computerUsePermissionsMessage(['Accessibility']));
  assert.match(refused.text, /System Settings → Privacy & Security/);
  assert.deepEqual(h.driver.calls.map((call) => call.tool), ['check_permissions'], 'nothing is tried without the grant');
  await settle();
  assert.equal(h.driver.stopped, 1, 'the driver is restarted to see a new grant');
  // Granted since: the next call goes through, and the check is made once per driver process.
  h.driver.accessibility = true;
  assert.equal((await h.call('s1', 'get_app_state', { app: 'Calculator' })).isError, false);
  await h.call('s1', 'list_apps');
  assert.equal(h.driver.of('check_permissions').length, 2);
  // A driver that came back after a crash is asked again.
  h.driver.crash();
  await h.call('s1', 'list_apps');
  assert.equal(h.driver.of('check_permissions').length, 3);
  h.dispose();
}

async function testPlanMode() {
  const h = harness({ facts: { plan: { planMode: true } } });
  const look = await h.call('plan', 'get_app_state', { app: 'Calculator' });
  assert.equal(look.isError, false, 'Plan mode may look');
  const click = await h.call('plan', 'click', { app: 'Calculator', element_index: '20' });
  assert.equal(click.text, COMPUTER_USE_PLAN_MESSAGE);
  // An app that is not running would have to be opened: an action.
  const open = await h.call('plan', 'get_app_state', { app: 'TextEdit' });
  assert.equal(open.isError, true);
  assert.match(open.text, /Plan mode is read-only/);
  assert.equal(h.cards.length, 0);
  assert.equal(h.driver.of('click').length + h.driver.of('launch_app').length, 0);
  assert.equal(h.lease.currentOwner(), null, 'Plan mode never takes the desktop');
  h.dispose();
}

async function testApprovalAndGrants() {
  let answer = DECLINE;
  const h = harness({ answer: () => answer });

  const early = await h.call('s1', 'click', { app: 'Calculator', element_index: '20' });
  assert.match(early.text, /Call get_app_state for "Calculator" first/);
  assert.equal(h.cards.length, 0);

  await h.call('s1', 'get_app_state', { app: 'Calculator' });
  const declined = await h.call('s1', 'click', { app: 'Calculator', element_index: '20' });
  assert.equal(declined.isError, true);
  assert.match(declined.text, /The user declined/);
  assert.equal(h.driver.of('click').length, 0, 'declined: nothing is sent');
  assert.equal(h.lease.currentOwner(), null, 'declined: the desktop is not held');
  assert.equal(h.cards.length, 1);
  const card = h.cards[0];
  assert.equal(card.kind, 'computer-use');
  assert.equal(card.server, 'aegis-computer-use');
  assert.equal(card.toolName, 'click');
  assert.equal(card.app, 'Calculator');
  assert.equal(card.mutating, true);
  assert.equal(card.canAllowUntilRevoked, true);
  assert.equal(card.canAllowForSession, false);
  assert.equal(card.question, 'Allow Computer use to click in Calculator?');
  assert.deepEqual(card.paramLines, [{ label: 'element', value: '[20] AXButton (Equals)' }]);

  answer = ALLOW;
  const once = await h.call('s1', 'click', { app: 'Calculator', element_index: '20' });
  assert.equal(once.isError, false);
  assert.deepEqual(h.driver.of('click')[0].args, {
    element_token: 's00000001:20', button: 'left', delivery_mode: 'background', scope: 'window', session: 'aegis-s1-1',
  });
  assert.match(once.text, /^click delivered\n\nApp: Calculator/, 'an action returns the new state');
  assert.equal(once.images.length, 1);
  assert.equal(h.lease.currentOwner()?.threadId, 's1');
  assert.equal(h.cards.length, 2);

  // The next click uses the snapshot the last action returned.
  answer = ALLOW_UNTIL_REVOKED;
  await h.call('s1', 'click', { app: 'Calculator', element_index: 6 });
  assert.equal(h.driver.of('click')[1].args.element_token, 's00000002:6');
  assert.equal(h.cards.length, 3);
  assert.deepEqual(h.grants.list('s1').map((grant) => [grant.tool, grant.app, grant.appId, grant.owner, grant.generation]), [
    ['click', 'Calculator', 'com.apple.calculator', 'gateway', 1],
  ], 'the grant shows the name and is matched on the bundle identifier');

  // Granted: clicks in Calculator no longer ask; another tool still does.
  answer = DECLINE;
  const granted = await h.call('s1', 'click', { app: 'com.apple.calculator', x: 10, y: 20, click_count: 2 });
  assert.equal(granted.isError, false);
  assert.equal(h.cards.length, 3);
  assert.deepEqual(h.driver.of('click')[2].args, {
    pid: 500, window_id: 71, x: 10, y: 20, button: 'left', count: 2,
    delivery_mode: 'background', scope: 'window', session: 'aegis-s1-1',
  });
  const typed = await h.call('s1', 'type_text', { app: 'Calculator', text: '42' });
  assert.equal(typed.isError, true);
  assert.equal(h.cards.length, 4);
  assert.equal(h.cards[3].toolName, 'type_text');
  assert.deepEqual(h.cards[3].paramLines, [{ label: 'text', value: '42' }]);

  // A grant is the session's own, and stopping the session ends it.
  h.gateway.finishTurn('s1');
  await h.call('s2', 'get_app_state', { app: 'Calculator' });
  await h.call('s2', 'click', { app: 'Calculator', element_index: '20' });
  assert.equal(h.cards.length, 5, "another session's grant does not carry over");
  assert.equal(h.grants.list('s1').length, 1, 'a turn ending keeps "until revoked"');
  h.gateway.forgetSession('s1', 'stop');
  assert.deepEqual(h.grants.list('s1'), []);
  h.dispose();
}

async function testOpeningAnApp() {
  let answer = DECLINE;
  const h = harness({ answer: () => answer });
  const declined = await h.call('s1', 'get_app_state', { app: 'TextEdit' });
  assert.equal(declined.isError, true);
  assert.equal(h.cards[0].question, 'Open 文本编辑?');
  assert.equal(h.cards[0].toolName, 'get_app_state');
  assert.equal(h.driver.of('launch_app').length, 0);
  assert.equal(h.lease.currentOwner(), null);

  answer = ALLOW;
  // A cold start puts its window up a moment after the process: the gateway waits for it.
  h.driver.lateWindow = 2;
  const opened = await h.call('s1', 'get_app_state', { app: 'com.apple.TextEdit' });
  assert.equal(opened.isError, false, opened.text);
  assert.equal(h.driver.lateWindow, 0);
  assert.deepEqual(h.driver.of('launch_app')[0].args, { bundle_id: 'com.apple.TextEdit', session: 'aegis-s1-1' });
  assert.equal(h.driver.of('get_window_state')[0].args.pid, 600, 'the window of the process that was started');
  assert.equal(h.lease.currentOwner()?.threadId, 's1', 'opening an app is acting: the desktop is this session’s');
  // Named again by its bundle identifier or by the localized name it was listed under.
  for (const app of ['com.apple.TextEdit', '文本编辑']) {
    assert.equal((await h.call('s1', 'press_key', { app, key: 'Return' })).isError, false, app);
  }
  assert.match((await h.call('s1', 'press_key', { app: 'TextEdit', key: 'Return' })).text, /Call get_app_state for "TextEdit" first/);
  h.dispose();

  // A window can be listed before the app has put it up: for a moment it has
  // another size and no accessibility tree (seen on a cold start of the real
  // Calculator). The gateway reads until it reads as a window, and only that
  // read is what the agent, the HUD and the session's files get.
  const cold = harness({ answer: () => ALLOW });
  cold.driver.unsettledReads = 3;
  const settled = await cold.call('s1', 'get_app_state', { app: 'TextEdit' });
  assert.equal(settled.isError, false, settled.text);
  assert.match(settled.text, /screenshot 460×816 px/);
  assert.match(settled.text, /\[20\] AXButton \(Equals\)/);
  assert.doesNotMatch(settled.text, /may still be loading/);
  assert.equal(cold.driver.of('get_window_state').length, 4);
  assert.equal(cold.driver.of('list_windows').length, 4, 'the window is picked again before each read');
  assert.equal(cold.frames.filter((frame) => frame.hasFreshMedia).length, 1, 'placeholder frames are not shown or saved');
  assert.equal(cold.gateway.takeMediaRefs('s1', cold.lastToolUseId()).length, 1);
  // The indexes that work afterwards are those of the read that was returned.
  await cold.call('s1', 'click', { app: 'com.apple.TextEdit', element_index: '20' });
  assert.equal(cold.driver.of('click')[0].args.element_token, 's00000004:20');
  cold.dispose();

  // An app that was already running and whose window never gives a tree (a
  // canvas): after a short wait the read is returned as it is, and says so.
  const canvas = harness();
  canvas.driver.unsettledReads = 100;
  const bare = await canvas.call('s1', 'get_app_state', { app: 'Calculator' });
  assert.equal(bare.isError, false);
  assert.match(bare.text, /gave no accessibility tree/);
  assert.equal(bare.images.length, 1, 'the screenshot is still there to work from');
  assert.equal(canvas.driver.of('get_window_state').length, 3);
  canvas.dispose();
}

/**
 * One session has the desktop at a time. While a session holds it, another
 * gets nothing from Computer use, looking included; a session that only
 * looks does not take it.
 */
async function testFullAccessAndLease() {
  const h = harness({ facts: { full: { fullAccess: true } } });
  // Two sessions may look while nobody acts.
  assert.equal((await h.call('other', 'get_app_state', { app: 'Calculator' })).isError, false);
  await h.call('full', 'get_app_state', { app: 'Calculator' });
  assert.equal(h.lease.currentOwner(), null);

  const run = await h.call('full', 'click', { app: 'Calculator', element_index: '20' });
  assert.equal(run.isError, false);
  assert.equal(h.cards.length, 0, 'Full Access runs actions without the card');
  assert.equal(h.lease.currentOwner()?.threadId, 'full');

  // The other session now gets nothing: not a click, not a look, not a list.
  const sent = h.driver.calls.length;
  for (const [tool, args] of [
    ['click', { app: 'Calculator', element_index: '20' }],
    ['get_app_state', { app: 'Calculator' }],
    ['list_apps', {}],
  ] as const) {
    assert.equal((await h.call('other', tool, args)).text, COMPUTER_USE_LEASE_MESSAGE, tool);
  }
  assert.equal(h.driver.calls.length, sent, 'nothing of the other session reaches the driver');
  assert.equal(h.cards.length, 0, 'the card is not shown for a desktop that is taken');

  h.gateway.finishTurn('full');
  assert.equal(h.lease.currentOwner(), null);
  // The driver's own session ends behind whatever call is in flight.
  await settle();
  assert.deepEqual(h.driver.of('end_session').map((call) => call.args), [{ session: 'aegis-full-2' }]);
  h.setAnswer(() => ALLOW);
  const free = await h.call('other', 'click', { app: 'Calculator', element_index: '20' });
  assert.equal(free.isError, false);
  assert.equal(h.lease.currentOwner()?.threadId, 'other');

  // After the turn the indexes are gone with it: the next turn looks first.
  h.gateway.finishTurn('other');
  const stale = await h.call('full', 'click', { app: 'Calculator', element_index: '20' });
  assert.match(stale.text, /Call get_app_state/);
  // And it does so under a driver session of its own: the ended one is not reused.
  const nextTurn = await h.call('full', 'get_app_state', { app: 'Calculator' });
  assert.equal(nextTurn.isError, false, nextTurn.text);
  assert.equal(h.driver.of('get_window_state').slice(-1)[0].args.session, 'aegis-full-3');
  assert.equal((await h.call('full', 'click', { app: 'Calculator', element_index: '20' })).isError, false);

  // The lease is shared with Codex's own Computer use: a Codex thread holding it shuts the gateway out too.
  h.gateway.finishTurn('full');
  h.lease.tryAcquire('codex-thread', 'codex-call');
  assert.equal((await h.call('full', 'list_apps')).text, COMPUTER_USE_LEASE_MESSAGE);
  h.dispose();
}

/** A session keeps the desktop through a later action of its own that does not happen. */
async function testLeaseSurvivesADeclinedAction() {
  let answer = ALLOW;
  const h = harness({ answer: () => answer });
  await h.call('a', 'get_app_state', { app: 'Calculator' });
  assert.equal((await h.call('a', 'click', { app: 'Calculator', element_index: '20' })).isError, false);
  assert.equal(h.lease.currentOwner()?.threadId, 'a');

  answer = DECLINE;
  assert.match((await h.call('a', 'click', { app: 'Calculator', element_index: '6' })).text, /The user declined/);
  assert.equal(h.lease.currentOwner()?.threadId, 'a', 'the declined action gives only its own hold back');
  assert.equal((await h.call('b', 'get_app_state', { app: 'Calculator' })).text, COMPUTER_USE_LEASE_MESSAGE);
  // Nor does an action that was refused before it was asked about.
  assert.match((await h.call('a', 'click', { app: 'Calculator' })).text, /element_index, or both x and y/);
  assert.equal(h.lease.currentOwner()?.threadId, 'a');

  answer = ALLOW;
  h.gateway.finishTurn('a');
  assert.equal((await h.call('b', 'get_app_state', { app: 'Calculator' })).isError, false);
  h.dispose();
}

/**
 * The switch going off (or the driver being changed) ends what stood on the
 * gateway: a card that is open, a call waiting in line, the holds on the
 * desktop, the gateway's grants. An answer that comes later allows nothing.
 */
async function testSwitchOffEndsWhatWaits() {
  // 1) The first call a session ever makes, waiting on its card. Nothing has
  //    been looked at yet, and it already holds the desktop.
  const h = harness({ cardsIgnoreAbort: true });
  const opening = h.call('s1', 'get_app_state', { app: 'TextEdit' });
  const card = await h.card();
  assert.equal(card.input.question, 'Open 文本编辑?');
  assert.equal(h.lease.currentOwner()?.threadId, 's1');
  // Codex's own Computer use is not the gateway's to end.
  const codexGrant: ComputerUseGrantTarget = {
    owner: 'codex', threadId: 'codex-thread', providerThreadId: 'p1', generation: 3,
    server: 'aegis-computer-use', tool: 'click', app: 'Finder', riskLevel: 'low',
  };
  assert.ok(h.grants.createGrant(codexGrant));

  h.setEnabled(false);
  await h.gateway.shutdown('disabled');
  assert.equal(card.signal.aborted, true, 'the card is told to come down');
  assert.equal((await opening).text, COMPUTER_USE_CANCELLED_MESSAGE);
  assert.equal(h.lease.currentOwner(), null, 'its hold on the desktop is gone though the session has no state yet');
  assert.ok(h.grants.matchGrant(codexGrant), "Codex's grant is untouched");

  // Back on. The old card is answered now, "until revoked": it allows nothing and writes nothing.
  h.setEnabled(true);
  card.answer(ALLOW_UNTIL_REVOKED);
  await settle();
  assert.equal(h.driver.of('launch_app').length, 0, 'nothing is opened');
  assert.deepEqual(h.grants.list('s1'), [], 'no grant comes back');
  assert.equal(h.lease.currentOwner(), null);
  h.dispose();

  // 1b) A session that holds the desktop for the rest of its turn with
  //     nothing looked at: it opened an app whose window never came up. The
  //     hold is found by who took the lease, not by what a session has seen.
  const blind = harness({ facts: { s1: { fullAccess: true } } });
  blind.driver.lateWindow = 1000;
  const noWindow = await blind.call('s1', 'get_app_state', { app: 'TextEdit' });
  assert.match(noWindow.text, /has no window to look at yet/);
  assert.equal(blind.lease.currentOwner()?.threadId, 's1', 'it acted, so the desktop stays its own');
  await blind.gateway.shutdown('disabled');
  assert.equal(blind.lease.currentOwner(), null);
  // A hold that is not the gateway's (a Codex thread's) is left alone.
  blind.lease.tryAcquire('codex-thread', 'codex-call');
  await blind.gateway.shutdown('disabled');
  assert.equal(blind.lease.currentOwner()?.threadId, 'codex-thread');
  blind.dispose();

  // 2) A call approved by a grant, waiting in line behind a call in flight.
  const q = harness({ answer: () => ALLOW_UNTIL_REVOKED });
  await q.call('s1', 'get_app_state', { app: 'Calculator' });
  await q.call('s1', 'click', { app: 'Calculator', element_index: '20' });
  assert.equal(q.grants.list('s1').length, 1);
  const held = q.driver.holdNext('list_apps');
  const inFlight = q.call('s1', 'list_apps');
  await held.entered.promise;
  const queued = q.call('s1', 'click', { app: 'Calculator', element_index: '6' });
  await settle();
  const clicksBefore = q.driver.of('click').length;

  const off = q.gateway.shutdown('driver-changed');
  await settle();
  assert.equal(q.driver.killed, 1, 'the call in flight is cancelled by stopping the driver');
  await off;
  assert.equal((await inFlight).text, COMPUTER_USE_CANCELLED_MESSAGE);
  assert.equal((await queued).isError, true);
  assert.equal(q.driver.of('click').length, clicksBefore, 'the queued click is never sent');
  assert.deepEqual(q.grants.list('s1'), [], "the gateway's grants are gone");
  assert.equal(q.lease.currentOwner(), null);
  assert.equal(q.driver.started, false, 'and nothing queued started the driver again');

  // 3) After it: the session starts over. What it knew belonged to the old driver.
  assert.match((await q.call('s1', 'click', { app: 'Calculator', element_index: '20' })).text, /Call get_app_state/);
  q.setAnswer(() => DECLINE);
  await q.call('s1', 'get_app_state', { app: 'Calculator' });
  assert.match((await q.call('s1', 'click', { app: 'Calculator', element_index: '20' })).text, /The user declined/,
    'and is asked again: the old grant did not come back');
  q.dispose();

  // 4) Off with nothing going on: the driver stops after what was queued,
  //    and no later call or tidy-up reaches it.
  const idle = harness({ facts: { s1: { fullAccess: true } } });
  await idle.call('s1', 'get_app_state', { app: 'Calculator' });
  await idle.call('s1', 'click', { app: 'Calculator', element_index: '20' });
  idle.gateway.finishTurn('s1');
  await idle.gateway.shutdown('disabled');
  assert.equal(idle.driver.stopped, 1);
  assert.equal(idle.driver.started, false, 'the driver stays stopped');
  idle.setEnabled(false);
  const sent = idle.driver.calls.length;
  idle.gateway.finishTurn('s1');
  assert.equal((await idle.call('s1', 'list_apps')).text, COMPUTER_USE_OFF_MESSAGE);
  await settle();
  assert.equal(idle.driver.calls.length, sent, 'off: not one more call reaches the driver');
  assert.equal(idle.driver.started, false);
  idle.dispose();

  // 5) A call that joined the line before the switch went off, where nobody
  //    called shutdown: it is still not what reaches the driver.
  const late = harness({ facts: { s1: { fullAccess: true } } });
  await late.call('s1', 'get_app_state', { app: 'Calculator' });
  const holding = late.driver.holdNext('list_apps');
  const first = late.call('s1', 'list_apps');
  await holding.entered.promise;
  const waiting = late.call('s1', 'click', { app: 'Calculator', element_index: '20' });
  await settle();
  late.setEnabled(false);
  // The driver went away meanwhile: the waiting call is not what brings it back.
  late.driver.crash();
  holding.gate.open();
  await first;
  assert.equal((await waiting).text, COMPUTER_USE_OFF_MESSAGE);
  assert.equal(late.driver.of('click').length, 0);
  assert.equal(late.driver.started, false, 'a call that no longer stands does not start the driver');
  late.dispose();
}

/** Stopping a session, or its turn ending, ends its calls wherever they are. */
async function testStopEndsWhatIsOnItsWay() {
  // A card left open when the session is stopped.
  const h = harness({ cardsIgnoreAbort: true });
  await h.call('s1', 'get_app_state', { app: 'Calculator' });
  const clicking = h.call('s1', 'click', { app: 'Calculator', element_index: '20' });
  const card = await h.card();
  h.gateway.forgetSession('s1', 'stop');
  assert.equal(card.signal.aborted, true);
  assert.equal((await clicking).text, COMPUTER_USE_CANCELLED_MESSAGE);
  card.answer(ALLOW_UNTIL_REVOKED);
  await settle();
  assert.equal(h.driver.of('click').length, 0, 'an answer after Stop runs nothing');
  assert.deepEqual(h.grants.list('s1'), []);
  assert.equal(h.lease.currentOwner(), null);
  h.dispose();

  // A request that is with the driver when the session is stopped: the driver is stopped.
  const f = harness({ facts: { s1: { fullAccess: true } } });
  await f.call('s1', 'get_app_state', { app: 'Calculator' });
  const held = f.driver.holdNext('drag');
  const dragging = f.call('s1', 'drag', { app: 'Calculator', from_x: 1, from_y: 2, to_x: 3, to_y: 4 });
  await held.entered.promise;
  f.gateway.forgetSession('s1', 'stop');
  assert.equal((await dragging).text, COMPUTER_USE_CANCELLED_MESSAGE);
  assert.equal(f.driver.killed, 1, 'the only way to know the action is no longer running');
  await settle();
  assert.equal(f.lease.currentOwner(), null);
  // The same through the caller's own signal (the provider's abort).
  await f.call('s1', 'get_app_state', { app: 'Calculator' });
  const heldAgain = f.driver.holdNext('type_text');
  const stop = new AbortController();
  const typing = f.call('s1', 'type_text', { app: 'Calculator', text: 'x' }, stop.signal);
  await heldAgain.entered.promise;
  stop.abort();
  assert.equal((await typing).text, COMPUTER_USE_CANCELLED_MESSAGE);
  assert.equal(f.driver.killed, 2);
  f.dispose();

  // Stopped while the driver was still starting: nothing is sent once it is up.
  const cold = harness({ facts: { s1: { fullAccess: true } } });
  cold.driver.startGate = gate();
  const abort = new AbortController();
  const looking = cold.call('s1', 'list_apps', {}, abort.signal);
  await settle();
  abort.abort();
  cold.driver.startGate.open();
  assert.equal((await looking).text, COMPUTER_USE_CANCELLED_MESSAGE);
  assert.equal(cold.driver.calls.length, 0, 'a start that finished after the stop sends nothing');
  cold.dispose();

  // The start took a while and the switch went off meanwhile, with no signal
  // to say so: what was true when the start began is asked again after it.
  const slowStart = harness({ facts: { s1: { fullAccess: true } } });
  slowStart.driver.startGate = gate();
  const first = slowStart.call('s1', 'list_apps');
  await settle();
  slowStart.setEnabled(false);
  slowStart.driver.startGate.open();
  assert.equal((await first).text, COMPUTER_USE_OFF_MESSAGE);
  assert.equal(slowStart.driver.calls.length, 0, 'nothing is sent to a driver that came up after the switch went off');
  slowStart.dispose();

  // The session's agent was rebuilt while a card was open, and nobody told
  // the gateway: the answer, "until revoked", writes no grant and runs nothing.
  const rebuilt = harness({ cardsIgnoreAbort: true });
  await rebuilt.call('s1', 'get_app_state', { app: 'Calculator' });
  const asked = rebuilt.call('s1', 'click', { app: 'Calculator', element_index: '20' });
  const open = await rebuilt.card();
  rebuilt.facts.s1 = { generation: 2 };
  open.answer(ALLOW_UNTIL_REVOKED);
  assert.equal((await asked).text, COMPUTER_USE_TURN_OVER_MESSAGE);
  assert.equal(open.signal.aborted, false);
  assert.deepEqual(rebuilt.grants.list('s1'), [], 'no grant is written for a runtime that is gone');
  assert.equal(rebuilt.driver.of('click').length, 0);
  assert.equal(rebuilt.lease.currentOwner(), null);
  rebuilt.dispose();

  // A turn that ended while its card was open: the answer runs nothing in the next turn.
  const t = harness({ cardsIgnoreAbort: true });
  await t.call('s1', 'get_app_state', { app: 'Calculator' });
  const pending = t.call('s1', 'click', { app: 'Calculator', element_index: '20' });
  const stale = await t.card();
  t.gateway.finishTurn('s1');
  await pending;
  await t.call('s1', 'get_app_state', { app: 'Calculator' });
  stale.answer(ALLOW);
  await settle();
  assert.equal(t.driver.of('click').length, 0);
  t.dispose();
}

/**
 * A window that was listed and then went away (the placeholder of a cold
 * start) leaves nothing behind: no state for a later click, no screenshot in
 * the HUD or on disk, no success.
 */
async function testWindowThatGoesAway() {
  // Listed once, read as a placeholder, gone at every later look.
  const gone = harness({ answer: () => ALLOW });
  gone.driver.unsettledReads = 1000;
  gone.driver.windowIds = [71, ...Array(40).fill(null)];
  const failed = await gone.call('s1', 'get_app_state', { app: 'TextEdit' });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /has no window to look at yet/);
  assert.equal(gone.driver.of('get_window_state').length, 1, 'the placeholder was read once');
  assert.deepEqual(failed.images, []);
  assert.equal(gone.frames.filter((frame) => frame.hasFreshMedia).length, 0, 'the placeholder is not shown');
  assert.deepEqual(gone.gateway.takeMediaRefs('s1', gone.lastToolUseId()), [], 'nor filed with the result');
  assert.equal(existsSync(join(gone.userDataDir, 'computer-use-artifacts')), false, 'nor saved');
  const after = await gone.call('s1', 'click', { app: 'com.apple.TextEdit', element_index: '20' });
  assert.match(after.text, /Call get_app_state/, 'its window id is not kept for a later click');
  assert.equal(gone.driver.of('click').length, 0);
  gone.dispose();

  // The same for an app that was already running: read without a tree three
  // times, then gone at the look that decides whether the bare read is handed back.
  const late = harness();
  late.driver.unsettledReads = 1000;
  late.driver.windowIds = [71, 71, 71, null];
  const bare = await late.call('s1', 'get_app_state', { app: 'Calculator' });
  assert.equal(bare.isError, true);
  assert.match(bare.text, /has no window to look at yet/);
  assert.equal(late.frames.filter((frame) => frame.hasFreshMedia).length, 0);
  assert.match((await late.call('s1', 'press_key', { app: 'Calculator', key: 'Return' })).text, /Call get_app_state/);
  late.dispose();

  // A placeholder that another window takes the place of: the window that
  // stays is the one later calls act on.
  const replaced = harness({ facts: { s1: { fullAccess: true } } });
  replaced.driver.unsettledReads = 1;
  replaced.driver.windowIds = [71, 72];
  const settled = await replaced.call('s1', 'get_app_state', { app: 'TextEdit' });
  assert.equal(settled.isError, false, settled.text);
  assert.deepEqual(replaced.driver.of('get_window_state').map((call) => call.args.window_id), [71, 72]);
  assert.equal(replaced.frames.filter((frame) => frame.hasFreshMedia).length, 1);
  await replaced.call('s1', 'click', { app: 'com.apple.TextEdit', x: 3, y: 4 });
  assert.equal(replaced.driver.of('click')[0].args.window_id, 72);
  replaced.dispose();
}

/**
 * What was known of an app is what the last look at it found. When that look
 * finds no window, or an action leaves the window unreadable, the indexes of
 * an earlier look are not there for a later click to use.
 */
async function testALookThatFailsForgetsTheLastOne() {
  const h = harness({ facts: { s1: { fullAccess: true } } });
  assert.equal((await h.call('s1', 'get_app_state', { app: 'Calculator' })).isError, false);
  assert.equal((await h.call('s1', 'click', { app: 'Calculator', element_index: '20' })).isError, false);
  // The same app, looked at again: its window is gone.
  h.driver.windowIds = Array(60).fill(null);
  const lost = await h.call('s1', 'get_app_state', { app: 'com.apple.calculator' });
  assert.equal(lost.isError, true);
  assert.match(lost.text, /has no window to look at yet/);
  const clicks = h.driver.of('click').length;
  for (const app of ['Calculator', 'com.apple.calculator']) {
    const stale = await h.call('s1', 'click', { app, element_index: '20' });
    assert.match(stale.text, /Call get_app_state/, `${app}: the first look's indexes are gone`);
  }
  assert.equal(h.driver.of('click').length, clicks, 'nothing is sent on a snapshot that is no longer the app');
  // Another app the session looked at keeps its own state.
  h.driver.windowIds = [];
  await h.call('s1', 'get_app_state', { app: 'com.apple.Notes' });
  h.driver.windowIds = Array(60).fill(null);
  await h.call('s1', 'get_app_state', { app: 'Calculator' });
  h.driver.windowIds = [];
  assert.equal((await h.call('s1', 'click', { app: 'com.apple.Notes', element_index: '20' })).isError, false);
  h.dispose();

  // An action ran, and the window could not be read after it.
  const a = harness({ facts: { s1: { fullAccess: true } } });
  await a.call('s1', 'get_app_state', { app: 'Calculator' });
  a.driver.failedReads = 1;
  const acted = await a.call('s1', 'click', { app: 'Calculator', element_index: '20' });
  assert.equal(acted.isError, false, 'the click itself ran');
  assert.match(acted.text, /could not be read afterwards/);
  assert.match((await a.call('s1', 'click', { app: 'Calculator', element_index: '6' })).text, /Call get_app_state/);
  assert.equal(a.driver.of('click').length, 1);
  a.dispose();
}

/**
 * Changing the driver draws a line in the queue at once: what arrives after
 * it never reaches the driver that is being replaced, however long that one
 * takes to get out of the way.
 */
async function testNothingNewReachesTheOldDriver() {
  const h = harness({ facts: { s1: { fullAccess: true } } });
  // The old driver is still coming up, with a call waiting on it.
  h.driver.startGate = gate();
  const waiting = h.call('s1', 'list_apps');
  await settle();
  assert.deepEqual(h.driver.log, []);
  // The driver path changes (the switch stays on), and a new call arrives while the old one is still in the way.
  const changing = h.gateway.shutdown('driver-changed');
  const fresh = h.call('s1', 'list_apps');
  await settle();
  const cold = h.driver.startGate;
  h.driver.startGate = null;
  cold.open();
  await changing;
  assert.equal((await waiting).text, COMPUTER_USE_CANCELLED_MESSAGE);
  assert.equal((await fresh).isError, false);
  assert.deepEqual(h.driver.log, ['start:1', 'stop', 'start:2', 'check_permissions@2', 'list_apps@2'],
    'the old driver took nothing after the change began; the new call went to the new one');
  h.dispose();

  // The same with a call in flight on the old driver.
  const f = harness({ facts: { s1: { fullAccess: true } } });
  await f.call('s1', 'list_apps');
  const held = f.driver.holdNext('list_apps');
  f.driver.exitGate = gate();
  const inFlight = f.call('s1', 'list_apps');
  await held.entered.promise;
  const off = f.gateway.shutdown('driver-changed');
  const next = f.call('s1', 'list_apps');
  await settle();
  f.driver.exitGate.open();
  await off;
  await inFlight;
  assert.equal((await next).isError, false);
  const after = f.driver.log.slice(f.driver.log.indexOf('stop'));
  assert.deepEqual(after, ['stop', 'start:2', 'check_permissions@2', 'list_apps@2']);
  f.dispose();
}

/**
 * The desktop is handed back when the session's action is over, not when it
 * was told to stop: a request that was with the driver is over when the
 * driver process is gone. Until then nobody else gets the desktop.
 */
async function testLeaseHandedBackAfterTheActionEnded() {
  for (const how of ['stop', 'turn-end', 'switch-off'] as const) {
    const f = harness({ facts: { s1: { fullAccess: true } } });
    await f.call('s1', 'get_app_state', { app: 'Calculator' });
    const held = f.driver.holdNext('drag');
    f.driver.exitGate = gate();
    const dragging = f.call('s1', 'drag', { app: 'Calculator', from_x: 1, from_y: 2, to_x: 3, to_y: 4 });
    await held.entered.promise;
    let off: Promise<void> | null = null;
    if (how === 'stop') f.gateway.forgetSession('s1', 'stop');
    if (how === 'turn-end') f.gateway.finishTurn('s1');
    if (how === 'switch-off') off = f.gateway.shutdown('disabled');
    await settle();
    assert.equal(f.driver.killed, 1, how);
    // Told to stop, not yet gone: the desktop is still this session's.
    assert.equal(f.lease.currentOwner()?.threadId, 's1', `${how}: not handed back while the driver is still going`);
    assert.equal(f.lease.tryAcquire('codex-thread', 'codex-call'), false, `${how}: Codex cannot take it yet`);
    assert.equal((await f.call('other', 'list_apps')).text, COMPUTER_USE_LEASE_MESSAGE, `${how}: nor may another session look`);
    f.driver.exitGate.open();
    assert.equal((await dragging).text, COMPUTER_USE_CANCELLED_MESSAGE);
    if (off) await off;
    await settle();
    assert.equal(f.lease.currentOwner(), null, `${how}: handed back once it is gone`);
    assert.equal(f.lease.tryAcquire('codex-thread', 'codex-call'), true);
    f.dispose();
  }

  // The next turn of the same session, begun while the old action is still
  // ending, keeps what it takes: only the old turn's holds are handed back.
  const again = harness({ facts: { s1: { fullAccess: true } } });
  await again.call('s1', 'get_app_state', { app: 'Calculator' });
  const held = again.driver.holdNext('drag');
  again.driver.exitGate = gate();
  const dragging = again.call('s1', 'drag', { app: 'Calculator', from_x: 1, from_y: 2, to_x: 3, to_y: 4 });
  await held.entered.promise;
  again.gateway.finishTurn('s1');
  await settle();
  const opening = again.call('s1', 'get_app_state', { app: 'TextEdit' });
  await settle();
  again.driver.exitGate.open();
  await dragging;
  assert.equal((await opening).isError, false);
  await settle();
  assert.equal(again.lease.currentOwner()?.threadId, 's1', 'the new turn opened an app and holds the desktop for it');
  assert.equal(again.lease.actionsOf('s1').length, 1, "and only for that: the old turn's hold is gone");
  again.dispose();
}

/**
 * Reading the macOS grants is a call to the driver that can take a while (the
 * first call of a cold driver). What happens meanwhile counts: the request it
 * was made for is not sent on the strength of a check made before it.
 */
async function testRecheckedAfterThePermissionProbe() {
  // Codex takes the desktop while the probe hangs.
  const h = harness();
  const probe = h.driver.holdNext('check_permissions');
  const looking = h.call('s1', 'list_apps');
  await probe.entered.promise;
  assert.equal(h.lease.tryAcquire('codex-thread', 'codex-call'), true);
  probe.gate.open();
  assert.equal((await looking).text, COMPUTER_USE_LEASE_MESSAGE);
  assert.deepEqual(h.driver.calls.map((call) => call.tool), ['check_permissions'], 'the request the probe was for is not sent');
  h.dispose();

  // The switch goes off while the probe hangs, and nobody says so.
  const off = harness();
  const hanging = off.driver.holdNext('check_permissions');
  const first = off.call('s1', 'get_app_state', { app: 'Calculator' });
  await hanging.entered.promise;
  off.setEnabled(false);
  hanging.gate.open();
  assert.equal((await first).text, COMPUTER_USE_OFF_MESSAGE);
  assert.deepEqual(off.driver.calls.map((call) => call.tool), ['check_permissions']);
  off.dispose();

  // The session's agent is rebuilt while the probe hangs.
  const rebuilt = harness();
  const waiting = rebuilt.driver.holdNext('check_permissions');
  const call = rebuilt.call('s1', 'list_apps');
  await waiting.entered.promise;
  rebuilt.facts.s1 = { generation: 2 };
  waiting.gate.open();
  assert.equal((await call).text, COMPUTER_USE_TURN_OVER_MESSAGE);
  assert.equal(rebuilt.driver.of('list_apps').length, 0);
  rebuilt.dispose();
}

/** What allowed a call is asked again at the moment the call is sent. */
async function testRecheckedWhenSent() {
  const setUp = async (facts: Partial<ComputerUseSessionFacts>) => {
    const h = harness({ facts: { s1: { ...facts } }, answer: () => ALLOW_UNTIL_REVOKED });
    await h.call('s1', 'get_app_state', { app: 'Calculator' });
    if (!facts.fullAccess) await h.call('s1', 'click', { app: 'Calculator', element_index: '20' });
    const sent = h.driver.of('click').length;
    // A call in flight, and a click that waits behind it, already allowed.
    const held = h.driver.holdNext('list_apps');
    const first = h.call('s1', 'list_apps');
    await held.entered.promise;
    const waiting = h.call('s1', 'click', { app: 'Calculator', element_index: '6' });
    await settle();
    return { h, sent, release: async () => { held.gate.open(); await first; return waiting; } };
  };

  // Full Access was what allowed it, and the conversation left Full Access.
  let run = await setUp({ fullAccess: true });
  run.h.facts.s1 = { fullAccess: false };
  assert.match((await run.release()).text, /left Full Access/);
  assert.equal(run.h.driver.of('click').length, run.sent);
  run.h.dispose();

  // A grant was what allowed it, and the grant was revoked.
  run = await setUp({});
  run.h.grants.revoke('s1');
  assert.match((await run.release()).text, /revoked while the call waited/);
  assert.equal(run.h.driver.of('click').length, run.sent);
  run.h.dispose();

  // The session went into Plan mode.
  run = await setUp({});
  run.h.facts.s1 = { planMode: true };
  assert.equal((await run.release()).text, COMPUTER_USE_PLAN_MESSAGE);
  assert.equal(run.h.driver.of('click').length, run.sent);
  run.h.dispose();

  // The session's agent was rebuilt.
  run = await setUp({});
  run.h.facts.s1 = { generation: 2 };
  assert.equal((await run.release()).text, COMPUTER_USE_TURN_OVER_MESSAGE);
  assert.equal(run.h.driver.of('click').length, run.sent);
  run.h.dispose();

  // The session is gone.
  run = await setUp({});
  run.h.facts.s1 = null;
  assert.match((await run.release()).text, /no longer open/);
  run.h.dispose();

  // Another session took the desktop meanwhile (the lease was lost).
  run = await setUp({});
  run.h.lease.releaseThread('s1');
  run.h.lease.tryAcquire('codex-thread', 'x');
  assert.equal((await run.release()).text, COMPUTER_USE_LEASE_MESSAGE);
  assert.equal(run.h.driver.of('click').length, run.sent);
  run.h.dispose();

  // The driver process is another one than the app was looked at through:
  // its pid, window and snapshot are not handed to the new one.
  const d = harness({ facts: { s1: { fullAccess: true } } });
  await d.call('s1', 'get_app_state', { app: 'Calculator' });
  d.driver.crash();
  const stale = await d.call('s1', 'click', { app: 'Calculator', element_index: '20' });
  assert.equal(stale.text, COMPUTER_USE_DRIVER_RESTARTED_MESSAGE);
  assert.equal(d.driver.of('click').length, 0);
  assert.match((await d.call('s1', 'click', { app: 'Calculator', element_index: '20' })).text, /Call get_app_state/);
  await d.call('s1', 'get_app_state', { app: 'Calculator' });
  assert.equal((await d.call('s1', 'click', { app: 'Calculator', element_index: '20' })).isError, false);
  assert.ok(d.driver.calls.every((call) => call.instance !== undefined), 'every call names the driver process it is for');
  d.dispose();
}

/** A grant is for one app by its exact identity, one runtime, and one backend. */
async function testGrantsAreExact() {
  const h = harness({ answer: () => ALLOW_UNTIL_REVOKED });
  // Two apps named "Notes". By name they cannot be told apart.
  assert.match((await h.call('s1', 'get_app_state', { app: 'Notes' })).text, /matches several apps/);
  await h.call('s1', 'get_app_state', { app: 'com.apple.Notes' });
  await h.call('s1', 'get_app_state', { app: 'com.example.notes' });
  await h.call('s1', 'click', { app: 'com.apple.Notes', element_index: '20' });
  assert.equal(h.cards.length, 1);
  assert.equal(h.cards[0].app, 'Notes');
  assert.deepEqual(h.grants.list('s1').map((grant) => grant.appId), ['com.apple.Notes']);
  assert.equal(h.driver.of('click')[0].args.element_token, 's00000001:20', 'the first app, by its own snapshot');

  // The other "Notes" is asked about: the grant is not for a name.
  h.setAnswer(() => DECLINE);
  assert.match((await h.call('s1', 'click', { app: 'com.example.notes', element_index: '20' })).text, /The user declined/);
  assert.equal(h.cards.length, 2);
  // By the shared name, a later call means neither.
  assert.match((await h.call('s1', 'click', { app: 'Notes', element_index: '20' })).text, /Call get_app_state for "Notes" first/);
  // The granted one still runs without a card.
  assert.equal((await h.call('s1', 'click', { app: 'com.apple.Notes', element_index: '6' })).isError, false);
  assert.equal(h.cards.length, 2);

  // An app with no bundle identifier cannot be granted: it is asked about every time.
  h.setAnswer(() => ALLOW_UNTIL_REVOKED);
  await h.call('s1', 'get_app_state', { app: 'Loose' });
  await h.call('s1', 'click', { app: 'Loose', element_index: '20' });
  assert.equal(h.cards[2].canAllowUntilRevoked, false);
  await h.call('s1', 'click', { app: 'Loose', element_index: '20' });
  assert.equal(h.cards.length, 4);
  assert.deepEqual(h.grants.list('s1').map((grant) => grant.appId), ['com.apple.Notes']);

  // The session's agent is rebuilt: the grant of the old one neither matches nor stays listed.
  h.gateway.finishTurn('s1');
  h.facts.s1 = { generation: 2 };
  await h.call('s1', 'get_app_state', { app: 'com.apple.Notes' });
  assert.deepEqual(h.grants.list('s1'), [], 'gone from the list at the first call of the new runtime');
  h.setAnswer(() => DECLINE);
  assert.match((await h.call('s1', 'click', { app: 'com.apple.Notes', element_index: '20' })).text, /The user declined/);
  h.dispose();

  // The registry: one backend's grants are not the other's.
  const registry = new ComputerUseGrantRegistry();
  const gateway: ComputerUseGrantTarget = {
    owner: 'gateway', threadId: 't', providerThreadId: null, generation: 1,
    server: 'aegis-computer-use', tool: 'click', app: 'Notes', appId: 'com.apple.Notes', riskLevel: 'low',
  };
  const codex: ComputerUseGrantTarget = { ...gateway, owner: 'codex', appId: undefined, generation: 4 };
  assert.equal(registry.matchGrant(gateway), null);
  assert.ok(registry.createGrant(gateway));
  assert.ok(registry.matchGrant(gateway));
  assert.equal(registry.matchGrant(codex), null, "a gateway grant does not answer for Codex's call of the same name");
  assert.equal(registry.matchGrant({ ...gateway, appId: 'com.example.notes' }), null, 'same name, another app');
  assert.equal(registry.matchGrant({ ...gateway, appId: undefined }), null, 'nor by name alone');
  assert.equal(registry.matchGrant({ ...gateway, riskLevel: 'medium' }), null, 'a grant does not reach past its risk');
  assert.equal(registry.matchGrant({ ...gateway, generation: 2 }), null);
  assert.equal(registry.createGrant({ ...gateway, app: null }), null);
  assert.ok(registry.createGrant(codex));
  assert.equal(registry.list('t').length, 2);
  // A Codex grant keeps the key it always had.
  assert.equal(registry.matchGrant(codex)?.key, ['t', '', 'aegis-computer-use', 'click', 'notes'].join('\0'));

  registry.revokeOtherGenerations('t', 1, 'gateway');
  assert.equal(registry.list('t').length, 2, 'the current runtime keeps its grant');
  registry.revokeThread('t', 'stop', 'gateway');
  assert.deepEqual(registry.list('t').map((grant) => grant.owner), ['codex']);
  assert.ok(registry.createGrant(gateway));
  registry.revokeOwner('codex', 'stop-all');
  assert.deepEqual(registry.list('t').map((grant) => grant.owner), ['gateway'], "Codex stopping leaves the gateway's");
  assert.ok(registry.createGrant(codex));
  registry.revokeOwner('gateway', 'disabled');
  assert.deepEqual(registry.list('t').map((grant) => grant.owner), ['codex'], "the switch going off leaves Codex's");
  registry.revokeOtherGenerations('t', 5, 'codex');
  assert.deepEqual(registry.list('t'), []);
}

async function testActionMapping() {
  const h = harness({ facts: { s1: { fullAccess: true } } });
  await h.call('s1', 'get_app_state', { app: 'Calculator' });
  const window = { pid: 500, window_id: 71 };
  const session = { session: 'aegis-s1-1' };
  const background = { delivery_mode: 'background', scope: 'window' };
  const last = (tool: string) => h.driver.of(tool).slice(-1)[0]?.args;

  await h.call('s1', 'click', { app: 'Calculator', element_index: '20', click_count: 2 });
  assert.deepEqual(last('double_click'), { element_token: 's00000001:20', delivery_mode: 'background', ...session });
  await h.call('s1', 'click', { app: 'Calculator', element_index: '20', mouse_button: 'right' });
  assert.equal(last('click')?.button, 'right');
  // A count written as a digit is the count; the double click of an element is the driver's own call.
  await h.call('s1', 'click', { app: 'Calculator', element_index: '6', click_count: '2' });
  assert.equal(h.driver.of('double_click').length, 2);
  assert.equal(h.driver.of('double_click')[1].args.element_token, 's00000003:6');
  await h.call('s1', 'click', { app: 'Calculator', x: 5, y: 6, click_count: 3 });
  assert.deepEqual(last('click'), { ...window, x: 5, y: 6, button: 'left', count: 3, ...background, ...session });
  await h.call('s1', 'perform_secondary_action', { app: 'Calculator', element_index: '6', action: 'AXShowMenu' });
  assert.equal(last('click')?.action, 'show_menu');
  await h.call('s1', 'set_value', { app: 'Calculator', element_index: '6', value: 'x' });
  assert.deepEqual(last('set_value'), { element_token: last('set_value')?.element_token, value: 'x', ...session });
  await h.call('s1', 'scroll', { app: 'Calculator', element_index: '0', direction: 'Down', pages: 2 });
  assert.deepEqual(
    { direction: last('scroll')?.direction, amount: last('scroll')?.amount, pid: last('scroll')?.pid },
    { direction: 'down', amount: 10, pid: 500 }
  );
  await h.call('s1', 'drag', { app: 'Calculator', from_x: 1, from_y: 2, to_x: 3, to_y: 4 });
  assert.deepEqual(last('drag'), { ...window, from_x: 1, from_y: 2, to_x: 3, to_y: 4, ...background, ...session });
  await h.call('s1', 'press_key', { app: 'Calculator', key: 'super+shift+z' });
  assert.deepEqual(last('hotkey'), { ...window, keys: ['cmd', 'shift', 'z'], ...background, ...session });
  await h.call('s1', 'press_key', { app: 'Calculator', key: 'KP_8' });
  assert.deepEqual(last('press_key'), { ...window, key: '8', ...background, ...session });
  await h.call('s1', 'type_text', { app: 'Calculator', text: '6*7' });
  assert.deepEqual(last('type_text'), { ...window, text: '6*7', ...background, ...session });

  // Every input call says where and how it is delivered; none leaves it to the driver's default.
  for (const call of h.driver.calls) {
    const fixed = DRIVER_INPUT_TOOLS[call.tool];
    if (!fixed) continue;
    for (const [name, value] of Object.entries(fixed)) assert.equal(call.args[name], value, `${call.tool}.${name}`);
    assert.ok(!('target' in call.args), `${call.tool} names its window by pid and id only`);
  }
  for (const tool of ['click', 'double_click', 'scroll', 'drag', 'press_key', 'hotkey', 'type_text']) {
    assert.equal(DRIVER_INPUT_TOOLS[tool].delivery_mode, 'background', tool);
  }

  // Refused before anything is asked or sent. A click the driver call cannot
  // carry is refused, not shown on the card and dropped.
  const sent = h.driver.calls.length;
  for (const [tool, args, pattern] of [
    ['click', { app: 'Calculator' }, /element_index, or both x and y/],
    ['click', { app: 'Calculator', element_index: 'abc' }, /not an index/],
    ['click', { app: 'Calculator', element_index: '20', click_count: 3 }, /click_count can be 1, or 2 with the left button/],
    ['click', { app: 'Calculator', element_index: '20', click_count: 2, mouse_button: 'right' }, /click_count can be 1, or 2/],
    ['click', { app: 'Calculator', x: 1, y: 2, click_count: 4 }, /click_count must be a whole number: 1, 2 or 3/],
    // Nothing is rounded or guessed: 1.6 is not a double click, a word is not a single one.
    ['click', { app: 'Calculator', element_index: '20', click_count: 1.6 }, /click_count must be a whole number/],
    ['click', { app: 'Calculator', element_index: '20', click_count: 'twice' }, /click_count must be a whole number/],
    ['click', { app: 'Calculator', element_index: '20', click_count: '2.0' }, /click_count must be a whole number/],
    ['click', { app: 'Calculator', element_index: '20', click_count: 0 }, /click_count must be a whole number/],
    ['click', { app: 'Calculator', x: 1, y: 2, click_count: 2.5 }, /click_count must be a whole number/],
    ['click', { app: 'Calculator', element_index: '20', click_count: true }, /click_count must be a whole number/],
    // Said and empty is not the same as not said: an explicit null is refused, not read as one click.
    ['click', { app: 'Calculator', element_index: '20', click_count: null }, /click_count must be a whole number/],
    ['click', { app: 'Calculator', x: 1, y: 2, click_count: null }, /click_count must be a whole number/],
    ['scroll', { app: 'Calculator', element_index: '1', direction: 'sideways' }, /direction must be/],
    ['press_key', { app: 'Calculator', key: 'hyper+x' }, /not a modifier/],
    ['press_key', { app: 'Calculator', key: 'asterisk' }, /type other characters with type_text/],
    ['set_value', { app: 'Calculator', value: 'x' }, /element_index is required/],
    ['type_text', { app: 'Calculator', text: '' }, /text is required/],
    ['get_app_state', {}, /`app` is required/],
  ] as const) {
    const result = await h.call('s1', tool, args);
    assert.equal(result.isError, true, tool);
    assert.match(result.text, pattern);
  }
  assert.equal(h.driver.calls.length, sent);
  assert.equal(h.cards.length, 0);

  // What the card says is what is sent.
  const asked = harness({ answer: () => ALLOW });
  await asked.call('s1', 'get_app_state', { app: 'Calculator' });
  await asked.call('s1', 'click', { app: 'Calculator', element_index: '20', click_count: 2 });
  assert.deepEqual(asked.cards[0].paramLines, [
    { label: 'element', value: '[20] AXButton (Equals)' },
    { label: 'clicks', value: '2' },
  ]);
  assert.equal(asked.driver.of('double_click').length, 1);
  asked.dispose();

  // Only calls the policy allows ever leave the gateway.
  const policy = buildCuaDriverPolicy();
  for (const call of h.driver.calls) {
    assert.match(policy, new RegExp(`(?:- |tool: )${call.tool}\\b`), `${call.tool} is in the policy`);
  }
  h.dispose();
}

function testKeysAndActions() {
  assert.deepEqual(parseXdotoolKey('Return'), { modifiers: [], key: 'return' });
  assert.deepEqual(parseXdotoolKey('ctrl+alt+Delete'), { modifiers: ['ctrl', 'option'], key: 'delete' });
  assert.deepEqual(parseXdotoolKey('super+c'), { modifiers: ['cmd'], key: 'c' });
  assert.deepEqual(parseXdotoolKey('Page_Down'), { modifiers: [], key: 'pagedown' });
  assert.deepEqual(parseXdotoolKey('F12'), { modifiers: [], key: 'f12' });
  assert.ok('error' in parseXdotoolKey('ctrl+'));
  assert.ok('error' in parseXdotoolKey('F13'));
  assert.equal(normalizeSecondaryAction('AXShowAlternateUI'), 'show_alternate_ui');
  assert.equal(normalizeSecondaryAction('increment'), 'increment');
}

function testDriverSetup() {
  // The driver's environment is built, not inherited.
  const env = buildCuaDriverEnv({
    base: {
      PATH: '/bin',
      HOME: '/Users/someone',
      LANG: 'en_US.UTF-8',
      CUA_DRIVER_RS_TELEMETRY_ENABLED: 'true',
      CUA_DRIVER_RS_MCP_HTTP_PORT: '8123',
      CUA_DRIVER_RS_MCP_HTTP_TOKEN: 'x'.repeat(40),
      CUA_DRIVER_ALLOW_BRIEF_FOREGROUND: '1',
      CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: '1',
      CUA_DRIVER_PERMISSION_MODE: 'unrestricted',
      CUA_DRIVER_MANAGED_POLICY_FILE: '/tmp/other.yaml',
      CUA_DRIVER_DISABLE_KEY_FOCUS_GUARD: '1',
      AEGIS_SESSION_MCP_TOKEN: 'secret',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NODE_OPTIONS: '--inspect',
    },
    homeDir: '/tmp/aegis/driver',
    hostBundleId: 'com.aegis.desktop',
    policyFile: '/tmp/aegis/driver/policy.yaml',
  });
  assert.deepEqual(env, {
    PATH: '/bin',
    HOME: '/Users/someone',
    LANG: 'en_US.UTF-8',
    CUA_DRIVER_EMBEDDED: '1',
    CUA_DRIVER_HOST_BUNDLE_ID: 'com.aegis.desktop',
    CUA_DRIVER_RS_HOME: '/tmp/aegis/driver',
    CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
    CUA_TELEMETRY_ENABLED: 'false',
    CUA_DRIVER_RS_UPDATE_CHECK: 'false',
    CUA_DRIVER_POLICY_FILE: '/tmp/aegis/driver/policy.yaml',
  }, 'nothing of Aegis’s own environment configures the driver');

  const args = cuaDriverDaemonArgs('/tmp/a/driver.sock', 'com.aegis.desktop');
  assert.ok(args.includes('--parent-liveness-stdio'), 'the daemon exits with Aegis');
  assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), ['--permission-mode', 'standard']);
  assert.deepEqual(args.slice(0, 2), ['serve', '--embedded']);

  assert.equal(cuaDriverSocketPath('/tmp/a'), '/tmp/a/driver.sock');
  const long = cuaDriverSocketPath(`/Users/someone/Library/Application Support/${'x'.repeat(90)}`);
  assert.ok(Buffer.byteLength(long) <= 100, 'a socket path macOS accepts');

  const policy = buildCuaDriverPolicy();
  for (const tool of ['kill_app', 'run_script', 'run_steps', 'clipboard_read', 'clipboard_write', 'browser_', 'get_desktop_state', 'bring_to_front', 'set_config', 'install_extension', 'check_for_update', 'start_recording']) {
    assert.ok(!policy.includes(tool), `${tool} is not allowed`);
  }
  // delivery_mode and scope must be there, with these values: no `optional`.
  assert.match(policy, /- tool: click\n {6}constraints:\n {8}delivery_mode: \{ allowed: \[background\] \}\n {8}scope: \{ allowed: \[window\] \}\n {8}target: \{ optional: true, allowed: \[\] \}/);
  assert.match(policy, /- tool: drag\n {6}constraints:\n {8}delivery_mode: \{ allowed: \[background\] \}\n {8}scope: \{ allowed: \[window\] \}/);
  assert.match(policy, /- tool: double_click\n {6}constraints:\n {8}delivery_mode: \{ allowed: \[background\] \}\n/);
  assert.doesNotMatch(policy, /delivery_mode: \{ optional/);
  assert.doesNotMatch(policy, /foreground|desktop/);
  assert.match(policy, /- tool: launch_app\n {6}constraints:\n {8}urls: \{ optional: true, allowed: \[\] \}/);

  // The version is fixed in two files that must agree.
  const fetchScript = readFileSync(join(__dirname, '..', 'fetch-cua-driver.mjs'), 'utf8');
  assert.equal(/export const VERSION = '([^']+)'/.exec(fetchScript)?.[1], CUA_DRIVER_VERSION);
  assert.match(fetchScript, /export const SHA256 = '[a-f0-9]{64}'/);

  const dir = mkdtempSync(join(tmpdir(), 'aegis-cu-bin-'));
  const binary = join(dir, 'cua-driver');
  const lookup = { env: { AEGIS_CUA_DRIVER_PATH: binary }, configuredPath: '', platform: 'darwin' as const };
  // A build with no binary anywhere (the repo copy, when fetched, is found last).
  const missing = resolveCuaDriver({ ...lookup, env: { AEGIS_CUA_DRIVER_PATH: join(dir, 'absent') }, readVersion: () => null });
  if (!existsSync(join(__dirname, '..', '..', 'native', 'cua-driver', 'dist', 'cua-driver'))) {
    assert.equal(missing.state, 'missing');
    assert.match(missing.message || '', /fetch:cua-driver/);
  }
  writeFileSync(binary, '');
  assert.equal(resolveCuaDriver({ ...lookup, readVersion: () => '0.56.9' }).state, 'version-mismatch');
  assert.match(resolveCuaDriver({ ...lookup, readVersion: () => '0.56.9' }).message || '', new RegExp(`runs ${CUA_DRIVER_VERSION.replace(/\./g, '\\.')} only`));
  assert.equal(resolveCuaDriver({ ...lookup, readVersion: () => null }).state, 'version-mismatch');
  const ready = resolveCuaDriver({ ...lookup, readVersion: () => CUA_DRIVER_VERSION });
  assert.deepEqual([ready.state, ready.path, ready.message], ['ready', binary, null]);
  assert.equal(resolveCuaDriver({ ...lookup, platform: 'win32' }).state, 'unsupported-platform');
  rmSync(dir, { recursive: true, force: true });
}

/**
 * A stand-in for the cua-driver executable: `serve` holds a socket file and
 * exits when its stdin closes (as the real one does with
 * --parent-liveness-stdio); `mcp` answers MCP over stdio and never answers
 * the tool "slow"; `--version` answers with the version in version.txt. Each
 * writes what it was started with: next to the socket, or next to itself.
 */
const STAND_IN = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const net = require('net');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'version.env.json'), JSON.stringify(process.env));
  console.log('cua-driver ' + fs.readFileSync(path.join(path.dirname(process.argv[1]), 'version.txt'), 'utf8').trim());
  process.exit(0);
}
const socket = args[args.indexOf('--socket') + 1];
fs.writeFileSync(path.join(path.dirname(socket), args[0] + '.started.json'), JSON.stringify({ pid: process.pid, args, env: process.env }));
if (args[0] === 'serve') {
  // Two daemons at once is what must never happen: the one before this one is looked for.
  const pidFile = path.join(path.dirname(socket), 'daemon.pid');
  try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0); fs.writeFileSync(path.join(path.dirname(socket), 'overlap'), '1'); } catch {}
  fs.writeFileSync(pidFile, String(process.pid));
  net.createServer(() => {}).listen(socket);
  // With a file named "stubborn" beside the socket, this daemon does not go when told to.
  const stubborn = () => fs.existsSync(path.join(path.dirname(socket), 'stubborn'));
  const quit = () => { if (stubborn()) return; try { fs.unlinkSync(socket); } catch {} process.exit(0); };
  process.on('SIGTERM', quit);
  if (args.includes('--parent-liveness-stdio')) { process.stdin.resume(); process.stdin.on('end', quit); }
  process.stderr.write('stand-in daemon listening\\n');
} else {
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === 'notifications/cancelled') fs.writeFileSync(path.join(path.dirname(socket), 'cancel-notified'), '1');
      if (message.id === undefined) continue;
      if (message.method === 'initialize') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'cua-driver' } } }) + '\\n'); continue; }
      if (message.params.name === 'slow') continue;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok ' + message.params.name }], structuredContent: { echo: message.params.arguments } } }) + '\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** The process host, against the stand-in executable: how it starts the driver and how it stops it. */
async function testDriverHostProcesses() {
  if (process.platform === 'win32') return;
  const dir = mkdtempSync(join(tmpdir(), 'aegis-cu-host-'));
  const binary = join(dir, 'cua-driver');
  writeFileSync(binary, STAND_IN);
  chmodSync(binary, 0o755);
  const homeDir = join(dir, 'home');
  const host = new CuaDriverHost({
    resolveBinary: () => binary,
    homeDir,
    hostBundleId: 'com.aegis.desktop',
    env: { ...process.env, CUA_DRIVER_RS_MCP_HTTP_PORT: '8123', CUA_DRIVER_ALLOW_BRIEF_FOREGROUND: '1', AEGIS_SESSION_MCP_TOKEN: 'secret', NODE_OPTIONS: '' },
    // A driver that will not go is killed after this long (two seconds outside the tests).
    exitWaitMs: 300,
  });
  const started = (kind: 'serve' | 'mcp') =>
    JSON.parse(readFileSync(join(homeDir, `${kind}.started.json`), 'utf8')) as { pid: number; args: string[]; env: Record<string, string> };
  const pids = (): number[] => {
    try {
      return execFileSync('pgrep', ['-f', binary], { encoding: 'utf8' }).split('\n').map((line) => Number(line)).filter((pid) => pid > 0);
    } catch {
      return [];
    }
  };
  const noneLeft = () => until(() => pids().length === 0, 'the driver processes to be gone');
  try {
    assert.equal(host.isRunning(), false);
    const first = await host.start();
    assert.equal(first, 1);
    assert.equal(await host.start(), 1, 'a running driver keeps its number');
    // What the two processes were really started with.
    const daemon = started('serve');
    assert.deepEqual(daemon.args, cuaDriverDaemonArgs(join(homeDir, 'driver.sock'), 'com.aegis.desktop'));
    for (const child of [daemon, started('mcp')]) {
      assert.equal(child.env.CUA_DRIVER_EMBEDDED, '1');
      assert.equal(child.env.CUA_DRIVER_RS_TELEMETRY_ENABLED, 'false');
      assert.equal(child.env.CUA_DRIVER_POLICY_FILE, join(homeDir, 'policy.yaml'));
      for (const name of ['CUA_DRIVER_RS_MCP_HTTP_PORT', 'CUA_DRIVER_ALLOW_BRIEF_FOREGROUND', 'AEGIS_SESSION_MCP_TOKEN', 'NODE_OPTIONS']) {
        assert.equal(child.env[name], undefined, `${name} does not reach the driver`);
      }
    }
    assert.equal(readFileSync(join(homeDir, 'policy.yaml'), 'utf8'), buildCuaDriverPolicy());
    // stderr goes to a file: a pipe to this process would break the daemon's exit when this process dies.
    assert.match(readFileSync(join(homeDir, 'driver.log'), 'utf8'), /stand-in daemon listening/);

    const echoed = await host.call('list_apps', { session: 's' }, { instance: first });
    assert.equal(echoed.text, 'ok list_apps');
    assert.deepEqual(echoed.structured, { echo: { session: 's' } });

    // A call in flight is cancelled by stopping the driver, and "cancelled" is said once it is gone.
    const running = pids();
    assert.equal(running.length, 2);
    const stop = new AbortController();
    const slow = host.call('slow', {}, { signal: stop.signal, instance: first });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop.abort();
    await assert.rejects(slow, new RegExp(COMPUTER_USE_CANCELLED_MESSAGE));
    assert.equal(alive(daemon.pid), false, 'the daemon is gone by the time the caller hears "cancelled"');
    assert.equal(existsSync(join(homeDir, 'cancel-notified')), false, 'no cancel notification is relied on');
    assert.equal(host.isRunning(), false);
    await noneLeft();

    // A call meant for the driver that is gone is refused and starts nothing.
    await assert.rejects(host.call('list_apps', {}, { instance: first }), new RegExp(COMPUTER_USE_DRIVER_RESTARTED_MESSAGE));
    assert.equal(host.isRunning(), false);
    assert.deepEqual(pids(), []);

    // The next call starts another driver, with another number.
    const second = await host.start();
    assert.equal(second, 2);
    await assert.rejects(host.call('list_apps', {}, { instance: first }), new RegExp(COMPUTER_USE_DRIVER_RESTARTED_MESSAGE));
    // Stopped already: neither started nor called.
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(host.start(stopped.signal), new RegExp(COMPUTER_USE_CANCELLED_MESSAGE));
    await assert.rejects(host.call('list_apps', {}, { signal: stopped.signal }), new RegExp(COMPUTER_USE_CANCELLED_MESSAGE));

    await host.stop();
    assert.equal(host.isRunning(), false);
    await noneLeft();
    assert.equal(existsSync(join(homeDir, 'driver.sock')), false);

    // A stale socket from a run that crashed does not stop the next start.
    writeFileSync(join(homeDir, 'driver.sock'), '');
    assert.equal(await host.start(), 3);
    await host.stop();
    await noneLeft();

    // ── A driver that does not go when told to ─────────────────────────────
    // One way out for every way in: a call that timed out, a call that was
    // cancelled, a proxy that died, a stop. Each waits for both processes to
    // be gone (killed after a moment if they stay), and nothing is reported,
    // and no new driver is started, before that.
    const stubborn = join(homeDir, 'stubborn');
    const daemonPid = () => started('serve').pid;
    const proxyPid = () => started('mcp').pid;

    // A tool call that times out: the caller hears so only once the driver is gone.
    let instance = await host.start();
    writeFileSync(stubborn, '');
    let pid = daemonPid();
    let began = Date.now();
    await assert.rejects(host.call('slow', {}, { timeoutMs: 100, instance }), /timed out/);
    assert.equal(alive(pid), false, 'a timed-out call is reported when the daemon is gone, not while it lingers');
    assert.ok(Date.now() - began >= 100 + 300, 'it had to be killed: it was given its moment first');
    assert.equal(host.isRunning(), false);
    await noneLeft();

    // stop() while such a driver is still on its way out: stopped means gone.
    rmSync(stubborn, { force: true });
    instance = await host.start();
    writeFileSync(stubborn, '');
    pid = daemonPid();
    const timingOut = host.call('slow', {}, { timeoutMs: 50, instance }).then(() => 'answered', (error: Error) => error.message);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(alive(pid), true, 'told to go and still there');
    assert.equal(host.isRunning(), false, 'no longer handed out');
    await host.stop();
    assert.equal(alive(pid), false, 'stop() returned only once it was gone');
    assert.match(await timingOut, /timed out/);

    // A new driver does not start beside one that is still going.
    rmSync(stubborn, { force: true });
    instance = await host.start();
    writeFileSync(stubborn, '');
    pid = daemonPid();
    const cancel = new AbortController();
    const cancelled = host.call('slow', {}, { signal: cancel.signal, instance }).then(() => 'answered', (error: Error) => error.message);
    await new Promise((resolve) => setTimeout(resolve, 50));
    cancel.abort();
    // Asked for at once, while the old daemon ignores being told to go.
    const next = await host.start();
    rmSync(stubborn, { force: true });
    assert.equal(alive(pid), false, 'the old daemon was gone before the new one started');
    assert.equal(existsSync(join(homeDir, 'overlap')), false, 'no daemon ever started while another was alive');
    assert.equal(next, instance + 1);
    assert.notEqual(daemonPid(), pid);
    assert.equal(await cancelled, COMPUTER_USE_CANCELLED_MESSAGE);

    // The proxy dies by itself: the daemon is taken down with it, the call in
    // flight fails once both are gone, and stop() has nothing left to wait for.
    pid = daemonPid();
    const orphaned = host.call('slow', {}, { instance: next }).then(() => 'answered', (error: Error) => error.message);
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.kill(proxyPid(), 'SIGKILL');
    assert.match(await orphaned, /stopped unexpectedly/);
    assert.equal(alive(pid), false, 'the daemon did not outlive its proxy');
    assert.equal(host.isRunning(), false);
    await host.stop();
    await noneLeft();
  } finally {
    host.stopSync();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The `--version` probe runs the binary too, and gives it the same built environment. */
function testVersionProbeEnvironment() {
  if (process.platform === 'win32') return;
  const dir = mkdtempSync(join(tmpdir(), 'aegis-cu-version-'));
  try {
    const binary = join(dir, 'cua-driver');
    writeFileSync(binary, STAND_IN);
    chmodSync(binary, 0o755);
    writeFileSync(join(dir, 'version.txt'), CUA_DRIVER_VERSION);
    const version = readCuaDriverVersion(binary, {
      ...process.env,
      CUA_DRIVER_RS_MCP_HTTP_PORT: '8123',
      CUA_DRIVER_ALLOW_BRIEF_FOREGROUND: '1',
      CUA_DRIVER_RS_TELEMETRY_ENABLED: 'true',
      AEGIS_SESSION_MCP_TOKEN: 'secret',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    });
    assert.equal(version, CUA_DRIVER_VERSION);
    const seen = JSON.parse(readFileSync(join(dir, 'version.env.json'), 'utf8')) as Record<string, string>;
    for (const name of ['CUA_DRIVER_RS_MCP_HTTP_PORT', 'CUA_DRIVER_ALLOW_BRIEF_FOREGROUND', 'AEGIS_SESSION_MCP_TOKEN', 'HTTPS_PROXY']) {
      assert.equal(seen[name], undefined, `${name} does not reach the version probe`);
    }
    assert.equal(seen.CUA_DRIVER_RS_TELEMETRY_ENABLED, 'false');
    assert.equal(seen.CUA_DRIVER_RS_UPDATE_CHECK, 'false');
    assert.equal(seen.PATH, process.env.PATH);
    // And it is what decides "ready".
    const status = resolveCuaDriver({ env: { AEGIS_CUA_DRIVER_PATH: binary }, configuredPath: '', platform: 'darwin' });
    assert.equal(status.state, 'ready');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testBubbleTools() {
  const tools = createBubbleComputerUseTools('s1') as Array<{
    name: string; readOnly: boolean; requiresApproval: boolean; description: string;
  }>;
  assert.deepEqual(tools.map((tool) => tool.name), COMPUTER_USE_GATEWAY_TOOLS.map((tool) => `mcp__aegis-computer-use__${tool}`));
  assert.deepEqual(tools.filter((tool) => tool.readOnly).map((tool) => tool.name), [
    'mcp__aegis-computer-use__list_apps',
    'mcp__aegis-computer-use__get_app_state',
  ], 'Bubble refuses the seven action tools in Plan mode by itself');
  assert.ok(tools.every((tool) => tool.requiresApproval === !tool.readOnly));
  // The list is what the gateway can do: no tool is offered that only ever answers "not supported".
  assert.equal(COMPUTER_USE_TOOL_DEFINITIONS.length, COMPUTER_USE_GATEWAY_TOOLS.length);
  assert.ok(!tools.some((tool) => tool.name.endsWith('select_text')));

  assert.equal(computerUseToolName('click'), 'mcp__aegis-computer-use__click');
  assert.equal(computerUseGatewayTool('mcp__aegis-computer-use__click'), 'click');
  assert.equal(computerUseGatewayTool('mcp__computer-use__click'), null, "Codex's own server is not the gateway");
  assert.equal(computerUseGatewayTool('mcp__aegis-computer-use__kill_app'), null);
  assert.equal(computerUseGatewayTool('mcp__aegis-computer-use__select_text'), null);
  assert.equal(computerUseGatewayTool('click'), null);

  // Bubble's own approval layer is answered only for gateway tools the turn
  // was really given. The name alone is not enough: with the switch off, the
  // same name is an MCP server's tool that the gateway never sees.
  const click = { type: 'external_tool', title: 'mcp__aegis-computer-use__click' };
  const registered = bubbleComputerUseToolNames([{ name: 'read_session' }, ...tools]);
  assert.equal(registered.size, tools.length);
  assert.equal(isBubbleComputerUseApproval(click, registered), true);
  assert.equal(isBubbleComputerUseApproval({ type: 'external_tool', title: 'mcp__aegis-browser__browser_use' }, registered), false);
  assert.equal(isBubbleComputerUseApproval({ type: 'bash', title: 'mcp__aegis-computer-use__click' }, registered), false);
  assert.equal(isBubbleComputerUseApproval(click, bubbleComputerUseToolNames([{ name: 'read_session' }])), false,
    'a turn without the tools: the same name gets Bubble’s ordinary approval');
  // An object that only carries the name is not one of the gateway's tools.
  const lookalike = { name: 'mcp__aegis-computer-use__click', execute: async () => ({ content: '' }) };
  assert.equal(isBubbleComputerUseApproval(click, bubbleComputerUseToolNames([lookalike])), false);
}

async function main() {
  testSettings();
  await testSwitchAndSession();
  await testObserveAndDeniedTargets();
  await testMissingMacPermission();
  await testPlanMode();
  await testApprovalAndGrants();
  await testOpeningAnApp();
  await testFullAccessAndLease();
  await testLeaseSurvivesADeclinedAction();
  await testSwitchOffEndsWhatWaits();
  await testStopEndsWhatIsOnItsWay();
  await testWindowThatGoesAway();
  await testALookThatFailsForgetsTheLastOne();
  await testNothingNewReachesTheOldDriver();
  await testLeaseHandedBackAfterTheActionEnded();
  await testRecheckedAfterThePermissionProbe();
  await testRecheckedWhenSent();
  await testGrantsAreExact();
  await testActionMapping();
  testKeysAndActions();
  testDriverSetup();
  await testDriverHostProcesses();
  testVersionProbeEnvironment();
  testBubbleTools();
  console.log('computer use gateway tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
