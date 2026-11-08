import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HelperMessageParser, type HelperVideoFrame } from '../../src/electron/libs/ios-simulator/helper';
import { cleanStderr, parseSimctlDevices } from '../../src/electron/libs/ios-simulator/toolchain';
import {
  attachViewer,
  bootDevice,
  detachViewer,
  findElement,
  iosSimulatorRecordForTests,
  freeDevice,
  markStreamLost,
  sessionDevice,
  shutdownDevice,
  releaseSessionDevices,
  resetIosSimulatorServiceForTests,
  runAgentAction,
  sendPaneInput,
  sendPaneTouch,
  setIosSimulatorTestDoubles,
} from '../../src/electron/libs/ios-simulator/service';
import { IOS_SIMULATOR_ARG_KEYS, compactUiTree, iosSimulatorInputSchema, runIosSimulatorTool } from '../../src/electron/libs/ios-simulator/tool';
import {
  AMBIGUOUS_CALLER,
  findIosSimulatorCallerSessionId,
  initializeBrowserUseConsent,
  type BrowserUseConsentHost,
} from '../../src/electron/libs/browser-use-consent';
import { z } from 'zod';
import { concentric, cornerRadiusFromInset, layoutChrome } from '../../src/electron/libs/ios-simulator/chrome';
import { isIosProject } from '../../src/electron/libs/ios-simulator/project';
import {
  appFromBuildSettings,
  buildErrors,
  chooseContainer,
  chooseScheme,
  findXcodeContainers,
} from '../../src/electron/libs/ios-simulator/build';
import {
  compareVersions,
  h264CodecString,
  iosSimulatorTabId,
  iosSimulatorTabUdid,
  edgeNear,
  IOS_SCREEN_EDGES,
  orientationDegrees,
  physicalEdge,
  shownToPhysical,
} from '../../src/shared/ios-simulator';
import {
  SIMULATOR_PICK_TAB,
  getRightUtilityTabKind,
  replaceLauncherTab,
  resolveRightUtilityTabOpen,
} from '../../src/ui/utils/right-utility-tabs';

