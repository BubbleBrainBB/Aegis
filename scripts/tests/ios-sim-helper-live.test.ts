// Live check of aegis-sim-helper against a booted simulator (needs Xcode
// and a built helper; not in CI): screen info, an H.264 stream that starts
// with a keyframe, live touches that move the screen, discrete input, the
// accessibility tree and a screenshot.
//
//   npm run build:ios-sim-helper && npx tsx scripts/tests/ios-sim-helper-live.test.ts [udid]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimHelper, findHelper, type HelperVideoFrame } from '../../src/electron/libs/ios-simulator/helper';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bootedUdid(): string {
  const wanted = process.argv[2];
  if (wanted) return wanted;
  const json = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8' })) as {
    devices: Record<string, Array<{ udid: string; name: string }>>;
  };
  const device = Object.values(json.devices).flat().find((candidate) => /iPhone/.test(candidate.name));
  assert.ok(device, 'a booted iPhone simulator');
  return device.udid;
}

async function main() {
  const path = findHelper();
  assert.ok(path, 'aegis-sim-helper is built');
  const udid = bootedUdid();
  const frames: Array<HelperVideoFrame & { at: number }> = [];
  const helper = new SimHelper(path, (frame) => frames.push({ ...frame, at: Date.now() }), () => {});
  const temp = mkdtempSync(join(tmpdir(), 'aegis-sim-helper-'));
  try {
    let started = Date.now();
    await helper.start();
    console.log('start', Date.now() - started, 'ms');

    const screen = await helper.request<{ pointWidth: number; pointHeight: number; scale: number; name: string }>({ cmd: 'screen', udid });
    console.log('screen', screen);
    assert.ok(screen.pointWidth > 300 && screen.scale >= 2);
    const w = screen.pointWidth;
    const h = screen.pointHeight;

    await helper.request({ cmd: 'button', udid, button: 'home' });
    started = Date.now();
    await helper.request({ cmd: 'stream', udid, maxEdge: 1600 });
    while (!frames.length && Date.now() - started < 5_000) await wait(10);
    assert.ok(frames.length, 'a first frame');
    assert.equal(frames[0].keyFrame, true, 'the stream opens on a keyframe');
    assert.equal(frames[0].data.subarray(0, 4).toString('hex'), '00000001', 'Annex B');
    console.log('first frame', frames[0].at - started, 'ms,', `${frames[0].width}x${frames[0].height},`, Math.round(frames[0].data.length / 1024), 'KB');

    // A live drag across the home screen pages.
    const before = frames.length;
    started = Date.now();
    helper.send({ cmd: 'touch', udid, phase: 'down', x: w * 0.85, y: h * 0.5 });
    for (let step = 1; step <= 30; step += 1) {
      helper.send({ cmd: 'touch', udid, phase: 'move', x: w * (0.85 - 0.02 * step), y: h * 0.5 });
      await wait(16);
    }
    helper.send({ cmd: 'touch', udid, phase: 'up', x: w * 0.25, y: h * 0.5 });
    const firstMoveFrame = frames.slice(before).find((frame) => frame.at >= started);
    await wait(800);
    const during = frames.slice(before);
    const span = (during.at(-1)!.at - during[0].at) / 1000;
    console.log(
      'drag:', during.length, 'frames,', (during.length / Math.max(span, 0.001)).toFixed(0), 'fps,',
      'first changed frame', firstMoveFrame ? firstMoveFrame.at - started : 'none', 'ms,',
      Math.round(during.reduce((sum, frame) => sum + frame.data.length, 0) / span / 1024), 'KB/s'
    );
    assert.ok(during.length > 15, 'the screen streams while dragging');

    for (const [label, command] of [
      ['tap', { cmd: 'tap', udid, x: w / 2, y: h * 0.15 }],
      ['home button', { cmd: 'button', udid, button: 'home' }],
      ['swipe', { cmd: 'swipe', udid, x: w * 0.2, y: h * 0.5, toX: w * 0.8, toY: h * 0.5, duration: 0.25 }],
    ] as const) {
      started = Date.now();
      await helper.request(command);
      console.log(label, Date.now() - started, 'ms');
    }

    execFileSync('xcrun', ['simctl', 'launch', '--terminate-running-process', udid, 'com.apple.Preferences']);
    await wait(1500);
    started = Date.now();
    let tree = await helper.request<Array<Record<string, unknown>>>({ cmd: 'describe', udid });
    console.log('describe', Date.now() - started, 'ms; root keys:', Object.keys(tree[0] ?? {}).sort().join(','));
    // A foldable starts Settings more slowly.
    for (let i = 0; i < 10 && !/"General"/.test(JSON.stringify(tree)); i++) {
      await wait(500);
      tree = await helper.request<Array<Record<string, unknown>>>({ cmd: 'describe', udid });
    }
    assert.match(JSON.stringify(tree), /"General"/, 'the tree has Settings rows');

    const shot = join(temp, 'shot.png');
    started = Date.now();
    await helper.request({ cmd: 'screenshot', udid, path: shot });
    console.log('screenshot', Date.now() - started, 'ms,', Math.round(statSync(shot).size / 1024), 'KB');
    assert.ok(existsSync(shot));

    await helper.request({ cmd: 'text', udid, text: 'é' }).then(
      () => assert.fail('non-ASCII text is refused'),
      (error: Error) => assert.match(error.message, /unsupported-text/)
    );
    await helper.request({ cmd: 'button', udid, button: 'home' });
    await helper.request({ cmd: 'unstream', udid });
    console.log('ios-sim-helper live check passed');
  } finally {
    helper.stop();
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
