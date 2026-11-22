// The Computer use gateway against a scripted driver: what it refuses, what
// it asks, what it sends to cua-driver, and what it leaves for the HUD. No
// driver binary and no desktop are involved (scripts/verify-computer-use-live.ts
// runs the real one).

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computerUseGatewayTool,
  computerUseToolName,
  COMPUTER_USE_TOOLS,
  type ComputerUseLiveFrame,
} from '../../src/shared/computer-use';
import type { ComputerUsePermissionInput } from '../../src/shared/types';
import {
  COMPUTER_USE_DENIED_TARGET_MESSAGE,
  COMPUTER_USE_LEASE_MESSAGE,
  ComputerUseLease,
  resolveComputerUseArtifact,
} from '../../src/electron/libs/codex-computer-use';
import { ComputerUseGrantRegistry } from '../../src/electron/libs/codex-computer-use-grants';
import { CUA_DRIVER_VERSION, resolveCuaDriver } from '../../src/electron/libs/computer-use/driver-binary';
import {
  buildCuaDriverEnv,
  cuaDriverSocketPath,
  type ComputerUseDriver,
  type DriverToolResult,
} from '../../src/electron/libs/computer-use/driver-host';
import { buildCuaDriverPolicy } from '../../src/electron/libs/computer-use/policy';
import {
  COMPUTER_USE_OFF_MESSAGE,
  COMPUTER_USE_PLAN_MESSAGE,
  COMPUTER_USE_SELECT_TEXT_MESSAGE,
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
import { createBubbleComputerUseTools, isBubbleComputerUseApproval } from '../../src/electron/libs/bubble-computer-use-tool';
import { isComputerUseAvailableNow } from '../../src/electron/libs/computer-use';
import {
  getComputerUseSettings,
  isComputerUseEnabled,
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

class ScriptedDriver implements ComputerUseDriver {
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  /** Like the real driver: a session it ended cannot be named again. */
  ended = new Set<string>();
  started = false;
  stopped = 0;
  accessibility = true;
  /** How many window listings of a freshly opened app (pid 600) come back empty first. */
  lateWindow = 0;
  private snapshots = 0;

  async call(tool: string, args: Record<string, unknown>): Promise<DriverToolResult> {
    this.started = true;
    this.calls.push({ tool, args });
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
          ],
        });
      case 'list_windows':
        if (args.pid === 600 && this.lateWindow > 0) {
          this.lateWindow -= 1;
          return ok('windows', { windows: [] });
        }
        return ok('windows', {
          windows: [
            { window_id: 9, pid: args.pid, title: 'menu', layer: 25, is_on_screen: true, z_index: 9, bounds: { width: 10, height: 10 } },
            { window_id: 71, pid: args.pid, title: 'Calculator', layer: 0, is_on_screen: true, z_index: 3, bounds: { width: 230, height: 408 } },
          ],
        });
      case 'launch_app':
        return ok('launched', { pid: 600 });
      case 'get_window_state': {
        this.snapshots += 1;
        const id = `s${String(this.snapshots).padStart(8, '0')}`;
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
  }

  stopSync(): void {
    this.stopped += 1;
    this.started = false;
  }

  of(tool: string) {
    return this.calls.filter((call) => call.tool === tool);
  }
}

