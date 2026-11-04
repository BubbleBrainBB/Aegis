// Opening a file reference with a line number must scroll the real Files panel
// to that line, for every surface a text file can land on: read-only code,
// HTML source, editable text, MDX source and Markdown. The panel is driven the
// way the app drives it, through openProjectFileInRightPanel.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronBin = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');

const LINE_COUNT = 400;
const TARGET_LINE = 300;
const SECOND_TARGET_LINE = 200;

const FILES = [
  { name: 'First.tsx', kind: 'text', ext: '.tsx', editable: false, prefix: 'TSX' },
  { name: 'page.html', kind: 'html', ext: '.html', editable: false, prefix: 'HTML' },
  { name: 'notes.txt', kind: 'text', ext: '.txt', editable: true, prefix: 'TXT' },
  { name: 'doc.mdx', kind: 'text', ext: '.mdx', editable: true, prefix: 'MDX' },
  { name: 'readme.md', kind: 'markdown', ext: '.md', editable: true, prefix: 'MD' },
];

const marker = (prefix, line) => `${prefix}_LINE_${String(line).padStart(3, '0')}`;

const mock = `
const LINE_COUNT = ${LINE_COUNT};
const FILES = ${JSON.stringify(FILES)};
const marker = (prefix, line) => prefix + '_LINE_' + String(line).padStart(3, '0');
const frontmatter = ['---', 'title: Doc', 'status: draft', '---'];

export const sources = Object.fromEntries(FILES.map((file) => [file.name, Array.from(
  { length: LINE_COUNT },
  (_, index) => (file.ext === '.mdx' && frontmatter[index])
    // Wrapped lines make CodeMirror's height estimate for unrendered lines wrong.
    || marker(file.prefix, index + 1) + (file.ext === '.md' && index % 10 === 4 ? ' wrapped'.repeat(60) : '')
).join('\\n')]));

window.electron = {
  getProjectTree: async (cwd) => ({ name: 'project', path: cwd, kind: 'dir', children: [] }),
  readProjectFilePreview: async (_cwd, filePath) => {
    const name = filePath.split('/').pop();
    const file = FILES.find((entry) => entry.name === name);
    return {
      kind: file.kind,
      path: filePath,
      name,
      ext: file.ext,
      size: sources[name].length,
      mtimeMs: 1,
      text: sources[name],
      editable: file.editable,
    };
  },
};
`;

const harness = `
import { sources } from './mock.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { ProjectTreePanel } from '/src/ui/components/ProjectTreePanel.tsx';
import { useAppStore } from '/src/ui/store/useAppStore.ts';
import '/src/ui/index.css';

const cwd = '/qa/project';
const editorView = () => {
  const node = document.querySelector('.cm-editor');
  return node ? EditorView.findFromDOM(node) : null;
};
// Markdown scrolls its page around the editor; the others scroll inside it.
const scroller = (view) => document.querySelector('.aegis-md-main') || view.scrollDOM;

window.qa = {
  open: (name, lineStart) => useAppStore.getState().openProjectFileInRightPanel({
    cwd,
    path: cwd + '/' + name,
    ...(lineStart ? { lineStart, lineEnd: lineStart } : {}),
  }),
  scrollToTop: () => {
    const view = editorView();
    if (view) scroller(view).scrollTop = 0;
  },
  clickProperty: (key) => {
    const button = Array.from(document.querySelectorAll('.aegis-mdx-property-key'))
      .find((node) => node.textContent === key);
    button?.click();
    return Boolean(button);
  },
  snapshot: (name, text) => {
    const view = editorView();
    if (!view) return { mounted: false };
    const viewport = scroller(view);
    const viewportRect = viewport.getBoundingClientRect();
    const line = Array.from(view.contentDOM.querySelectorAll('.cm-line'))
      .find((node) => node.textContent.startsWith(text));
    const rect = line?.getBoundingClientRect();
    const head = view.state.selection.main.head;
    return {
      mounted: true,
      visible: Boolean(rect && rect.top >= viewportRect.top && rect.bottom <= viewportRect.bottom),
      scrollTop: viewport.scrollTop,
      completeFile: view.state.doc.toString() === sources[name],
      caretLine: view.state.doc.lineAt(head).number,
      readOnly: view.state.readOnly,
    };
  },
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
const FILES = ${JSON.stringify(FILES)};
const marker = (prefix, line) => prefix + '_LINE_' + String(line).padStart(3, '0');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// CI runners have Reduce Motion on; tests expect the default motion preference.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 640, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const snapshot = (name, text) => js('window.qa.snapshot(' + JSON.stringify(name) + ',' + JSON.stringify(text) + ')');
  const open = (name, line) => js('window.qa.open(' + JSON.stringify(name) + ',' + (line || 0) + ')');
  // Waits for the line, then lets late scrolls or a view-state restore land
  // so the result is where the panel settled.
  const settled = async (name, text) => {
    let last = null;
    for (let index = 0; index < 50; index += 1) {
      last = await snapshot(name, text);
      if (last.visible) break;
      await delay(100);
    }
    await delay(300);
    return snapshot(name, text);
  };
  try {
    await win.loadURL(process.env.QA_URL);
    for (let i = 0; i < 600 && !(await js('Boolean(window.qa)')); i += 1) await delay(100);
    await delay(300);

    const results = {};
    for (const file of FILES) {
      const text = marker(file.prefix, ${TARGET_LINE});
      await open(file.name, ${TARGET_LINE});
      const first = await settled(file.name, text);
      await js('window.qa.scrollToTop()');
      await delay(200);
      const scrolledAway = await snapshot(file.name, text);
      await open(file.name, ${TARGET_LINE});
      const repeated = await settled(file.name, text);
      results[file.name] = { first, scrolledAway, repeated };
    }

    // doc.mdx and readme.md are now open tabs too: a new line in an open tab
    // must win over the tab's saved position.
    await open('notes.txt', ${SECOND_TARGET_LINE});
    const openTab = await settled('notes.txt', marker('TXT', ${SECOND_TARGET_LINE}));

    // A reference without a line must not inherit the previous file's line.
    await open('First.tsx', ${TARGET_LINE});
    await settled('First.tsx', marker('TSX', ${TARGET_LINE}));
    await open('readme.md');
    const noLineMarkdown = await settled('readme.md', marker('MD', 1));
    await open('First.tsx');
    const noLineCode = await settled('First.tsx', marker('TSX', 1));

    // MDX Properties reveal their source line, moving the caret as well.
    await open('doc.mdx', ${TARGET_LINE});
    await settled('doc.mdx', marker('MDX', ${TARGET_LINE}));
    const clickedProperty = await js('window.qa.clickProperty("status")');
    const mdxProperty = await settled('doc.mdx', 'status: draft');

    console.log(JSON.stringify({ ok: true, results, openTab, noLineMarkdown, noLineCode, clickedProperty, mdxProperty }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
`;

