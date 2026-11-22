// Runs the Computer use gateway against the real cua-driver on this Mac.
//
//   npm run verify:computer-use-live
//
// It touches one app, Calculator, and nothing else: opens it in the
// background, presses 6 × 7 = through the accessibility tree, reads 42 back,
// and checks on the way that the approval card is asked for, that a grant
// stops the asking, that Plan mode and a second session are held off, that
// Aegis itself is refused, and that the driver's own policy refuses what the
// gateway never sends. No file is opened, nothing is typed anywhere else, no
// pointer moves, no window comes to the front. Calculator is closed again
// only when this script was what opened it.
//
// macOS decides Accessibility and Screen Recording by the app at the top of
// the process chain that started this script (a terminal, or Aegis). When
// either is missing the script stops before acting and says where to turn
// it on; it never asks macOS for them itself.
//
// Screenshots and a summary land in output/computer-use-live/.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { CuaDriverHost } from '../src/electron/libs/computer-use/driver-host';
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

function driverProcesses(homeDir: string): string[] {
  try {
    return execFileSync('/usr/bin/pgrep', ['-fl', homeDir], { encoding: 'utf8' }).split('\n').filter((line) => line.includes('cua-driver'));
  } catch {
    return [];
  }
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
  const status = resolveCuaDriver();
  if (status.state !== 'ready' || !status.path) {
    console.error(status.message);
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'aegis-cu-live-'));
  const homeDir = path.join(userDataDir, 'computer-use', 'driver');
  const driver = new CuaDriverHost({ resolveBinary: () => status.path!, homeDir, hostBundleId: 'com.aegis.desktop' });
  const summary: Record<string, unknown> = { driver: { version: status.version, path: status.path } };
  const calculatorsBefore = calculatorPids();
  let opened: number[] = [];

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

    // ── The driver's own policy: what the gateway never sends is refused ──
    for (const [tool, args] of [
      ['get_screen_size', {}],
      ['clipboard_read', {}],
      ['kill_app', { pid: 0 }],
    ] as const) {
      const refused = await driver.call(tool, args);
      assert.equal(refused.isError, true, `${tool} must be refused by the policy`);
      assert.match(refused.text, /denied|not allowed|policy/i, `${tool}: ${refused.text}`);
    }
    summary.policy = 'get_screen_size, clipboard_read and kill_app are refused by the driver';

    // ── The gateway, with a host that answers the approval card from a script ──
    const lease = new ComputerUseLease();
    const grants = new ComputerUseGrantRegistry();
    const cards: ComputerUsePermissionInput[] = [];
    const frames: ComputerUseLiveFrame[] = [];
    const facts: Record<string, ComputerUseSessionFacts> = {
      main: { planMode: false, fullAccess: false, readOnlyWorkflowRole: null },
      plan: { planMode: true, fullAccess: false, readOnlyWorkflowRole: null },
      second: { planMode: false, fullAccess: false, readOnlyWorkflowRole: null },
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

    // Plan mode looks, and does not act.
    const planLook = await call('plan', 'get_app_state', { app: CALCULATOR });
    assert.equal(planLook.isError, false, planLook.text);
    assert.equal((await call('plan', 'click', { app: CALCULATOR, element_index: buttonIndex(planLook.text, 'AllClear') })).text, COMPUTER_USE_PLAN_MESSAGE);

    // One session at a time: "main" holds the desktop until its turn ends.
    assert.equal(lease.currentOwner()?.threadId, 'main');
    answer = { allow: true, untilRevoked: false };
    const secondLook = await call('second', 'get_app_state', { app: CALCULATOR });
    const clear = buttonIndex(secondLook.text, 'AllClear');
    const blockedCards = cards.length;
    assert.equal((await call('second', 'click', { app: CALCULATOR, element_index: clear })).text, COMPUTER_USE_LEASE_MESSAGE);
    assert.equal(cards.length, blockedCards, 'no card for a desktop that is taken');
    gateway.finishTurn('main');
    const afterLook = await call('second', 'get_app_state', { app: CALCULATOR });
    const cleared = await call('second', 'click', { app: CALCULATOR, element_index: buttonIndex(afterLook.text, 'AllClear') });
    assert.equal(cleared.isError, false, cleared.text);
    assert.equal(cards.length, blockedCards + 1, "the second session asks for itself: main's grant is not its own");
    assert.match(cleared.text, /AXStaticText = "0"/, 'Calculator is back at 0');
    save('3-cleared', cleared);
    summary.lease = 'second session refused while main held the desktop, allowed after main finished';

    // A session's next turn works like its first (the driver session of the last turn has ended).
    gateway.finishTurn('second');
    const nextTurn = await call('second', 'get_app_state', { app: CALCULATOR });
    assert.equal(nextTurn.isError, false, nextTurn.text);
    assert.match(nextTurn.text, /AXStaticText = "0"/);
    summary.nextTurn = 'the same session read Calculator again in a new turn';

    gateway.finishTurn('second');
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