function message(kind: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head[0] = kind;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function videoPayload(udid: string, keyFrame: boolean, width: number, height: number, data: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt16BE(width, 0);
  size.writeUInt16BE(height, 2);
  return Buffer.concat([Buffer.from([udid.length]), Buffer.from(udid), Buffer.from([keyFrame ? 1 : 0]), size, data]);
}

/** A helper and simctl that record what the service sends them. */
function fakeSimulator(options: { state?: string; streamDelayMs?: number; gateClose?: boolean; others?: Array<{ udid: string; state: string }> } = {}) {
  const log: string[] = [];
  const device = { udid: 'U1', name: 'iPhone 17 Pro', runtime: 'iOS 26.1', state: options.state ?? 'Booted', family: 'iPhone' as const };
  const gates: Array<() => void> = [];
  const helper = {
    running: true,
    async request<T>(command: Record<string, unknown>): Promise<T> {
      log.push(String(command.cmd));
      if (command.cmd === 'stream' && options.streamDelayMs) await new Promise((resolve) => setTimeout(resolve, options.streamDelayMs));
      if (command.cmd === 'text') await new Promise<void>((resolve) => gates.push(resolve));
      if (command.cmd === 'close' && options.gateClose) await new Promise<void>((resolve) => (closeGate = resolve));
      const screen = { pointWidth: 402, pointHeight: 874, hidWidth: 402, hidHeight: 874, uiOrientation: 1, screenID: 1 };
      return (command.cmd === 'stream' || command.cmd === 'screen' ? screen : true) as T;
    },
    send(command: Record<string, unknown>) {
      log.push(`${command.cmd}:${command.phase ?? ''}${command.edge ? `:edge${command.edge}` : ''}`);
    },
    stop() {},
  };
  let bootGate: (() => void) | null = null;
  let closeGate: (() => void) | null = null;
  const run = async (_file: string, args: string[]) => {
    log.push(`simctl ${args[1]}`);
    if (args[1] === 'boot') {
      await new Promise<void>((resolve) => (bootGate = resolve));
      device.state = 'Booted';
    }
    if (args[1] === 'shutdown') device.state = 'Shutdown';
    return { stdout: '', stderr: '' };
  };
  const others = (options.others ?? []).map((other) => ({ ...device, ...other }));
  setIosSimulatorTestDoubles({ helper, run, listDevices: async () => [{ ...device }, ...others.map((other) => ({ ...other }))] });
  return {
    log,
    device,
    releaseText: () => gates.shift()?.(),
    finishBoot: () => bootGate?.(),
    finishClose: () => closeGate?.(),
  };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // Helper messages: JSON and video survive any chunking.
  {
    const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac]);
    const stream = Buffer.concat([
      message(1, Buffer.from(JSON.stringify({ event: 'ready', version: 1 }))),
      message(2, videoPayload('65D8EC4E', true, 734, 1600, sps)),
      message(1, Buffer.from(JSON.stringify({ id: 3, ok: true, result: { pointWidth: 402 } }))),
      message(2, videoPayload('65D8EC4E', false, 734, 1600, Buffer.from([0, 0, 0, 1, 0x41, 9]))),
    ]);
    for (const size of [1, 5, 13, stream.length]) {
      const json: Array<Record<string, unknown>> = [];
      const video: HelperVideoFrame[] = [];
      const parser = new HelperMessageParser((value) => json.push(value), (frame) => video.push(frame));
      for (let offset = 0; offset < stream.length; offset += size) parser.push(stream.subarray(offset, offset + size));
      assert.deepEqual(json.map((value) => value.event ?? value.id), ['ready', 3], `json at chunk size ${size}`);
      assert.equal(video.length, 2, `video at chunk size ${size}`);
      assert.deepEqual(
        { udid: video[0].udid, keyFrame: video[0].keyFrame, width: video[0].width, height: video[0].height },
        { udid: '65D8EC4E', keyFrame: true, width: 734, height: 1600 }
      );
      assert.deepEqual(video[0].data, sps);
      assert.equal(video[1].keyFrame, false);
    }
    // The codec string comes from the SPS: High profile, level 4.0.
    assert.equal(h264CodecString(sps), 'avc1.640028');
    assert.equal(h264CodecString(Buffer.from([0, 0, 1, 0x68, 0xee, 0x3c, 0x80, 0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f])), 'avc1.42e01f');
    assert.equal(h264CodecString(Buffer.from([0, 0, 0, 1, 0x41, 9, 9, 9])), null, 'a delta frame carries no SPS');
  }

  // Rotation: HID and the framebuffer stay physical portrait. Measured on an
  // iPhone 17 Pro (402x874 pt) in Safari, landscape-right: the UI point
  // (523, 249) of a 874x402 UI is the physical point (153, 523).
  {
    const physical = shownToPhysical('landscape-right', 523 / 874, 249 / 402);
    assert.deepEqual([Math.round(physical.x * 402), Math.round(physical.y * 874)], [153, 523]);
    for (const orientation of ['portrait', 'landscape-left', 'landscape-right', 'portrait-upside-down'] as const) {
      // Corners land on corners, and the picture turns the opposite way to the map.
      const corner = shownToPhysical(orientation, 0, 0);
      assert.ok([0, 1].includes(corner.x) && [0, 1].includes(corner.y), orientation);
    }
    assert.deepEqual(shownToPhysical('portrait', 0.25, 0.75), { x: 0.25, y: 0.75 });
    assert.deepEqual(shownToPhysical('portrait-upside-down', 0.25, 0.75), { x: 0.75, y: 0.25 });
    assert.deepEqual(shownToPhysical('landscape-left', 0.25, 0.75), { x: 0.75, y: 0.75 });
    assert.equal(orientationDegrees('landscape-right'), -90);
    assert.equal(orientationDegrees('landscape-left'), 90);
  }

  // Edge gestures name the physical edge. Measured on Xcode 27: a swipe up
  // from the bottom sends an upright app home with edge 3, a landscape-right
  // one with edge 2 (its UI bottom is the physical left), not with 3.
  {
    assert.equal(physicalEdge('portrait', 'bottom'), IOS_SCREEN_EDGES.bottom);
    assert.equal(physicalEdge('landscape-right', 'bottom'), IOS_SCREEN_EDGES.left);
    assert.equal(physicalEdge('landscape-left', 'bottom'), IOS_SCREEN_EDGES.right);
    assert.equal(physicalEdge('portrait-upside-down', 'bottom'), IOS_SCREEN_EDGES.top);
    assert.equal(physicalEdge('landscape-right', 'top'), IOS_SCREEN_EDGES.right);
    assert.equal(physicalEdge('portrait', 'left'), IOS_SCREEN_EDGES.left);
    // The home indicator of a 402x874 screen, on it and just below it.
    assert.equal(edgeNear('portrait', 201, 866, 402, 874, 20), IOS_SCREEN_EDGES.bottom);
    assert.equal(edgeNear('portrait', 201, 880, 402, 874, 20), IOS_SCREEN_EDGES.bottom);
    assert.equal(edgeNear('landscape-right', 437, 396, 874, 402, 20), IOS_SCREEN_EDGES.left);
    assert.equal(edgeNear('portrait', 201, 437, 402, 874, 20), undefined, 'the middle is no edge');
  }

  // Device outlines from Xcode's DeviceKit chrome.json (values as Xcode 27
  // ships them).
  {
    const pro = layoutChrome(
      {
        images: { composite: 'PhoneComposite', sizing: { leftWidth: 18, rightWidth: 18, topHeight: 18, bottomHeight: 18 }, devicePadding: { top: 0, left: 9, bottom: 0, right: 9 } },
        paths: { simpleOutsideBorder: { cornerRadiusX: 80 } },
        inputs: [
          { name: 'action', type: 'button', image: 'Mute BTN', anchor: 'left', align: 'leading', offsets: { normal: { x: 8, y: 160 }, rollover: { x: 3, y: 160 } } },
          { name: 'power', accessibilityTitle: 'Sleep/Wake', type: 'button', usagePage: 12, usage: 48, image: 'X_Power BTN', anchor: 'right', align: 'leading', offsets: { normal: { x: -8, y: 262 }, rollover: { x: -3, y: 262 } } },
        ],
      },
      { width: 436, height: 908 },
      { width: 402, height: 874 },
      new Map([['Mute BTN', { width: 16, height: 34 }], ['X_Power BTN', { width: 16, height: 101 }]]),
      null
    );
    assert.deepEqual(pro.body, { width: 436, height: 908, radius: 80 });
    assert.deepEqual(pro.screen, { x: 17, y: 17, width: 402, height: 874 });
    assert.deepEqual(
      pro.buttons.map((button) => [button.name, button.side, button.offset, button.length, button.protrudeHover, button.hid]),
      [['action', 'left', 160, 34, 6, null], ['power', 'right', 262, 101, 6, { page: 12, usage: 48 }]]
    );
    assert.equal(pro.buttons[1].title, 'Sleep/Wake');
    // The body's corners follow the screen mask's: iPhone 17 Pro's mask
    // turns opaque 55 px in on the diagonal (1206 px wide, 402 pt), a 62.6 pt
    // corner, and with the 17 pt bezel that is Xcode's own 80 pt body radius.
    assert.equal(Math.round(cornerRadiusFromInset(55, 1206, 402) * 10) / 10, 62.6);
    assert.equal(concentric(pro, { width: 1206, topLeft: 55, topRight: 55, bottomRight: 55, bottomLeft: 55 }).body.radius, 79.6);
    assert.equal(concentric(pro, { width: 1206, topLeft: 55, topRight: 55, bottomRight: 55, bottomLeft: 55 }).body.radii, undefined);
    // A foldable's outer screen is square on the hinge side: each corner
    // keeps its own radius.
    const folded = concentric(pro, { width: 1206, topLeft: 6, topRight: 55, bottomRight: 55, bottomLeft: 6 });
    assert.deepEqual(folded.body.radii, { topLeft: 23.8, topRight: 79.6, bottomRight: 79.6, bottomLeft: 23.8 });

    // An older iPhone: the screen sits between a forehead and a chin, and the
    // Home button is on the front, centered, 90 pt up from the bottom.
    const se = layoutChrome(
      {
        images: { sizing: { leftWidth: 28, rightWidth: 28, topHeight: 111, bottomHeight: 111 }, devicePadding: { top: 0, left: 9, bottom: 0, right: 9 } },
        inputs: [{ name: 'home', type: 'button', usagePage: 12, usage: 64, image: 'Home BTN', anchor: 'bottom', align: 'center', offsets: { normal: { x: 0, y: -90 } } }],
      },
      { width: 431, height: 889 },
      { width: 375, height: 667 },
      new Map([['Home BTN', { width: 67, height: 67 }]]),
      null
    );
    assert.deepEqual(se.screen, { x: 28, y: 111, width: 375, height: 667 });
    assert.deepEqual(se.buttons[0].rect, { x: 182, y: 799, width: 67, height: 67 });
    assert.deepEqual(se.buttons[0].hid, { page: 12, usage: 64 });
    // An iPad: the power button on the top edge counts back from the right.
    const ipad = layoutChrome(
      {
        images: { sizing: { leftWidth: 46, rightWidth: 46, topHeight: 46, bottomHeight: 46 }, devicePadding: { top: 9, left: 0, bottom: 0, right: 10 } },
        inputs: [{ name: 'power', type: 'button', image: 'iPadPowerBTN', anchor: 'top', align: 'trailing', offsets: { normal: { x: -74, y: 8 }, rollover: { x: -74, y: 2 } } }],
      },
      { width: 912, height: 1272 },
      { width: 820, height: 1180 },
      new Map([['iPadPowerBTN', { width: 89, height: 16 }]]),
      null
    );
    assert.deepEqual(
      [ipad.buttons[0].side, ipad.buttons[0].offset, ipad.buttons[0].length, ipad.buttons[0].protrudeHover],
      ['top', 912 + 10 - 74 - 89, 89, 7]
    );
  }

  // simctl: iOS only, available only, booted and newest first.
  {
    const json = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [
          { udid: 'B', name: 'iPad Air 11-inch (M3)', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M3' },
          { udid: 'A', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' },
          { udid: 'X', name: 'iPhone Gone', state: 'Shutdown', isAvailable: false },
        ],
        'com.apple.CoreSimulator.SimRuntime.iOS-18-4': [
          { udid: 'C', name: 'iPhone 16', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16' },
        ],
        'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'W', name: 'Apple Watch', state: 'Shutdown', isAvailable: true }],
      },
    });
    const devices = parseSimctlDevices(json);
    assert.deepEqual(devices.map((device) => device.udid), ['C', 'A', 'B']);
    assert.equal(devices[0].runtime, 'iOS 18.4');
    assert.equal(devices[1].family, 'iPhone');
    assert.equal(devices[2].family, 'iPad');
  }

  assert.equal(
    cleanStderr('2026-11-05 axe[1:2] Malformed bundle does not contain an identifier at /x\nInvalid device: X'),
    'Invalid device: X'
  );
  assert.ok(compareVersions('1.6.0', '1.8.0') < 0);
  assert.ok(compareVersions('1.10.0', '1.8.0') > 0);
  assert.equal(compareVersions('1.8', '1.8.0'), 0);

  // The UI tree: labelled elements kept, empty groups flattened.
  {
    const tree = [
      {
        role: 'AXApplication',
        AXLabel: 'Demo',
        frame: { x: 0, y: 0, width: 402, height: 874 },
        children: [
          {
            type: 'Group',
            frame: { x: 0, y: 0, width: 402, height: 874 },
            children: [
              { type: 'Button', AXLabel: 'Sign in', AXUniqueId: 'signIn', frame: { x: 20, y: 700, width: 362, height: 50 } },
              { type: 'TextField', AXLabel: 'Email', AXValue: 'a@b.c', enabled: false, frame: { x: 20, y: 600.4, width: 362, height: 44 } },
            ],
          },
        ],
      },
    ];
    assert.equal(
      compactUiTree(tree),
      [
        'Application "Demo" [0,0 402x874]',
        '  Button "Sign in" id=signIn [20,700 362x50]',
        '  TextField "Email" value="a@b.c" disabled [20,600 362x44]',
      ].join('\n')
    );
    // Tapping by label prefers the control over its text.
    const rows = [
      {
        type: 'Application',
        children: [
          { type: 'StaticText', AXLabel: 'General', frame: { x: 29, y: 305, width: 101, height: 29 } },
          { type: 'Button', AXLabel: 'General', frame: { x: 16, y: 293, width: 370, height: 52 } },
          { type: 'Button', AXLabel: 'Hidden', frame: { x: 0, y: 0, width: 0, height: 0 } },
        ],
      },
    ];
    assert.equal(findElement(rows, { label: 'General' })?.type, 'Button');
    assert.equal(findElement(rows, { label: 'Hidden' }), null, 'zero-size elements cannot be tapped');
    assert.equal(findElement(tree, { id: 'signIn' })?.AXLabel, 'Sign in');
  }

  // Tabs: one per device, the pick pane swaps in place.
  {
    const tab = iosSimulatorTabId('65D8EC4E');
    assert.equal(tab, 'simulator:65D8EC4E');
    assert.equal(iosSimulatorTabUdid(tab), '65D8EC4E');
    assert.equal(iosSimulatorTabUdid(SIMULATOR_PICK_TAB), null);
    assert.equal(iosSimulatorTabUdid('browser:x'), null);
    assert.equal(getRightUtilityTabKind(tab), 'simulator');
    assert.equal(getRightUtilityTabKind(SIMULATOR_PICK_TAB), 'simulator');
    const before = ['files:a', SIMULATOR_PICK_TAB, 'terminal'] as const;
    const opened = resolveRightUtilityTabOpen([...before], tab);
    assert.deepEqual(
      replaceLauncherTab([...before], opened.tabs, opened.activeTab, SIMULATOR_PICK_TAB),
      ['files:a', tab, 'terminal'],
      'the device takes the pick pane’s place'
    );
  }

  // iOS project detection.
  {
    const root = await mkdtemp(join(tmpdir(), 'aegis-ios-project-'));
    try {
      const plain = join(root, 'plain');
      await mkdir(join(plain, 'src'), { recursive: true });
      assert.equal(await isIosProject(plain), false);
      const nested = join(root, 'nested');
      await mkdir(join(nested, 'apps', 'ios', 'Demo.xcodeproj'), { recursive: true });
      assert.equal(await isIosProject(nested), true, 'an Xcode project two levels down');
      const ignored = join(root, 'ignored');
      await mkdir(join(ignored, 'node_modules', 'pkg', 'Demo.xcodeproj'), { recursive: true });
      assert.equal(await isIosProject(ignored), false, 'node_modules is not scanned');
      const pkg = join(root, 'pkg');
      await mkdir(pkg, { recursive: true });
      await writeFile(join(pkg, 'Package.swift'), 'platforms: [.iOS(.v17)]');
      assert.equal(await isIosProject(pkg), true, 'a Swift package for iOS');
      const macPkg = join(root, 'mac');
      await mkdir(macPkg, { recursive: true });
      await writeFile(join(macPkg, 'Package.swift'), 'platforms: [.macOS(.v14)]');
      assert.equal(await isIosProject(macPkg), false, 'a macOS-only package');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // Unscoped ios_simulator calls are told apart by all their arguments, and
  // two chats with the same call in flight are not guessed between.
  {
    assert.deepEqual([...IOS_SIMULATOR_ARG_KEYS].sort(), Object.keys(iosSimulatorInputSchema(z)).sort(), 'every schema argument is matched');
    const call = (id: string, input: Record<string, unknown>) =>
      [{ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__aegis-browser__ios_simulator', input }] } }] as never;
    const histories: Record<string, unknown[]> = {
      a: call('ta', { action: 'boot', device: 'iPhone 17 Pro' }),
      b: call('tb', { action: 'boot', device: 'iPad Air' }),
      c: call('tc', { action: 'screenshot' }),
      d: call('td', { action: 'screenshot' }),
    };
    initializeBrowserUseConsent({
      getSessionHistory: (id: string) => histories[id] as never,
      listRunningSessionIds: () => Object.keys(histories),
      isSessionFullAccess: () => false,
      requestPermission: async () => false,
    } as unknown as BrowserUseConsentHost);
    const find = (args: Record<string, unknown>) => findIosSimulatorCallerSessionId(args, IOS_SIMULATOR_ARG_KEYS, 'ios_simulator');
    assert.equal(await find({ action: 'boot', device: 'iPad Air' }), 'b', 'the boot for the other device is not taken');
    assert.equal(await find({ action: 'boot', device: 'iPhone 17 Pro' }), 'a');
    assert.equal(await find({ action: 'screenshot' }), AMBIGUOUS_CALLER, 'two identical pending screenshots are not guessed');
    // Matched by contents only: a device action must name its device, so
    // even a swapped match cannot act on another chat's simulator.
    const unverified = await runIosSimulatorTool('a', { action: 'tap', x: 10, y: 10 }, { inlineImage: false, verifiedCaller: false });
    assert.equal(unverified.isError, true);
    assert.match(unverified.content[0].type === 'text' ? unverified.content[0].text : '', /Pass device/);
    const unverifiedBoot = await runIosSimulatorTool('a', { action: 'boot' }, { inlineImage: false, verifiedCaller: false });
    assert.match(unverifiedBoot.content[0].type === 'text' ? unverifiedBoot.content[0].text : '', /Pass device/, 'boot too names its device');
    const unverifiedBuild = await runIosSimulatorTool('a', { action: 'build_and_run', device: 'U1', project: 'App.xcodeproj' }, { inlineImage: false, verifiedCaller: false });
    assert.match(unverifiedBuild.content[0].type === 'text' ? unverifiedBuild.content[0].text : '', /absolute path/, 'build_and_run names its project by absolute path');
    initializeBrowserUseConsent(null as never);
  }

  // build_and_run: which project and scheme, which app, and what to report.
  {
    const root = await mkdtemp(join(tmpdir(), 'aegis-ios-build-'));
    try {
      const app = join(root, 'App');
      await mkdir(join(app, 'Demo.xcodeproj'), { recursive: true });
      await mkdir(join(app, 'Demo.xcworkspace'), { recursive: true });
      await mkdir(join(app, 'Pods', 'Pods.xcodeproj'), { recursive: true });
      const found = await findXcodeContainers(root);
      assert.deepEqual(found.map((item) => item.path.slice(root.length)), ['/App/Demo.xcworkspace'], 'the CocoaPods workspace stands in for its project; Pods is skipped');
      assert.equal((await chooseContainer(root)).kind, 'workspace');
      await mkdir(join(root, 'Other', 'Other.xcodeproj'), { recursive: true });
      await assert.rejects(chooseContainer(root), /Several Xcode projects[\s\S]*Other/);
      assert.equal((await chooseContainer(root, 'Other/Other.xcodeproj')).kind, 'project');
      await assert.rejects(chooseContainer(join(root, 'Other')).then(() => chooseContainer(root, 'Other')), /not an .xcodeproj/);
      const empty = join(root, 'empty');
      await mkdir(empty);
      await assert.rejects(chooseContainer(empty), /No Xcode project/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    const demo = { path: '/x/Demo.xcodeproj', kind: 'project' as const };
    assert.equal(chooseScheme(['Demo'], demo), 'Demo');
    assert.equal(chooseScheme(['DemoTests', 'Demo', 'Widget'], demo), 'Demo', 'the scheme named after the project');
    assert.throws(() => chooseScheme(['A', 'B'], demo), /Several schemes/);
    assert.throws(() => chooseScheme(['A'], demo, 'Z'), /No scheme "Z"/);
    assert.deepEqual(
      appFromBuildSettings([
        { target: 'Kit', buildSettings: { WRAPPER_EXTENSION: 'framework', TARGET_BUILD_DIR: '/b', FULL_PRODUCT_NAME: 'Kit.framework' } },
        { target: 'Demo', buildSettings: { WRAPPER_EXTENSION: 'app', TARGET_BUILD_DIR: '/b/Debug-iphonesimulator', FULL_PRODUCT_NAME: 'Demo.app', PRODUCT_BUNDLE_IDENTIFIER: 'com.x.demo' } },
      ]),
      { appPath: '/b/Debug-iphonesimulator/Demo.app', bundleId: 'com.x.demo' }
    );
    assert.equal(appFromBuildSettings([{ buildSettings: { WRAPPER_EXTENSION: 'framework' } }]), null);
    const log = [
      'CompileSwift normal arm64 /p/ContentView.swift',
      'error: the following command failed with exit code 1 but produced no further output',
      '/p/ContentView.swift:12:9: error: cannot find \'Foo\' in scope',
      '/p/ContentView.swift:12:9: error: cannot find \'Foo\' in scope',
      '/p/Model.swift:3:1: warning: unused variable',
      ...Array.from({ length: 3000 }, (_, i) => `noise ${i}`),
      'The following build commands failed:',
      '\tCompileSwift normal arm64 /p/ContentView.swift (in target \'Demo\' from project \'Demo\')',
      '(1 failure)',
    ].join('\n');
    const errors = buildErrors(log);
    assert.match(errors, /ContentView.swift:12:9: error: cannot find 'Foo'/);
    assert.equal(errors.match(/cannot find 'Foo'/g)?.length, 1, 'repeated errors once');
    assert.ok(!/warning|noise|no further output/.test(errors), 'no warnings or log noise');
    assert.match(errors, /following build commands failed[\s\S]*in target 'Demo'/);
  }

  // Service races (fake helper and simctl).
  // Text typed before a click lands before the click, even with the queue busy.
  {
    const sim = fakeSimulator();
    await attachViewer('U1', 'chat');
    const typing = sendPaneInput('U1', { kind: 'type', text: 'hi' });
    await tick();
    sendPaneTouch({ udid: 'U1', phase: 'down', x: 0.5, y: 0.5 });
    sendPaneTouch({ udid: 'U1', phase: 'up', x: 0.5, y: 0.5 });
    assert.ok(!sim.log.some((entry) => entry.startsWith('dtouch:down')), 'the press waits for the typing');
    sim.releaseText();
    await typing;
    await tick();
    const order = sim.log.filter((entry) => entry === 'text' || entry.startsWith('dtouch'));
    assert.deepEqual(order, ['text', 'dtouch:down', 'dtouch:up'], 'typing, then the click');
    resetIosSimulatorServiceForTests();
  }

  // Each waiting click keeps its own place: text A, click field B, text B,
  // click field C lands B's text in B, not in C.
  {
    const sim = fakeSimulator();
    await attachViewer('U1', 'chat');
    const click = (x: number) => {
      sendPaneTouch({ udid: 'U1', phase: 'down', x, y: 0.5 });
      sendPaneTouch({ udid: 'U1', phase: 'up', x, y: 0.5 });
    };
    const textA = sendPaneInput('U1', { kind: 'type', text: 'A' });
    await tick();
    click(0.2);
    const textB = sendPaneInput('U1', { kind: 'type', text: 'B' });
    click(0.8);
    sim.releaseText();
    await textA;
    await tick();
    sim.releaseText();
    await textB;
    await tick();
    const order = sim.log.filter((entry) => entry === 'text' || entry.startsWith('dtouch'));
    assert.deepEqual(order, ['text', 'dtouch:down', 'dtouch:up', 'text', 'dtouch:down', 'dtouch:up'], 'each click in its own turn');
    resetIosSimulatorServiceForTests();
  }

  // A click still waiting when the pane closes is dropped, not replayed on
  // the screen shown afterwards.
  {
    const sim = fakeSimulator();
    await attachViewer('U1', 'chat');
    const typing = sendPaneInput('U1', { kind: 'type', text: 'A' });
    await tick();
    sendPaneTouch({ udid: 'U1', phase: 'down', x: 0.5, y: 0.5 });
    detachViewer('U1', 'chat');
    sendPaneTouch({ udid: 'U1', phase: 'up', x: 0.5, y: 0.5 });
    // Shown again (or through a restarted helper) before the click's turn:
    // it still must not land on the new screen.
    const reattaching = attachViewer('U1', 'chat');
    sim.releaseText();
    await reattaching;
    await typing;
    await tick();
    assert.ok(!sim.log.some((entry) => entry.startsWith('dtouch:down')), 'the stale press is not replayed (a bare lift is harmless)');
    resetIosSimulatorServiceForTests();
  }

  // A lift goes through after the stream stopped: no finger is left down.
  {
    const sim = fakeSimulator();
    await attachViewer('U1', 'chat');
    sendPaneTouch({ udid: 'U1', phase: 'down', x: 0.5, y: 0.98, edge: 3 });
    detachViewer('U1', 'chat');
    await tick();
    sendPaneTouch({ udid: 'U1', phase: 'up', x: 0.5, y: 0.98 });
    sendPaneTouch({ udid: 'U1', phase: 'down', x: 0.5, y: 0.5 });
    assert.deepEqual(sim.log.filter((entry) => entry.startsWith('dtouch')), ['dtouch:down:edge3', 'dtouch:up'], 'the lift is sent; a press without a pane is not');
    resetIosSimulatorServiceForTests();
  }

  // The last pane closing while the stream starts leaves no stream running.
  {
    const sim = fakeSimulator({ streamDelayMs: 30 });
    const attaching = attachViewer('U1', 'chat');
    await tick(5);
    detachViewer('U1', 'chat');
    await attaching;
    assert.equal(iosSimulatorRecordForTests('U1').streaming, false);
    assert.deepEqual(sim.log.filter((entry) => /stream/.test(entry)), ['stream', 'unstream'], 'the late stream is stopped');
    resetIosSimulatorServiceForTests();
  }

  // An agent action that turns up while a shutdown is under way does not
  // run on the device going away; it is told to boot again.
  {
    const sim = fakeSimulator({ gateClose: true });
    const shuttingDown = shutdownDevice('U1');
    await tick();
    assert.ok(sim.log.includes('close'), 'the shutdown started');
    let ran = false;
    const late = runAgentAction('U1', 'chat', async () => {
      ran = true;
    });
    sim.finishClose();
    await shuttingDown;
    await assert.rejects(late, /shut down/);
    assert.equal(ran, false, 'the action did not run on the dead device');
    resetIosSimulatorServiceForTests();
  }

  // Devices stay up: a chat closing gives its devices up, it does not shut
  // them down, and nothing shuts down a device left idle.
  {
    const sim = fakeSimulator({ state: 'Shutdown' });
    const booting = bootDevice('U1', 'chat');
    await tick();
    sim.finishBoot();
    await booting;
    await releaseSessionDevices('chat');
    await tick(50);
    assert.ok(!sim.log.includes('simctl shutdown'), 'still up');
    assert.equal(iosSimulatorRecordForTests('U1').ownerSessionId, null, 'no longer the chat\'s');
    resetIosSimulatorServiceForTests();
  }

  // A device one chat uses is never another chat's default: a chat that
  // names none gets a free device, or none.
  {
    fakeSimulator({ others: [{ udid: 'U2', state: 'Shutdown' }] });
    await attachViewer('U1', 'a');
    assert.equal(iosSimulatorRecordForTests('U1').ownerSessionId, 'a');
    assert.equal(await sessionDevice('b'), null, 'b does not get a\'s device');
    assert.equal((await freeDevice())?.udid, 'U2', 'b boots the free one');
    await attachViewer('U2', 'c');
    assert.equal(await freeDevice(), null, 'none left: b must name one');
    resetIosSimulatorServiceForTests();
  }

  // Restarted outside Aegis: the pane is told its stream is gone (it offers
  // to reconnect); attaching again streams the new boot.
  {
    const sim = fakeSimulator();
    await attachViewer('U1', 'chat');
    assert.equal(iosSimulatorRecordForTests('U1').streaming, true);
    markStreamLost('U1');
    assert.equal(iosSimulatorRecordForTests('U1').streaming, false, 'the pane sees the stream is gone');
    detachViewer('U1', 'chat');
    await attachViewer('U1', 'chat');
    assert.equal(iosSimulatorRecordForTests('U1').streaming, true, 'streaming again after Reconnect');
    assert.equal(sim.log.filter((entry) => entry === 'stream').length, 2);
    resetIosSimulatorServiceForTests();
  }

  // A shutdown while a boot is still on its way wins: the boot does not
  // start the device again or stream it.
  {
    const sim = fakeSimulator({ state: 'Shutdown' });
    await attachViewer('U1', 'chat').catch(() => {});
    const booting = bootDevice('U1', 'chat');
    await tick();
    await shutdownDevice('U1');
    sim.finishBoot();
    await assert.rejects(booting, /shut down while it was starting/);
    assert.equal(iosSimulatorRecordForTests('U1').streaming, false, 'no stream for the cancelled boot');
    resetIosSimulatorServiceForTests();
  }

  // A stream reply read after the device restarted describes a gone stream:
  // the pane keeps showing Reconnect.
  {
    fakeSimulator({ streamDelayMs: 30 });
    const attaching = attachViewer('U1', 'chat');
    await tick(5);
    markStreamLost('U1');
    await attaching;
    assert.equal(iosSimulatorRecordForTests('U1').streaming, false, 'the late reply does not revive it');
    resetIosSimulatorServiceForTests();
  }

  console.log('ios-simulator tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
