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
  openReleasesPage: () => void;
  broadcast: (status: AppUpdateStatus) => void;
  setQuitting: (quitting: boolean) => void;
  updateDetail: (info: { releaseNotes?: unknown }) => string;
  log?: (message: string, error?: unknown) => void;
  now?: () => number;
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
        buttons: ['Download and Install', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });
      if (result.response === 0) download();
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
