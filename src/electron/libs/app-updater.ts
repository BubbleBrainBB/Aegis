import type { MessageBoxOptions } from 'electron';
import type { AppUpdateStatus } from '../../shared/types';

type Listener = (...args: any[]) => void;

/** The slice of electron-updater's AppUpdater this flow drives. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: Listener): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface AppUpdaterDeps {
  updater: () => UpdaterLike;
  /** Electron's own autoUpdater; on macOS it says when Squirrel.Mac has the update. */
  nativeUpdater: () => { on(event: 'update-downloaded' | 'error', listener: Listener): unknown };
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** False for builds with no installer to hand the update to (Windows portable). */
  canInstallInApp: () => boolean;
  showMessageBox: (options: MessageBoxOptions) => Promise<{ response: number }>;
  /** Opens the page of one release, or the list of releases without a version. */
  openReleasesPage: (version?: string | null) => void;
  broadcast: (status: AppUpdateStatus) => void;
  setQuitting: (quitting: boolean) => void;
  updateDetail: (info: { releaseNotes?: unknown }) => string;
  log?: (message: string, error?: unknown) => void;
  now?: () => number;
}

/**
 * The update dialog is a native message box: it grows with its text, cannot
 * scroll, and puts its buttons under the text. Long release notes pushed the
 * buttons off the screen, so the dialog shows only the start of the notes and
 * the Release Notes button opens the rest.
 */
const UPDATE_DETAIL_MAX_LINES = 8;
const UPDATE_DETAIL_MAX_CHARS = 600;
const UPDATE_DETAIL_FALLBACK = 'Aegis downloads the update in the background, then asks you to restart.';

/** The update dialog's buttons, by the index the message box answers with. */
const UPDATE_PROMPT_BUTTONS = ['Download and Install', 'Release Notes', 'Later'];
const UPDATE_PROMPT_DOWNLOAD = 0;
const UPDATE_PROMPT_RELEASE_NOTES = 1;
const UPDATE_PROMPT_LATER = 2;

/**
 * Every character the message box starts a new line at, not only LF: CR, the
 * vertical tab, the form feed, NEL and the Unicode line and paragraph
 * separators. Counting lines by LF alone let the others through as one "line".
 */
const LINE_BREAKS = /\r\n|[\r\u000B\u000C\u0085\u2028\u2029]/g;

const HTML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeCodePoint(code: number, fallback: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

function stripSimpleHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    // After the tags, so escaped markup in the notes stays text.
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, decimal?: string, hex?: string, name?: string) => {
      if (decimal) return decodeCodePoint(Number.parseInt(decimal, 10), match);
      if (hex) return decodeCodePoint(Number.parseInt(hex, 16), match);
      return HTML_ENTITIES[(name ?? '').toLowerCase()] ?? match;
    })
    .trim();
}

function normalizeReleaseNotes(releaseNotes: unknown): string | null {
  if (typeof releaseNotes === 'string') {
    const normalized = stripSimpleHtml(releaseNotes).trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (Array.isArray(releaseNotes)) {
    const sections = releaseNotes
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }

        const version = typeof (entry as { version?: unknown }).version === 'string'
          ? (entry as { version?: string }).version
          : null;
        const note = typeof (entry as { note?: unknown }).note === 'string'
          ? stripSimpleHtml((entry as { note?: string }).note || '')
          : '';

        if (!note.trim()) {
          return null;
        }

        return version ? `Version ${version}\n${note.trim()}` : note.trim();
      })
      .filter((value): value is string => Boolean(value && value.trim()));

    return sections.length > 0 ? sections.join('\n\n') : null;
  }

  return null;
}

/**
 * The start of the release notes: at most UPDATE_DETAIL_MAX_LINES lines of
 * text (single blank lines between them are kept and not counted) and
 * UPDATE_DETAIL_MAX_CHARS characters, ending in … when something was left out.
 */
