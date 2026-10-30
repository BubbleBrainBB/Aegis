import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// Read-only file previews (files the panel can't edit, e.g. .mjs, LICENSE)
// render through ProjectTextEditor: they must stay view-only, render only the
// visible lines of a file near the 5MB preview cap, show unknown file types
// as plain text, and still pick the language for known ones.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../..');
const electronBin = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron'
);

const LARGE_LINE_COUNT = 100_000;
const TARGET_LINE = 90_000;

function runElectron(mainPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronBin, [mainPath], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Read-only preview Electron regression timed out\n${stdout}\n${stderr}`));
    }, 60_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Read-only preview Electron regression exited with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function writeHarness(tmpDir) {
  const harness = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { language } from '@codemirror/language';
import { ProjectTextEditor } from '/src/ui/components/ProjectTextEditor.tsx';
import '/src/ui/index.css';

// ~5MB: a Markdown-looking heading first, so a Markdown fallback would show.
const largeSource = ['# Not a heading in a LICENSE'].concat(
  Array.from({ length: ${LARGE_LINE_COUNT} - 1 }, (_, index) =>
    'LINE_' + String(index + 2).padStart(6, '0') + ' ' + 'x'.repeat(36)
  )
).join('\\n');
const scriptSource = 'export const answer = 42;\\n';

const files = {
  large: { name: 'LICENSE', text: largeSource },
  script: { name: 'build.mjs', text: scriptSource },
};

function Harness() {
  const [fileKey, setFileKey] = useState('large');
  const [readOnly, setReadOnly] = useState(true);
  const [scrollTarget, setScrollTarget] = useState(null);
  const file = files[fileKey];

  window.__AegisReadOnlyPreviewVerify = {
    ready: true,
    view: () => EditorView.findFromDOM(document.querySelector('.cm-editor')),
    scrollTo: (line) => setScrollTarget({ line, token: Date.now() }),
    show: (key) => setFileKey(key),
    setReadOnly,
    snapshot: () => {
      const view = window.__AegisReadOnlyPreviewVerify.view();
      const scroller = view.scrollDOM.getBoundingClientRect();
      const lines = Array.from(view.contentDOM.querySelectorAll('.cm-line'));
      const target = lines.find((line) => line.textContent.startsWith('LINE_${String(TARGET_LINE).padStart(6, '0')}'));
      const targetRect = target?.getBoundingClientRect();
      return {
        docLength: view.state.doc.length,
        docLines: view.state.doc.lines,
        stateReadOnly: view.state.readOnly,
        contentEditable: view.contentDOM.getAttribute('contenteditable'),
        renderedLineCount: lines.length,
        targetVisible: Boolean(targetRect && targetRect.top >= scroller.top && targetRect.bottom <= scroller.bottom),
        languageName: view.state.facet(language)?.name ?? null,
        docText: view.state.doc.length < 1000 ? view.state.doc.toString() : null,
        unchanged: view.state.doc.toString() === file.text,
      };
    },
  };

  return (
    <div style={{ width: 760, height: 400 }}>
      <ProjectTextEditor
        value={file.text}
        fileName={file.name}
        scrollTarget={scrollTarget}
        readOnly={readOnly}
        plainTextFallback
      />
    </div>
  );
}

// Record every key that reaches the page, so the test can prove its key
// events were delivered (CI runners drop keys for unfocused windows).
window.__AegisKeysSeen = [];
document.addEventListener('keydown', (event) => {
  window.__AegisKeysSeen.push((event.shiftKey ? 'Shift+' : '') + event.key);
}, true);

createRoot(document.getElementById('root')).render(<Harness />);
`;

  const main = `
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
app.commandLine.appendSwitch('disable-gpu');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(win, expression) {
  return win.webContents.executeJavaScript(expression, true);
}

const SNAPSHOT = 'window.__AegisReadOnlyPreviewVerify.snapshot()';

async function waitFor(win, expression, label) {
  for (let index = 0; index < 150; index += 1) {
    if (await run(win, expression)) return;
    await delay(100);
  }
  const last = await run(win, SNAPSHOT).catch(() => null);
  throw new Error('Timed out waiting for ' + label + '; last snapshot: ' + JSON.stringify(last));
}

// Focus the editor (a no-op while it is not editable) and send real key
// events, including the custom Tab / Shift-Tab bindings that dispatch edits.
// Resend when the page did not see every key.
async function typeKeys(win, keys) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await run(win, 'window.__AegisKeysSeen = []; window.__AegisReadOnlyPreviewVerify.view().focus()');
    for (const { keyCode, modifiers = [] } of keys) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    }
    for (let index = 0; index < 10; index += 1) {
      await delay(100);
      const seen = await run(win, 'window.__AegisKeysSeen');
      if (seen.length >= keys.length) return seen;
    }
  }
  throw new Error('The page never received keys: ' + JSON.stringify(keys));
}

const EDIT_ATTEMPT = [
  { keyCode: 'Tab' },
  { keyCode: 'Tab', modifiers: ['shift'] },
  { keyCode: 'a' },
  { keyCode: 'Backspace' },
  { keyCode: 'Enter' },
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ webPreferences: { backgroundThrottling: false }, width: 800, height: 460, show: false });
  try {
    await win.loadURL(process.env.AEGIS_READONLY_PREVIEW_VERIFY_URL);
    // Hidden windows drop keys and focus; emulate a focused page instead.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitFor(win, 'Boolean(window.__AegisReadOnlyPreviewVerify?.ready && document.querySelector(".cm-editor"))', 'harness');
    await delay(300);
    const initial = await run(win, SNAPSHOT);

    const keysSeen = await typeKeys(win, EDIT_ATTEMPT);
    const afterTyping = await run(win, SNAPSHOT);

    await run(win, 'window.__AegisReadOnlyPreviewVerify.scrollTo(${TARGET_LINE})');
    await waitFor(win, SNAPSHOT + '.targetVisible', 'line ${TARGET_LINE} to scroll into view');
    const scrolled = await run(win, SNAPSHOT);

    await run(win, 'window.__AegisReadOnlyPreviewVerify.show("script")');
    await waitFor(win, SNAPSHOT + '.languageName === "javascript"', 'javascript language for .mjs');
    await typeKeys(win, EDIT_ATTEMPT);
    const script = await run(win, SNAPSHOT);

    // The same instance can be pointed at an editable file, and the same key
    // path then does edit — proving the read-only attempts above were delivered.
    await run(win, 'window.__AegisReadOnlyPreviewVerify.setReadOnly(false)');
    await waitFor(win, SNAPSHOT + '.contentEditable === "true"', 'the editor to become editable');
    await typeKeys(win, [{ keyCode: 'z' }]);
    await waitFor(win, '!' + SNAPSHOT + '.unchanged', 'typing to edit the editable document');
    const editable = await run(win, SNAPSHOT);

    console.log(JSON.stringify({ ok: true, initial, keysSeen, afterTyping, scrolled, script, editable }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
`;

  await writeFile(
    path.join(tmpDir, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>'
  );
  await writeFile(path.join(tmpDir, 'harness.tsx'), harness);
  await writeFile(path.join(tmpDir, 'electron-main.cjs'), main);
}

async function main() {
  const tmpDir = await mkdtemp(path.join(projectRoot, '.aegis-readonly-preview-'));
  let server;
  try {
    await writeHarness(tmpDir);
    server = await createServer({
      root: projectRoot,
      configFile: path.join(projectRoot, 'vite.config.ts'),
      // Its own dependency cache, and the language the test loads lazily bundled
      // up front: a shared cache re-optimized mid-run left the .mjs language
      // module missing on CI.
      cacheDir: path.join(tmpDir, 'vite-cache'),
      optimizeDeps: { include: ['@codemirror/lang-javascript'] },
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    await server.listen();
    const baseUrl = server.resolvedUrls?.local?.[0];
    assert.ok(baseUrl, 'Vite did not report a local URL');
    const harnessUrl = new URL(`${path.basename(tmpDir)}/index.html`, baseUrl).href;
    const stdout = await runElectron(path.join(tmpDir, 'electron-main.cjs'), {
      AEGIS_READONLY_PREVIEW_VERIFY_URL: harnessUrl,
    });
    const resultLine = stdout.trim().split('\n').filter(Boolean).pop();
    assert.ok(resultLine, 'Electron did not return regression results');
    const result = JSON.parse(resultLine);
    assert.equal(result.ok, true);

    const { initial, keysSeen, afterTyping, scrolled, script, editable } = result;
    assert.equal(initial.docLines, LARGE_LINE_COUNT, 'the whole large file must be loaded');
    assert.ok(initial.docLength > 4_000_000, `the large fixture must be near the 5MB cap (${initial.docLength})`);
    assert.equal(initial.stateReadOnly, true);
    assert.equal(initial.contentEditable, 'false', 'read-only previews must not be editable');
    assert.ok(
      initial.renderedLineCount < 500,
      `only the visible lines may be rendered (${initial.renderedLineCount} of ${initial.docLines})`
    );
    assert.equal(initial.languageName, null, 'unknown file types must be plain text, not Markdown');

    assert.ok(
      keysSeen.includes('Tab') && keysSeen.includes('Shift+Tab'),
      `the edit attempt must reach the page (${JSON.stringify(keysSeen)})`
    );
    assert.equal(afterTyping.unchanged, true, 'typing must not change a read-only preview');

    assert.equal(scrolled.targetVisible, true, `a reveal target must scroll line ${TARGET_LINE} into view`);
    assert.ok(scrolled.renderedLineCount < 500, 'scrolling must keep rendering only the visible lines');

    assert.equal(script.languageName, 'javascript', '.mjs must highlight as JavaScript');
    assert.equal(script.unchanged, true, 'Tab, Shift-Tab and typing must not edit a read-only preview');
    assert.equal(script.contentEditable, 'false');

    assert.equal(editable.stateReadOnly, false, 'readOnly must be reconfigurable on the same instance');
    assert.equal(editable.contentEditable, 'true');
    assert.ok(editable.docText?.includes('z'), `typing must edit once editable (${JSON.stringify(editable.docText)})`);

    console.log('project file read-only preview Electron regression passed');
  } finally {
    if (server) await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

await main();
