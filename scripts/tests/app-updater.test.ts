import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAppUpdater } from '../../src/electron/libs/app-updater';
import type { AppUpdateStatus } from '../../src/shared/types';

// Drives the update flow with electron-updater's event order, including the
// macOS quirks: update-downloaded fires before Squirrel.Mac has the update,
// and the download promise resolves once Squirrel has fetched the zip, before
// it has unpacked and verified it.

const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness(options: { platform?: NodeJS.Platform; portable?: boolean; dialogResponse?: number } = {}) {
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    checks: 0,
    downloads: 0,
    installs: 0,
    installThrows: null as Error | null,
    rejectDownload: (_error: Error) => {},
    resolveDownload: () => {},
    checkForUpdates() {
      this.checks += 1;
      return Promise.resolve();
    },
    downloadUpdate() {
      this.downloads += 1;
      return new Promise((resolve, reject) => {
        this.rejectDownload = reject;
        this.resolveDownload = () => resolve([]);
      });
    },
    quitAndInstall() {
      this.installs += 1;
      if (this.installThrows) throw this.installThrows;
    },
  });
  const native = new EventEmitter();
  const broadcasts: AppUpdateStatus[] = [];
  const dialogs: string[] = [];
  const quitting: boolean[] = [];
  let releasesOpened = 0;
  const app = createAppUpdater({
    updater: () => updater,
    nativeUpdater: () => native,
    platform: options.platform ?? 'darwin',
    isPackaged: true,
    canInstallInApp: () => !options.portable,
    showMessageBox: async (box) => {
      dialogs.push(String(box.message));
      return { response: options.dialogResponse ?? 1 };
    },
    openReleasesPage: () => {
      releasesOpened += 1;
    },
    broadcast: (status) => broadcasts.push(status),
    setQuitting: (value) => quitting.push(value),
    updateDetail: () => '',
    log: () => {},
  });
  app.setup();
  return { app, updater, native, broadcasts, dialogs, quitting, releasesOpened: () => releasesOpened };
}

async function available(h: ReturnType<typeof harness>, version = '0.0.84') {
  h.app.check();
  h.updater.emit('update-available', { version });
  await tick();
}