function runElectron(mainPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronBin, [mainPath], { cwd: projectRoot, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`File reveal panel test timed out\n${stdout}\n${stderr}`));
    }, 120_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`File reveal panel test exited with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

const qaRoot = path.join(projectRoot, '.aegis-design-qa');
await mkdir(qaRoot, { recursive: true });
const tmpDir = await mkdtemp(path.join(qaRoot, 'file-reveal-panel-'));
let server;
try {
  await writeFile(path.join(tmpDir, 'index.html'), '<!doctype html><html><body><div id="root" style="position:relative;width:760px;height:600px"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmpDir, 'mock.js'), mock);
  await writeFile(path.join(tmpDir, 'harness.tsx'), harness);
  await writeFile(path.join(tmpDir, 'electron-main.cjs'), main);
  server = await createServer({
    root: projectRoot,
    configFile: path.join(projectRoot, 'vite.config.ts'),
    // Own dep cache: sharing node_modules/.vite breaks a running dev server.
    // The languages load lazily; bundled up front so no re-optimize reloads mid-run.
    cacheDir: path.join(tmpDir, 'vite-cache'),
    optimizeDeps: { include: ['@codemirror/lang-javascript', '@codemirror/lang-html'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0];
  assert.ok(baseUrl, 'Vite did not report a local URL');
  const harnessPath = path.relative(projectRoot, tmpDir).split(path.sep).join('/');
  const stdout = await runElectron(path.join(tmpDir, 'electron-main.cjs'), { QA_URL: new URL(`${harnessPath}/index.html`, baseUrl).href });
  const result = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());

  for (const file of FILES) {
    const { first, scrolledAway, repeated } = result.results[file.name];
    assert.equal(first.visible, true, `${file.name} must scroll to line ${TARGET_LINE}: ${JSON.stringify(first)}`);
    assert.ok(first.scrollTop > 0, `${file.name} must actually scroll`);
    assert.equal(first.completeFile, true, `${file.name} must show the whole file, not a slice`);
    assert.equal(first.caretLine, 1, `${file.name}: a file reference scrolls without moving the caret`);
    assert.equal(first.readOnly, !file.editable, `${file.name} must keep its editability`);
    assert.equal(scrolledAway.visible, false, `${file.name}: the test must scroll away before repeating`);
    assert.equal(repeated.visible, true, `${file.name}: repeating the reference must scroll again: ${JSON.stringify(repeated)}`);
  }

  assert.equal(result.openTab.visible, true, `a new line in an open tab must scroll: ${JSON.stringify(result.openTab)}`);

  assert.equal(result.noLineMarkdown.visible, true, `readme.md without a line must start at the top: ${JSON.stringify(result.noLineMarkdown)}`);
  assert.equal(result.noLineMarkdown.scrollTop, 0);
  assert.equal(result.noLineCode.visible, true, `First.tsx without a line must start at the top: ${JSON.stringify(result.noLineCode)}`);
  assert.equal(result.noLineCode.scrollTop, 0);

  assert.equal(result.clickedProperty, true, 'the MDX source must show its Properties');
  assert.equal(result.mdxProperty.visible, true, `an MDX property must reveal its source line: ${JSON.stringify(result.mdxProperty)}`);
  assert.equal(result.mdxProperty.caretLine, 3, 'an MDX property must put the caret on its line');

  console.log('project file reveal panel Electron regression passed');
} finally {
  if (server) await server.close();
  await rm(tmpDir, { recursive: true, force: true });
}
