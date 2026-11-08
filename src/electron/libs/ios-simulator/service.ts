// The iOS Simulator service: which chat uses which device, the live screen a
// pane shows, and input from the pane and from agents. Devices stay up until
// shut down on purpose; Aegis shuts down the ones it booted when it quits.
//
// Screens, touches, keys, the accessibility tree and screenshots go through
// aegis-sim-helper, one native process for every device: it keeps a HID
// connection per device (a touch lands in well under a millisecond) and
// encodes each screen to H.264 as the simulator repaints it. Booting,
// installing and launching stay with `xcrun simctl`.

import { spawn } from 'child_process';
import { mkdir, readFile, rm } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  edgeNear,
  IOS_EDGE_REACH,
  shownToPhysical,
  type IosSimulatorDevice,
  type IosSimulatorInput,
  type IosSimulatorOrientation,
  type IosSimulatorTouch,
  type IosSimulatorView,
} from '../../../shared/ios-simulator';
import { SimHelper, findHelper, type HelperScreen, type HelperVideoFrame } from './helper';
import { getToolchainStatus, listDevices, run } from './toolchain';
import { getDeviceChrome } from './chrome';
import type { IosDeviceChrome } from '../../../shared/ios-simulator';

const PBCOPY_TIMEOUT_MS = 10_000;
/** Longest edge of the streamed screen, in pixels: sharp in a wide pane. */
const STREAM_MAX_EDGE = 1600;

const HID_KEYCODES: Record<Extract<IosSimulatorInput, { kind: 'key' }>['key'], number> = {
  return: 40,
  escape: 41,
  backspace: 42,
  tab: 43,
};

interface DeviceRecord {
  udid: string;
  ownerSessionId: string | null;
  bootedByAegis: boolean;
  agentBusy: number;
  /** Portrait screen size in points. */
  pointSize: { width: number; height: number } | null;
  /** The shown screen's own outline and mask (a foldable's inner screen). */
  chromeIds: { chromeIdentifier?: string; maskIdentifier?: string };
  /** How the UI is turned, as the simulator reports it. */
  orientation: IosSimulatorOrientation;
  /** Panes (by chat) currently showing this device. */
  viewers: Set<string>;
  streaming: boolean;
  /** Aegis is booting it right now. */
  booting: boolean;
  /** Pane keys and buttons queued or running, which a press waits for. */
  paneInputs: number;
  /** Pane gestures waiting for their turn in the input queue. */
  pendingGestures: number;
  /** The gesture the pane's finger is in, while it is down. */
  gesture: PaneGesture | null;
  /** A shutdown in progress: opening a pane or booting waits for it. */
  shuttingDown: Promise<void> | null;
  /** Bumped by every shutdown: an agent action queued before one fails
   * rather than acting on a device that is gone. */
  bootGeneration: number;
  /** Bumped when buffered gestures no longer apply (helper restarted, the
   * last pane closed): they are dropped, not replayed onto a new screen. */
  inputGeneration: number;
}

/** One press to lift on the pane. While pane input queued before it is
 * pending, its touches wait for their own turn in the queue. */
interface PaneGesture {
  touches: IosSimulatorTouch[];
  released: boolean;
  generation: number;
}