function harness(overrides: {
  enabled?: boolean;
  facts?: Record<string, Partial<ComputerUseSessionFacts> | null>;
  answer?: (input: ComputerUsePermissionInput) => ComputerUseApprovalDecision | Promise<ComputerUseApprovalDecision>;
} = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'aegis-cu-test-'));
  const driver = new ScriptedDriver();
  const lease = new ComputerUseLease();
  const grants = new ComputerUseGrantRegistry();
  const cards: ComputerUsePermissionInput[] = [];
  const frames: ComputerUseLiveFrame[] = [];
  const refused: string[] = [];
  let enabled = overrides.enabled ?? true;
  const gateway = new ComputerUseGateway(
    {
      isEnabled: () => enabled,
      driverStatus: () => ({ state: 'ready', path: '/x/cua-driver', version: CUA_DRIVER_VERSION, pinnedVersion: CUA_DRIVER_VERSION, message: null }),
      getSession: (sessionId) => {
        const facts = overrides.facts?.[sessionId];
        if (facts === null) return null;
        return { planMode: false, fullAccess: false, readOnlyWorkflowRole: null, ...(facts || {}) };
      },
      requestApproval: async (_sessionId, input) => {
        cards.push(input);
        return overrides.answer ? overrides.answer(input) : { allow: true, untilRevoked: false };
      },
      emitLive: (_sessionId, frame) => frames.push(frame),
      userDataDir: () => userDataDir,
      ownProcessIds: () => [AEGIS_PID, AEGIS_PID + 1],
      onRefused: (sessionId, tool) => refused.push(`${sessionId}:${tool}`),
    },
    driver,
    { lease, grants }
  );
  let n = 0;
  const call = (sessionId: string, tool: string, args: Record<string, unknown> = {}) =>
    gateway.call({ sessionId, tool, args, toolUseId: `call-${++n}` });
  return {
    gateway, driver, lease, grants, cards, frames, refused, userDataDir, call,
    lastToolUseId: () => `call-${n}`,
    setEnabled: (value: boolean) => { enabled = value; },
    dispose: () => rmSync(userDataDir, { recursive: true, force: true }),
  };
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

  const unknown = await h.call('s1', 'kill_app', { app: 'Calculator' });
  assert.match(unknown.text, /Unknown Computer use tool/);
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.driver.stopped, 1, 'the driver is restarted to see a new grant');
  // Granted since: the next call goes through, and the check is not repeated after that.
  h.driver.accessibility = true;
  assert.equal((await h.call('s1', 'get_app_state', { app: 'Calculator' })).isError, false);
  await h.call('s1', 'list_apps');
  assert.equal(h.driver.of('check_permissions').length, 2);
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
  let answer: ComputerUseApprovalDecision = { allow: false, untilRevoked: false };
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

  answer = { allow: true, untilRevoked: false };
  const once = await h.call('s1', 'click', { app: 'Calculator', element_index: '20' });
  assert.equal(once.isError, false);
  assert.deepEqual(h.driver.of('click')[0].args, { element_token: 's00000001:20', button: 'left', session: 'aegis-s1-1' });
  assert.match(once.text, /^click delivered\n\nApp: Calculator/, 'an action returns the new state');
  assert.equal(once.images.length, 1);
  assert.equal(h.lease.currentOwner()?.threadId, 's1');
  assert.equal(h.cards.length, 2);

  // The next click uses the snapshot the last action returned.
  answer = { allow: true, untilRevoked: true };
  await h.call('s1', 'click', { app: 'Calculator', element_index: 6 });
  assert.equal(h.driver.of('click')[1].args.element_token, 's00000002:6');
  assert.equal(h.cards.length, 3);
  assert.deepEqual(h.grants.list('s1').map((grant) => [grant.tool, grant.app, grant.server]), [
    ['click', 'Calculator', 'aegis-computer-use'],
  ]);

  // Granted: clicks in Calculator no longer ask; another tool still does.
  answer = { allow: false, untilRevoked: false };
  const granted = await h.call('s1', 'click', { app: 'com.apple.calculator', x: 10, y: 20, click_count: 2 });
  assert.equal(granted.isError, false);
  assert.equal(h.cards.length, 3);
  assert.deepEqual(h.driver.of('click')[2].args, { pid: 500, window_id: 71, x: 10, y: 20, button: 'left', count: 2, session: 'aegis-s1-1' });
  const typed = await h.call('s1', 'type_text', { app: 'Calculator', text: '42' });
  assert.equal(typed.isError, true);
  assert.equal(h.cards.length, 4);
  assert.equal(h.cards[3].toolName, 'type_text');
  assert.deepEqual(h.cards[3].paramLines, [{ label: 'text', value: '42' }]);

  // A grant is the session's own, and stopping the session ends it.
  await h.call('s2', 'get_app_state', { app: 'Calculator' });
  h.gateway.finishTurn('s1');
  await h.call('s2', 'click', { app: 'Calculator', element_index: '20' });
  assert.equal(h.cards.length, 5, "another session's grant does not carry over");
  h.gateway.forgetSession('s1', 'stop');
  assert.deepEqual(h.grants.list('s1'), []);
  h.dispose();
}

