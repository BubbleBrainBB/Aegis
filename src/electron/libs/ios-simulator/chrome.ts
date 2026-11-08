// A simulator's outline from the simulator's own data, read from the Xcode
// on this Mac (nothing of Apple's is shipped with Aegis):
//
// - the device type's profile names its DeviceKit chrome (the body
//   Simulator.app draws) and its framebuffer mask (the screen's exact shape);
// - the chrome's chrome.json gives the body's corner radius, the bezel and
//   every hardware button's place along the edges;
// - PDF sizes are read with sips, and the mask is rasterized with it (the
//   mask PDF is drawn at the screen's pixel size, so it stays sharp).

import { existsSync } from 'fs';
import { mkdir, readFile, readdir, rm } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import type { IosCornerRadii, IosDeviceButton, IosDeviceChrome } from '../../../shared/ios-simulator';
import { run } from './toolchain';

interface ChromeJson {
  images?: {
    composite?: string;
    sizing?: { leftWidth?: number; rightWidth?: number; topHeight?: number; bottomHeight?: number };
    devicePadding?: { top?: number; left?: number; bottom?: number; right?: number };
  };
  paths?: { simpleOutsideBorder?: { cornerRadiusX?: number } };
  inputs?: Array<{
    name?: string;
    accessibilityTitle?: string;
    type?: string;
    usagePage?: number;
    usage?: number;
    image?: string;
    anchor?: string;
    align?: string;
    offsets?: { normal?: { x?: number; y?: number }; rollover?: { x?: number; y?: number } };
  }>;
}

const CHROME_DIRS = ['/Library/Developer/DeviceKit/Chrome', join(homedir(), 'Library/Developer/DeviceKit/Chrome')];

let deviceTypePaths: Promise<Map<string, string>> | null = null;
const cache = new Map<string, Promise<IosDeviceChrome | null>>();

function bundlePaths(): Promise<Map<string, string>> {
  if (!deviceTypePaths) {
    deviceTypePaths = run('xcrun', ['simctl', 'list', 'devicetypes', '-j'], { timeoutMs: 30_000 })
      .then(({ stdout }) => {
        const parsed = JSON.parse(stdout) as { devicetypes?: Array<{ identifier: string; bundlePath: string }> };
        return new Map((parsed.devicetypes ?? []).map((type) => [type.identifier, type.bundlePath]));
      })
      .catch((error) => {
        deviceTypePaths = null;
        throw error;
      });
  }
  return deviceTypePaths;
}

async function plist(path: string): Promise<Record<string, unknown>> {
  const { stdout } = await run('plutil', ['-convert', 'json', '-o', '-', path], { timeoutMs: 10_000 });
  return JSON.parse(stdout) as Record<string, unknown>;
}

/** A PDF page's size in points (a PDF's pixel size at 72 dpi). */
export async function pdfSize(path: string): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { timeoutMs: 10_000 });
    const width = Number(/pixelWidth:\s*([\d.]+)/.exec(stdout)?.[1]);
    const height = Number(/pixelHeight:\s*([\d.]+)/.exec(stdout)?.[1]);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

