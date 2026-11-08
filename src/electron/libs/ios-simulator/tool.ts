// The ios_simulator tool as agents see it: one schema, description and
// runner shared by Claude's and Qoder's in-process MCP server, the HTTP MCP
// server the other providers reach, and Bubble's host tool.

import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import { nativeImage } from 'electron';
import { orientationDegrees, type IosSimulatorDevice, type IosSimulatorOrientation } from '../../../shared/ios-simulator';
import { getToolchainStatus, isToolchainReadyCached, run } from './toolchain';
import { buildForSimulator } from './build';

/** How long a launched app runs before build_and_run reports on it. */
const LAUNCH_SETTLE_MS = 2_500;
import {
  agentButton,
  agentKey,
  agentSwipe,
  agentTap,
  bootDevice,
  captureScreenshot,
  claimDevice,
  deviceBootGeneration,
  freeDevice,
  deviceOwner as iosSimulatorDeviceOwner,
  describeUi,
  ensurePointSize,
  findDevice,
  getDevices,
  getView,
  isAgentAllowed,
  openPanel,
  refreshScreen,
  rotateDevice,
  runAgentAction,
  sessionDevice,
  setAgentAllowed,
  shutdownDevice,
  typeText,
  uiOrientation,
  type UiElement,
} from './service';

export const IOS_SIMULATOR_TOOL_NAME = 'ios_simulator';

export const IOS_SIMULATOR_ACTIONS = [
  'list_devices',
  'boot',
  'build_and_run',
  'install',
  'launch',
  'terminate',
  'open_url',
  'screenshot',
  'describe_ui',
  'tap',
  'swipe',
  'type',
  'key',
  'button',
  'rotate',
  'shutdown',
] as const;

export type IosSimulatorAction = (typeof IOS_SIMULATOR_ACTIONS)[number];

export const IOS_SIMULATOR_TOOL_DESCRIPTION = [
  "Run and check an iOS app in Apple's iOS Simulator; the user watches the same device in the chat's simulator pane.",
  'Workflow: boot (optionally naming a device such as "iPhone 17 Pro"), which returns the device id;',
  'build_and_run builds the Xcode project in the chat folder for that device, installs and launches it, and reports compiler errors or the app\'s first output (project and scheme when there are several);',
  'or install a .app you built and launch it by bundle id; then screenshot and describe_ui to see the screen;',
  'tap by label or id from describe_ui (preferred) or by x/y in points; type, swipe, key, button; screenshot again to verify.',
  'Screenshot pixels are points, the same space as x/y and describe_ui frames, also when the device is rotated.',
  'A swipe that starts within 20 points of an edge is an edge gesture, as on a device: up from the bottom goes home.',
  "Actions use the chat's device unless device names another; pass device (the id boot returned) on each call to be explicit. The user approves each device once.",
].join(' ');

type Zod = typeof import('zod')['z'];

export function iosSimulatorInputSchema(z: Zod) {
  return {
    action: z.enum(IOS_SIMULATOR_ACTIONS).describe('What to do on the simulator.'),
    device: z.string().optional().describe('Device id or name; default is the device this chat is using.'),
    app_path: z.string().optional().describe('Path to a built .app bundle (install).'),
    bundle_id: z.string().optional().describe('App bundle identifier (launch, terminate).'),
    args: z.array(z.string()).optional().describe('Launch arguments passed to the app (launch).'),
    url: z.string().optional().describe('URL or deep link to open on the device (open_url).'),
    x: z.number().optional().describe('X in points (tap; swipe start).'),
    y: z.number().optional().describe('Y in points (tap; swipe start).'),
    to_x: z.number().optional().describe('Swipe end x in points.'),
    to_y: z.number().optional().describe('Swipe end y in points.'),
    label: z.string().optional().describe('Accessibility label of the element to tap.'),
    id: z.string().optional().describe('Accessibility identifier of the element to tap.'),
    text: z.string().optional().describe('Text to type into the focused field (type).'),
    key: z.enum(['return', 'backspace', 'tab', 'escape']).optional().describe('Key to press (key).'),
    button: z.enum(['home', 'lock', 'siri', 'side-button']).optional().describe('Hardware button to press (button).'),
    orientation: z
      .enum(['portrait', 'landscape-left', 'landscape-right', 'portrait-upside-down'])
      .optional()
      .describe('How to turn the device (rotate).'),
    duration: z.number().optional().describe('Swipe duration in seconds (default 0.3).'),
    project: z.string().optional().describe('The .xcodeproj or .xcworkspace to build (build_and_run), when the folder has several.'),
    scheme: z.string().optional().describe('The scheme to build (build_and_run), when the project has several.'),
    configuration: z.string().optional().describe('Build configuration (build_and_run; default Debug).'),
  };
}

