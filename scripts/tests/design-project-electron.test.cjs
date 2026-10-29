// Design projects end to end in real Chromium: design_project_create makes a
// folder under designs/ and hands over the instructions once; design_show and
// design_ready save versions and serve pages whose pinned React/Babel tags
// load offline with their integrity hashes; design_ready reports a broken
// page's errors and, for a clean page, starts a background review that only
// writes back when it finds problems; skills, starters and versions read
// back; the server never leaves the folder; the Design view chat gets the
// instructions with its first message.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-design-project-'));
app.setPath('userData', path.join(temp, 'profile'));
app.on('window-all-closed', () => {});
const dist = path.join(__dirname, '../../dist-electron');
const repoRoot = path.join(temp, 'repo');
fs.mkdirSync(repoRoot, { recursive: true });

const TAGS = `<script src="https://unpkg.com/react@18.3.1/umd/react.development.js" integrity="sha384-hD6/rw4ppMLGNu3tX5cjIb+uRZ7UkRJ6BPkLpg4hAu/6onKUg4lLsHAs9EBPT82L" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" integrity="sha384-u6aeetuaXnQ38mYT8rp6sbXaQe3NL9t+IBXmnYxwkUI2Hw4bsp2Wvmx4yRQF1uAm" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" integrity="sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y" crossorigin="anonymous"></script>`;
const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reader</title>${TAGS}<style>:root{--ink:#1d1d1f}body{margin:0;font:16px system-ui;color:var(--ink)}</style></head><body><div id="root"></div>${body}</body></html>`;
const APP = `function App(){const [n,setN]=React.useState(0);return <main style={{padding:24}}><h1>Library</h1><button onClick={()=>setN(n+1)}>Saved {n}</button></main>}
Object.assign(window,{App});`;
const MOUNT = `<script type="text/babel" src="app.jsx"></script><script type="text/babel">ReactDOM.createRoot(document.getElementById('root')).render(<App/>)</script>`;

const get = (url) =>
  new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
async function until(check, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    const { setDesignProjectRoot } = require(`${dist}/electron/design/styles.js`);
    const { runDesignTool } = require(`${dist}/electron/design/tools.js`);
    const { getDesignRepository } = require(`${dist}/electron/design/service.js`);
    const { setProjectReviewer } = require(`${dist}/electron/design/project/verify.js`);
    const { setDesignFollowUp } = require(`${dist}/electron/design/project/tools.js`);
    const { projectServer, servedPage } = require(`${dist}/electron/design/project/server.js`);
    const { designContextText, setDesignFocus } = require(`${dist}/electron/design/focus.js`);
    setDesignProjectRoot(() => repoRoot);
    const repo = getDesignRepository();
    const run = async (name, session, args) => {
      const result = await runDesignTool(name, session, args);
      return result;
    };

    // Create: a folder under designs/, the instructions once, the skills listed.
    const created = await run('design_project_create', 's1', { title: 'Reader App', operationId: 'p1' });
    assert.ok(!created.isError, created.text);
    const folder = path.join(repoRoot, 'designs', 'Reader App');
    assert.ok(fs.statSync(folder).isDirectory(), 'the project folder exists');
    assert.match(created.text, /You are an expert designer/, 'the first create carries the instructions');
    assert.match(created.text, /hi-fi-design/, 'and lists the skills');
    const [summary] = repo.list('s1');
    assert.equal(summary.kind, 'project');
    assert.equal(summary.folder, folder);
    const again = await run('design_project_create', 's1', { title: 'Reader App', operationId: 'p2' });
    assert.ok(!again.isError, again.text);
    assert.ok(fs.existsSync(path.join(repoRoot, 'designs', 'Reader App 2')), 'a taken name gets a numbered folder');
    assert.doesNotMatch(again.text, /You are an expert designer/, 'the instructions come once per conversation');
    const id = summary.id;

    // design_show saves a version and lists the pages.
    fs.writeFileSync(path.join(folder, 'Reader App.html'), page(MOUNT));
    fs.writeFileSync(path.join(folder, 'app.jsx'), APP);
    const shown = await run('design_show', 's1', { path: 'Reader App.html', documentId: id });
    assert.ok(!shown.isError, shown.text);
    let doc = repo.read('s1', id);
    assert.deepEqual(doc.files.map((f) => f.path), ['Reader App.html', 'app.jsx']);
    assert.deepEqual(repo.list('s1').find((d) => d.id === id).pages, ['Reader App.html']);
    const v1 = doc.revision;
    const outside = await run('design_show', 's1', { path: '../../escape.html', documentId: id });
    assert.ok(outside.isError && /outside the project folder/.test(outside.text), outside.text);

    // A clean page: no errors, a background review that writes back only on problems.
    const followUps = [];
    setDesignFollowUp(async (sessionId, display, prompt) => {
      followUps.push({ sessionId, display, prompt });
      return true;
    });
    const reviewed = [];
    setProjectReviewer(async (input) => {
      reviewed.push(input);
      return JSON.stringify({ verdict: 'needs_work', summary: 'The save button is unlabeled.', issues: [{ where: 'header', problem: 'Button has no label', fix: 'Name it' }] });
    });
    const ready = await run('design_ready', 's1', { path: 'Reader App.html', documentId: id });
    assert.ok(!ready.isError, ready.text);
    assert.match(ready.text, /loads cleanly/, ready.text);
    await until(() => followUps.length === 1, 'the needs_work review writes back');
    assert.equal(followUps[0].sessionId, 's1');
    assert.match(followUps[0].prompt, /Button has no label/);
    assert.match(followUps[0].prompt, /design_ready/);
    assert.equal(reviewed[0].shots.length, 2, 'desktop and phone screenshots');
    assert.ok(reviewed[0].shots.every((s) => s.png.length > 1000 && s.errors.length === 0), 'the page rendered without errors');

    // A done review stays silent.
    setProjectReviewer(async () => JSON.stringify({ verdict: 'done', summary: 'Fine.', issues: [] }));
    fs.writeFileSync(path.join(folder, 'app.jsx'), APP.replace('Library', 'Library · All'));
    const quiet = await run('design_ready', 's1', { path: 'Reader App.html', documentId: id });
    assert.ok(!quiet.isError, quiet.text);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(followUps.length, 1, 'a done review sends nothing');

    // A broken page: its errors come back at once, no review.
    fs.writeFileSync(path.join(folder, 'Broken.html'), page(`<script type="text/babel" src="missing.jsx"></script><script type="text/babel">const x = <div>;</script>`));
    const broken = await run('design_ready', 's1', { path: 'Broken.html', documentId: id });
    assert.ok(!broken.isError, broken.text);
    assert.match(broken.text, /has errors/, broken.text);
    assert.match(broken.text, /missing\.jsx/, 'the failed load is named');

    // Versions: listed, and an old file reads back as it was.
    const versions = await run('design_versions', 's1', { documentId: id });
    assert.match(versions.text, new RegExp(`v${v1} `));
    const old = await run('design_version', 's1', { version: v1, paths: ['app.jsx'], documentId: id });
    assert.match(old.text, /<h1>Library<\/h1>/);
    assert.doesNotMatch(old.text, /Library · All/);

    // Skills and starters.
    const skill = await run('design_skill', 's1', { name: 'Hi-fi design' });
    assert.match(skill.text, /# Hi-fi design/);
    const missing = await run('design_skill', 's1', { name: 'nope' });
    assert.ok(missing.isError && /make-a-deck/.test(missing.text));
    const starter = await run('design_starter_copy', 's1', { kind: 'design_canvas.jsx', documentId: id });
    assert.ok(!starter.isError, starter.text);
    assert.ok(fs.existsSync(path.join(folder, 'design_canvas.jsx')));
    assert.match(starter.text, /DCArtboard/, 'usage notes come back');

    // The server: the folder only, under its token; pages get the host script and local libraries.
    const { base } = await projectServer(id, folder);
    const served = await get(base + encodeURIComponent('Reader App.html'));
    assert.equal(served.status, 200);
    assert.match(served.body, /__aegis\/host\.js/);
    assert.match(served.body, /__aegis\/lib\/react\.development\.js/);
    assert.doesNotMatch(served.body, /unpkg\.com/);
    assert.match(fs.readFileSync(path.join(folder, 'Reader App.html'), 'utf8'), /unpkg\.com/, 'the file on disk keeps the public URLs');
    const lib = await get(base + '__aegis/lib/react.development.js');
    assert.equal(lib.status, 200);
    assert.equal(lib.headers['access-control-allow-origin'], '*');
    fs.writeFileSync(path.join(temp, 'secret.txt'), 'secret');
    const origin = new URL(base).origin;
    const token = new URL(base).pathname.split('/')[1];
    assert.equal((await get(`${origin}/${token}/..%2F..%2F..%2Fsecret.txt`)).status, 404, 'no way out of the folder');
    assert.equal((await get(`${origin}/wrong-token/Reader%20App.html`)).status, 404, 'the token is required');
    assert.match(servedPage('<p>x</p>', 't'), /^<script src="\/t\/__aegis\/host\.js"><\/script>/);

    // A chat with no project never gets the project instructions (designs default to the canvas).
    assert.doesNotMatch(designContextText('s9'), /<design_instructions>/);
    // An open project shows its folder and the page on screen.
    setDesignFocus('s1', { documentId: id, path: 'Reader App.html' });
    const context = designContextText('s1');
    assert.match(context, /Open: design project "Reader App"/);
    assert.match(context, /On screen: "Reader App.html"/);
    assert.doesNotMatch(context, /<design_instructions>/, 's1 already got them from design_project_create');

    console.log('design project Electron regression passed');
  } catch (error) {
    console.error(error);
    code = 1;
  }
  try {
    fs.rmSync(temp, { recursive: true, force: true });
  } catch {}
  app.exit(code);
});
