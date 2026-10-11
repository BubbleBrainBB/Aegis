// Generative-UI widgets end to end: the real aegis-widget:// protocol and the
// real InlineWidget. A widget loads a bundled library, sizes the chat card to
// its content, follows the app theme live, has no network and can't navigate
// away, sends a prompt only from a real click, keeps its state across a
// remount, gives up its frame far off screen and opens links in the app. A
// call still being written is drawn inert as it grows, and its accepted call
// takes over the same frame and runs it; a refused one disappears.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');

const WIDGET = `
<style>
  .card { height: 320px; color: var(--text-primary); }
  button { padding: 6px 10px; }
</style>
<div class="card">
  <button id="ask" onclick="aegis.sendPrompt('Explain the March dip')">Explain</button>
  <button id="save" onclick="aegis.setState({ tab: 2 })">Save</button>
  <button id="copy-api" onclick="navigator.clipboard.writeText('#75E1A4')">Copy</button>
  <button id="copy-exec" onclick="const t = document.createElement('textarea'); t.value = '#CDF2DD'; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();">Copy old way</button>
  <a id="link" href="https://example.com/report">Report</a>
  <canvas id="chart" width="300" height="120"></canvas>
  <div id="spill" style="position:absolute;left:0;top:330px;height:40px;width:10px"></div>
  <svg width="200" height="40"><rect id="tealbox" class="c-teal" x="0" y="0" width="100" height="30"/><line class="arr" x1="110" y1="15" x2="190" y2="15"/></svg>
</div>
<script src="aegis-widget://lib/chart.js"></script>
<script>
  window.barChart = new Chart(document.getElementById('chart'), { type: 'bar', data: { labels: ['Jan', 'Feb', 'Mar'], datasets: [{ data: [3, 5, 2] }] }, options: { animation: false } });
  window.restored = aegis.getState();
</script>`;

// What models often write: no library tag at all, or a CDN URL (blocked).
const CARELESS = `<canvas id="auto"></canvas>
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<script>
  new Chart(document.getElementById('auto'), { type: 'bar', data: { labels: ['a'], datasets: [{ data: [1] }] }, options: { animation: false } });
  window.autoLoaded = typeof Chart === 'function' && typeof d3 === 'object';
</script>`;

// A show_widget call as it streams: inert markup first, then the whole call.
const DRAFTED = `<style>.d { height: 180px; }</style><div class="d"><h3 id="d-title">Pipeline</h3><button id="d-btn" onclick="window.clicked = true">Go</button><svg width="200" height="60"><text id="d-placed">moved by script</text><text id="d-fixed" x="10" y="30">fixed</text><g transform="translate(20 20)"><text id="d-grouped">grouped</text></g></svg><p id="d-more">more rows</p></div><script>window.ran = (window.ran || 0) + 1; const p = document.getElementById('d-placed'); p.setAttribute('x', '40'); p.setAttribute('y', '40');</script>`;

