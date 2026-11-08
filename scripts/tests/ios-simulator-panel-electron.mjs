// Live check of the iOS Simulator pane against a real simulator (needs
// Xcode, an iOS runtime and a built aegis-sim-helper; not in CI). The real panel component,
// preload bridge and main-process service: frames reach the screen, a click
// on the screen taps the device at the same spot, ⇧⌘H goes Home, and a
// capture of the pane is saved for a look.
//
//   npm run transpile:electron && node scripts/tests/ios-simulator-panel-electron.mjs [device name]
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'vite';

const root = process.cwd();
const deviceName = process.argv[2] || 'iPhone 17 Pro';
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const tmp = await mkdtemp(path.join(root, '.aegis-design-qa/ios-simulator-'));
const runtime = await mkdtemp(path.join(os.tmpdir(), 'aegis-ios-simulator-panel-'));

const harness = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Tooltip } from '@base-ui-components/react/tooltip';
import { IosSimulatorPanel } from '/src/ui/components/IosSimulatorPanel';
import '/src/ui/index.css';
function Harness() {
  const [udid, setUdid] = useState(new URLSearchParams(location.search).get('udid'));
  window.qa = { udid, setUdid };
  return <Tooltip.Provider><div style={{ position: 'relative', width: 460, height: 860, background: 'var(--bg-primary)', color: 'var(--text-primary)', borderLeft: '1px solid var(--border)' }}>
    <IosSimulatorPanel sessionId="qa" udid={udid} hidden={false} onSelectDevice={(next) => setUdid(next === 'pick' ? null : next)} />
  </div></Tooltip.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;

const main = String.raw`
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
app.setPath('userData', process.env.QA_PROFILE);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const dist = path.join(process.env.QA_ROOT, 'dist-electron/electron');
  const { registerIosSimulatorIpc, disposeIosSimulatorIpc } = require(path.join(dist, 'ios-simulator-ipc.js'));
  const service = require(path.join(dist, 'libs/ios-simulator/service.js'));
  const { run } = require(path.join(dist, 'libs/ios-simulator/toolchain.js'));
  const device = await service.findDevice(process.env.QA_DEVICE);
  assert.ok(device, 'device ' + process.env.QA_DEVICE);
  await service.bootDevice(device.udid, null);
  // A device left locked by an earlier run: wake and unlock it.
  await service.sendPaneInput(device.udid, { kind: 'button', button: 'home' });
  await delay(800);
  await service.sendPaneInput(device.udid, { kind: 'button', button: 'home' });
  await delay(800);
  if (!process.env.QA_CAPTURE_ONLY) await run('xcrun', ['simctl', 'launch', '--terminate-running-process', device.udid, 'com.apple.Preferences']);
  const win = new BrowserWindow({ width: 460, height: 860, show: false, webPreferences: { backgroundThrottling: false, preload: path.join(dist, 'preload.cjs') } });
  registerIosSimulatorIpc(win, () => {});
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const until = async (c, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(c)) return; await delay(100); } throw Error('Timed out: ' + c); };
  const ui = async () => JSON.stringify(await service.describeUi(device.udid));
  // The app in front: SpringBoard's label is a space.
  const front = async () => (await service.describeUi(device.udid))[0]?.AXLabel;
  // A mouse drag on the pane, as a finger.
  const drag = async (from, to) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 15; i++) {
      await delay(16);
      const x = Math.round(from.x + ((to.x - from.x) * i) / 15), y = Math.round(from.y + ((to.y - from.y) * i) / 15);
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y, modifiers: ['leftButtonDown'] });
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  };
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  try {
    await win.loadURL(process.env.QA_URL + '?udid=' + device.udid);
    win.showInactive();
    await until('(() => { const c = document.querySelector("canvas"); return c && c.width > 0 && c.getBoundingClientRect().width > 50; })()');
    const box = await js('(() => { const r = document.querySelector("[data-orientation]").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()');
    console.log('screen box', box);
    if (process.env.QA_CAPTURE_ONLY) {
      // Look at a device without driving it (e.g. a foldable): capture and stop.
      await delay(1500);
      fs.writeFileSync(process.env.QA_CAPTURE, (await win.webContents.capturePage()).toPNG());
      console.log('ios simulator panel capture written');
      disposeIosSimulatorIpc();
      app.exit(0);
      return;
    }
    if (!process.env.QA_CAPTURE_ONLY) assert.ok(Math.abs(box.w / box.h - 402 / 874) < 0.02, 'the screen keeps the device aspect ratio');
    assert.match(await js('document.body.innerText'), new RegExp(process.env.QA_DEVICE), 'device menu names the device');

    // The device menu opens, lists devices under their iOS version, and
    // picking the current device keeps the pane on it.
    await js('document.querySelector("[aria-label=\'Choose a simulator\']").click()');
    await until('[...document.querySelectorAll("[role=menuitem]")].some((item) => item.textContent.includes(' + JSON.stringify(process.env.QA_DEVICE) + '))');
    assert.match(await js('[...document.querySelectorAll("[role=group]")].map((group) => group.textContent).join("|")'), /iOS \d+/, 'devices are grouped by iOS version');
    await js('[...document.querySelectorAll("[role=menuitem]")].find((item) => item.textContent.includes(' + JSON.stringify(process.env.QA_DEVICE) + ')).click()');
    await until('!document.querySelector("[role=menu]")');
    assert.equal(await js('document.body.innerText.includes("Something went wrong")'), false, 'the pane did not crash');
    assert.ok(await js('!!document.querySelector("canvas")'), 'the screen is still shown');

    // Two-finger scrolling (wheel events) drags the list like a finger.
    const generalTop = async () => {
      const find = (node) => node.AXLabel === 'General' && node.frame ? node.frame.y : (node.children ?? []).map(find).find((value) => value !== undefined);
      return (await service.describeUi(device.udid)).map(find).find((value) => value !== undefined);
    };
    const beforeScroll = await generalTop();
    const cx = Math.round(box.x + box.w / 2), cy = Math.round(box.y + box.h * 0.6);
    let afterScroll = beforeScroll;
    for (const sign of [-1, 1]) {
      for (let i = 0; i < 12; i++) {
        win.webContents.sendInputEvent({ type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: sign * 40, canScroll: true });
        await delay(16);
      }
      await delay(400);
      afterScroll = await generalTop();
      if (afterScroll !== beforeScroll) break;
    }
    console.log('scroll moved General from', Math.round(beforeScroll), 'to', afterScroll === undefined ? 'out of view' : Math.round(afterScroll));
    assert.notEqual(afterScroll, beforeScroll, 'two-finger scrolling moves the list');
    await run('xcrun', ['simctl', 'launch', '--terminate-running-process', device.udid, 'com.apple.Preferences']);
    await delay(1500);

    // Click "General" (201,319 in points on a 402x874 screen).
    let started = Date.now();
    const x = Math.round(box.x + (201 / 402) * box.w);
    const y = Math.round(box.y + (319 / 874) * box.h);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await delay(60);
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    let opened = false;
    for (let i = 0; i < 20 && !opened; i++) { await delay(250); opened = /"About"/.test(await ui()); }
    assert.ok(opened, 'a click on the pane taps the device');
    console.log('click to page change', Date.now() - started, 'ms');
    await delay(800);
    fs.writeFileSync(process.env.QA_CAPTURE, (await win.webContents.capturePage()).toPNG());

    // ⇧⌘H goes Home.
    await js('document.querySelector("[aria-label$=screen]").focus()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'H', modifiers: ['meta', 'shift'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'H', modifiers: ['meta', 'shift'] });
    let home = false;
    for (let i = 0; i < 20 && !home; i++) { await delay(250); home = !/"About"/.test(await ui()); }
    assert.ok(home, 'shift-command-H presses Home');

    // A drag up from the home indicator (8 points above the bottom) goes
    // home, as on a device: the touch carries the edge.
    await run('xcrun', ['simctl', 'launch', '--terminate-running-process', device.udid, 'com.apple.Preferences']);
    await delay(1500);
    assert.equal(await front(), 'Settings');
    await drag({ x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h - (8 / 874) * box.h) }, { x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h * 0.55) });
    let swipedHome = false;
    for (let i = 0; i < 20 && !swipedHome; i++) { await delay(250); swipedHome = (await front()) !== 'Settings'; }
    assert.ok(swipedHome, 'a swipe up from the home indicator goes home');

    // Rotate from the toolbar: the screen turns to landscape, and a click on
    // the turned picture lands on the same spot of the app.
    await run('xcrun', ['simctl', 'launch', '--terminate-running-process', device.udid, 'com.apple.mobilesafari']);
    await delay(2000);
    await js('document.querySelector("[aria-label=Rotate]").click()');
    await until('document.querySelector("[data-orientation]")?.dataset.orientation === "landscape-right"');
    await delay(1500);
    const wide = await js('(() => { const r = document.querySelector("[data-orientation]").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()');
    console.log('landscape box', wide);
    assert.ok(wide.w > wide.h, 'the screen is shown in landscape');
    // Safari's address field, in the landscape UI (874x402 points).
    const fx = Math.round(wide.x + (437 / 874) * wide.w);
    const fy = Math.round(wide.y + (32 / 402) * wide.h);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: fx, y: fy });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: fx, y: fy, button: 'left', clickCount: 1 });
    await delay(60);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: fx, y: fy, button: 'left', clickCount: 1 });
    let keyboard = false;
    for (let i = 0; i < 24 && !keyboard; i++) { await delay(250); keyboard = /Keyboard|"space"|"Go"/i.test(await ui()); }
    fs.writeFileSync(process.env.QA_CAPTURE.replace(/\.png$/, '-landscape.png'), (await win.webContents.capturePage()).toPNG());
    assert.ok(keyboard, 'a click on the turned picture focuses the address field');
    // Turned, the home indicator is at the bottom of the picture, which is a
    // side of the physical screen: a swipe from the bezel below it still goes
    // home.
    await drag({ x: Math.round(wide.x + wide.w / 2), y: Math.round(wide.y + wide.h + 4) }, { x: Math.round(wide.x + wide.w / 2), y: Math.round(wide.y + wide.h * 0.4) });
    let landscapeHome = false;
    for (let i = 0; i < 20 && !landscapeHome; i++) { await delay(250); landscapeHome = (await front()) !== 'Safari'; }
    assert.ok(landscapeHome, 'a swipe up from the landscape home indicator goes home');
    await service.rotateDevice(device.udid, 'portrait');
    await service.sendPaneInput(device.udid, { kind: 'button', button: 'home' });

    // The side buttons sit where Xcode's outline puts them; the power button
    // presses through: the screen locks.
    await delay(1200);
    const buttons = await js('[...document.querySelectorAll("[role=button][aria-label]")].map((el) => ({ label: el.getAttribute("aria-label"), title: el.title }))');
    console.log('side buttons', buttons.map((button) => button.label).join(', '));
    assert.ok(buttons.length >= 4, 'every side button of the outline is there and presses through');
    const power = buttons.find((button) => /Sleep|Power|Side/i.test(button.label));
    assert.ok(power, 'the power button is there');
    const brightness = () => js('(() => { const c = document.querySelector("canvas"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let sum = 0; for (let i = 0; i < d.length; i += 400) sum += d[i] + d[i + 1] + d[i + 2]; return sum / (d.length / 400) / 3; })()');
    const lit = await brightness();
    const at = await js('(() => { const r = document.querySelector(' + JSON.stringify('[aria-label="' + power.label + '"]') + ').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await delay(60);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    // Always-on display models dim to the lock screen rather than go black.
    let dark = lit;
    for (let i = 0; i < 20 && dark > lit * 0.5; i++) { await delay(200); dark = await brightness(); }
    console.log('power button: brightness', Math.round(lit), '->', Math.round(dark));
    assert.ok(dark < lit * 0.5, 'pressing the power button locks the screen');
    await service.sendPaneInput(device.udid, { kind: 'button', button: 'lock' });
    await delay(800);
    await service.sendPaneInput(device.udid, { kind: 'button', button: 'home' });
    await delay(800);

    // Detach: the pane offers a device again.
    await js('qa.setUdid(null)');
    await until('document.body.innerText.includes("No simulator attached")');
    assert.deepEqual(errors, [], 'no renderer errors');
    console.log('ios simulator panel check passed');
    disposeIosSimulatorIpc();
    app.exit(0);
  } catch (e) {
    console.error(e);
    try { fs.writeFileSync(process.env.QA_CAPTURE, (await win.webContents.capturePage()).toPNG()); } catch {}
    console.error(errors.join('\n'));
    app.exit(1);
  }
});
`;

let server;
try {
  await writeFile(path.join(tmp, 'index.html'), '<html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  server = await createServer({
    // Own dep cache: sharing node_modules/.vite breaks a running dev server.
    root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(tmp, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: { ignored: ['**/.aegis-design-qa/**'] } },
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  const env = {
    ...process.env,
    QA_URL: new URL(path.relative(root, tmp) + '/index.html', origin).href,
    // The harness origin is the trusted renderer, as the dev server is.
    DEV_SERVER_URL: new URL(origin).origin,
    QA_ROOT: root,
    QA_DEVICE: deviceName,
    QA_CAPTURE_ONLY: process.env.QA_CAPTURE_ONLY ?? '',
    QA_PROFILE: path.join(runtime, 'profile'),
    QA_CAPTURE: path.join(os.tmpdir(), 'aegis-ios-simulator-panel.png'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(tmp, 'main.cjs')], { cwd: root, env, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('iOS Simulator panel check timed out')); }, 180000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('iOS Simulator panel check failed: ' + code)); });
  });
  console.log('pane capture:', env.QA_CAPTURE);
} finally {
  await server?.close();
  await rm(tmp, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
}