async function testOpeningAnApp() {
  let answer: ComputerUseApprovalDecision = { allow: false, untilRevoked: false };
  const h = harness({ answer: () => answer });
  const declined = await h.call('s1', 'get_app_state', { app: 'TextEdit' });
  assert.equal(declined.isError, true);
  assert.equal(h.cards[0].question, 'Open 文本编辑?');
  assert.equal(h.cards[0].toolName, 'get_app_state');
  assert.equal(h.driver.of('launch_app').length, 0);

  answer = { allow: true, untilRevoked: false };
  // A cold start puts its window up a moment after the process: the gateway waits for it.
  h.driver.lateWindow = 2;
  const opened = await h.call('s1', 'get_app_state', { app: 'com.apple.TextEdit' });
  assert.equal(opened.isError, false, opened.text);
  assert.equal(h.driver.lateWindow, 0);
  assert.deepEqual(h.driver.of('launch_app')[0].args, { bundle_id: 'com.apple.TextEdit', session: 'aegis-s1-1' });
  assert.equal(h.driver.of('get_window_state')[0].args.pid, 600, 'the window of the process that was started');
  // Reached by the name the bundle has, too, not only the localized one.
  const again = await h.call('s1', 'press_key', { app: 'TextEdit', key: 'Return' });
  assert.match(again.text, /Call get_app_state for "TextEdit" first/);
  const byQuery = await h.call('s1', 'press_key', { app: 'com.apple.TextEdit', key: 'Return' });
  assert.equal(byQuery.isError, false);
  h.dispose();
}

async function testFullAccessAndLease() {
  const h = harness({ facts: { full: { fullAccess: true } } });
  await h.call('full', 'get_app_state', { app: 'Calculator' });
  const run = await h.call('full', 'click', { app: 'Calculator', element_index: '20' });
  assert.equal(run.isError, false);
  assert.equal(h.cards.length, 0, 'Full Access runs actions without the card');
  assert.equal(h.lease.currentOwner()?.threadId, 'full');

  // One session at a time: another may look, not act.
  const look = await h.call('other', 'get_app_state', { app: 'Calculator' });
  assert.equal(look.isError, false);
  const blocked = await h.call('other', 'click', { app: 'Calculator', element_index: '20' });
  assert.equal(blocked.text, COMPUTER_USE_LEASE_MESSAGE);
  assert.equal(h.cards.length, 0, 'the card is not shown for a desktop that is taken');
  assert.equal(h.driver.of('click').length, 1);

  h.gateway.finishTurn('full');
  assert.equal(h.lease.currentOwner(), null);
  // The driver's own session ends behind whatever call is in flight.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.driver.of('end_session').map((call) => call.args), [{ session: 'aegis-full-1' }]);
  await h.call('other', 'get_app_state', { app: 'Calculator' });
  const free = await h.call('other', 'click', { app: 'Calculator', element_index: '20' });
  assert.equal(free.isError, false);
  assert.equal(h.lease.currentOwner()?.threadId, 'other');

  // After the turn the indexes are gone with it: the next turn looks first.
  const stale = await h.call('full', 'click', { app: 'Calculator', element_index: '20' });
  assert.match(stale.text, /Call get_app_state/);
  // And it does so under a driver session of its own: the ended one is not reused.
  h.gateway.finishTurn('other');
  const nextTurn = await h.call('full', 'get_app_state', { app: 'Calculator' });
  assert.equal(nextTurn.isError, false, nextTurn.text);
  assert.equal(h.driver.of('get_window_state').slice(-1)[0].args.session, 'aegis-full-3');
  assert.equal((await h.call('full', 'click', { app: 'Calculator', element_index: '20' })).isError, false);

  // Turning it off: the driver stops after what was queued, and nothing
  // queued (a turn's tidy-up) starts it again.
  h.gateway.finishTurn('other');
  await h.gateway.shutdown('disabled');
  assert.equal(h.driver.stopped, 1);
  assert.equal(h.driver.started, false, 'the driver stays stopped');
  assert.equal(h.lease.currentOwner(), null);
  h.setEnabled(false);
  const sent = h.driver.calls.length;
  h.gateway.finishTurn('full');
  assert.equal((await h.call('other', 'list_apps')).text, COMPUTER_USE_OFF_MESSAGE);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.driver.calls.length, sent, 'off: not one more call reaches the driver');
  assert.equal(h.driver.started, false);
  h.dispose();
}