async function main() {
  // macOS: download, Squirrel takes it, restart.
  {
    const h = harness();
    assert.equal(h.updater.autoDownload, false);
    assert.equal(h.updater.autoInstallOnAppQuit, true);
    await available(h);
    assert.equal(h.app.status().phase, 'available');
    assert.equal(h.app.status().version, '0.0.84');
    assert.deepEqual(h.dialogs, [], 'a background check stays quiet');

    h.app.download();
    assert.equal(h.updater.downloads, 1);
    assert.deepEqual([h.app.status().phase, h.app.status().progress], ['downloading', 0]);
    h.updater.emit('download-progress', { percent: 42.7 });
    assert.equal(h.app.status().progress, 42);

    h.updater.emit('update-downloaded', { version: '0.0.84' });
    assert.deepEqual([h.app.status().phase, h.app.status().progress], ['downloading', 100], 'Squirrel.Mac still has to take the zip');
    h.app.install();
    assert.equal(h.updater.installs, 0, 'no restart before Squirrel.Mac is ready');

    h.native.emit('update-downloaded');
    assert.equal(h.app.status().phase, 'downloaded');
    h.app.install();
    assert.equal(h.updater.installs, 1);
    assert.deepEqual(h.quitting, [true]);
    assert.equal(h.broadcasts.at(-1)?.phase, 'downloaded');
  }

  // Windows and Linux: update-downloaded means ready.
  {
    const h = harness({ platform: 'win32' });
    await available(h);
    h.app.download();
    h.updater.emit('update-downloaded', { version: '0.0.84' });
    assert.equal(h.app.status().phase, 'downloaded');
    h.native.emit('update-downloaded');
    assert.equal(h.app.status().phase, 'downloaded');
  }

  // UPDATE-001: Squirrel.Mac fails after it has fetched the zip. By then
  // electron-updater has resolved the download, so only the native error
  // event reports it (electron-updater 6.8.9 MacUpdater).
  {
    const h = harness();
    await available(h);
    h.app.download();
    h.updater.emit('update-downloaded', { version: '0.0.84' });
    h.updater.resolveDownload();
    await tick();
    const error = new Error('Code signature did not pass validation');
    h.updater.emit('error', error);
    assert.equal(h.app.status().phase, 'downloading', 'the updater error event alone could be a stray check');
    h.native.emit('error', error);
    assert.deepEqual([h.app.status().phase, h.app.status().error], ['error', 'Code signature did not pass validation']);
    assert.deepEqual(h.quitting, [], 'nothing was quitting');

    h.app.check();
    assert.equal(h.updater.checks, 2, 'checks resume after a failure');
    h.app.download();
    assert.equal(h.updater.downloads, 2, 'retry starts a new download');
    assert.equal(h.app.status().phase, 'downloading');
  }

  // Squirrel.Mac fails before fetching the zip: the download rejects and the
  // native error fires too; one failure either way.
  {
    const h = harness();
    await available(h);
    h.app.download();
    h.updater.emit('update-downloaded', { version: '0.0.84' });
    const error = new Error('No space left on device');
    h.native.emit('error', error);
    h.updater.rejectDownload(error);
    await tick();
    assert.deepEqual([h.app.status().phase, h.app.status().error], ['error', 'No space left on device']);
    assert.equal(h.broadcasts.filter((status) => status.phase === 'error').length, 1);
  }

  // A plain download failure (network) on any platform.
  {
    const h = harness({ platform: 'win32' });
    await available(h);
    h.app.download();
    h.updater.emit('download-progress', { percent: 30 });
    h.updater.emit('error', new Error('net::ERR_CONNECTION_RESET'));
    h.updater.rejectDownload(new Error('net::ERR_CONNECTION_RESET'));
    await tick();
    assert.equal(h.app.status().phase, 'error');
    h.app.download();
    assert.equal(h.app.status().phase, 'downloading');
  }

  // A failed install hands the app back: not quitting, retry offered.
  {
    const h = harness({ platform: 'linux' });
    await available(h);
    h.app.download();
    h.updater.emit('update-downloaded', { version: '0.0.84' });
    h.app.install();
    h.updater.emit('error', new Error('APPIMAGE env is not defined'));
    assert.equal(h.app.status().phase, 'error');
    assert.deepEqual(h.quitting, [true, false]);
    h.app.download();
    assert.equal(h.app.status().phase, 'downloading');
  }

  // quitAndInstall throwing is treated the same way.
  {
    const h = harness({ platform: 'win32' });
    await available(h);
    h.app.download();
    h.updater.emit('update-downloaded', { version: '0.0.84' });
    h.updater.installThrows = new Error('spawn failed');
    h.app.install();
    assert.deepEqual([h.app.status().phase, h.app.status().error], ['error', 'spawn failed']);
    assert.deepEqual(h.quitting, [true, false]);
  }

  // UPDATE-003: no check while an update is in flight, so a newer release
  // cannot relabel the download electron-updater is still holding.
  {
    const h = harness();
    await available(h, '0.0.84');
    h.app.download();
    h.app.check();
    h.app.check({ manual: true });
    await tick();
    assert.equal(h.updater.checks, 1, 'neither automatic nor manual checks run during a download');
    assert.deepEqual(h.dialogs, ['Aegis 0.0.84 is downloading.']);

    // A check that started before the download resolves late with a newer version.
    h.updater.emit('update-available', { version: '0.0.85' });
    h.updater.emit('update-not-available');
    await tick();
    assert.deepEqual([h.app.status().phase, h.app.status().version], ['downloading', '0.0.84']);

    h.updater.emit('update-downloaded', { version: '0.0.84' });
    h.native.emit('update-downloaded');
    assert.deepEqual([h.app.status().phase, h.app.status().version], ['downloaded', '0.0.84']);
    h.app.check({ manual: true });
    await tick();
    assert.equal(h.updater.checks, 1);
    assert.equal(h.dialogs.at(-1), 'Aegis 0.0.84 is ready to install.');
  }

  // Manual checks: dialogs, and "Download and Install" starts the download.
  {
    const h = harness({ dialogResponse: 0 });
    h.app.check({ manual: true });
    h.updater.emit('update-available', { version: '0.0.84' });
    await tick();
    assert.deepEqual(h.dialogs, ['A new version (0.0.84) is available.']);
    assert.equal(h.app.status().phase, 'downloading');

    const quiet = harness();
    quiet.app.check();
    quiet.updater.emit('error', new Error('offline'));
    assert.deepEqual(quiet.dialogs, [], 'a failed background check stays quiet');
    assert.equal(quiet.app.status().phase, 'idle');
    quiet.app.check({ manual: true });
    quiet.updater.emit('error', new Error('offline'));
    await tick();
    assert.deepEqual(quiet.dialogs, ['Failed to check for updates.']);
  }

  // Stray events outside a download change nothing.
  {
    const h = harness({ platform: 'win32' });
    await available(h);
    h.updater.emit('download-progress', { percent: 50 });
    h.updater.emit('update-downloaded', { version: '0.0.84' });
    h.native.emit('update-downloaded');
    assert.deepEqual([h.app.status().phase, h.app.status().progress], ['available', null]);
    h.app.install();
    assert.equal(h.updater.installs, 0);
  }

  // Windows portable has no installer: the button opens the Releases page.
  {
    const h = harness({ platform: 'win32', portable: true });
    await available(h);
    h.app.download();
    assert.equal(h.updater.downloads, 0);
    assert.equal(h.releasesOpened(), 1);
    assert.equal(h.app.status().phase, 'available');
  }

  console.log('PASS: app updater state machine');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
