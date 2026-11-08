// iOS Simulator pane: types shared by the main process, the preload bridge
// and the renderer. The main process drives Apple's simulators through
// `xcrun simctl` and aegis-sim-helper (native/ios-sim-helper); the renderer
// decodes the helper's H.264 frames and sends input in normalized screen
// coordinates.

export const IOS_SIMULATOR_CHANNELS = {
  status: 'ios-simulator:status',
  project: 'ios-simulator:project',
  devices: 'ios-simulator:devices',
  view: 'ios-simulator:view',
  boot: 'ios-simulator:boot',
  shutdown: 'ios-simulator:shutdown',
  attach: 'ios-simulator:attach',
  detach: 'ios-simulator:detach',
  input: 'ios-simulator:input',
  /** renderer → main, fire and forget: a live touch from the pane. */
  touch: 'ios-simulator:touch',
  /** renderer → main: the decoder needs a keyframe to (re)start. */
  keyframe: 'ios-simulator:keyframe',
  screenshot: 'ios-simulator:screenshot',
  chrome: 'ios-simulator:chrome',
  setAgentAccess: 'ios-simulator:set-agent-access',
  /** main → renderer: one H.264 access unit of an attached device. */
  frame: 'ios-simulator:frame',
  /** main → renderer: a device's view state changed. */
  state: 'ios-simulator:state',
} as const;

/** The tab id prefix of a device pane: `simulator:<udid>`. */
export const IOS_SIMULATOR_TAB_PREFIX = 'simulator:';

/** `helper`: aegis-sim-helper is not built (development checkouts only;
 * packaged apps ship it). */
export type IosSimulatorSetupStep = 'macos' | 'xcode' | 'runtime' | 'helper';

export interface IosSimulatorStatus {
  /** Every requirement is met: devices can be listed, streamed and driven. */
  ready: boolean;
  /** Requirements that are missing, in the order to fix them. */
  missing: IosSimulatorSetupStep[];
  xcodePath: string | null;
  helperPath: string | null;
}

export interface IosSimulatorDevice {
  udid: string;
  name: string;
  /** e.g. "iOS 26.1" */
  runtime: string;
  /** CoreSimulator state: Booted, Shutdown, Booting, Shutting Down. */
  state: string;
  family: 'iPhone' | 'iPad' | 'other';
  /** CoreSimulator device type, e.g. com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro. */
  deviceType?: string;
}

/** What a pane shows about one device. */
export interface IosSimulatorView {
  device: IosSimulatorDevice;
  /** The chat whose agent started or uses this device. */
  ownerSessionId: string | null;
  /** Aegis booted it, so Aegis shuts it down when it quits. */
  bootedByAegis: boolean;
  /** Agents may tap, type and take screenshots on it. */
  agentAllowed: boolean;
  /** An agent action is running on the device right now. */
  agentBusy: boolean;
  /** Screen size in points, portrait, when known. */
  pointSize: { width: number; height: number } | null;
  /** How the device is turned. The stream stays in the physical portrait
   * framebuffer; the pane turns the picture to match. */
  orientation: IosSimulatorOrientation;
  /** The pane's stream is live. False with the device booted means it was
   * restarted outside Aegis: the pane offers to reconnect. */
  streaming: boolean;
}

/**
 * A device's outline from the simulator's own data (points, portrait): the
 * body Simulator.app draws (Xcode's DeviceKit chrome), where the screen sits
 * in it, the screen's exact shape (the device type's framebuffer mask), and
 * the hardware buttons along its edges.
 */
export interface IosDeviceChrome {
  /** radius: one radius for every corner; radii, when the corners differ
   * (a foldable's hinge side is square), win over it. */
  body: { width: number; height: number; radius: number; radii?: IosCornerRadii };
  screen: { x: number; y: number; width: number; height: number };
  /** PNG data URL: opaque where the screen shows, clear in its corners. */
  maskUrl: string | null;
  buttons: IosDeviceButton[];
}

export interface IosCornerRadii {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

export interface IosDeviceButton {
  name: string;
  title: string;
  /** An edge, or `face` for a button on the front (the Home button). */
  side: 'left' | 'right' | 'top' | 'bottom' | 'face';
  /** From the body's top (left and right sides) or left (top and bottom). */
  offset: number;
  length: number;
  /** For `face` buttons: where on the front, in body points. */
  rect?: { x: number; y: number; width: number; height: number };
  /** How far it stands out from the body, at rest and under the pointer. */
  protrude: number;
  protrudeHover: number;
  /** The HID usage it sends when pressed (Xcode's own, from chrome.json). */
  hid: { page: number; usage: number } | null;
}

export interface IosSimulatorProjectInfo {
  /** The folder holds an Xcode project, workspace or an iOS Swift package. */
  isIosProject: boolean;
}

/** Discrete input from the pane. Coordinates are 0..1 fractions of the screen. */
export type IosSimulatorInput =
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: 'return' | 'backspace' | 'tab' | 'escape' }
  | { kind: 'button'; button: 'home' | 'lock' | 'siri' }
  /** A hardware button by HID usage, as the device outline names it. */
  | { kind: 'hardware'; page: number; usage: number }
  | { kind: 'rotate'; orientation: IosSimulatorOrientation };