export function summarizeReleaseNotes(notes: string): string {
  const kept: string[] = [];
  let textLines = 0;
  let droppedLines = false;
  // After the entities are decoded, so &#8232; and the like count as line breaks too.
  for (const raw of notes.replace(LINE_BREAKS, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      if (kept.length > 0 && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    if (textLines === UPDATE_DETAIL_MAX_LINES) {
      droppedLines = true;
      break;
    }
    kept.push(line);
    textLines += 1;
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  const text = kept.join('\n');

  if (text.length <= UPDATE_DETAIL_MAX_CHARS && !droppedLines) return text;
  if (droppedLines && text.length + 2 <= UPDATE_DETAIL_MAX_CHARS) return `${text}\n…`;

  // Leave room for the ellipsis, and end on a whole word when one ends nearby.
  const room = UPDATE_DETAIL_MAX_CHARS - 1;
  let head = text.slice(0, room);
  if (!/\s/.test(text.charAt(room))) {
    const lastBreak = head.search(/\s\S*$/);
    if (lastBreak >= room - 80) head = head.slice(0, lastBreak);
    // No word break nearby (CJK, a long URL): cut here, but not through a surrogate pair.
    else if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  }
  return `${head.replace(/[\s.,;:!?…-]+$/, '')}…`;
}

/** The update dialog's detail text: the start of the release notes, if there are any. */
export function buildUpdateDetail(info: { releaseNotes?: unknown }): string {
  const notes = normalizeReleaseNotes(info.releaseNotes);
  const summary = notes ? summarizeReleaseNotes(notes) : '';
  return summary || UPDATE_DETAIL_FALLBACK;
}

/** A release's page (releases are tagged v<version>), or the list of releases without a version. */
export function releasePageUrl(releasesUrl: string, version?: string | null): string {
  const tag = version?.trim().replace(/^v/i, '');
  return tag ? `${releasesUrl}/tag/v${encodeURIComponent(tag)}` : releasesUrl;
}

/**
 * The app's update flow: check → available → downloading → downloaded →
 * restart, with error as a retryable stop on the way.
 */
export function createAppUpdater(deps: AppUpdaterDeps) {
  const log = deps.log ?? ((message, error) => console.warn(message, error));
  let status: AppUpdateStatus = {
    available: false,
    version: null,
    autoDetected: false,
    phase: 'idle',
    progress: null,
    error: null,
  };
  let initialized = false;
  let pendingManualCheck = false;
  let installRequested = false;
  const now = deps.now ?? Date.now;
  let lastCheckAt = -Infinity;

  const setStatus = (patch: Partial<AppUpdateStatus>) => {
    status = { ...status, ...patch };
    deps.broadcast(status);
  };
  const inFlight = () => status.phase === 'downloading' || status.phase === 'downloaded';
  const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

  function fail(error: unknown): void {
    if (!inFlight() && !installRequested) return;
    log('[Updater] Update failed:', error);
    if (installRequested) {
      installRequested = false;
      deps.setQuitting(false);
    }
    setStatus({ phase: 'error', progress: null, error: errorMessage(error) });
  }

  function download(): void {
    if (status.phase !== 'available' && status.phase !== 'error') return;
    if (!deps.canInstallInApp()) {
      deps.openReleasesPage();
      return;
    }
    setStatus({ phase: 'downloading', progress: 0, error: null });
    // Rejects for download failures and, on macOS, for Squirrel.Mac failing
    // before it has fetched the zip. A failed check never lands here.
    deps.updater().downloadUpdate().catch(fail);
  }

  function install(): void {
    if (status.phase !== 'downloaded') return;
    installRequested = true;
    deps.setQuitting(true);
    try {
      deps.updater().quitAndInstall();
    } catch (error) {
      fail(error);
    }
  }

  function promptToInstall(): void {
    void deps.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: `Aegis${status.version ? ` ${status.version}` : ''} is ready to install.`,
      detail: 'Restart Aegis to finish updating. Running agents will stop.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0) install();
    });
  }

  /**
   * `unlessCheckedWithinMs` is for background checks tied to something that
   * happens often (the window coming to the front): it skips the check when
   * one already ran that recently.
   */
  function check(options?: { manual?: boolean; unlessCheckedWithinMs?: number }): void {
    const manual = options?.manual === true;
    if (!deps.isPackaged) {
      if (manual) {
        void deps.showMessageBox({ type: 'info', title: 'Updates', message: 'Updates are only available in the packaged app.' });
      }
      return;
    }
    // One update at a time: a check now could swap the version that
    // electron-updater or Squirrel.Mac is still working on.
    if (inFlight()) {
      if (!manual) return;
      if (status.phase === 'downloaded') {
        promptToInstall();
      } else {
        void deps.showMessageBox({
          type: 'info',
          title: 'Updating',
          message: `Aegis${status.version ? ` ${status.version}` : ''} is downloading.`,
          detail: 'You can restart to install it once it is ready.',
        });
      }
      return;
    }
    if (!manual && options?.unlessCheckedWithinMs !== undefined && now() - lastCheckAt < options.unlessCheckedWithinMs) return;
    lastCheckAt = now();
    // electron-updater answers overlapping checks once: a background check
    // that starts while a manual one is out must not take its dialog away.
    pendingManualCheck = pendingManualCheck || manual;
    // Failures are reported through the 'error' listener.
    deps.updater().checkForUpdates().catch(() => undefined);
  }

  function setup(): void {
    if (!deps.isPackaged || initialized) return;
    initialized = true;
    const updater = deps.updater();
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;

    updater.on('error', (error: unknown) => {
      const notify = pendingManualCheck;
      pendingManualCheck = false;
      // Installing is the one step whose failure only arrives here.
      if (installRequested) {
        fail(error);
        return;
      }
      // Download failures arrive through downloadUpdate()'s rejection instead.
      if (inFlight()) {
        log('[Updater] Updater error during download:', error);
        return;
      }
      // A failed check is no answer: the next occasion to check takes it.
      lastCheckAt = -Infinity;
      if (!notify) {
        log('[Updater] Background update check failed:', error);
        return;
      }
      void deps.showMessageBox({
        type: 'error',
        title: 'Update error',
        message: 'Failed to check for updates.',
        detail: errorMessage(error),
      });
    });

    updater.on('update-available', async (info: { version?: string; releaseNotes?: unknown } | undefined) => {
      const notify = pendingManualCheck;
      pendingManualCheck = false;
      const version = info?.version || null;
      // A check that was already running when a download started must not
      // swap the version under it: electron-updater keeps that download.
      if (!inFlight()) {
        setStatus({
          available: true,
          version,
          autoDetected: !notify || status.autoDetected,
          phase: 'available',
          progress: null,
          error: null,
        });
      }
      if (!notify) return;
      if (status.phase === 'downloaded') {
        promptToInstall();
        return;
      }
      if (status.phase === 'downloading') return;
      const result = await deps.showMessageBox({
        type: 'info',
        title: 'Update available',
        message: `A new version${version ? ` (${version})` : ''} is available.`,
        detail: deps.updateDetail(info ?? {}),
        buttons: UPDATE_PROMPT_BUTTONS,
        // Return downloads, Esc is Later.
        defaultId: UPDATE_PROMPT_DOWNLOAD,
        cancelId: UPDATE_PROMPT_LATER,
      });
      if (result.response === UPDATE_PROMPT_DOWNLOAD) download();
      // The update stays available: the rail and Settings still offer the download.
      else if (result.response === UPDATE_PROMPT_RELEASE_NOTES) deps.openReleasesPage(version);
    });

    updater.on('update-not-available', () => {
      const notify = pendingManualCheck;
      pendingManualCheck = false;
      if (!inFlight()) {
        setStatus({ available: false, version: null, autoDetected: false, phase: 'idle', progress: null, error: null });
      }
      if (!notify) return;
      void deps.showMessageBox({ type: 'info', title: 'Up to date', message: 'You are already using the latest version.' });
    });

    updater.on('download-progress', (progress: { percent?: number } | undefined) => {
      if (status.phase !== 'downloading') return;
      const percent = Math.max(0, Math.min(100, Math.floor(progress?.percent ?? 0)));
      if (status.progress !== percent) setStatus({ progress: percent });
    });

    const markDownloaded = () => setStatus({ available: true, phase: 'downloaded', progress: null, error: null });
    updater.on('update-downloaded', (info: { version?: string } | undefined) => {
      if (status.phase !== 'downloading') return;
      if (info?.version) status = { ...status, version: info.version };
      if (deps.platform !== 'darwin') {
        markDownloaded();
        return;
      }
      // On macOS this fires once the zip is in; Squirrel.Mac still has to
      // fetch and verify it. Stay in downloading until it has the update.
      setStatus({ progress: 100 });
    });
    if (deps.platform === 'darwin') {
      const native = deps.nativeUpdater();
      native.on('update-downloaded', () => {
        if (status.phase === 'downloading') markDownloaded();
      });
      // Once Squirrel.Mac has fetched the zip, downloadUpdate() has already
      // resolved, so unpacking or verifying failures only arrive here. Only
      // Squirrel.Mac emits these, never a check.
      native.on('error', (error: unknown) => {
        if (status.phase === 'downloading') fail(error);
      });
    }
  }

  return {
    setup,
    check,
    download,
    install,
    status: () => status,
  };
}