async function rasterize(pdf: string, key: string): Promise<string | null> {
  const dir = join(tmpdir(), 'aegis-simulator-chrome');
  await mkdir(dir, { recursive: true });
  const png = join(dir, `${key.replace(/[^\w.-]/g, '_')}.png`);
  try {
    if (!existsSync(png)) await run('sips', ['-s', 'format', 'png', pdf, '--out', png], { timeoutMs: 20_000 });
    return `data:image/png;base64,${(await readFile(png)).toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Lay out a chrome: body, the screen inside it, and the buttons. Pure, so
 * it is tested without Xcode.
 */
export function layoutChrome(
  chrome: ChromeJson,
  body: { width: number; height: number },
  screen: { width: number; height: number },
  buttonSizes: Map<string, { width: number; height: number }>,
  maskUrl: string | null
): IosDeviceChrome {
  const sizing = chrome.images?.sizing ?? {};
  const padding = chrome.images?.devicePadding ?? {};
  const spareX = Math.max(0, body.width - screen.width);
  const spareY = Math.max(0, body.height - screen.height);
  const share = (a?: number, b?: number) => (a !== undefined && b !== undefined && a + b > 0 ? a / (a + b) : 0.5);
  const buttons: IosDeviceButton[] = [];
  const pad = { top: padding.top ?? 0, left: padding.left ?? 0, bottom: padding.bottom ?? 0, right: padding.right ?? 0 };
  for (const input of chrome.inputs ?? []) {
    if (input.type !== 'button' || !input.name || !input.image) continue;
    const size = buttonSizes.get(input.image);
    if (!size) continue;
    const normal = input.offsets?.normal ?? {};
    const rollover = input.offsets?.rollover ?? normal;
    const hid = typeof input.usagePage === 'number' && typeof input.usage === 'number' ? { page: input.usagePage, usage: input.usage } : null;
    const base = { name: input.name, title: input.accessibilityTitle ?? input.name, hid };
    // Offsets place the button image in a canvas padded around the body:
    // leading offsets count from the canvas's top or left, trailing ones
    // back from its bottom or right, and a centered one sits on the front.
    if (input.align === 'center') {
      const x = (body.width - size.width) / 2 + (normal.x ?? 0);
      const y = (normal.y ?? 0) < 0 ? body.height + pad.bottom + (normal.y ?? 0) : (normal.y ?? 0) - pad.top;
      buttons.push({ ...base, side: 'face', offset: 0, length: size.width, protrude: 0, protrudeHover: 0, rect: { x, y, width: size.width, height: size.height } });
      continue;
    }
    const side = input.anchor === 'right' || input.anchor === 'top' || input.anchor === 'bottom' ? input.anchor : 'left';
    const vertical = side === 'left' || side === 'right';
    const length = vertical ? size.height : size.width;
    const along = (vertical ? normal.y : normal.x) ?? 0;
    const offset = input.align === 'trailing'
      ? (vertical ? body.height + pad.bottom : body.width + pad.right) - Math.abs(along) - length
      : along - (vertical ? pad.top : pad.left);
    // What shows outside the body is the padding less the offset across.
    const outward = side === 'left' ? pad.left : side === 'right' ? pad.right : side === 'top' ? pad.top : pad.bottom;
    const across = (point: { x?: number; y?: number }) => Math.abs((vertical ? point.x : point.y) ?? 0);
    buttons.push({
      ...base,
      side,
      offset,
      length,
      protrude: Math.max(2.5, outward - across(normal)),
      protrudeHover: Math.max(4, outward - across(rollover)),
    });
  }
  return {
    body: { width: body.width, height: body.height, radius: chrome.paths?.simpleOutsideBorder?.cornerRadiusX ?? 0 },
    screen: {
      x: spareX * share(sizing.leftWidth, sizing.rightWidth),
      y: spareY * share(sizing.topHeight, sizing.bottomHeight),
      width: screen.width,
      height: screen.height,
    },
    maskUrl,
    buttons,
  };
}

/**
 * The screen's corner radius, in screen points, from where the mask turns
 * opaque along the top-left diagonal: for a round corner of radius r that
 * is r(1 − 1/√2) in from each edge. Measured on the diagonal, where an
 * outline that is not concentric with the screen shows first.
 */
export function cornerRadiusFromInset(insetPixels: number, maskWidth: number, screenWidth: number): number {
  return (insetPixels / (1 - Math.SQRT1_2)) * (screenWidth / maskWidth);
}

/** Diagonal insets of the mask's four corners, in pixels. */
export interface MaskInsets {
  width: number;
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

/** The mask's corner insets, read from an uncompressed BMP of it (sips
 * writes 32-bit BGRA, bottom-up). Each corner is read on its own: a
 * foldable's screen is square on the hinge side. */
async function maskDiagonalInset(pdf: string): Promise<MaskInsets | null> {
  const dir = join(tmpdir(), 'aegis-simulator-chrome');
  await mkdir(dir, { recursive: true });
  const bmp = join(dir, `inset-${Date.now().toString(36)}.bmp`);
  try {
    await run('sips', ['-s', 'format', 'bmp', pdf, '--out', bmp], { timeoutMs: 20_000 });
    const data = await readFile(bmp);
    const offset = data.readUInt32LE(10);
    const width = data.readInt32LE(18);
    const rawHeight = data.readInt32LE(22);
    const bitsPerPixel = data.readUInt16LE(28);
    if (bitsPerPixel !== 32) return null;
    const height = Math.abs(rawHeight);
    const rowBytes = Math.ceil((width * 4) / 4) * 4;
    const alpha = (x: number, y: number) => data[offset + (rawHeight > 0 ? height - 1 - y : y) * rowBytes + x * 4 + 3];
    const inset = (toX: (i: number) => number, toY: (i: number) => number) => {
      for (let i = 0; i < Math.min(width, height) / 2; i += 1) if (alpha(toX(i), toY(i)) > 128) return i;
      return 0;
    };
    return {
      width,
      topLeft: inset((i) => i, (i) => i),
      topRight: inset((i) => width - 1 - i, (i) => i),
      bottomRight: inset((i) => width - 1 - i, (i) => height - 1 - i),
      bottomLeft: inset((i) => i, (i) => height - 1 - i),
    };
  } catch {
    return null;
  } finally {
    await rm(bmp, { force: true }).catch(() => {});
  }
}

/** A body holds a screen when the screen fits with a bezel-sized margin. */
export function holds(body: { width: number; height: number }, screen: { width: number; height: number }): boolean {
  const spareX = body.width - screen.width;
  const spareY = body.height - screen.height;
  return spareX >= 0 && spareY >= 0 && spareX <= Math.max(150, screen.width * 0.3) && spareY <= Math.max(260, screen.height * 0.35);
}

/**
 * The framebuffer mask for the display being streamed. Device types list
 * one mask; a foldable carries one per display, told apart by shape.
 */
async function pickMask(
  resources: string,
  named: string | null,
  sensorBar: string | null,
  screen: { width: number; height: number }
): Promise<string | null> {
  const aspect = screen.width / screen.height;
  const candidates = (await readdir(resources).catch(() => [] as string[])).filter(
    (file) => file.endsWith('.pdf') && file !== `${sensorBar}.pdf`
  );
  let best: { file: string; error: number } | null = null;
  for (const file of candidates) {
    const size = await pdfSize(join(resources, file));
    if (!size) continue;
    const error = Math.abs(size.width / size.height - aspect) / aspect;
    // The named mask wins a tie.
    const score = error - (file === `${named}.pdf` ? 0.001 : 0);
    if (!best || score < best.error) best = { file, error: score };
  }
  return best && best.error < 0.02 ? best.file : null;
}

/** The shown screen's own chrome and mask, when the simulator names them
 * (a foldable's inner screen has its own). */
export interface ScreenChromeIds {
  chromeIdentifier?: string;
  maskIdentifier?: string;
}

async function loadChrome(deviceType: string, screen: { width: number; height: number }, ids: ScreenChromeIds): Promise<IosDeviceChrome | null> {
  const bundle = (await bundlePaths()).get(deviceType);
  if (!bundle) return null;
  const resources = join(bundle, 'Contents', 'Resources');
  const profile = await plist(join(resources, 'profile.plist'));
  const chromeId = ids.chromeIdentifier ?? (typeof profile.chromeIdentifier === 'string' ? profile.chromeIdentifier : null);
  const maskName = ids.maskIdentifier ?? (typeof profile.framebufferMask === 'string' ? profile.framebufferMask : null);
  const sensorBar = typeof profile.sensorBarImage === 'string' ? profile.sensorBarImage : null;
  const maskPdf = await pickMask(resources, maskName, sensorBar, screen);
  const maskUrl = maskPdf ? await rasterize(join(resources, maskPdf), `${deviceType}-${maskPdf}`) : null;
  const chromeDir = chromeId
    ? CHROME_DIRS.map((dir) => join(dir, `${chromeId.split('.').pop()}.devicechrome`, 'Contents', 'Resources')).find((dir) =>
        existsSync(join(dir, 'chrome.json'))
      )
    : undefined;
  if (!chromeDir) return null;
  const chrome = JSON.parse(await readFile(join(chromeDir, 'chrome.json'), 'utf8')) as ChromeJson;
  // The body: the composite image when it holds the screen; else the nine
  // slices' sizing around the screen (older chromes, and resizable ones
  // drawn for a display of another size, like a foldable's inner screen).
  // A chrome the screen did not name and that cannot hold it describes
  // another display: the screen gets an outline of its own, no buttons.
  const composite = chrome.images?.composite ? await pdfSize(join(chromeDir, `${chrome.images.composite}.pdf`)) : null;
  const sizing = chrome.images?.sizing;
  const sliced = sizing
    ? {
        width: screen.width + (sizing.leftWidth ?? 0) + (sizing.rightWidth ?? 0),
        height: screen.height + (sizing.topHeight ?? 0) + (sizing.bottomHeight ?? 0),
      }
    : null;
  const body = composite && holds(composite, screen) ? composite : ids.chromeIdentifier || !composite ? sliced : null;
  if (!body || !holds(body, screen)) {
    const bezel = 16;
    return concentric({
      body: { width: screen.width + bezel * 2, height: screen.height + bezel * 2, radius: Math.min(chrome.paths?.simpleOutsideBorder?.cornerRadiusX ?? 60, Math.min(screen.width, screen.height) * 0.12) + bezel },
      screen: { x: bezel, y: bezel, ...screen },
      maskUrl,
      buttons: [],
    }, maskPdf ? await maskDiagonalInset(join(resources, maskPdf)) : null);
  }
  const images = [...new Set((chrome.inputs ?? []).map((input) => input.image).filter((name): name is string => Boolean(name)))];
  const sizes = new Map<string, { width: number; height: number }>();
  await Promise.all(
    images.map(async (name) => {
      const size = await pdfSize(join(chromeDir, `${name}.pdf`));
      if (size) sizes.set(name, size);
    })
  );
  const outline = layoutChrome(chrome, body, screen, sizes, maskUrl);
  return concentric(outline, maskPdf ? await maskDiagonalInset(join(resources, maskPdf)) : null);
}

/**
 * The body's corners follow the screen's: its radius is the screen's corner
 * radius (measured off the mask) plus the bezel, so the bezel is as thick at
 * the corners as along the sides. chrome.json's radius is in the units its
 * images are drawn in, which for resizable chromes (a foldable's inner
 * screen) are not the screen's points.
 */
export function concentric(outline: IosDeviceChrome, insets: MaskInsets | null): IosDeviceChrome {
  if (!insets) return outline;
  const { screen, body } = outline;
  const left = screen.x;
  const top = screen.y;
  const right = body.width - screen.x - screen.width;
  const bottom = body.height - screen.y - screen.height;
  const corner = (pixels: number, bezelA: number, bezelB: number) =>
    Math.round((cornerRadiusFromInset(pixels, insets.width, screen.width) + Math.min(bezelA, bezelB)) * 10) / 10;
  const radii: IosCornerRadii = {
    topLeft: corner(insets.topLeft, left, top),
    topRight: corner(insets.topRight, right, top),
    bottomRight: corner(insets.bottomRight, right, bottom),
    bottomLeft: corner(insets.bottomLeft, left, bottom),
  };
  const same = Object.values(radii).every((value) => Math.abs(value - radii.topLeft) < 1);
  return { ...outline, body: { ...body, radius: radii.topLeft, ...(same ? {} : { radii }) } };
}

/** The outline for a device type, or null when Xcode has none for it. */
export function getDeviceChrome(
  deviceType: string,
  screen: { width: number; height: number },
  ids: ScreenChromeIds = {}
): Promise<IosDeviceChrome | null> {
  const key = `${deviceType}@${screen.width}x${screen.height}@${ids.chromeIdentifier ?? ''}@${ids.maskIdentifier ?? ''}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = loadChrome(deviceType, screen, ids).catch((error) => {
      console.warn('[ios-simulator] no device chrome for', deviceType, String(error).slice(0, 200));
      cache.delete(key);
      return null;
    });
    cache.set(key, entry);
  }
  return entry;
}
