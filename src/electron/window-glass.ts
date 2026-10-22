import { BrowserWindow, nativeTheme, type BrowserWindowConstructorOptions } from 'electron';
import path from 'node:path';

/**
 * Glass window material. On macOS 27 nothing blurs behind a window except
 * Liquid Glass (NSGlassEffectView), which Electron has no API for, so a small
 * native module puts one under the web contents. It only shows through a
 * window created `transparent: true` — a choice Electron makes once, at
 * creation — so the saved theme decides it when a window opens and turning
 * glass on or off takes effect in new windows (after a restart for the main one).
 */

type Variant = 'light' | 'dark';
type Material = 'glass' | 'solid';

interface LiquidGlassAddon {
  isSupported(): boolean;
  setGlass(handle: Buffer, enabled: boolean, cornerRadius?: number, style?: number): boolean;
  /** Older builds of the module lack it. */
  watchFullScreen?(handle: Buffer, callback: (phase: string) => void): boolean;
}

const GLASS_CORNER_RADIUS = 16;
const GLASS_STYLE_REGULAR = 0;

let addon: LiquidGlassAddon | null | undefined;

function liquidGlass(): LiquidGlassAddon | null {
  if (addon !== undefined) return addon;
  addon = null;
  if (process.platform !== 'darwin') return addon;
  try {
    const loaded = require(path.join(__dirname, '..', 'native', 'liquid-glass.node')) as LiquidGlassAddon;
    if (loaded.isSupported()) addon = loaded;
  } catch (error) {
    console.warn('[glass] Liquid Glass module unavailable; glass themes paint solid.', error);
  }
  return addon;
}

export function glassSupported(): boolean {
  return liquidGlass() !== null;
}

/** Whether the saved appearance asks for glass in either variant. */
export function savedAppearanceWantsGlass(rendererState: Record<string, string>): boolean {
  try {
    const saved = JSON.parse(rendererState['cowork-app-storage'] || '{}');
    const recipes = saved?.state?.themeState?.chromeThemes ?? {};
    return recipes.light?.glassWindow === true || recipes.dark?.glassWindow === true;
  } catch {
    return false;
  }
}

const glassWindows = new WeakSet<BrowserWindow>();

/** Constructor options for a window that should be able to show glass. */
export function glassWindowOptions(wantsGlass: boolean): Partial<BrowserWindowConstructorOptions> {
  return wantsGlass && glassSupported() ? { transparent: true, backgroundColor: '#00000000' } : {};
}

/** Call right after creating a window with glassWindowOptions(). */
export function registerGlassWindow(win: BrowserWindow, options: Partial<BrowserWindowConstructorOptions>): void {
  if (options.transparent) glassWindows.add(win);
}

export function isGlassWindow(win: BrowserWindow): boolean {
  return glassWindows.has(win);
}

/** Per-variant material the renderer asked for. */
const themedMaterials: Partial<Record<Variant, Material>> = {};

export function setThemedMaterial(variant: Variant, material: Material): void {
  themedMaterials[variant] = material;
}

/**
 * Windows that are in native fullscreen or on their way in. A fullscreen window has no desktop
 * behind it, only the Space's dark backdrop, which the glass and the page's thin tints would show
 * as a grey wash, so these paint solid.
 */
const fullScreenWindows = new WeakSet<BrowserWindow>();
// Native fullscreen takes well under a second; if it has not arrived by then, it was refused.
const ENTER_FULL_SCREEN_TIMEOUT_MS = 2000;

export function isWindowFullScreen(win: BrowserWindow): boolean {
  return fullScreenWindows.has(win) || win.isFullScreen() || win.isSimpleFullScreen();
}

/**
 * Calls `onChange(true)` as soon as native fullscreen starts and `onChange(false)` once the window
 * has left it. Electron's 'enter-full-screen' only fires after AppKit has animated the window into
 * its Space, which is too late to avoid the grey frames, so the native module reports the start.
 */
export function watchFullScreen(win: BrowserWindow, onChange: () => void): void {
  // One pending entry per window: a new start, a finished entry, leaving or closing cancels it.
  let pendingEntry: ReturnType<typeof setTimeout> | null = null;
  const cancelPendingEntry = () => {
    if (pendingEntry) clearTimeout(pendingEntry);
    pendingEntry = null;
  };
  const set = (fullScreen: boolean) => {
    if (win.isDestroyed() || fullScreen === fullScreenWindows.has(win)) return;
    if (fullScreen) fullScreenWindows.add(win);
    else fullScreenWindows.delete(win);
    onChange();
  };
  liquidGlass()?.watchFullScreen?.(win.getNativeWindowHandle(), (phase) => {
    if (phase !== 'will-enter') return;
    cancelPendingEntry();
    set(true);
    // A watchdog, not a failure signal: if fullscreen never arrives, stop painting for it.
    pendingEntry = setTimeout(() => {
      pendingEntry = null;
      if (!win.isDestroyed() && !win.isFullScreen()) set(false);
    }, ENTER_FULL_SCREEN_TIMEOUT_MS);
  });
  win.on('enter-full-screen', () => {
    cancelPendingEntry();
    set(true);
  });
  win.on('leave-full-screen', () => {
    cancelPendingEntry();
    set(false);
  });
  win.on('closed', cancelPendingEntry);
}

/** Shows or hides the glass for the current variant; non-glass windows just get their solid color. */
export function applyWindowMaterial(win: BrowserWindow, solidBackground: string): void {
  if (win.isDestroyed()) return;
  const glass =
    isGlassWindow(win) &&
    !isWindowFullScreen(win) &&
    themedMaterials[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'] === 'glass';
  liquidGlass()?.setGlass(win.getNativeWindowHandle(), glass, GLASS_CORNER_RADIUS, GLASS_STYLE_REGULAR);
  win.setBackgroundColor(glass ? '#00000000' : solidBackground);
}
