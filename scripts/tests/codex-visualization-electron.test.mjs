// Codex `visualize` references end to end: a reply's content reference
// renders in place, in the newest installed plugin runtime (read from the
// Codex home, never bundled), themed through the host style variables, with
// window.openai wired to Aegis (follow-up prompts, widget state restored after
// a remount). A file outside the session's project is refused.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');

const qaRoot = path.join(root, '.aegis-design-qa');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'codex-viz-'));
const codexHome = path.join(tmp, 'codex');
const project = path.join(tmp, 'project');
const elsewhere = path.join(tmp, 'elsewhere');
const runtime = (version) => path.join(codexHome, 'plugins/cache/openai-bundled/visualize', version, 'skills/visualize/assets');

const fragment = `<div id="viz" class="card" style="height:240px">GDP
  <button id="ask" type="button" onclick="window.openai.sendFollowUpMessage({ prompt: 'Explain Shanghai' })">Ask</button>
  <button id="save" type="button" onclick="window.openai.setWidgetState({ privateContent: { tab: 3 } })">Save</button>
</div>
<script>window.__restored = window.openai.widgetState;</script>`;

const ref = (file) => `visualize${JSON.stringify({ path: file })}`;
const reply = `Here is the chart.\n${ref(path.join(project, 'output', 'gdp.html'))}\nShanghai leads.\n${ref(path.join(elsewhere, 'x.html'))}`;

