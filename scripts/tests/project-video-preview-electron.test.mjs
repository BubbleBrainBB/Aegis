import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// A video opened from the project tree plays in the same player as a task
// attachment: own control bar under the picture, options menu, Save as.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronBin = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');

const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectTreePanel } from '/src/ui/components/ProjectTreePanel.tsx';
import { useAppStore } from '/src/ui/store/useAppStore.ts';
import '/src/ui/index.css';

const cwd = '/qa/project';
useAppStore.setState({ projectCwd: cwd });
const file = (name, dir = '/media') => ({ name, path: cwd + dir + '/' + name, kind: 'file' });
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { qa.copied.push(text); } } });
window.qa = { saved: [], copied: [], urls: [], open: () => useAppStore.getState().openProjectFileInRightPanel({ cwd, path: cwd + '/media/clip.mp4' }) };
window.electron = {
  getProjectTree: async (root) => ({ name: 'project', path: root, kind: 'dir', children: [
    { name: 'media', path: root + '/media', kind: 'dir', children: [
      { name: 'raw', path: root + '/media/raw', kind: 'dir', children: [file('take 2.mp4', '/media/raw')] },
      file('clip.mp4'), file('other.mp4'),
    ] },
  ] }),
  watchProjectTree: async () => true,
  unwatchProjectTree: async () => true,
  // The project is a folder inside its repository.
  getGitRepoBrief: async () => ({ ok: true, root: '/qa', fullName: 'acme/films', branch: 'feat/cut', defaultBranch: 'main' }),
  openExternalUrl: async (url) => { qa.urls.push(url); return { ok: true }; },
  readProjectFilePreview: async (_cwd, filePath) => ({
    kind: 'video', path: filePath, name: filePath.split('/').pop(), ext: '.mp4', size: 10,
    previewUrl: '/scripts/tests/fixtures/video-preview.mp4',
  }),
  listOpenWithApps: async () => ({ ok: true, apps: [{ name: 'QuickTime Player', appPath: '/System/Applications/QuickTime Player.app', iconDataUrl: null }] }),
  saveFileCopy: async (root, filePath) => { qa.saved.push({ cwd: root, path: filePath }); return { ok: true, filePath: '/Downloads/clip.mp4' }; },
};