async function testActionMapping() {
  const h = harness({ facts: { s1: { fullAccess: true } } });
  await h.call('s1', 'get_app_state', { app: 'Calculator' });
  const window = { pid: 500, window_id: 71 };
  const session = { session: 'aegis-s1-1' };
  const last = (tool: string) => h.driver.of(tool).slice(-1)[0]?.args;

  await h.call('s1', 'click', { app: 'Calculator', element_index: '20', click_count: 2 });
  assert.deepEqual(last('double_click'), { element_token: 's00000001:20', ...session });
  await h.call('s1', 'click', { app: 'Calculator', element_index: '20', mouse_button: 'right' });
  assert.equal(last('click')?.button, 'right');
  await h.call('s1', 'perform_secondary_action', { app: 'Calculator', element_index: '6', action: 'AXShowMenu' });
  assert.equal(last('click')?.action, 'show_menu');
  await h.call('s1', 'set_value', { app: 'Calculator', element_index: '6', value: 'x' });
  assert.equal(last('set_value')?.value, 'x');
  await h.call('s1', 'scroll', { app: 'Calculator', element_index: '0', direction: 'Down', pages: 2 });
  assert.deepEqual(
    { direction: last('scroll')?.direction, amount: last('scroll')?.amount, pid: last('scroll')?.pid },
    { direction: 'down', amount: 10, pid: 500 }
  );
  await h.call('s1', 'drag', { app: 'Calculator', from_x: 1, from_y: 2, to_x: 3, to_y: 4 });
  assert.deepEqual(last('drag'), { ...window, from_x: 1, from_y: 2, to_x: 3, to_y: 4, ...session });
  await h.call('s1', 'press_key', { app: 'Calculator', key: 'super+shift+z' });
  assert.deepEqual(last('hotkey'), { ...window, keys: ['cmd', 'shift', 'z'], ...session });
  await h.call('s1', 'press_key', { app: 'Calculator', key: 'KP_8' });
  assert.deepEqual(last('press_key'), { ...window, key: '8', ...session });
  await h.call('s1', 'type_text', { app: 'Calculator', text: '6*7' });
  assert.deepEqual(last('type_text'), { ...window, text: '6*7', ...session });

  // Refused before anything is asked or sent.
  const sent = h.driver.calls.length;
  for (const [tool, args, pattern] of [
    ['click', { app: 'Calculator' }, /element_index, or both x and y/],
    ['click', { app: 'Calculator', element_index: 'abc' }, /not an index/],
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
  const select = await h.call('s1', 'select_text', { app: 'Calculator', element_index: '1', text: '0' });
  assert.equal(select.text, COMPUTER_USE_SELECT_TEXT_MESSAGE);
  assert.equal(h.driver.calls.length, sent);
  assert.equal(h.cards.length, 0);

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
  const env = buildCuaDriverEnv({
    base: { PATH: '/bin', CUA_DRIVER_RS_TELEMETRY_ENABLED: 'true' },
    homeDir: '/tmp/aegis/driver',
    hostBundleId: 'com.aegis.desktop',
    policyFile: '/tmp/aegis/driver/policy.yaml',
  });
  assert.equal(env.CUA_DRIVER_EMBEDDED, '1');
  assert.equal(env.CUA_DRIVER_HOST_BUNDLE_ID, 'com.aegis.desktop');
  assert.equal(env.CUA_DRIVER_RS_HOME, '/tmp/aegis/driver');
  assert.equal(env.CUA_DRIVER_RS_TELEMETRY_ENABLED, 'false', 'telemetry is off whatever the environment says');
  assert.equal(env.CUA_DRIVER_RS_UPDATE_CHECK, 'false');
  assert.equal(env.CUA_DRIVER_POLICY_FILE, '/tmp/aegis/driver/policy.yaml');
  assert.equal(env.PATH, '/bin');

  assert.equal(cuaDriverSocketPath('/tmp/a'), '/tmp/a/driver.sock');
  const long = cuaDriverSocketPath(`/Users/someone/Library/Application Support/${'x'.repeat(90)}`);
  assert.ok(Buffer.byteLength(long) <= 100, 'a socket path macOS accepts');

  const policy = buildCuaDriverPolicy();
  for (const tool of ['kill_app', 'run_script', 'run_steps', 'clipboard_read', 'clipboard_write', 'browser_', 'get_desktop_state', 'bring_to_front', 'set_config', 'install_extension', 'check_for_update', 'start_recording']) {
    assert.ok(!policy.includes(tool), `${tool} is not allowed`);
  }
  assert.match(policy, /- tool: click\n {6}constraints:\n {8}delivery_mode: \{ optional: true, allowed: \[background\] \}\n {8}scope: \{ optional: true, allowed: \[window\] \}/);
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

function testBubbleTools() {
  const tools = createBubbleComputerUseTools('s1') as Array<{
    name: string; readOnly: boolean; requiresApproval: boolean; parameters: { required: string[] };
  }>;
  assert.deepEqual(tools.map((tool) => tool.name), COMPUTER_USE_TOOLS.map((tool) => `mcp__aegis-computer-use__${tool}`));
  assert.deepEqual(tools.filter((tool) => tool.readOnly).map((tool) => tool.name), [
    'mcp__aegis-computer-use__list_apps',
    'mcp__aegis-computer-use__get_app_state',
  ], 'Bubble refuses the eight action tools in Plan mode by itself');
  assert.ok(tools.every((tool) => tool.requiresApproval === !tool.readOnly));
  assert.equal(COMPUTER_USE_TOOL_DEFINITIONS.length, COMPUTER_USE_TOOLS.length);

  assert.equal(computerUseToolName('click'), 'mcp__aegis-computer-use__click');
  assert.equal(computerUseGatewayTool('mcp__aegis-computer-use__click'), 'click');
  assert.equal(computerUseGatewayTool('mcp__computer-use__click'), null, "Codex's own server is not the gateway");
  assert.equal(computerUseGatewayTool('mcp__aegis-computer-use__kill_app'), null);
  assert.equal(computerUseGatewayTool('click'), null);
  // Bubble's own approval layer is answered for gateway tools only.
  assert.equal(isBubbleComputerUseApproval({ type: 'external_tool', title: 'mcp__aegis-computer-use__click' }), true);
  assert.equal(isBubbleComputerUseApproval({ type: 'external_tool', title: 'mcp__aegis-browser__browser_use' }), false);
  assert.equal(isBubbleComputerUseApproval({ type: 'bash', title: 'mcp__aegis-computer-use__click' }), false);
}

function testNeutralGrants() {
  const registry = new ComputerUseGrantRegistry();
  const target = { threadId: 't', providerThreadId: null, generation: 0, server: 'aegis-computer-use', tool: 'click', app: 'Calculator', riskLevel: 'low' };
  assert.equal(registry.matchGrant(target), null);
  assert.ok(registry.createGrant(target));
  assert.ok(registry.matchGrant(target));
  assert.equal(registry.matchGrant({ ...target, riskLevel: 'medium' }), null, 'a grant does not reach past its risk');
  assert.equal(registry.matchGrant({ ...target, app: 'Notes' }), null);
  assert.equal(registry.matchGrant({ ...target, generation: 1 }), null);
  assert.equal(registry.createGrant({ ...target, app: null }), null);
}

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
  } finally {
    if (saved.path === undefined) delete process.env.AEGIS_COMPUTER_USE_SETTINGS_PATH;
    else process.env.AEGIS_COMPUTER_USE_SETTINGS_PATH = saved.path;
    if (saved.on !== undefined) process.env.AEGIS_COMPUTER_USE_ENABLED = saved.on;
    rmSync(dir, { recursive: true, force: true });
  }
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
  await testActionMapping();
  testKeysAndActions();
  testDriverSetup();
  testBubbleTools();
  testNeutralGrants();
  console.log('computer use gateway tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
