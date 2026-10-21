import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// The question card keeps picks per question as label arrays: labels that
// contain commas toggle and show as selected, and submit carries them
// unsplit in questionAnswers next to the comma-joined `answers`.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, '.aegis-design-qa');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'decision-panel-'));
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DecisionPanel } from '/src/ui/components/DecisionPanel';
import '/src/ui/index.css';
const input = {
  questions: [
    { question: 'Pick cities', multiSelect: true, options: [{ label: 'Paris, France' }, { label: 'Austin, Texas' }, { label: 'Lima' }] },
    { question: 'One city', options: [{ label: 'Paris, France' }, { label: 'Lima' }] },
  ],
};
window.qa = { submitted: null };
createRoot(document.getElementById('root')).render(<DecisionPanel input={input} onSubmit={(result) => { window.qa.submitted = result; }} />);
`;
const main = String.raw`
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
app.setPath('userData', path.join(__dirname, 'profile'));
const delay = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const js = code => win.webContents.executeJavaScript(code, true);
  try {
    await win.loadURL(process.env.QA_URL);
    for (let i = 0; i < 100 && !(await js('!!document.querySelector("input[type=text]")')); i++) await delay(100);
    // Option buttons in order: question 1 (3), then question 2 (2).
    const option = (q, i) => '(() => { const sections = document.querySelector("#root > div").children; return sections[' + q + '].querySelectorAll("button")[' + i + ']; })()';
    const click = async (q, i) => { await js(option(q, i) + '.click()'); await delay(60); };
    const selected = async (q, i) => js(option(q, i) + '.className.includes("bg-[var(--accent)]/10")');
    const setOther = async (q, value) => {
      await js('(() => { const el = document.querySelectorAll("input[type=text]")[' + q + ']; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, ' + JSON.stringify(value) + '); el.dispatchEvent(new Event("input", { bubbles: true })); })()');
      await delay(60);
    };

    await click(0, 0);
    await click(0, 1);
    assert.deepEqual([await selected(0, 0), await selected(0, 1), await selected(0, 2)], [true, true, false], 'comma labels show as selected');
    await click(0, 0);
    assert.deepEqual([await selected(0, 0), await selected(0, 1)], [false, true], 'a comma label deselects on its own');
    await click(0, 0);
    await click(1, 0);
    assert.equal(await selected(1, 0), true, 'single choice with a comma label');

    await setOther(0, 'Rome, Italy, Europe');
    await js('Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Submit").click()');
    await delay(60);
    const result = await js('window.qa.submitted');
    assert.equal(result.behavior, 'allow');
    assert.deepEqual(result.updatedInput.answers, {
      'Pick cities': 'Austin, Texas,Paris, France,Rome, Italy, Europe',
      'One city': 'Paris, France',
    }, 'answers keep the AskUserQuestion comma-joined shape');
    assert.deepEqual(result.questionAnswers, {
      'Pick cities': { selected: ['Austin, Texas', 'Paris, France'], other: 'Rome, Italy, Europe' },
      'One city': { selected: ['Paris, France'] },
    }, 'questionAnswers keeps labels and Other text apart');
    assert.deepEqual(errors, []);
    console.log('Decision panel: comma labels toggle, show selected and submit structured answers');
    app.exit(0);
  } catch (e) {
    console.error(e);
    console.error(await js('document.body.innerText').catch(() => ''));
    app.exit(1);
  }
});
`;
let server;
try {
  await writeFile(path.join(tmp, 'index.html'), '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  const url = new URL(path.relative(root, tmp) + '/index.html', server.resolvedUrls.local[0]).href;
  await new Promise((resolve, reject) => {
    const env = { ...process.env, QA_URL: url };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(tmp, 'main.cjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', c => { out += c; process.stdout.write(c); });
    child.stderr.on('data', c => { err += c; process.stderr.write(c); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Timed out\n' + out + '\n' + err)); }, 120000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error(out + '\n' + err)); });
  });
  console.log('decision panel Electron regression passed');
} finally {
  await server?.close();
  await rm(tmp, { recursive: true, force: true });
}
