import { BrowserWindow, type BrowserWindowConstructorOptions, screen, shell } from 'electron';
import {
  COMPUTER_USE_PREVIEW_HASH,
  computerUsePreviewWindowPolicy,
  mergeComputerUseLiveFrame,
  type ComputerUseLiveFrame,
  type ComputerUsePreviewOpenInput,
  type ComputerUsePreviewSnapshot,
} from '../../shared/computer-use';
import { DEV_SERVER_URL, getPreloadPath, getUIPath, isDev } from '../util';

let hostWindow: BrowserWindow | null = null;
let previewWindow: BrowserWindow | null = null;
let previewSessionId: string | null = null;
const liveFrames = new Map<string, ComputerUseLiveFrame>();

export function attachComputerUsePreviewHost(win: BrowserWindow): void {
  hostWindow = win;
  win.on('closed', () => {
    if (hostWindow === win) {
      closeComputerUsePreviewWindow();
      hostWindow = null;
    }
  });
}

export function buildComputerUsePreviewWindowOptions(
  parent: BrowserWindow
): BrowserWindowConstructorOptions {
  const policy = computerUsePreviewWindowPolicy();
  return {
    parent,
    modal: policy.modal,
    show: false,
    width: 200,
    height: 113,
    minWidth: 32,
    minHeight: 32,
    frame: false,
    transparent: true,
    hasShadow: true,
    skipTaskbar: true,
    title: 'Computer Use',
    alwaysOnTop: policy.alwaysOnTop,
    fullscreenable: policy.fullscreenable,
    autoHideMenuBar: true,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  };
}

export function rememberComputerUseLive(sessionId: string, frame: ComputerUseLiveFrame): void {
  liveFrames.set(sessionId, mergeComputerUseLiveFrame(liveFrames.get(sessionId) ?? null, frame));
  if (previewSessionId === sessionId) pushPreviewSnapshot();
}

export function activeGatewayPreviewSessions(): string[] {
  return [...liveFrames].filter(([, frame]) => frame.previewWindowId != null).map(([id]) => id);
}

export function clearComputerUseLive(sessionId: string): void {
  liveFrames.delete(sessionId);
  stopComputerUsePreviewIfSession(sessionId);
}

export function getComputerUsePreviewSnapshot(): ComputerUsePreviewSnapshot | null {
  return previewSessionId ? { sessionId: previewSessionId, live: liveFrames.get(previewSessionId) ?? null } : null;
}

export function isComputerUsePreviewOpen(): boolean {
  return Boolean(previewWindow && !previewWindow.isDestroyed());
}

export async function openComputerUsePreviewWindow(
  input: ComputerUsePreviewOpenInput
): Promise<{ ok: boolean; open: boolean; sessionId: string; message?: string }> {
  const sessionId = sanitizeSessionId(input.sessionId);
  if (!sessionId) return { ok: false, open: false, sessionId: '', message: 'Missing session.' };
  const parent = hostWindow;
  if (!parent || parent.isDestroyed()) {
    return { ok: false, open: false, sessionId, message: 'Main window is gone.' };
  }

  if (!liveFrames.get(sessionId)?.media) {
    return { ok: false, open: false, sessionId, message: 'No active Computer Use preview.' };
  }
  previewSessionId = sessionId;
  if (previewWindow && !previewWindow.isDestroyed()) {
    pushPreviewSnapshot();
    notifyHostPreview(true);
    if (previewWindow.isMinimized()) previewWindow.restore();
    previewWindow.showInactive();
    return { ok: true, open: true, sessionId };
  }

  const win = new BrowserWindow(buildComputerUsePreviewWindowOptions(parent));
  previewWindow = win;
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    positionBesideParent(win, parent);
    win.showInactive();
    pushPreviewSnapshot();
  });
  win.on('closed', () => {
    if (previewWindow === win) {
      previewWindow = null;
      previewSessionId = null;
      notifyHostPreview(false);
    }
  });

  try {
    await loadComputerUsePreviewUi(win);
  } catch (error) {
    if (previewWindow !== win || win.isDestroyed()) return { ok: true, open: false, sessionId };
    closeComputerUsePreviewWindow();
    throw error;
  }
  if (previewWindow === win && !win.isDestroyed()) notifyHostPreview(true);
  return { ok: true, open: previewWindow === win, sessionId };
}

export function closeComputerUsePreviewWindow(): void {
  const win = previewWindow;
  previewWindow = null;
  previewSessionId = null;
  if (win && !win.isDestroyed()) win.close();
  notifyHostPreview(false);
}

export function stopComputerUsePreviewIfSession(sessionId: string): void {
  if (previewSessionId === sessionId) closeComputerUsePreviewWindow();
}

export function fitComputerUsePreview(senderId: number, width: number, height: number): void {
  const win = previewWindow;
  if (!win || win.isDestroyed() || win.webContents.id !== senderId) return;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const scale = 200 / Math.max(width, height);
  const size = [Math.max(32, Math.round(width * scale)), Math.max(32, Math.round(height * scale))];
  const [w, h] = win.getContentSize();
  if (w !== size[0] || h !== size[1]) win.setContentSize(size[0], size[1]);
}

async function loadComputerUsePreviewUi(win: BrowserWindow): Promise<void> {
  if (isDev()) {
    try {
      const url = `${DEV_SERVER_URL.replace(/\/$/, '')}/#${COMPUTER_USE_PREVIEW_HASH}`;
      await win.loadURL(url);
      return;
    } catch {
      // fall through to packaged UI
    }
  }
  await win.loadFile(getUIPath(), { hash: COMPUTER_USE_PREVIEW_HASH });
}

function sanitizeSessionId(value: string | null | undefined): string | null {
  const raw = (value || '').trim();
  if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes('..')) return null;
  return raw;
}

function pushPreviewSnapshot(): void {
  const win = previewWindow;
  const snapshot = getComputerUsePreviewSnapshot();
  if (!win || win.isDestroyed() || !snapshot || win.webContents.isDestroyed()) return;
  win.webContents.send('computer-use-preview-state', JSON.stringify(snapshot));
}

function notifyHostPreview(open: boolean): void {
  const host = hostWindow;
  if (!host || host.isDestroyed() || host.webContents.isDestroyed()) return;
  const sessionId = previewSessionId || '';
  host.webContents.send(
    'server-event',
    JSON.stringify({
      type: 'computerUse.preview',
      payload: { sessionId, open },
    })
  );
}

function positionBesideParent(win: BrowserWindow, parent: BrowserWindow): void {
  const bounds = parent.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const [width, height] = win.getSize();
  win.setPosition(
    Math.max(area.x, Math.min(bounds.x + bounds.width - 48, area.x + area.width - width)),
    Math.max(area.y, Math.min(bounds.y + 72, area.y + area.height - height))
  );
}