/** Every argument of the tool, for matching an HTTP call to its transcript
 * tool_use (kept equal to iosSimulatorInputSchema by a test). */
export const IOS_SIMULATOR_ARG_KEYS = [
  'action',
  'device',
  'app_path',
  'bundle_id',
  'args',
  'url',
  'x',
  'y',
  'to_x',
  'to_y',
  'label',
  'id',
  'text',
  'key',
  'button',
  'orientation',
  'duration',
  'project',
  'scheme',
  'configuration',
] as const;

export interface IosSimulatorToolArgs {
  action: IosSimulatorAction;
  device?: string;
  app_path?: string;
  bundle_id?: string;
  args?: string[];
  url?: string;
  x?: number;
  y?: number;
  to_x?: number;
  to_y?: number;
  label?: string;
  id?: string;
  text?: string;
  key?: 'return' | 'backspace' | 'tab' | 'escape';
  button?: 'home' | 'lock' | 'siri' | 'side-button';
  orientation?: IosSimulatorOrientation;
  duration?: number;
  project?: string;
  scheme?: string;
  configuration?: string;
}

export type IosSimulatorToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface IosSimulatorToolResult {
  content: IosSimulatorToolContent[];
  isError?: boolean;
}

/** Asks the user, in the chat, to let agents drive a device. */
export type IosSimulatorConsent = (
  sessionId: string,
  device: IosSimulatorDevice,
  signal?: AbortSignal
) => Promise<boolean>;

let consent: IosSimulatorConsent | null = null;

export function setIosSimulatorConsent(next: IosSimulatorConsent | null): void {
  consent = next;
}

/** The folder a chat's agent works in, where build_and_run looks for the app. */
let sessionFolder: ((sessionId: string) => string | null) | null = null;

export function setIosSimulatorSessionFolder(next: ((sessionId: string) => string | null) | null): void {
  sessionFolder = next;
}

/** Whether to offer the tool at all: the Mac can run simulators. */
export async function isIosSimulatorToolAvailable(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const status = await getToolchainStatus().catch(() => null);
  return Boolean(status?.ready);
}

/** The same, from the last check, for tool lists built synchronously. */
export function isIosSimulatorToolAvailableNow(): boolean {
  return process.platform === 'darwin' && isToolchainReadyCached();
}

function text(value: string, isError = false): IosSimulatorToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function describeDevice(device: IosSimulatorDevice): string {
  return `${device.name} (${device.runtime}) id=${device.udid} ${device.state}`;
}

/** The device an action targets: named, the chat's own, or a fresh boot. */
async function resolveDevice(sessionId: string, query: string | undefined): Promise<IosSimulatorDevice | null> {
  if (query) return findDevice(query);
  return sessionDevice(sessionId);
}

async function ensureConsent(sessionId: string, device: IosSimulatorDevice, signal?: AbortSignal): Promise<boolean> {
  if (isAgentAllowed(device.udid)) return true;
  if (!consent) return false;
  const allowed = await consent(sessionId, device, signal);
  if (allowed) setAgentAllowed(device.udid, true);
  return allowed;
}

// ===== Accessibility tree =====

