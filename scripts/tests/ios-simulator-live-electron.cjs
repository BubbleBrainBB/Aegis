// Live check of the iOS Simulator service and the ios_simulator tool against
// a real simulator (needs Xcode, an iOS runtime and a built aegis-sim-helper;
// not in CI): H.264 frames stream to a viewer, the agent boots, launches
// Settings, reads the UI tree, taps by label and takes a point-sized
// screenshot, the pane's live touches and buttons land, and the stream stops
// when the viewer detaches.
//
//   npm run build:ios-sim-helper && npm run transpile:electron && ./node_modules/.bin/electron scripts/tests/ios-simulator-live-electron.cjs [device name]
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-ios-simulator-live-'));
app.setPath('userData', path.join(temp, 'profile'));
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => {
  console.error('ios simulator live check timed out');
  app.exit(1);
}, 600_000);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

app.whenReady().then(async () => {
  const service = require('../../dist-electron/electron/libs/ios-simulator/service.js');
  const tool = require('../../dist-electron/electron/libs/ios-simulator/tool.js');
  const { getToolchainStatus } = require('../../dist-electron/electron/libs/ios-simulator/toolchain.js');
  const frames = [];
  const states = [];
  const panels = [];
  service.setIosSimulatorHost({
    sendFrame: (frame) => frames.push({ ...frame, at: Date.now() }),
    sendState: (view) => states.push(view),
    openPanel: (sessionId, udid) => panels.push({ sessionId, udid }),
  });
  const consents = [];
  tool.setIosSimulatorConsent(async (sessionId, device) => {
    consents.push({ sessionId, udid: device.udid });
    return true;
  });
  const chat = 'chat-live';
  const call = async (args) => {
    const result = await tool.runIosSimulatorTool(chat, args, { inlineImage: true });
    const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    if (result.isError) throw new Error(`${args.action} failed: ${text}`);
    return { ...result, text };
  };

  try {
    const status = await getToolchainStatus({ fresh: true });
    assert.equal(status.ready, true, `toolchain ready (missing: ${status.missing.join(', ')})`);
    console.log('toolchain', status.helperPath, status.xcodePath);

    const list = await call({ action: 'list_devices' });
    assert.match(list.text, /iOS \d+/);
    const wanted = process.argv.slice(2).find((arg) => !arg.startsWith('-')) || 'iPhone 17 Pro';

    // Boot (a no-op when already booted) opens the pane and asks once.
    let started = Date.now();
    const boot = await call({ action: 'boot', device: wanted });
    const udid = /id=([0-9A-F-]{36})/.exec(boot.text)?.[1];
    assert.ok(udid, `boot names the device id: ${boot.text}`);
    assert.deepEqual(panels.at(-1), { sessionId: chat, udid }, 'boot opens the pane');
    assert.equal(consents.length, 1, 'the user is asked once for the device');
    console.log('boot', Date.now() - started, 'ms');

    // A viewer gets live frames.
    started = Date.now();
    const view = await service.attachViewer(udid, chat);
    assert.equal(view.device.state, 'Booted');
    await until(() => frames.some((frame) => frame.udid === udid), 'a first frame');
    const first = frames.find((frame) => frame.udid === udid);
    console.log('first frame', first.at - started, 'ms,', `${first.width}x${first.height},`, Math.round(first.data.length / 1024), 'KB');
    assert.equal(first.keyFrame, true, 'a viewer starts on a keyframe');
    assert.equal(Buffer.from(first.data.subarray(0, 4)).toString('hex'), '00000001', 'H.264 Annex B');
    assert.ok(first.height > first.width, 'portrait');
    await until(async () => (await service.getView(udid)).pointSize, 'screen size in points');
    const points = (await service.getView(udid)).pointSize;
    console.log('points', points);

    // Agent: launch Settings, read it, tap by label, verify.
    started = Date.now();
    await call({ action: 'launch', bundle_id: 'com.apple.Preferences' });
    console.log('launch', Date.now() - started, 'ms');
    await wait(1500);
    started = Date.now();
    const ui = await call({ action: 'describe_ui' });
    console.log('describe_ui', Date.now() - started, 'ms,', ui.text.split('\n').length, 'lines');
    assert.match(ui.text, /"General"/, 'Settings shows General');
    // Settings animates in after launch; a tap during that is lost, as on
    // a real phone. Tap again if the page has not changed.
    const onGeneral = async () => /"About"/.test((await call({ action: 'describe_ui' })).text);
    let opened = false;
    for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
      started = Date.now();
      await call({ action: 'tap', label: 'General' });
      console.log('tap by label', Date.now() - started, 'ms');
      opened = await until(onGeneral, 'the General page', 6_000).catch(() => false);
    }
    assert.ok(opened, 'tapping General opens it');

    started = Date.now();
    const shot = await call({ action: 'screenshot' });
    console.log('screenshot', Date.now() - started, 'ms');
    const image = shot.content.find((part) => part.type === 'image');
    assert.ok(image, 'inline image');
    const { nativeImage } = require('electron');
    const size = nativeImage.createFromBuffer(Buffer.from(image.data, 'base64')).getSize();
    assert.equal(size.width, Math.round(Math.min(points.width, points.height)), 'one pixel per point');

    // The pane's own input: Back with a live touch (top-left of the General
    // page), then Home with the hardware button.
    started = Date.now();
    const before = frames.length;
    service.sendPaneTouch({ udid, phase: 'down', x: 40 / 402, y: 85 / 874 });
    await wait(60);
    service.sendPaneTouch({ udid, phase: 'up', x: 40 / 402, y: 85 / 874 });
    await until(() => frames.length > before, 'frames after a touch', 3_000);
    console.log('pane touch to new frame', frames[before].at - started, 'ms');
    const backAtRoot = await until(async () => !/"About"/.test((await call({ action: 'describe_ui' })).text), 'back on Settings', 6_000).catch(() => false);
    assert.ok(backAtRoot, 'a pane touch on Back leaves General');
    started = Date.now();
    await service.sendPaneInput(udid, { kind: 'button', button: 'home' });
    console.log('pane home button', Date.now() - started, 'ms');
    // A live drag across the home screen pages.
    const dragStart = frames.length;
    service.sendPaneTouch({ udid, phase: 'down', x: 0.85, y: 0.5 });
    for (let step = 1; step <= 30; step += 1) {
      service.sendPaneTouch({ udid, phase: 'move', x: 0.85 - 0.02 * step, y: 0.5 });
      await wait(16);
    }
    service.sendPaneTouch({ udid, phase: 'up', x: 0.25, y: 0.5 });
    await wait(600);
    const dragged = frames.slice(dragStart);
    const span = (dragged.at(-1).at - dragged[0].at) / 1000;
    console.log('drag:', dragged.length, 'frames,', (dragged.length / span).toFixed(0), 'fps');
    assert.ok(dragged.length > 15, 'the screen follows a live drag');
    await service.sendPaneInput(udid, { kind: 'button', button: 'home' });
    // Text without keys (accents) goes through the pasteboard.
    await service.typeText(udid, 'café');

    // Landscape: Safari turns with the device. The screenshot comes back
    // upright at one pixel per point, and a tap by label lands although HID
    // takes physical portrait points.
    await call({ action: 'launch', bundle_id: 'com.apple.mobilesafari' });
    await wait(2000);
    await call({ action: 'rotate', orientation: 'landscape-right' });
    await wait(1500);
    const wide = await call({ action: 'screenshot' });
    const wideSize = nativeImage.createFromBuffer(Buffer.from(wide.content.find((part) => part.type === 'image').data, 'base64')).getSize();
    console.log('landscape screenshot', wideSize);
    if (process.env.QA_CAPTURE) fs.writeFileSync(process.env.QA_CAPTURE, Buffer.from(wide.content.find((part) => part.type === 'image').data, 'base64'));
    assert.ok(wideSize.width > wideSize.height, 'the screenshot is upright in landscape');
    const wideUi = await call({ action: 'describe_ui' });
    const field = /TextField "([^"]+)"/.exec(wideUi.text)?.[1] ?? 'Search or enter website';
    await call({ action: 'tap', label: field });
    const keyboard = await until(async () => /Keyboard|"space"|"Go"/i.test((await call({ action: 'describe_ui' })).text), 'the keyboard', 6_000).catch(() => false);
    assert.ok(keyboard, `tapping "${field}" in landscape focuses it`);
    await call({ action: 'type', text: 'aegis' });
    assert.match((await call({ action: 'describe_ui' })).text, /aegis/, 'typed text shows in the field');
    await call({ action: 'key', key: 'escape' }).catch(() => {});
    // An agent swipe up from the bottom edge goes home, landscape too.
    await call({ action: 'swipe', x: 437, y: 398, to_x: 437, to_y: 150, duration: 0.25 });
    const swipedHome = await until(async () => !/^Application "Safari"/.test((await call({ action: 'describe_ui' })).text), 'home after a swipe up', 6_000).catch(() => false);
    assert.ok(swipedHome, 'a swipe up from the bottom edge goes home');
    await call({ action: 'rotate', orientation: 'portrait' });
    await service.sendPaneInput(udid, { kind: 'button', button: 'home' });

    // build_and_run: a SwiftUI app made with XcodeGen builds, installs and
    // launches; a compile error comes back as the compiler's line; a crash
    // at launch is reported.
    const { spawnSync } = require('node:child_process');
    if (spawnSync('xcodegen', ['--version']).status === 0) {
      const demo = path.join(temp, 'demo');
      fs.mkdirSync(path.join(demo, 'Sources'), { recursive: true });
      fs.writeFileSync(path.join(demo, 'project.yml'), [
        'name: AegisBuildDemo',
        'targets:',
        '  AegisBuildDemo:',
        '    type: application',
        '    platform: iOS',
        '    deploymentTarget: "17.0"',
        '    sources: [Sources]',
        '    settings:',
        '      base:',
        '        PRODUCT_BUNDLE_IDENTIFIER: dev.aegis.builddemo',
        '        GENERATE_INFOPLIST_FILE: YES',
        '        INFOPLIST_KEY_UILaunchScreen_Generation: YES',
        '        CODE_SIGNING_ALLOWED: NO',
        '',
      ].join('\n'));
      const source = (body) =>
        fs.writeFileSync(path.join(demo, 'Sources', 'App.swift'), `import SwiftUI\n@main struct DemoApp: App {\n  init() { ${body} }\n  var body: some Scene { WindowGroup { Text("Hello from Aegis build") } }\n}\n`);
      source('print("aegis-build-demo started")');
      assert.equal(spawnSync('xcodegen', ['generate', '--spec', 'project.yml'], { cwd: demo }).status, 0, 'xcodegen made the demo project');
      tool.setIosSimulatorSessionFolder(() => demo);
      const buildAndRun = async () => {
        const result = await tool.runIosSimulatorTool(chat, { action: 'build_and_run' }, { inlineImage: false });
        return { ...result, text: result.content.map((part) => part.text ?? '').join('\n') };
      };
      started = Date.now();
      const built = await buildAndRun();
      console.log('build_and_run', Date.now() - started, 'ms:', built.text.split('\n')[0]);
      assert.ok(!built.isError, built.text);
      assert.match(built.text, /aegis-build-demo started/, 'the app output comes back');
      const shown = await until(async () => /Hello from Aegis build/.test((await call({ action: 'describe_ui' })).text), 'the built app on screen', 10_000).catch(() => false);
      assert.ok(shown, 'the built app is on screen');

      source('let broken: Int = "text"');
      const failed = await buildAndRun();
      console.log('compile error:', failed.text.split('\n').slice(0, 3).join(' | '));
      assert.equal(failed.isError, true);
      assert.match(failed.text, /App\.swift:\d+:\d+: error: /, 'the compiler error with file and line');
      assert.ok(failed.text.length < 4_000, 'a short report, not the build log');

      source('fatalError("aegis-build-demo crash")');
      const crashed = await buildAndRun();
      console.log('crash:', crashed.text.split('\n').slice(0, 2).join(' | '));
      assert.equal(crashed.isError, true);
      assert.match(crashed.text, /crashed or exited/, 'a crash at launch is reported');
      await call({ action: 'button', button: 'home' });
    } else {
      console.log('build_and_run skipped: xcodegen is not installed');
    }

    // Busy state was published around agent actions.
    assert.ok(states.some((state) => state.device.udid === udid && state.agentBusy), 'agent busy was shown');
    assert.equal((await service.getView(udid)).agentBusy, false, 'and cleared');

    // Detaching stops the stream.
    service.detachViewer(udid, chat);
    const count = frames.length;
    await wait(1500);
    assert.ok(frames.length - count <= 2, 'no frames after detach');

    console.log('ios simulator live check passed');
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
});