const harness = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
const { StructuredResponse } = await import('/src/ui/components/StructuredResponse.tsx');
const { ImageStudioSessionContext } = await import('/src/ui/lib/image-studio.ts');
const { useAppStore } = await import('/src/ui/store/useAppStore.ts');
const { useWidgetStateStore } = await import('/src/ui/store/useWidgetStateStore.ts');
await import('/src/ui/index.css');
window.electron = { ...window.electron, prepareCodexVisualization: (input) => window.qaNative.prepare(input) };
document.documentElement.style.setProperty('--text-primary', 'rgb(10, 20, 30)');
useAppStore.setState({ sessions: { s1: { id: 's1', cwd: ${JSON.stringify(project)} } } });
window.qa = { store: useAppStore, widgets: useWidgetStateStore };
function Harness() {
  const [mount, setMount] = useState(1);
  window.qa.remount = () => setMount((value) => value + 1);
  return <ImageStudioSessionContext.Provider value="s1">
    <div style={{ width: 640, padding: 8 }}><StructuredResponse key={mount} content={${JSON.stringify(reply)}} /></div>
  </ImageStudioSessionContext.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;

const main = String.raw`
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.env.QA_ROOT;
const widget = require(path.join(root, 'dist-electron/electron/widget-protocol.js'));
const codex = require(path.join(root, 'dist-electron/electron/codex-visualization.js'));
widget.registerWidgetSchemePrivileged();
app.on('web-contents-created', (_event, contents) => widget.guardWidgetFrameNavigation(contents));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  widget.installWidgetProtocol();
  ipcMain.handle('qa:prepare', (_event, input) => codex.prepareCodexVisualization(input));
  const win = new BrowserWindow({ width: 900, height: 800, show: true, webPreferences: { backgroundThrottling: false, preload: path.join(process.env.QA_DIR, 'preload.cjs') } });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const until = async (check, label, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await check(); if (value) return value; await delay(60); } throw new Error('timed out: ' + label); };
  const settle = (promise, ms = 3000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('frame did not answer')), ms))]);
  const frames = () => win.webContents.mainFrame.framesInSubtree.filter((frame) => frame.url.startsWith('aegis-widget://codex/') && !frame.detached);
  const inFrame = (code) => settle(frames().at(-1).executeJavaScript(code));
  const click = (selector) => settle(frames().at(-1).executeJavaScript('document.querySelector(' + JSON.stringify(selector) + ').click()', true));
  try {
    await win.loadURL(process.env.QA_URL);
    await until(() => frames().length === 1 && inFrame('!!document.getElementById("viz") && window.__kitRan === "1.0.1"').catch(() => false), 'fragment renders in the newest runtime');
    assert.equal(await inFrame('document.documentElement.dataset.theme'), 'light');
    assert.equal(await inFrame('getComputedStyle(document.querySelector(".card")).color'), 'rgb(10, 20, 30)', 'Aegis text color through --color-text-primary');
    assert.equal(await inFrame('typeof window.openai.setWidgetState'), 'function');
    assert.ok(await js('document.body.innerText.includes("Here is the chart.") && document.body.innerText.includes("Shanghai leads.")'), 'text around the reference stays');
    assert.ok(!(await js('document.body.innerText.includes("visualize")')), 'no raw reference');
    await until(() => js('document.body.innerText.includes("outside this session")'), 'a file outside the project is refused');

    // Theme changes reach the runtime's host variables.
    await js('document.documentElement.style.setProperty("--text-primary", "rgb(200, 100, 50)")');
    await until(async () => (await inFrame('getComputedStyle(document.querySelector(".card")).color')) === 'rgb(200, 100, 50)', 'theme follows');

    // Follow-ups go to the conversation; state comes back after a remount.
    await click('#ask');
    const injection = await until(() => js('qa.store.getState().pendingChatInjection'), 'follow-up injected');
    assert.equal(injection.text, 'Explain Shanghai');
    assert.equal(injection.submit, true);
    await click('#save');
    const key = 'codex:' + ${JSON.stringify(path.join(project, 'output', 'gdp.html'))};
    await until(() => js('qa.widgets.getState().states[' + JSON.stringify(key) + ']?.value?.privateContent?.tab === 3'), 'state saved');
    await js('qa.remount()');
    await until(() => frames().length === 1 && inFrame('window.__restored && window.__restored.privateContent.tab === 3').catch(() => false), 'state restored after remount');
    console.log(JSON.stringify({ ok: true }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
`;

let server;
try {
  await mkdir(path.join(project, 'output'), { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  await writeFile(path.join(project, 'output', 'gdp.html'), fragment);
  await writeFile(path.join(elsewhere, 'x.html'), '<div>nope</div>');
  for (const version of ['1.0.0', '1.0.1']) {
    await mkdir(runtime(version), { recursive: true });
    await writeFile(path.join(runtime(version), 'visualize.css'), ':root { --foreground: var(--color-text-primary, black); } .card { color: var(--foreground); } body { margin: 0; }');
    await writeFile(path.join(runtime(version), 'visualize.html'), `<!--__INLINE_VISUALIZATION_FRAGMENT__-->\n<script>window.__kitRan = ${JSON.stringify(version)};</script>`);
  }
  await writeFile(path.join(tmp, 'index.html'), '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  await writeFile(path.join(tmp, 'preload.cjs'), "const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('qaNative', { prepare: (input) => ipcRenderer.invoke('qa:prepare', input) });");
  server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    // Own dep cache: sharing node_modules/.vite breaks a running dev server.
    cacheDir: path.join(tmp, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const url = new URL(`${path.relative(root, tmp).split(path.sep).join('/')}/index.html`, server.resolvedUrls.local[0]).href;
  await new Promise((resolve, reject) => {
    const child = spawn(electronBin, [path.join(tmp, 'main.cjs')], {
      cwd: root,
      env: { ...process.env, QA_URL: url, QA_ROOT: root, QA_DIR: tmp, CODEX_HOME: codexHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out\n${out}\n${err}`)); }, 120000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('exit', (code) => { clearTimeout(timer); code === 0 && out.includes('"ok":true') ? resolve(out) : reject(new Error(`${out}\n${err}`)); });
  });
  console.log('codex visualization Electron: in place, newest runtime, host theme vars, follow-up, state across remount, outside-project refused');
} finally {
  if (server) await server.close();
  await rm(tmp, { recursive: true, force: true });
}