const harness = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
window.electron = {
  browser: {
    getState: async () => ({ page: null }),
    open: async ({ initialUrl }) => { window.qa.opened = initialUrl; return { page: { url: initialUrl } }; },
    navigate: async ({ url }) => { window.qa.opened = url; return {}; },
  },
  copyWidgetText: (text) => window.qaNative.copy(text),
};
const { InlineWidget } = await import('/src/ui/components/widget/InlineWidget.tsx');
const { ImageStudioSessionContext } = await import('/src/ui/lib/image-studio.ts');
const { useAppStore } = await import('/src/ui/store/useAppStore.ts');
const { useWidgetStateStore } = await import('/src/ui/store/useWidgetStateStore.ts');
const { useWidgetDraftStore } = await import('/src/ui/store/useWidgetDraftStore.ts');
const { AssistantWorkstream } = await import('/src/ui/components/AssistantWorkstream.tsx');
const DRAFTED = ${JSON.stringify(DRAFTED)};
const widgetEntry = (status, isError = false) => ({
  id: 'entry-draft', type: 'tool', toolName: 'mcp__aegis-sessions__show_widget', status, summary: 'Widget',
  block: { type: 'tool_use', id: 'tool-draft', name: 'mcp__aegis-sessions__show_widget', input: { title: 'Pipeline', html: DRAFTED } },
  result: status === 'pending' ? undefined : { type: 'tool_result', tool_use_id: 'tool-draft', content: 'ok', is_error: isError },
});
const traceModel = (entries) => ({ state: 'running', title: '', summary: '', entries, previewEntries: entries, toolCount: entries.length, noteCount: 0, hiddenEntryCount: 0, todoProgress: null });
await import('/src/ui/index.css');
document.documentElement.style.setProperty('--text-primary', 'rgb(10, 20, 30)');
window.qa = { store: useAppStore, widgets: useWidgetStateStore, drafts: useWidgetDraftStore, DRAFTED };
function Harness() {
  const [mount, setMount] = useState(1);
  const [spacer, setSpacer] = useState(0);
  const [careless, setCareless] = useState(false);
  const [trace, setTrace] = useState(null);
  window.qa.trace = (status, isError) => setTrace(status ? [widgetEntry(status, isError)] : []);
  window.qa.remount = () => setMount((value) => value + 1);
  window.qa.careless = () => setCareless(true);
  window.qa.spacer = setSpacer;
  return <ImageStudioSessionContext.Provider value="s1">
    <div id="scroller" style={{ height: 620, overflowY: 'auto' }}>
      <div style={{ width: 640, padding: 8 }}>
        <InlineWidget key={mount} toolUseId="tool-1" title="Revenue" html={${JSON.stringify(WIDGET)}} />
        {careless ? <InlineWidget toolUseId="tool-2" html={${JSON.stringify(CARELESS)}} /> : null}
        {trace ? <div id="trace"><AssistantWorkstream live model={traceModel(trace)} /></div> : null}
        <div style={{ height: spacer }} />
      </div>
    </div>
  </ImageStudioSessionContext.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;

const main = String.raw`
const { app, BrowserWindow, clipboard } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const root = process.env.QA_ROOT;
const widget = require(path.join(root, 'dist-electron/electron/widget-protocol.js'));
widget.registerWidgetSchemePrivileged();
app.on('web-contents-created', (_event, contents) => widget.guardWidgetFrameNavigation(contents));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  widget.installWidgetProtocol();
  require('electron').ipcMain.handle('qa:copy', (_event, text) => { clipboard.writeText(String(text)); return true; });
  let hits = 0;
  const server = http.createServer((_req, res) => { hits += 1; res.end('leak'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ width: 900, height: 700, show: true, webPreferences: { backgroundThrottling: false, preload: path.join(process.env.QA_DIR, 'preload.cjs') } });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const until = async (check, label, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await check(); if (value) return value; await delay(60); } throw new Error('timed out: ' + label); };
  // After a remount the old frame can linger in the list for a moment; the
  // newest is the live one.
  const widgetFrames = () => win.webContents.mainFrame.framesInSubtree.filter((frame) => frame.url.startsWith('aegis-widget://') && !frame.detached);
  const widgetFrame = () => widgetFrames().at(-1);
  // A frame being torn down may never answer; don't let one call hang the run.
  const settle = (promise, ms = 3000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('frame did not answer')), ms))]);
  const inWidget = (code) => settle(widgetFrame().executeJavaScript(code));
  try {
    await win.loadURL(process.env.QA_URL);
    await until(() => widgetFrame() && inWidget('window.barChart instanceof Chart').catch(() => false), 'widget renders with Chart.js');
    assert.equal(await inWidget('typeof Chart'), 'function', 'the bundled library loads');
    await until(async () => (await js('document.querySelector("[data-chat-widget] > div").getBoundingClientRect().height')) >= 300, 'card sizes to content');
    // Content that spills out of the root (absolutely positioned) still fits: no scrollbar.
    await until(async () => (await inWidget('document.documentElement.scrollHeight <= document.documentElement.clientHeight')), 'the frame grows to fit spilling content (no scrollbar)');

    // Theme: variables arrive, and follow changes live.
    assert.equal(await inWidget('getComputedStyle(document.querySelector(".card")).color'), 'rgb(10, 20, 30)');
    await js('document.documentElement.style.setProperty("--text-primary", "rgb(200, 100, 50)")');
    await until(async () => (await inWidget('getComputedStyle(document.querySelector(".card")).color')) === 'rgb(200, 100, 50)', 'theme change reaches the widget');

    // The design system: pre-styled controls, ramp classes that flip for dark
    // mode, and the shared arrow marker.
    assert.equal(await inWidget('getComputedStyle(document.getElementById("ask")).borderTopLeftRadius'), '8px', 'buttons come styled');
    assert.equal(await inWidget('getComputedStyle(document.getElementById("tealbox")).fill'), 'rgb(233, 252, 247)', 'c-teal fills with stop 50');
    assert.ok(await inWidget('!!document.getElementById("arrow")'), 'arrow marker defined');
    await js('document.documentElement.classList.add("dark")');
    await until(async () => (await inWidget('getComputedStyle(document.getElementById("tealbox")).fill')) === 'rgb(0, 78, 66)', 'dark mode switches the ramp to stop 800');
    await js('document.documentElement.classList.remove("dark")');

    // No network, no navigating away.
    assert.equal(await inWidget('fetch("http://127.0.0.1:' + server.address().port + '/").then(() => "reached", () => "blocked")'), 'blocked');
    assert.equal(hits, 0, 'the request never left');
    await inWidget('location.href = "http://127.0.0.1:' + server.address().port + '/"').catch(() => {});
    await delay(400);
    assert.ok(widgetFrame() && widgetFrame().url.startsWith('aegis-widget://'), 'the frame stays on its shell');
    assert.equal(hits, 0);

    // sendPrompt: refused without a click, delivered with one.
    assert.equal(await inWidget('aegis.sendPrompt("sneaky")'), false);
    // Synthetic input doesn't route into the out-of-process widget frame in
    // this harness; a click run with a user gesture grants the same user
    // activation a real click does.
    const click = async (selector) => {
      await settle(widgetFrame().executeJavaScript('document.querySelector(' + JSON.stringify(selector) + ').click()', true));
      await delay(200);
    };
    await click('#ask');
    const injection = await until(() => js('qa.store.getState().pendingChatInjection'), 'prompt injected');
    assert.equal(injection.text, 'Explain the March dip');
    assert.equal(injection.submit, true);
    assert.equal(injection.sessionId, 's1');

    // The standard copy calls (blocked in the sandbox) reach the clipboard.
    const userClipboard = clipboard.readText();
    await click('#copy-api');
    await until(() => clipboard.readText() === '#75E1A4', 'navigator.clipboard.writeText copies');
    await click('#copy-exec');
    await until(() => clipboard.readText() === '#CDF2DD', 'execCommand("copy") copies');
    clipboard.writeText(userClipboard);

    // Links open in the app's browser.
    await click('#link');
    await until(() => js('qa.opened === "https://example.com/report"'), 'link opened in the app browser');

    // State survives a remount.
    await click('#save');
    await until(() => js('qa.widgets.getState().states["tool-1"]?.value?.tab === 2'), 'state saved');
    await js('qa.remount()');
    await until(() => widgetFrames().length === 1 && inWidget('window.restored && window.restored.tab === 2').catch(() => false), 'state restored after remount');

    // Just out of view the frame stays (no reload while scrolling past); far
    // off screen it goes, keeping its height; it comes back.
    await js('qa.spacer(6000)');
    await delay(100);
    await js('document.getElementById("scroller").scrollTop = 900');
    await delay(400);
    assert.ok(await js('!!document.querySelector("[data-chat-widget] iframe")'), 'a widget just out of view keeps its frame');
    await js('document.getElementById("scroller").scrollTop = 5000');
    await until(() => js('!document.querySelector("[data-chat-widget] iframe")'), 'frame dropped off screen');
    const placeholder = await js('document.querySelector("[data-chat-widget] > div").getBoundingClientRect().height');
    assert.ok(placeholder >= 300, 'placeholder keeps the height: ' + placeholder);
    await js('document.getElementById("scroller").scrollTop = 0');
    await until(() => widgetFrame() && inWidget('window.barChart instanceof Chart').catch(() => false), 'frame back on screen');

    // A widget that forgot its library tag, or pointed it at a CDN, still works.
    await js('qa.spacer(0); qa.careless()');
    const autoFrame = async () => {
      for (const frame of widgetFrames()) {
        if (await settle(frame.executeJavaScript('!!document.getElementById("auto")')).catch(() => false)) return frame;
      }
      return null;
    };
    await until(async () => { const frame = await autoFrame(); return frame && settle(frame.executeJavaScript('window.autoLoaded === true')).catch(() => false); }, 'missing and CDN libraries load from the bundle');
    assert.ok(!(await js('document.body.innerText.includes("Failed to load")')), 'no load error for the rewritten CDN tag');

    // A call still being written: drawn as it grows, inert, in one frame; the
    // accepted call takes over that frame and runs it once.
    await js('qa.spacer(0)');
    const draftFrame = async () => {
      for (const frame of widgetFrames()) {
        if (await settle(frame.executeJavaScript('!!document.getElementById("d-title")')).catch(() => false)) return frame;
      }
      return null;
    };
    const inDraft = async (code) => settle((await draftFrame()).executeJavaScript(code, true));
    await js('qa.trace(null); qa.drafts.getState().put("s1", { toolUseId: "tool-draft", html: qa.DRAFTED.slice(0, qa.DRAFTED.indexOf("<p id")) })');
    await until(() => draftFrame(), 'the draft is drawn in the trace');
    // Chromium pauses rendering in off-screen cross-origin frames (no sizing
    // until visible); the chat keeps a streaming draft in view.
    await js('document.getElementById("trace").scrollIntoView({ block: "end" })');
    assert.equal(await inDraft('document.getElementById("d-more")'), null, 'only what has arrived');
    assert.equal(await inDraft('typeof window.ran'), 'undefined', 'no script runs in a draft');
    assert.equal(await inDraft('document.getElementById("d-btn").hasAttribute("onclick")'), false, 'inline handlers stay inert');
    assert.equal(await inDraft('document.getElementById("d-placed").getAttribute("visibility")'), 'hidden', 'an SVG label the script will place waits instead of piling up at 0,0');
    assert.equal(await inDraft('document.getElementById("d-fixed").getAttribute("visibility")'), null, 'a placed label shows');
    assert.equal(await inDraft('document.getElementById("d-grouped").getAttribute("visibility")'), null, 'a label placed by its group shows');
    await until(async () => (await js('document.querySelector("#trace [data-chat-widget] > div").getBoundingClientRect().height')) >= 170, 'the draft sizes the card');
    await inDraft('window.sameFrame = true');
    await js('qa.drafts.getState().put("s1", { toolUseId: "tool-draft", html: qa.DRAFTED })');
    await until(() => inDraft('!!document.getElementById("d-more")').catch(() => false), 'the draft grows');
    assert.equal(await inDraft('typeof window.ran'), 'undefined', 'a complete-looking draft still waits for its call');
    await js('qa.trace("pending")');
    await delay(300);
    assert.equal(await inDraft('typeof window.ran'), 'undefined', 'a call the tool has not answered stays inert');
    await js('qa.trace("success")');
    await until(() => inDraft('window.ran === 1').catch(() => false), 'the accepted call runs its scripts');
    assert.equal(await inDraft('window.sameFrame'), true, 'in the frame the draft was drawn in');
    assert.equal(await inDraft('document.getElementById("d-placed").getAttribute("visibility")'), null, 'the live widget shows every label');
    assert.equal(await js('document.querySelectorAll("#trace [data-chat-widget]").length'), 1, 'the draft gave way to its call');
    await inDraft('document.getElementById("d-btn").click()');
    assert.equal(await inDraft('window.clicked'), true, 'handlers work once live');
    await delay(300);
    assert.equal(await inDraft('window.ran'), 1, 'scripts ran once');
    // A refused call disappears with its draft.
    await js('qa.trace("error", true)');
    await until(() => js('!document.querySelector("#trace [data-chat-widget]")'), 'a refused widget is not drawn');
    await js('qa.drafts.getState().clear("s1")');

    console.log(JSON.stringify({ ok: true }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
`;

const qaRoot = path.join(root, '.aegis-design-qa');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'widget-'));
let server;
try {
  await writeFile(path.join(tmp, 'index.html'), '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  await writeFile(path.join(tmp, 'preload.cjs'), "const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('qaNative', { copy: (text) => ipcRenderer.invoke('qa:copy', text) });");
  server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    // Own dep cache: sharing node_modules/.vite breaks a running dev server.
    cacheDir: path.join(tmp, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const url = new URL(`${path.relative(root, tmp).split(path.sep).join('/')}/index.html`, server.resolvedUrls.local[0]).href;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(electronBin, [path.join(tmp, 'main.cjs')], { cwd: root, env: { ...process.env, QA_URL: url, QA_ROOT: root, QA_DIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out\n${out}\n${err}`)); }, 120000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('exit', (code) => { clearTimeout(timer); code === 0 && out.includes('"ok":true') ? resolve(out) : reject(new Error(`${out}\n${err}`)); });
  });
  void output;
  console.log('widget Electron: library, sizing, live theme, no network, no navigation, click-only prompt, state across remount, offscreen unload, links, missing/CDN libraries, streamed draft → live call in one frame, refused call hidden');
} finally {
  if (server) await server.close();
  await rm(tmp, { recursive: true, force: true });
}
