import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { MessageBoxOptions } from 'electron';
import { buildUpdateDetail, createAppUpdater, releasePageUrl, summarizeReleaseNotes } from '../../src/electron/libs/app-updater';
import type { AppUpdateStatus } from '../../src/shared/types';

// Drives the update flow with electron-updater's event order, including the
// macOS quirks: update-downloaded fires before Squirrel.Mac has the update,
// and the download promise resolves once Squirrel has fetched the zip, before
// it has unpacked and verified it.

const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness(options: {
  platform?: NodeJS.Platform;
  portable?: boolean;
  dialogResponse?: number;
  updateDetail?: (info: { releaseNotes?: unknown }) => string;
} = {}) {
  const clock = { now: 1_000_000 };
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
  const boxes: MessageBoxOptions[] = [];
  const quitting: boolean[] = [];
  const releasePages: Array<string | null | undefined> = [];
  const app = createAppUpdater({
    updater: () => updater,
    nativeUpdater: () => native,
    platform: options.platform ?? 'darwin',
    isPackaged: true,
    canInstallInApp: () => !options.portable,
    showMessageBox: async (box) => {
      dialogs.push(String(box.message));
      boxes.push(box);
      return { response: options.dialogResponse ?? 1 };
    },
    openReleasesPage: (version) => {
      releasePages.push(version);
    },
    broadcast: (status) => broadcasts.push(status),
    setQuitting: (value) => quitting.push(value),
    updateDetail: options.updateDetail ?? (() => ''),
    log: () => {},
    now: () => clock.now,
  });
  app.setup();
  return { app, updater, native, broadcasts, dialogs, boxes, quitting, clock, releasePages, releasesOpened: () => releasePages.length };
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

  // Background checks tied to the window coming to the front or the Mac
  // waking: at most one per interval, and a release found that way reaches
  // the rail with no dialog and nobody asking.
  {
    const h = harness();
    const gap = 10 * 60 * 1000;
    const recheck = () => h.app.check({ unlessCheckedWithinMs: gap });
    recheck();
    h.updater.emit('update-not-available');
    assert.equal(h.updater.checks, 1, 'the first one runs');
    h.clock.now += gap - 1;
    recheck();
    assert.equal(h.updater.checks, 1, 'not again within the interval');
    h.app.check();
    assert.equal(h.updater.checks, 2, 'the timer check itself always runs');
    h.clock.now += gap;
    recheck();
    assert.equal(h.updater.checks, 3, 'again once the interval has passed');
    h.updater.emit('update-available', { version: '0.0.86' });
    await tick();
    assert.deepEqual([h.app.status().phase, h.app.status().version, h.app.status().autoDetected], ['available', '0.0.86', true]);
    assert.deepEqual(h.dialogs, [], 'found in the background: the rail button, no dialog');

    // A failed check is no answer: the next occasion checks again.
    const offline = harness();
    offline.app.check({ unlessCheckedWithinMs: gap });
    offline.updater.emit('error', new Error('offline'));
    offline.app.check({ unlessCheckedWithinMs: gap });
    assert.equal(offline.updater.checks, 2);

    // A manual check always runs, and keeps its dialog when a background
    // check starts before the answer is in.
    const manual = harness();
    manual.app.check({ unlessCheckedWithinMs: gap });
    manual.app.check({ manual: true });
    manual.app.check();
    assert.equal(manual.updater.checks, 3);
    manual.updater.emit('update-not-available');
    await tick();
    assert.deepEqual(manual.dialogs, ['You are already using the latest version.']);
    manual.updater.emit('update-not-available');
    await tick();
    assert.equal(manual.dialogs.length, 1, 'one answer, one dialog');
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

  // The update dialog is a native message box that cannot scroll: it shows
  // the start of the release notes, never all of a long one.
  {
    const fallback = 'Aegis downloads the update in the background, then asks you to restart.';
    for (const empty of [undefined, null, '', '   ', '<p> </p>', [], [{ version: '0.0.87', note: '' }]]) {
      assert.equal(buildUpdateDetail({ releaseNotes: empty }), fallback);
    }
    assert.equal(buildUpdateDetail({}), fallback);

    // Short notes are shown whole, as text.
    const short = '<h2>What\'s New</h2>\n<ul>\n<li><strong>Faster start</strong>: the window opens sooner.</li>\n<li>Settings &gt; Usage shows &quot;All agents&quot; &amp; totals.</li>\n</ul>';
    assert.equal(
      buildUpdateDetail({ releaseNotes: short }),
      'What\'s New\n\nFaster start: the window opens sooner.\nSettings > Usage shows "All agents" & totals.',
    );
    assert.equal(summarizeReleaseNotes('One line.'), 'One line.');
    assert.equal(buildUpdateDetail({ releaseNotes: 'Shown as typed: &lt;b&gt; and &amp;lt; and &#8230; and &bogus;' }), 'Shown as typed: <b> and &lt; and … and &bogus;');
    assert.equal(
      buildUpdateDetail({ releaseNotes: [{ version: '0.0.87', note: '<p>Second.</p>' }, { version: '0.0.86', note: '<p>First.</p>' }] }),
      'Version 0.0.87\nSecond.\n\nVersion 0.0.86\nFirst.',
    );

    // Notes the size and shape of v0.0.87's: 8 sections of long list items, about 10,000 characters of HTML.
    const item = (section: number, index: number) => `<li><strong>Change ${section}.${index}</strong>: ${'this part of the app does one more thing than it did before, and here is how it works. '.repeat(4).trim()}</li>`;
    const long = `<h2>What's New</h2>\n${Array.from({ length: 8 }, (_, section) => `<h3>Section ${section}</h3>\n<ul>\n${[0, 1, 2].map((index) => item(section, index)).join('\n')}\n</ul>`).join('\n')}`;
    assert.ok(long.length > 9_000, `the sample is long (${long.length})`);
    const detail = buildUpdateDetail({ releaseNotes: long });
    assert.ok(detail.length <= 600, `at most 600 characters (${detail.length})`);
    assert.ok(detail.length > 400, `still a useful amount of text (${detail.length})`);
    assert.ok(detail.split('\n').filter(Boolean).length <= 8, 'at most 8 lines of text');
    assert.ok(detail.startsWith('What\'s New\nSection 0\n\nChange 0.0: this part of the app'), detail);
    assert.ok(detail.endsWith('…') && !/[\s.,;:]…$/.test(detail), `ends in a clean ellipsis: ${detail.slice(-30)}`);
    const full = long.replace(/<[^>]+>/g, '');
    const kept = detail.slice(0, -1);
    assert.ok(full.replace(/\n+/g, '\n').startsWith(kept.replace(/\n+/g, '\n')), 'the summary is the start of the notes');
    assert.match(full.replace(/\n+/g, '\n').charAt(kept.replace(/\n+/g, '\n').length), /[\s.,;:]/, 'cut at the end of a word');

    // Many short lines: the first 8, blank lines between sections kept.
    const lines = Array.from({ length: 30 }, (_, index) => `Fix number ${index + 1}`);
    assert.equal(summarizeReleaseNotes(lines.join('\n')), `${lines.slice(0, 8).join('\n')}\n…`);
    assert.equal(summarizeReleaseNotes(lines.slice(0, 8).join('\n')), lines.slice(0, 8).join('\n'), 'exactly 8 lines are not cut');
    assert.equal(
      summarizeReleaseNotes(`Title\n\n\n\n${lines.join('\n\n')}\n\n`),
      `Title\n\n${lines.slice(0, 7).join('\n\n')}\n…`,
    );

    // UPDATE-DIALOG-001: the message box also starts a new line at CR, the
    // vertical tab, the form feed, NEL and the Unicode line and paragraph
    // separators. Typed or written as an entity, each one counts as a line
    // break, so none of them gets more than 8 lines into the dialog.
    {
      const eight = `${Array.from({ length: 8 }, () => 'Fix').join('\n')}\n…`;
      const otherBreaks = /[\r\u000B\u000C\u0085\u2028\u2029]/;
      const bounded = (detail: string, label: string) => {
        assert.ok(!otherBreaks.test(detail), `${label}: only LF is left as a line break`);
        const text = detail.split('\n').filter(Boolean);
        assert.ok(text.length <= 9 && (text.length < 9 || text[8] === '…'), `${label}: at most 8 lines of text, then the ellipsis (${text.length})`);
        assert.ok(detail.length <= 600, `${label}: at most 600 characters (${detail.length})`);
      };
      const breaks: Array<[string, number]> = [
        ['LF', 0x0a], ['CR', 0x0d], ['VT', 0x0b], ['FF', 0x0c], ['NEL', 0x85], ['LS', 0x2028], ['PS', 0x2029],
      ];
      for (const [name, code] of breaks) {
        const char = String.fromCharCode(code);
        const forms: Array<[string, string]> = [
          [`${name} typed`, char],
          [`${name} as &#${code};`, `&#${code};`],
          [`${name} as &#x${code.toString(16)};`, `&#x${code.toString(16)};`],
        ];
        for (const [label, form] of forms) {
          // 150 one-word lines in under 600 characters: only the line count can stop it.
          const detail = buildUpdateDetail({ releaseNotes: `Fix${form}`.repeat(150) });
          assert.equal(detail, eight, label);
          bounded(detail, label);
          assert.equal(summarizeReleaseNotes(`One${char}Two`), 'One\nTwo', `${label}: a line break`);
          // Long lines too: the character limit still holds.
          bounded(buildUpdateDetail({ releaseNotes: `${'word '.repeat(30)}${form}`.repeat(40) }), `${label}, long lines`);
        }
      }
      assert.equal(buildUpdateDetail({ releaseNotes: 'Fix&#8232;'.repeat(150) }), eight, 'the reported case');
      // CRLF is one line break, not a line and a blank line.
      assert.equal(summarizeReleaseNotes('One\r\nTwo\r\n\r\nThree'), 'One\nTwo\n\nThree');
      assert.equal(summarizeReleaseNotes(`${'Fix\r\n'.repeat(150)}`), eight);
      // Mixed breaks in a row are blank lines, kept as one.
      const mixed = [0x0d, 0x2028, 0x0b, 0x85, 0x2029, 0x0c].map((code) => String.fromCharCode(code)).join('');
      assert.equal(summarizeReleaseNotes(`One${mixed}Two`), 'One\n\nTwo');
      bounded(summarizeReleaseNotes(`Fix${mixed}`.repeat(150)), 'mixed breaks');
      assert.equal(summarizeReleaseNotes(`Fix${mixed}`.repeat(150)).split('\n').filter(Boolean).length, 9);
    }

    // Text with no word breaks is cut at the limit, not through a character.
    const unbroken = summarizeReleaseNotes('更'.repeat(2_000));
    assert.equal(unbroken, `${'更'.repeat(599)}…`);
    // The limit falls inside the 300th emoji: it goes whole, not as half a surrogate pair.
    assert.equal(summarizeReleaseNotes('😀'.repeat(1_000)), `${'😀'.repeat(299)}…`);
    // Here it falls between two: nothing more is dropped.
    assert.equal(summarizeReleaseNotes(`a${'😀'.repeat(1_000)}`), `a${'😀'.repeat(299)}…`);
    assert.equal(summarizeReleaseNotes('x'.repeat(600)), 'x'.repeat(600), 'exactly 600 characters are not cut');
    assert.equal(summarizeReleaseNotes('x'.repeat(601)).length, 600);
  }

  // The update dialog: Return downloads, Esc is Later, and Release Notes
  // opens that version's page and leaves the update available.
  {
    const notes = `<ul>\n${Array.from({ length: 40 }, (_, index) => `<li>Change ${index + 1}: ${'words '.repeat(40)}</li>`).join('\n')}\n</ul>`;
    const ask = async (dialogResponse: number) => {
      const h = harness({ dialogResponse, updateDetail: buildUpdateDetail });
      h.app.check({ manual: true });
      h.updater.emit('update-available', { version: '0.0.87', releaseNotes: notes });
      await tick();
      return h;
    };

    const notesPage = await ask(1);
    const box = notesPage.boxes[0];
    assert.equal(box.message, 'A new version (0.0.87) is available.');
    assert.deepEqual(box.buttons, ['Download and Install', 'Release Notes', 'Later']);
    assert.equal(box.buttons?.[box.defaultId ?? -1], 'Download and Install', 'Return downloads');
    assert.equal(box.buttons?.[box.cancelId ?? -1], 'Later', 'Esc is Later');
    assert.ok(String(box.detail).length <= 600 && String(box.detail).endsWith('…'), 'the dialog gets the summary');
    assert.deepEqual(notesPage.releasePages, ['0.0.87']);
    assert.equal(notesPage.updater.downloads, 0);
    assert.deepEqual([notesPage.app.status().phase, notesPage.app.status().version], ['available', '0.0.87'], 'still there to download from the rail');

    const later = await ask(2);
    assert.deepEqual([later.updater.downloads, later.releasePages.length, later.app.status().phase], [0, 0, 'available']);

    const download = await ask(0);
    assert.deepEqual([download.updater.downloads, download.releasePages.length, download.app.status().phase], [1, 0, 'downloading']);

    const releases = 'https://github.com/BubbleBrainBB/Aegis/releases';
    assert.equal(releasePageUrl(releases, '0.0.87'), `${releases}/tag/v0.0.87`);
    assert.equal(releasePageUrl(releases, 'v0.0.87'), `${releases}/tag/v0.0.87`);
    assert.equal(releasePageUrl(releases, '1.0.0-beta.1'), `${releases}/tag/v1.0.0-beta.1`);
    assert.equal(releasePageUrl(releases, '0.0.87/../../evil?x=1'), `${releases}/tag/v0.0.87%2F..%2F..%2Fevil%3Fx%3D1`);
    for (const none of [undefined, null, '', ' ']) assert.equal(releasePageUrl(releases, none), releases);
  }

  console.log('PASS: app updater state machine');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