export type IosSimulatorOrientation = 'portrait' | 'landscape-left' | 'portrait-upside-down' | 'landscape-right';

/** A finger on the pane's screen, sent as it moves: 0..1 fractions of the
 * physical (portrait) screen. */
export interface IosSimulatorTouch {
  udid: string;
  phase: 'down' | 'move' | 'up';
  x: number;
  y: number;
  /** On 'down': the physical screen edge the finger starts on, if any. */
  edge?: IosScreenEdge;
}

/**
 * A screen edge as the simulator's digitizer names it (IndigoHIDEdge), always
 * of the physical portrait screen. iOS needs it on a touch that starts at an
 * edge to run its edge gestures: without `bottom` a swipe up from the home
 * indicator is an ordinary drag. Values checked against Xcode 27: 3 sends an
 * upright app home, 2 a landscape-right one (its UI bottom is physical left).
 */
export const IOS_SCREEN_EDGES = { none: 0, top: 1, left: 2, bottom: 3, right: 4 } as const;
export type IosScreenEdge = (typeof IOS_SCREEN_EDGES)[keyof typeof IOS_SCREEN_EDGES];

/** How near an edge, in points, a touch counts as starting on it. The home
 * indicator sits about 8 points above the bottom. */
export const IOS_EDGE_REACH = 20;

/** The physical edge a touch at (x, y) of the shown screen starts on, if it
 * is within `reach` of one (any unit; outside the screen counts too). */
export function edgeNear(
  orientation: IosSimulatorOrientation,
  x: number,
  y: number,
  width: number,
  height: number,
  reach: number
): IosScreenEdge | undefined {
  const distances = [
    ['top', y],
    ['left', x],
    ['bottom', height - y],
    ['right', width - x],
  ] as const;
  const [side, distance] = distances.reduce((nearest, next) => (next[1] < nearest[1] ? next : nearest));
  return distance < reach ? physicalEdge(orientation, side) : undefined;
}

/** The physical edge under a shown edge, for the screen as it is turned. */
export function physicalEdge(orientation: IosSimulatorOrientation, shown: 'top' | 'left' | 'bottom' | 'right'): IosScreenEdge {
  const middle = { top: [0.5, 0], left: [0, 0.5], bottom: [0.5, 1], right: [1, 0.5] }[shown];
  const point = shownToPhysical(orientation, middle[0], middle[1]);
  if (point.y === 0) return IOS_SCREEN_EDGES.top;
  if (point.x === 0) return IOS_SCREEN_EDGES.left;
  if (point.y === 1) return IOS_SCREEN_EDGES.bottom;
  return IOS_SCREEN_EDGES.right;
}

export interface IosSimulatorFrameEvent {
  udid: string;
  keyFrame: boolean;
  /** Encoded size in pixels. */
  width: number;
  height: number;
  /** One H.264 access unit, Annex B (SPS/PPS in front of keyframes). */
  data: Uint8Array;
}

export interface IosSimulatorSessionInput {
  udid: string;
  sessionId: string;
}

export function iosSimulatorTabId(udid: string): `simulator:${string}` {
  return `${IOS_SIMULATOR_TAB_PREFIX}${udid}` as `simulator:${string}`;
}

export function iosSimulatorTabUdid(tab: string | null | undefined): string | null {
  if (!tab?.startsWith(IOS_SIMULATOR_TAB_PREFIX)) return null;
  const udid = tab.slice(IOS_SIMULATOR_TAB_PREFIX.length);
  return udid && udid !== 'pick' ? udid : null;
}

/** Compare dotted versions: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * A point on the screen as shown, upright for the device's orientation, to
 * the physical portrait framebuffer (both as 0..1 fractions). HID input is
 * always physical; the picture is turned for display.
 */
export function shownToPhysical(orientation: IosSimulatorOrientation, x: number, y: number): { x: number; y: number } {
  switch (orientation) {
    case 'landscape-right':
      return { x: 1 - y, y: x };
    case 'landscape-left':
      return { x: y, y: 1 - x };
    case 'portrait-upside-down':
      return { x: 1 - x, y: 1 - y };
    default:
      return { x, y };
  }
}

/** Degrees to turn the physical picture so it shows upright. */
export function orientationDegrees(orientation: IosSimulatorOrientation): number {
  switch (orientation) {
    case 'landscape-right':
      return -90;
    case 'landscape-left':
      return 90;
    case 'portrait-upside-down':
      return 180;
    default:
      return 0;
  }
}

/** The WebCodecs codec string (`avc1.PPCCLL`) from the SPS in an Annex B
 * access unit, or null when it carries none. */
export function h264CodecString(annexB: Uint8Array): string | null {
  for (let i = 0; i + 4 < annexB.length; i += 1) {
    const three = annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1;
    const four = annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 0 && annexB[i + 3] === 1;
    if (!three && !four) continue;
    const start = i + (four ? 4 : 3);
    if ((annexB[start] & 0x1f) === 7 && start + 3 < annexB.length) {
      const hex = (value: number) => value.toString(16).padStart(2, '0');
      return `avc1.${hex(annexB[start + 1])}${hex(annexB[start + 2])}${hex(annexB[start + 3])}`;
    }
    i = start - 1;
  }
  return null;
}