/** What the service runs, replaceable in tests (no Xcode there). */
interface HelperLike {
  readonly running: boolean;
  request<T = unknown>(command: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  send(command: Record<string, unknown>): void;
  stop(): void;
}

export interface IosSimulatorHost {
  /** Deliver one H.264 access unit to the panes showing the device. */
  sendFrame(frame: HelperVideoFrame): void;
  /** A device's view changed. */
  sendState(view: IosSimulatorView): void;
  /** Ask the renderer to show the device's pane in the chat. */
  openPanel(sessionId: string, udid: string): void;
}

let host: IosSimulatorHost | null = null;
let helper: HelperLike | null = null;
let testDoubles: { helper: HelperLike; run: typeof run; listDevices: typeof listDevices } | null = null;
const runCommand: typeof run = (...args) => (testDoubles ? testDoubles.run(...args) : run(...args));
/** The helper when it is up (none is started for this). */
const liveHelper = (): HelperLike | null => testDoubles?.helper ?? helper;
const records = new Map<string, DeviceRecord>();
const inputQueues = new Map<string, Promise<unknown>>();
/** Devices the user allowed agents to drive, for as long as Aegis runs. */
const agentAllowed = new Set<string>();
let deviceCache: { at: number; devices: IosSimulatorDevice[] } | null = null;

export function setIosSimulatorHost(next: IosSimulatorHost | null): void {
  host = next;
}

function record(udid: string): DeviceRecord {
  let entry = records.get(udid);
  if (!entry) {
    entry = {
      udid,
      ownerSessionId: null,
      bootedByAegis: false,
      agentBusy: 0,
      pointSize: null,
      chromeIds: {},
      orientation: 'portrait',
      viewers: new Set(),
      streaming: false,
      booting: false,
      paneInputs: 0,
      pendingGestures: 0,
      gesture: null,
      inputGeneration: 0,
      shuttingDown: null,
      bootGeneration: 0,
    };
    records.set(udid, entry);
  }
  return entry;
}

/** The running helper, started on first use and again after it exits. */
function simHelper(): HelperLike {
  if (testDoubles) return testDoubles.helper;
  if (helper) return helper;
  const path = findHelper();
  if (!path) throw new Error('aegis-sim-helper is not built. Run npm run build:ios-sim-helper.');
  const created = new SimHelper(
    path,
    (frame) => {
      if (!records.get(frame.udid)?.streaming) return;
      host?.sendFrame(frame);
    },
    (reason) => {
      console.warn('[ios-simulator]', reason);
      if (helper === created) helper = null;
      // Panes still showing a device reconnect through a fresh helper;
      // gestures meant for the old one are dropped.
      for (const entry of records.values()) {
        dropPaneGestures(entry);
        if (!entry.streaming) continue;
        entry.streaming = false;
        if (entry.viewers.size > 0) void startStream(entry.udid).catch(() => {});
      }
    },
    (event) => {
      // The UI turned, or a foldable changed posture.
      if (event.event === 'display' && typeof event.udid === 'string') applyScreen(event.udid, event as unknown as HelperScreen);
      // Rebooted or shut down outside Aegis: the helper's old stream is gone.
      if (event.event === 'boot-changed' && typeof event.udid === 'string') markStreamLost(event.udid);
    }
  );
  helper = created;
  return created;
}

export async function getDevices(options: { fresh?: boolean } = {}): Promise<IosSimulatorDevice[]> {
  if (!options.fresh && deviceCache && Date.now() - deviceCache.at < 2_000) return deviceCache.devices;
  const devices = await (testDoubles ? testDoubles.listDevices() : listDevices());
  deviceCache = { at: Date.now(), devices };
  return devices;
}

export async function getDevice(udid: string, options: { fresh?: boolean } = {}): Promise<IosSimulatorDevice> {
  const device = (await getDevices(options)).find((candidate) => candidate.udid === udid);
  if (!device) throw new Error(`No simulator with id ${udid}. List devices to see what is installed.`);
  return device;
}

/** A device by udid or by name ("iPhone 17 Pro"); booted and newest first. */
export async function findDevice(query: string): Promise<IosSimulatorDevice | null> {
  const devices = await getDevices({ fresh: true });
  const exact = devices.find((device) => device.udid === query || device.name === query);
  if (exact) return exact;
  const lower = query.toLowerCase();
  return devices.find((device) => device.name.toLowerCase() === lower)
    ?? devices.find((device) => device.name.toLowerCase().includes(lower))
    ?? null;
}

export async function getView(udid: string, options: { fresh?: boolean } = {}): Promise<IosSimulatorView> {
  const device = await getDevice(udid, options);
  const entry = record(udid);
  return {
    device,
    ownerSessionId: entry.ownerSessionId,
    bootedByAegis: entry.bootedByAegis,
    agentAllowed: agentAllowed.has(udid),
    agentBusy: entry.agentBusy > 0,
    pointSize: entry.pointSize,
    orientation: entry.orientation,
    streaming: entry.streaming,
  };
}

async function publish(udid: string): Promise<void> {
  if (!host) return;
  const view = await getView(udid, { fresh: true }).catch(() => null);
  if (view) host.sendState(view);
}

async function requireHelper(): Promise<HelperLike> {
  if (testDoubles) return testDoubles.helper;
  const status = await getToolchainStatus();
  if (!status.ready) {
    throw new Error(`The iOS Simulator is not set up on this Mac (missing: ${status.missing.join(', ')}).`);
  }
  return simHelper();
}

// ===== Lifecycle =====
//
// Devices stay up until someone shuts them down (the pane's menu, an agent,
// Simulator.app), as in Xcode. The only automatic shutdown is when Aegis
// quits: the devices it booted go with it.

export async function bootDevice(udid: string, sessionId: string | null): Promise<IosSimulatorView> {
  const entry = record(udid);
  if (entry.shuttingDown) await entry.shuttingDown.catch(() => {});
  // Shut down while this boot waited: the shutdown wins; do not start it again.
  const generation = entry.bootGeneration;
  const shutDownMeanwhile = () => entry.bootGeneration !== generation || entry.shuttingDown !== null;
  const device = await getDevice(udid, { fresh: true });
  if (shutDownMeanwhile()) throw new Error(`${device.name} was shut down while it was starting.`);
  if (sessionId && !entry.ownerSessionId) entry.ownerSessionId = sessionId;
  if (device.state !== 'Booted') {
    // Marked before simctl runs, so quitting Aegis meanwhile still shuts it down.
    entry.booting = true;
    try {
      try {
        await runCommand('xcrun', ['simctl', 'boot', udid], { timeoutMs: 120_000 });
        entry.bootedByAegis = true;
      } catch (error) {
        // Booting a device that is already booting is not a failure.
        if (!/current state: Booted|Unable to boot device in current state: Booting/i.test(String(error))) throw error;
      }
      await runCommand('xcrun', ['simctl', 'bootstatus', udid, '-b'], { timeoutMs: 180_000 });
    } finally {
      entry.booting = false;
    }
    if (shutDownMeanwhile()) throw new Error(`${device.name} was shut down while it was starting.`);
  }
  deviceCache = null;
  if (entry.viewers.size > 0) await startStream(udid).catch(() => {});
  void publish(udid);
  return getView(udid, { fresh: true });
}

/** Shut the device down. While it runs, panes and boots wait for it, and
 * agent actions queued before it fail instead of acting on a gone device. */
export function shutdownDevice(udid: string): Promise<void> {
  const entry = record(udid);
  if (entry.shuttingDown) return entry.shuttingDown;
  entry.bootGeneration += 1;
  const done = (async () => {
    await stopStream(udid);
    // The helper's HID connection and framebuffer belong to this boot.
    const client = liveHelper();
    if (client?.running) await client.request({ cmd: 'close', udid }).catch(() => {});
    await runCommand('xcrun', ['simctl', 'shutdown', udid], { timeoutMs: 60_000 }).catch((error) => {
      if (!/current state: Shutdown/i.test(String(error))) throw error;
    });
    entry.bootedByAegis = false;
    entry.ownerSessionId = null;
    entry.pointSize = null;
    entry.chromeIds = {};
    entry.orientation = 'portrait';
    deviceCache = null;
    void publish(udid);
  })().finally(() => {
    entry.shuttingDown = null;
  });
  entry.shuttingDown = done;
  return done;
}

/** App quit: nothing can be awaited, so the shutdowns run detached and
 * finish after Aegis has exited. The helper ends with Aegis. */
export function shutdownAegisDevicesOnQuit(): void {
  helper?.stop();
  helper = null;
  for (const entry of records.values()) {
    entry.streaming = false;
    if (!entry.bootedByAegis && !entry.booting) continue;
    entry.bootedByAegis = false;
    try {
      if (entry.booting) {
        // Still booting: shut down once it is up, or the boot finishes after us.
        spawn('sh', ['-c', 'xcrun simctl bootstatus "$1" -b >/dev/null 2>&1; xcrun simctl shutdown "$1"', 'sh', entry.udid], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      } else {
        spawn('xcrun', ['simctl', 'shutdown', entry.udid], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch {
      // The device stays booted; Simulator.app can shut it down.
    }
  }
}

/** A chat was deleted: it no longer owns or shows any device. The devices
 * stay up for other chats (Aegis shuts down the ones it booted on quit). */
export async function releaseSessionDevices(sessionId: string): Promise<void> {
  for (const entry of records.values()) {
    if (entry.ownerSessionId === sessionId) entry.ownerSessionId = null;
    if (entry.viewers.delete(sessionId) && entry.viewers.size === 0) void stopStream(entry.udid);
  }
}

// ===== Screen =====

async function startStream(udid: string): Promise<void> {
  const entry = record(udid);
  const client = await requireHelper();
  const generation = entry.bootGeneration;
  const screen = await client.request<HelperScreen>({ cmd: 'stream', udid, maxEdge: STREAM_MAX_EDGE, maxFps: 60 });
  // The device restarted or shut down before this reply was read: the
  // stream it describes is gone (the pane offers to reconnect).
  if (entry.bootGeneration !== generation) return;
  // The last pane closed while the stream started: stop it again.
  if (entry.viewers.size === 0) {
    entry.streaming = false;
    await client.request({ cmd: 'unstream', udid }).catch(() => {});
    return;
  }
  const wasStreaming = entry.streaming;
  entry.streaming = true;
  applyScreen(udid, screen);
  if (!wasStreaming) void publish(udid);
}

/** The device was rebooted or shut down outside Aegis: the helper's stream
 * of that boot is gone. The pane says so and offers to reconnect, which
 * attaches again; nothing retries in the background. */
export function markStreamLost(udid: string): void {
  const entry = record(udid);
  entry.bootGeneration += 1;
  entry.streaming = false;
  entry.pointSize = null;
  entry.chromeIds = {};
  dropPaneGestures(entry);
  deviceCache = null;
  void publish(udid);
}

const UI_ORIENTATIONS: Record<number, IosSimulatorOrientation> = {
  1: 'portrait',
  2: 'portrait-upside-down',
  // UIInterfaceOrientation landscape right: the device turned left.
  3: 'landscape-left',
  4: 'landscape-right',
};

/** The screen as the helper reports it: the streamed display's size, the
 * HID space, and how the UI is turned. */
function applyScreen(udid: string, screen: HelperScreen): void {
  const entry = record(udid);
  let changed = false;
  if (screen.pointWidth > 0 && screen.pointHeight > 0) {
    changed ||= entry.pointSize?.width !== screen.pointWidth || entry.pointSize?.height !== screen.pointHeight;
    entry.pointSize = { width: screen.pointWidth, height: screen.pointHeight };
  }
  const ids = { chromeIdentifier: screen.chromeIdentifier, maskIdentifier: screen.maskIdentifier };
  changed ||= ids.chromeIdentifier !== entry.chromeIds.chromeIdentifier || ids.maskIdentifier !== entry.chromeIds.maskIdentifier;
  entry.chromeIds = ids;
  const orientation = UI_ORIENTATIONS[screen.uiOrientation] ?? entry.orientation;
  changed ||= orientation !== entry.orientation;
  entry.orientation = orientation;
  if (changed) void publish(udid);
}

/** Read the screen again (agents act without a pane streaming). */
export async function refreshScreen(udid: string): Promise<void> {
  applyScreen(udid, await (await requireHelper()).request<HelperScreen>({ cmd: 'screen', udid }));
}

async function stopStream(udid: string): Promise<void> {
  const entry = record(udid);
  if (!entry.streaming) return;
  entry.streaming = false;
  const client = liveHelper();
  if (client?.running) await client.request({ cmd: 'unstream', udid }).catch(() => {});
}

/** A pane starts showing the device. */
export async function attachViewer(udid: string, sessionId: string): Promise<IosSimulatorView> {
  const entry = record(udid);
  if (entry.shuttingDown) await entry.shuttingDown.catch(() => {});
  if (!entry.ownerSessionId) entry.ownerSessionId = sessionId;
  entry.viewers.add(sessionId);
  const view = await getView(udid, { fresh: true });
  // Streaming already: this asks for a keyframe, so the new pane can start.
  if (view.device.state === 'Booted') await startStream(udid);
  return getView(udid);
}

/** A pane stops showing the device (tab closed, chat switched away). */
export function detachViewer(udid: string, sessionId: string): void {
  const entry = records.get(udid);
  if (!entry) return;
  entry.viewers.delete(sessionId);
  if (entry.viewers.size > 0) return;
  dropPaneGestures(entry);
  void stopStream(udid);
}

/** A pane's decoder lost its place (or just started): send a keyframe. */
export function requestKeyFrame(udid: string): void {
  if (record(udid).streaming) liveHelper()?.send({ cmd: 'keyframe', udid });
}

/** The screen in points, from the helper. */
export async function ensurePointSize(udid: string): Promise<void> {
  if (record(udid).pointSize) return;
  await refreshScreen(udid);
}

/** The device's outline from Xcode's own data, for the pane to draw. */
export async function deviceChrome(udid: string): Promise<IosDeviceChrome | null> {
  const device = await getDevice(udid);
  if (!device.deviceType) return null;
  await ensurePointSize(udid);
  const entry = record(udid);
  return entry.pointSize ? getDeviceChrome(device.deviceType, entry.pointSize, entry.chromeIds) : null;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** How the UI is turned on the physical screen, as the simulator reports
 * it (rotation, a foldable's posture). */
export function uiOrientation(udid: string): IosSimulatorOrientation {
  return record(udid).orientation;
}

/**
 * UI points (what describe_ui and screenshots use) to 0..1 fractions of the
 * physical screen, which is what touches are sent in: the helper aims them
 * at the shown screen (a foldable has more than one).
 */
export function uiToPhysical(udid: string, orientation: IosSimulatorOrientation, x: number, y: number): { x: number; y: number } {
  const size = record(udid).pointSize;
  if (!size) throw new Error('The simulator screen size is not known yet.');
  const landscape = orientation === 'landscape-left' || orientation === 'landscape-right';
  const shownWidth = landscape ? size.height : size.width;
  const shownHeight = landscape ? size.width : size.height;
  const physical = shownToPhysical(orientation, x / shownWidth, y / shownHeight);
  return { x: clamp01(physical.x), y: clamp01(physical.y) };
}

// ===== Input =====

function enqueue<T>(udid: string, task: () => Promise<T>): Promise<T> {
  const previous = inputQueues.get(udid) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  inputQueues.set(udid, next.catch(() => {}));
  return next;
}

/** A finger on the pane, as it moves. Fire and forget: the helper keeps
 * the order, and a lost move is replaced by the next one. A press made
 * while pane keys or typing (or an earlier waiting press) are queued takes
 * its own place in the device's input queue, and the rest of its gesture
 * follows it: text typed before a click lands in the field it was typed
 * into. A lift always goes through, so no finger is left down. */
export function sendPaneTouch(touch: IosSimulatorTouch): void {
  const entry = records.get(touch.udid);
  if (!entry) return;
  if (touch.phase === 'down') {
    if (entry.paneInputs === 0 && entry.pendingGestures === 0) {
      entry.gesture = null;
      sendTouchNow(touch);
      return;
    }
    const gesture: PaneGesture = { touches: [touch], released: false, generation: entry.inputGeneration };
    entry.gesture = gesture;
    entry.pendingGestures += 1;
    void enqueue(touch.udid, async () => {
      entry.pendingGestures -= 1;
      if (gesture.generation !== entry.inputGeneration) return;
      gesture.released = true;
      const touches = gesture.touches;
      gesture.touches = [];
      touches.forEach(sendTouchNow);
    });
    return;
  }
  const gesture = entry.gesture;
  if (touch.phase === 'up') entry.gesture = null;
  if (gesture && !gesture.released) {
    gesture.touches.push(touch);
    return;
  }
  sendTouchNow(touch);
}

function dropPaneGestures(entry: DeviceRecord): void {
  entry.inputGeneration += 1;
  entry.gesture = null;
}

function sendTouchNow(touch: IosSimulatorTouch): void {
  const client = liveHelper();
  if (!client?.running) return;
  if (touch.phase !== 'up' && !records.get(touch.udid)?.streaming) return;
  client.send({
    cmd: 'dtouch',
    udid: touch.udid,
    phase: touch.phase,
    x: clamp01(touch.x),
    y: clamp01(touch.y),
    ...(touch.phase === 'down' && touch.edge ? { edge: touch.edge } : {}),
  });
}

/** Keys, buttons and rotation from the pane. */
export function sendPaneInput(udid: string, input: IosSimulatorInput): Promise<void> {
  const entry = record(udid);
  entry.paneInputs += 1;
  return enqueue(udid, async () => {
    switch (input.kind) {
      case 'type':
        await typeText(udid, input.text);
        return;
      case 'key':
        await (await requireHelper()).request({ cmd: 'key', udid, code: HID_KEYCODES[input.key] });
        return;
      case 'button':
        await (await requireHelper()).request({ cmd: 'button', udid, button: input.button });
        return;
      case 'rotate':
        await rotateDevice(udid, input.orientation);
        return;
      case 'hardware':
        await (await requireHelper()).request({ cmd: 'dbutton', udid, page: input.page, usage: input.usage });
        return;
    }
  }).finally(() => {
    entry.paneInputs -= 1;
  });
}

/** Turn the device. The app may or may not turn with it: what the pane
 * and agents go by is the UI orientation the simulator then reports. */
export async function rotateDevice(udid: string, orientation: IosSimulatorOrientation): Promise<void> {
  await (await requireHelper()).request({ cmd: 'rotate', udid, orientation });
  await new Promise((resolve) => setTimeout(resolve, 600));
  await refreshScreen(udid).catch(() => {});
}

/** Types on the device's keyboard; text it has no keys for (accents, CJK,
 * emoji) is pasted through the simulator's pasteboard instead. */
export async function typeText(udid: string, text: string): Promise<void> {
  if (!text) return;
  const client = await requireHelper();
  try {
    await client.request({ cmd: 'text', udid, text });
  } catch (error) {
    if (!/unsupported-text/.test(String(error))) throw error;
    await new Promise<void>((resolve, reject) => {
      const child = spawn('xcrun', ['simctl', 'pbcopy', udid], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      // Bounded: input queued behind it (and the pane's presses) waits on it.
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('simctl pbcopy did not finish in 10 s.'));
      }, PBCOPY_TIMEOUT_MS);
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`simctl pbcopy failed: ${stderr.trim()}`));
      });
      child.stdin?.end(text);
    });
    await client.request({ cmd: 'paste', udid });
  }
}

// ===== Agent access =====

export function isAgentAllowed(udid: string): boolean {
  return agentAllowed.has(udid);
}

export function setAgentAllowed(udid: string, allowed: boolean): void {
  if (allowed) agentAllowed.add(udid);
  else agentAllowed.delete(udid);
  void publish(udid);
}

/** Run an agent action on a device: queued with pane input, and the pane
 * shows the agent is using the device until it finishes. */
export async function runAgentAction<T>(udid: string, sessionId: string, action: () => Promise<T>): Promise<T> {
  const entry = record(udid);
  if (!entry.ownerSessionId) entry.ownerSessionId = sessionId;
  entry.agentBusy += 1;
  if (entry.agentBusy === 1) void publish(udid);
  // Asked for while a shutdown is under way: it is for the device going away.
  const generation = entry.shuttingDown ? -1 : entry.bootGeneration;
  try {
    return await enqueue(udid, async () => {
      if (entry.bootGeneration !== generation || entry.shuttingDown) {
        throw new Error('The simulator was shut down. Boot it again to continue.');
      }
      return action();
    });
  } finally {
    entry.agentBusy -= 1;
    if (entry.agentBusy === 0) void publish(udid);
  }
}

export function openPanel(sessionId: string, udid: string): void {
  host?.openPanel(sessionId, udid);
}

/** The device a chat's agent works on when it names none: the one it uses,
 * else a booted one no chat uses. Never another chat's. */
export async function sessionDevice(sessionId: string): Promise<IosSimulatorDevice | null> {
  const devices = await getDevices({ fresh: true });
  const owned = devices.find((device) => record(device.udid).ownerSessionId === sessionId && device.state === 'Booted');
  if (owned) return owned;
  return devices.find((device) => device.state === 'Booted' && !record(device.udid).ownerSessionId) ?? null;
}

/** A device to boot for a chat that names none: one no chat uses, booted
 * first, an iPhone before others. Null when every device is taken. */
export async function freeDevice(): Promise<IosSimulatorDevice | null> {
  const free = (await getDevices({ fresh: true })).filter((device) => !record(device.udid).ownerSessionId);
  const rank = (device: IosSimulatorDevice) => (device.state === 'Booted' ? 0 : 2) + (device.family === 'iPhone' ? 0 : 1);
  return free.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** Which boot of the device this is, as far as Aegis knows: it changes when
 * the device is shut down or restarted. */
export function deviceBootGeneration(udid: string): number {
  return record(udid).bootGeneration;
}

export function deviceOwner(udid: string): string | null {
  return records.get(udid)?.ownerSessionId ?? null;
}

export function claimDevice(udid: string, sessionId: string): void {
  record(udid).ownerSessionId = sessionId;
}

// ===== Agent primitives (points) =====

export interface UiElement {
  type?: string;
  role?: string;
  AXLabel?: string | null;
  AXValue?: string | null;
  AXUniqueId?: string | null;
  title?: string | null;
  enabled?: boolean;
  frame?: { x: number; y: number; width: number; height: number };
  children?: UiElement[];
}

/** The frontmost app's accessibility tree, frames in points. */
export async function describeUi(udid: string): Promise<UiElement[]> {
  const tree = await (await requireHelper()).request<UiElement[] | UiElement>({ cmd: 'describe', udid }, 30_000);
  return Array.isArray(tree) ? tree : [tree];
}

/** The element an agent means by label or id: exact matches first, then
 * buttons and other controls before plain text. */
export function findElement(roots: UiElement[], target: { label?: string; id?: string }): UiElement | null {
  const matches: UiElement[] = [];
  const visit = (node: UiElement) => {
    const hit = target.id
      ? node.AXUniqueId === target.id
      : Boolean(target.label) && (node.AXLabel === target.label || node.title === target.label);
    if (hit && node.frame && node.frame.width > 0 && node.frame.height > 0) matches.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  roots.forEach(visit);
  const rank = (node: UiElement) => (/Button|Cell|Link|Switch|TextField|Tab/i.test(node.type ?? node.role ?? '') ? 0 : 1);
  return matches.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** Taps in the UI's points (what describe_ui and screenshots show). */
export async function agentTap(udid: string, target: { x?: number; y?: number; label?: string; id?: string }): Promise<void> {
  const client = await requireHelper();
  await ensurePointSize(udid);
  await refreshScreen(udid);
  const tapAt = async (_roots: UiElement[] | null, x: number, y: number) => {
    const point = uiToPhysical(udid, uiOrientation(udid), x, y);
    await client.request({ cmd: 'dtap', udid, x: point.x, y: point.y });
  };
  if (target.id || target.label) {
    // The element may still be appearing: look for up to two seconds.
    const deadline = Date.now() + 2_000;
    for (;;) {
      const roots = await describeUi(udid);
      const element = findElement(roots, target);
      if (element?.frame) {
        const { x, y, width, height } = element.frame;
        await tapAt(roots, x + width / 2, y + height / 2);
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`No element with ${target.id ? `id ${target.id}` : `label "${target.label}"`} on screen. Use describe_ui to see what is there.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (typeof target.x === 'number' && typeof target.y === 'number') {
    await tapAt(null, target.x, target.y);
    return;
  }
  throw new Error('tap needs x and y in points, or a label or id from describe_ui.');
}

export async function agentSwipe(
  udid: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  seconds: number
): Promise<void> {
  const client = await requireHelper();
  await ensurePointSize(udid);
  await refreshScreen(udid);
  const orientation = uiOrientation(udid);
  const start = uiToPhysical(udid, orientation, from.x, from.y);
  const end = uiToPhysical(udid, orientation, to.x, to.y);
  // From an edge it is an edge gesture, e.g. a swipe up from the bottom goes home.
  const size = record(udid).pointSize!;
  const landscape = orientation === 'landscape-left' || orientation === 'landscape-right';
  const [width, height] = landscape ? [size.height, size.width] : [size.width, size.height];
  const edge = edgeNear(orientation, from.x, from.y, width, height, IOS_EDGE_REACH);
  await client.request({ cmd: 'dswipe', udid, x: start.x, y: start.y, toX: end.x, toY: end.y, duration: seconds, ...(edge ? { edge } : {}) });
}

export async function agentKey(udid: string, key: keyof typeof HID_KEYCODES): Promise<void> {
  await (await requireHelper()).request({ cmd: 'key', udid, code: HID_KEYCODES[key] });
}

export async function agentButton(udid: string, button: string): Promise<void> {
  await (await requireHelper()).request({ cmd: 'button', udid, button });
}

/** A PNG of the device screen (full resolution). */
export async function captureScreenshot(udid: string): Promise<Buffer> {
  const dir = join(tmpdir(), 'aegis-simulator-shots');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${udid}-${Date.now().toString(36)}.png`);
  try {
    await (await requireHelper()).request({ cmd: 'screenshot', udid, path: file }, 30_000);
    return await readFile(file);
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
}

/** The pane's screenshot button: a PNG on the Desktop, like Simulator.app. */
export async function saveScreenshotToDesktop(udid: string): Promise<string> {
  const device = await getDevice(udid);
  const stamp = new Date().toISOString().replace(/[:T]/g, '.').slice(0, 19);
  const file = join(homedir(), 'Desktop', `Simulator Screenshot - ${device.name} - ${stamp}.png`);
  await (await requireHelper()).request({ cmd: 'screenshot', udid, path: file }, 30_000);
  return file;
}

/** Test seam: a fake helper, simctl and device list (no Xcode needed). */
export function setIosSimulatorTestDoubles(doubles: typeof testDoubles): void {
  testDoubles = doubles;
}

/** Test seam: a device's bookkeeping. */
export function iosSimulatorRecordForTests(udid: string): Readonly<DeviceRecord> {
  return record(udid);
}

/** Test seam. */
export function resetIosSimulatorServiceForTests(): void {
  helper?.stop();
  helper = null;
  testDoubles = null;
  records.clear();
  inputQueues.clear();
  agentAllowed.clear();
  deviceCache = null;
}