/** One line per element: type, label, value, id and frame in points. */
export function compactUiTree(roots: UiElement[], maxLines = 400): string {
  const lines: string[] = [];
  const visit = (node: UiElement, depth: number) => {
    if (lines.length >= maxLines) return;
    const kind = node.type || node.role?.replace(/^AX/, '') || 'Element';
    const label = node.AXLabel || node.title;
    const parts = [kind];
    if (label) parts.push(JSON.stringify(label.slice(0, 120)));
    if (node.AXValue) parts.push(`value=${JSON.stringify(String(node.AXValue).slice(0, 80))}`);
    if (node.AXUniqueId) parts.push(`id=${node.AXUniqueId}`);
    if (node.enabled === false) parts.push('disabled');
    if (node.frame) {
      const f = node.frame;
      parts.push(`[${Math.round(f.x)},${Math.round(f.y)} ${Math.round(f.width)}x${Math.round(f.height)}]`);
    }
    // Unlabelled groups add depth without meaning: keep only their children.
    const skip = (kind === 'Group' || kind === 'Other') && !label && !node.AXUniqueId && depth > 0;
    if (!skip) lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`);
    for (const child of node.children ?? []) visit(child, skip ? depth : depth + 1);
  };
  for (const root of Array.isArray(roots) ? roots : []) visit(root, 0);
  if (lines.length >= maxLines) lines.push(`… (cut at ${maxLines} elements)`);
  return lines.join('\n');
}

// ===== Screenshots =====

let shotSequence = 0;

/** Turns a BGRA image a multiple of 90 degrees (clockwise when positive). */
export function rotateImage(image: Electron.NativeImage, degrees: number): Electron.NativeImage {
  const turns = (((degrees / 90) % 4) + 4) % 4;
  if (turns === 0) return image;
  const { width, height } = image.getSize();
  const source = image.toBitmap();
  const outWidth = turns % 2 === 0 ? width : height;
  const outHeight = turns % 2 === 0 ? height : width;
  const out = Buffer.alloc(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [nx, ny] = turns === 1 ? [height - 1 - y, x] : turns === 2 ? [width - 1 - x, height - 1 - y] : [y, width - 1 - x];
      source.copy(out, (ny * outWidth + nx) * 4, (y * width + x) * 4, (y * width + x) * 4 + 4);
    }
  }
  return nativeImage.createFromBitmap(out, { width: outWidth, height: outHeight });
}

/** A JPEG of the screen as the app shows it (upright when it turned with the
 * device), at one pixel per point, so x/y read off the image are tap
 * coordinates. Saved to a file for clients that cannot take images. */
async function screenshotContent(
  udid: string,
  inlineImage: boolean
): Promise<IosSimulatorToolContent[]> {
  const png = await captureScreenshot(udid);
  await ensurePointSize(udid);
  await refreshScreen(udid).catch(() => {});
  const view = await getView(udid);
  let image = nativeImage.createFromBuffer(png);
  const points = view.pointSize;
  if (points && image.getSize().width > 0) {
    // The framebuffer is physical portrait: shrink to points, then turn.
    image = image.resize({ width: Math.round(points.width), quality: 'best' });
    if (view.orientation !== 'portrait') image = rotateImage(image, orientationDegrees(uiOrientation(udid)));
  }
  const jpeg = image.toJPEG(80);
  const final = image.getSize();
  const dir = join(tmpdir(), 'aegis-simulator-shots');
  await mkdir(dir, { recursive: true });
  shotSequence += 1;
  const path = join(dir, `screen-${Date.now().toString(36)}-${shotSequence}.jpg`);
  await writeFile(path, jpeg);
  const scaleNote = points
    ? 'Image pixels are points: x/y read off the image can be tapped directly.'
    : `Image pixels are device pixels; divide by the screen scale for points.`;
  const where = inlineImage
    ? `Also saved to ${path}.`
    : `Saved to ${path}. Open that image file (for example with your image viewing or file reading tool) to see it.`;
  const content: IosSimulatorToolContent[] = [
    { type: 'text', text: `Screenshot ${final.width}x${final.height} of ${view.device.name}. ${scaleNote} ${where}` },
  ];
  if (inlineImage) content.push({ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' });
  return content;
}

// ===== Runner =====

/** Build the chat's app for the device, install it and launch it. */
async function buildAndRun(
  sessionId: string,
  udid: string,
  deviceName: string,
  args: IosSimulatorToolArgs,
  signal?: AbortSignal
): Promise<IosSimulatorToolResult> {
  const cwd = sessionFolder?.(sessionId) ?? null;
  if (!cwd && !(args.project && isAbsolute(args.project))) {
    return text('This chat has no project folder; pass project with the absolute path of the .xcodeproj or .xcworkspace.', true);
  }
  // The boot this build is for: if the device is shut down or restarted
  // meanwhile, the app is not installed on whatever runs there afterwards.
  const generation = deviceBootGeneration(udid);
  const result = await buildForSimulator(
    { cwd: cwd ?? '/', udid, project: args.project, scheme: args.scheme, configuration: args.configuration },
    signal
  );
  if (!result.ok && 'tooLong' in result) {
    return text(
      `Building ${result.scheme} takes longer than one call allows, so it was stopped. Run it in your shell, then install the .app and launch it with this tool:\n${result.command}`,
      true
    );
  }
  if (!result.ok) {
    return text(`Build of ${result.scheme} (${result.configuration}) failed after ${result.seconds} s:\n${result.errors}`, true);
  }
  const { app } = result;
  if (!app.bundleId) return text(`Built ${app.appPath}, but could not read its bundle identifier.`, true);
  return runAgentAction(udid, sessionId, async () => {
    if (deviceBootGeneration(udid) !== generation) {
      return text('The simulator was shut down or restarted during the build. Call build_and_run again.', true);
    }
    await run('xcrun', ['simctl', 'install', udid, app.appPath], { timeoutMs: 180_000, signal });
    const launched = await launchWithOutput(udid, app.bundleId, args.args ?? [], signal);
    const lines = [
      `Built ${result.scheme} (${result.configuration}) in ${result.seconds} s, installed ${app.bundleId} and launched it on ${deviceName}.`,
    ];
    if (launched.crashed) lines.push('The app is no longer running: it crashed or exited right after launch.');
    if (launched.output) lines.push(`Its output so far:\n${launched.output}`);
    lines.push(launched.crashed ? 'Fix it and call build_and_run again.' : 'Take a screenshot to see it.');
    return text(lines.join('\n'), launched.crashed);
  });
}

/** Launch an app with its stdout and stderr in files, then report the first
 * lines it printed and whether it is still running a moment later. The
 * files sit in the app's own data container: the app is sandboxed and
 * cannot open paths elsewhere. */
async function launchWithOutput(
  udid: string,
  bundleId: string,
  argv: string[],
  signal?: AbortSignal
): Promise<{ output: string; crashed: boolean }> {
  const container = await run('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'data'], { timeoutMs: 20_000 })
    .then(({ stdout }) => stdout.trim())
    .catch(() => '');
  const stamp = `aegis-launch-${Date.now().toString(36)}`;
  const outFile = container ? join(container, 'tmp', `${stamp}.out`) : '';
  const errFile = container ? join(container, 'tmp', `${stamp}.err`) : '';
  if (container) await mkdir(join(container, 'tmp'), { recursive: true }).catch(() => {});
  try {
    await run(
      'xcrun',
      ['simctl', 'launch', '--terminate-running-process', ...(container ? [`--stdout=${outFile}`, `--stderr=${errFile}`] : []), udid, bundleId, ...argv],
      // Unbuffered, as when Xcode runs it: print() reaches the file at once.
      { timeoutMs: 60_000, signal, env: { ...process.env, SIMCTL_CHILD_NSUnbufferedIO: 'YES' } }
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, LAUNCH_SETTLE_MS));
    const read = (file: string) => (file ? readFile(file, 'utf8').catch(() => '') : Promise.resolve(''));
    const output = [await read(outFile), await read(errFile)]
      .join('\n')
      .split('\n')
      .filter((line) => line.trim())
      .slice(-20)
      .map((line) => line.slice(0, 300))
      .join('\n');
    // launchctl in the simulator lists a running app with its pid; one that
    // crashed is gone from the list (or shows "-"). An iOS app does not quit
    // by itself, so not running moments after launch is a crash.
    const list = await run('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], { timeoutMs: 15_000 }).catch(() => null);
    const entry = list?.stdout.split('\n').find((line) => line.includes(`UIKitApplication:${bundleId}[`));
    const crashed = list ? !entry || entry.trim().split(/\s+/)[0] === '-' : false;
    return { output, crashed };
  } finally {
    if (outFile) await rm(outFile, { force: true }).catch(() => {});
    if (errFile) await rm(errFile, { force: true }).catch(() => {});
  }
}

export async function runIosSimulatorTool(
  sessionId: string,
  args: IosSimulatorToolArgs,
  options: {
    inlineImage: boolean;
    signal?: AbortSignal;
    /** False when the call was matched to its chat by its contents only (a
     * provider runtime shared by many chats, e.g. Kimi): such a call relies
     * on nothing chosen for "this chat", so a mismatch cannot reach another
     * chat's device or folder. It names its device, and build_and_run its
     * project by absolute path. */
    verifiedCaller?: boolean;
  }
): Promise<IosSimulatorToolResult> {
  const verified = options.verifiedCaller !== false;
  if (!verified && args.action !== 'list_devices') {
    if (!args.device) return text('Pass device on this call: a device id from list_devices.', true);
    if (args.action === 'build_and_run' && !(args.project && isAbsolute(args.project))) {
      return text('Pass project on this call: the absolute path of the .xcodeproj or .xcworkspace.', true);
    }
  }
  try {
    const status = await getToolchainStatus();
    if (!status.ready) {
      return text(`The iOS Simulator is not set up on this Mac (missing: ${status.missing.join(', ')}). Open the simulator pane for the setup steps.`, true);
    }
    if (args.action === 'list_devices') {
      const devices = await getDevices({ fresh: true });
      if (devices.length === 0) return text('No iOS simulators are installed. Install an iOS runtime in Xcode > Settings > Components.');
      return text(devices.map(describeDevice).join('\n'));
    }

    let device = await resolveDevice(sessionId, args.device);
    if (!device && args.device) return text(`No simulator matches "${args.device}". Use list_devices.`, true);
    if (!device) {
      if (args.action !== 'boot' && args.action !== 'build_and_run') {
        return text('This chat has no booted simulator yet. Call boot first (optionally with a device name).', true);
      }
      device = await freeDevice();
      if (!device) {
        const installed = (await getDevices({ fresh: true })).length;
        return text(
          installed
            ? 'Every simulator is in use by another chat. Pass device (from list_devices) to share one, or add a simulator in Xcode.'
            : 'No iOS simulators are installed.',
          true
        );
      }
    }
    if (!(await ensureConsent(sessionId, device, options.signal))) {
      return text(`The user did not allow agents to use ${device.name}.`, true);
    }
    const udid = device.udid;
    // Picked for this chat while the user was asked: another chat may have
    // taken it meanwhile, and an implicit pick never shares.
    const owner = iosSimulatorDeviceOwner(udid);
    if (!args.device && owner && owner !== sessionId) {
      return text(`${device.name} was just taken by another chat. Call again for a free simulator, or pass device to share it.`, true);
    }
    // A device is this chat's if no chat uses it yet. Naming another chat's
    // device shares it for this call; it never moves it to this chat.
    if (!owner) claimDevice(udid, sessionId);

    if (args.action === 'boot') {
      const view = await bootDevice(udid, sessionId);
      openPanel(sessionId, udid);
      return text(`Booted ${describeDevice(view.device)}. Build with -destination 'id=${udid}'.`);
    }
    if (args.action === 'build_and_run') {
      if (device.state !== 'Booted') await bootDevice(udid, sessionId);
      openPanel(sessionId, udid);
      return await buildAndRun(sessionId, udid, device.name, args, options.signal);
    }
    if (device.state !== 'Booted') {
      return text(`${device.name} is not booted. Call boot first.`, true);
    }

    return await runAgentAction(udid, sessionId, async () => {
      switch (args.action) {
        case 'install': {
          if (!args.app_path) return text('install needs app_path, the built .app bundle.', true);
          await run('xcrun', ['simctl', 'install', udid, args.app_path], { timeoutMs: 180_000, signal: options.signal });
          openPanel(sessionId, udid);
          return text(`Installed ${args.app_path} on ${device!.name}.`);
        }
        case 'launch': {
          if (!args.bundle_id) return text('launch needs bundle_id.', true);
          const { stdout } = await run(
            'xcrun',
            ['simctl', 'launch', '--terminate-running-process', udid, args.bundle_id, ...(args.args ?? [])],
            { timeoutMs: 60_000, signal: options.signal }
          );
          openPanel(sessionId, udid);
          return text(`Launched ${args.bundle_id} on ${device!.name} (${stdout.trim() || 'running'}). Take a screenshot to see it.`);
        }
        case 'terminate': {
          if (!args.bundle_id) return text('terminate needs bundle_id.', true);
          await run('xcrun', ['simctl', 'terminate', udid, args.bundle_id], { timeoutMs: 30_000 });
          return text(`Terminated ${args.bundle_id}.`);
        }
        case 'open_url': {
          if (!args.url) return text('open_url needs url.', true);
          await run('xcrun', ['simctl', 'openurl', udid, args.url], { timeoutMs: 30_000 });
          openPanel(sessionId, udid);
          return text(`Opened ${args.url} on ${device!.name}.`);
        }
        case 'screenshot':
          return { content: await screenshotContent(udid, options.inlineImage) };
        case 'describe_ui': {
          const tree = await describeUi(udid);
          return text(`UI of ${device!.name} (frames in points):\n${compactUiTree(tree)}`);
        }
        case 'tap': {
          await agentTap(udid, { x: args.x, y: args.y, label: args.label, id: args.id });
          const where = args.id ? `id ${args.id}` : args.label ? `"${args.label}"` : `(${args.x}, ${args.y})`;
          return text(`Tapped ${where}.`);
        }
        case 'swipe': {
          if ([args.x, args.y, args.to_x, args.to_y].some((value) => typeof value !== 'number')) {
            return text('swipe needs x, y, to_x and to_y in points.', true);
          }
          await agentSwipe(udid, { x: args.x!, y: args.y! }, { x: args.to_x!, y: args.to_y! }, args.duration ?? 0.3);
          return text(`Swiped from (${args.x}, ${args.y}) to (${args.to_x}, ${args.to_y}).`);
        }
        case 'type': {
          if (!args.text) return text('type needs text.', true);
          await typeText(udid, args.text);
          return text(`Typed ${args.text.length} characters.`);
        }
        case 'key': {
          if (!args.key) return text('key needs key.', true);
          await agentKey(udid, args.key);
          return text(`Pressed ${args.key}.`);
        }
        case 'button': {
          if (!args.button) return text('button needs button.', true);
          await agentButton(udid, args.button);
          return text(`Pressed ${args.button}.`);
        }
        case 'rotate': {
          if (!args.orientation) return text('rotate needs orientation.', true);
          await rotateDevice(udid, args.orientation);
          return text(`Turned ${device!.name} to ${args.orientation}. Apps that support it rotate; screenshot to see.`);
        }
        case 'shutdown': {
          await shutdownDevice(udid);
          return text(`Shut down ${device!.name}.`);
        }
        default:
          return text(`Unknown action ${String(args.action)}.`, true);
      }
    });
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true);
  }
}