function Harness() {
  const openRequest = useAppStore((state) => state.pendingProjectFileOpen);
  const onOpenRequestConsumed = useAppStore((state) => state.clearPendingProjectFileOpen);
  return (
    <ProjectTreePanel
      sessionId="qa"
      utilityTabId={openRequest?.tabId ?? 'files'}
      activeTab="files"
      collapsed={false}
      embedded
      onClose={() => {}}
      sharedPanelWidth={760}
      openRequest={openRequest}
      onOpenRequestConsumed={onOpenRequestConsumed}
    />
  );
}
createRoot(document.getElementById('root')).render(<Harness />);
`;

const main = `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// CI runners have Reduce Motion on; tests expect the default motion preference.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 640, show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const wait = async (code) => { for (let i = 0; i < 80; i += 1) { if (await js(code)) return; await delay(75); } throw new Error('Timed out: ' + code); };
  const click = async (label) => { assert(await js('(()=>{const b=document.querySelector("button[aria-label=' + JSON.stringify(label).replaceAll('"', '\\\\"') + ']");b?.click();return !!b})()'), 'Missing ' + label); await delay(150); };
  const pick = async (role, text) => {
    const find = '[...document.querySelectorAll("[role=' + role + ']")].find(e=>e.textContent.trim()===' + JSON.stringify(text) + ')';
    await wait('!!' + find); await js(find + '.click()'); await delay(150);
  };
  try {
    await win.loadURL(process.env.QA_URL);
    await wait('Boolean(window.qa)');
    await delay(300);
    await js('window.qa.open()');
    await wait('document.querySelector("video")?.readyState>=2');
    assert.equal(await js('document.querySelector("video").controls'), false, 'the player draws its own controls');
    const box = await js('(()=>{const r=s=>{const b=document.querySelector(s).getBoundingClientRect();return {top:b.top,bottom:b.bottom,width:b.width,height:b.height}};return {video:r("video"),bar:r("[data-video-controls]"),root:r("#root")}})()');
    assert.ok(box.video.height > 200, 'the video fills the preview area: ' + JSON.stringify(box));
    assert.ok(box.bar.top >= box.video.bottom && box.root.bottom - box.bar.bottom < 40, 'controls sit at the bottom of the panel: ' + JSON.stringify(box));
    await js('document.querySelector("video").muted=true');
    await click('Play'); await delay(400);
    assert.ok(await js('document.querySelector("video").currentTime>0'), 'the video plays');
    await click('Pause');
    await click('Video options'); await pick('menuitem', '1.5×');
    assert.equal(await js('document.querySelector("video").playbackRate'), 1.5);
    await click('Video options'); await pick('menuitem', 'Save video as…');
    await click('Open with…'); await pick('menuitem', 'Save as…');
    const file = { cwd: '/qa/project', path: '/qa/project/media/clip.mp4' };
    assert.deepEqual(await js('qa.saved'), [file, file]);
    // Header: the path in three forms, the file on GitHub, and folders that open.
    await click('Copy path');
    await click('Copy path as…');
    assert.deepEqual(await js('[...document.querySelectorAll("[role=menu] [role=menuitem]")].map(e=>e.textContent.trim())'), ['Absolute path', 'Relative to project', 'Relative to repo']);
    await pick('menuitem', 'Relative to project');
    await click('Copy path as…'); await pick('menuitem', 'Relative to repo');
    assert.deepEqual(await js('qa.copied'), ['/qa/project/media/clip.mp4', 'media/clip.mp4', 'project/media/clip.mp4']);
    await click('Open in GitHub'); await delay(200);
    await click('Open with…'); await pick('menuitem', 'Open in GitHub'); await delay(200);
    const github = 'https://github.com/acme/films/blob/feat/cut/project/media/clip.mp4';
    assert.deepEqual(await js('qa.urls'), [github, github]);
    await click('Browse media');
    await wait('[...document.querySelectorAll("[role=menu] [role=menuitem]")].length===3');
    assert.deepEqual(await js('[...document.querySelectorAll("[role=menu] [role=menuitem]")].map(e=>e.textContent.trim())'), ['raw', 'clip.mp4', 'other.mp4']);
    await pick('menuitem', 'raw');
    assert.deepEqual(await js('[...document.querySelectorAll("[role=menu] [role=menuitem]")].map(e=>e.textContent.trim())'), ['raw', 'take 2.mp4', 'clip.mp4', 'other.mp4'], 'a folder opens in place');
    if (process.env.QA_CAPTURE) {
      fs.mkdirSync(process.env.QA_CAPTURE, { recursive: true });
      fs.writeFileSync(path.join(process.env.QA_CAPTURE, 'project-breadcrumb.png'), (await win.webContents.capturePage()).toPNG());
    }
    await pick('menuitem', 'take 2.mp4');
    await wait('document.querySelector("[data-testid=files-path-bar]")?.textContent.includes("take 2.mp4")');
    assert.equal(await js('document.querySelector("[data-testid=files-path-bar]").textContent.includes("raw")'), true, 'the breadcrumb follows the opened file');
    await wait('document.querySelector("video")?.readyState>=2');
    if (process.env.QA_CAPTURE) {
      fs.mkdirSync(process.env.QA_CAPTURE, { recursive: true });
      fs.writeFileSync(path.join(process.env.QA_CAPTURE, 'project-video.png'), (await win.webContents.capturePage()).toPNG());
    }
    assert.deepEqual(errors, []);
    console.log('project video preview Electron regression passed');
    app.exit(0);
  } catch (error) {
    console.error(error, errors);
    app.exit(1);
  }
});
`;

const qaRoot = path.join(projectRoot, '.aegis-design-qa');
await mkdir(qaRoot, { recursive: true });
const tmpDir = await mkdtemp(path.join(qaRoot, 'project-video-preview-'));
let server;
try {
  await writeFile(path.join(tmpDir, 'index.html'), '<!doctype html><html><body style="margin:0"><div id="root" style="position:relative;width:760px;height:600px"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmpDir, 'harness.tsx'), harness);
  await writeFile(path.join(tmpDir, 'electron-main.cjs'), main);
  server = await createServer({
    root: projectRoot,
    configFile: path.join(projectRoot, 'vite.config.ts'),
    // Own dep cache: sharing node_modules/.vite breaks a running dev server.
    cacheDir: path.join(tmpDir, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0];
  assert.ok(baseUrl, 'Vite did not report a local URL');
  const harnessPath = path.relative(projectRoot, tmpDir).split(path.sep).join('/');
  await new Promise((resolve, reject) => {
    const env = { ...process.env, QA_URL: new URL(`${harnessPath}/index.html`, baseUrl).href, QA_CAPTURE: path.join(projectRoot, 'output/session-sources-qa') };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronBin, [path.join(tmpDir, 'electron-main.cjs')], { cwd: projectRoot, env, stdio: 'inherit' });
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Project video preview test timed out')); }, 120_000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error(`Project video preview test exited with ${code}`)); });
  });
} finally {
  if (server) await server.close();
  await rm(tmpDir, { recursive: true, force: true });
}
