// Design system packs: a project's design-system/ folder and built-in styles
// become what boards load (stylesheet with tokens and inlined fonts, components,
// assets); boards render with them; adherence and the system check report
// what strays; a design records its system.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-design-system-'));
app.setPath('userData', path.join(temp, 'profile'));
app.on('window-all-closed', () => {});
const dist = path.join(__dirname, '../../dist-electron');

const project = path.join(temp, 'project');
const ds = path.join(project, 'design-system');
fs.mkdirSync(path.join(ds, 'components'), { recursive: true });
fs.mkdirSync(path.join(ds, 'fonts'), { recursive: true });
fs.mkdirSync(path.join(ds, 'assets'), { recursive: true });
fs.mkdirSync(path.join(ds, 'templates'), { recursive: true });
fs.writeFileSync(path.join(ds, 'README.md'), '# Atlas\nCalm product UI.');
fs.writeFileSync(path.join(ds, 'tokens.css'), ':root{--accent:#2e5bff;--text:#1d2433;--radius:10px}');
fs.writeFileSync(path.join(ds, 'styles.css'), `@import "tokens.css";
@font-face{font-family:"Atlas Sans";src:url(fonts/AtlasSans.woff2) format("woff2")}
@font-face{font-family:"Remote";src:url(https://example.com/x.woff2)}
.btn{background:var(--accent);color:#fff;border-radius:var(--radius);padding:8px 14px}
.title{color:var(--text);font-family:"Atlas Sans",system-ui}
.ghost{color:var(--missing-token)}`);
fs.writeFileSync(path.join(ds, 'fonts', 'AtlasSans.woff2'), Buffer.from('wOF2fakefontbytes'));
fs.writeFileSync(path.join(ds, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#2e5bff"/></svg>');
fs.writeFileSync(path.join(ds, 'components', 'Badge.html'), `<!doctype html><html><head><style>.badge{display:inline-block;padding:2px 8px;border-radius:99px;background:var(--accent);color:#fff}</style></head><body>
<span class="badge">{{ label }} {{ count }}</span>
<script type="text/x-aegis-logic">class Component extends AegisBoard { state = { n: 0 } }</script>
<script type="application/x-aegis-props">{"label":{"type":"string","default":"New"},"count":{"type":"number","default":3}}</script>
</body></html>`);
fs.writeFileSync(path.join(ds, 'components', 'Badge.md'), 'A small count badge.');
fs.writeFileSync(path.join(ds, 'components', 'Broken.html'), '<span>x</span><script type="text/x-aegis-logic">class Component extends AegisBoard { oops( }</script>');
fs.writeFileSync(path.join(ds, 'templates', 'home.html'), '<main><aegis-use component="Hero"></aegis-use></main>');

app.whenReady().then(async () => {
  let code = 0;
  try {
    const { projectDesignPack, designSystemPack, NO_DESIGN_SYSTEM } = require(`${dist}/electron/design/system-pack.js`);
    const { adherenceWarnings, checkProjectDesignSystem } = require(`${dist}/electron/design/adherence.js`);
    const { designFrameHtml } = require(`${dist}/shared/design-frame.js`);
    const { describePack } = require(`${dist}/electron/design/system-guide.js`);
    const { DesignRepository } = require(`${dist}/electron/design/repository.js`);

    // A project's pack: imports inlined, local files as data URLs, remote ones dropped.
    const report = projectDesignPack(project);
    const pack = report.pack;
    assert.equal(pack.id, 'project');
    assert.match(pack.css, /--accent:#2e5bff/, '@import inlined');
    assert.match(pack.css, /url\("data:font\/woff2;base64,/, 'font file inlined');
    assert.ok(!pack.css.includes('example.com'), 'remote URLs never reach a board');
    assert.deepEqual(pack.fonts.sort(), ['Atlas Sans', 'Remote']);
    assert.match(pack.assets.logo, /^data:image\/svg\+xml;base64,/);
    assert.equal(pack.components.Badge.summary, 'A small count badge.');
    assert.match(pack.components.Badge.html, /<style>\.badge/, 'a component keeps its styles');
    assert.match(pack.components.Badge.logic, /class Component/);
    assert.equal(pack.components.Badge.props.count.default, 3);
    assert.equal(projectDesignPack(project).pack, pack, 'cached until a file changes');
    // Built-in packs and the system a design records.
    const warm = designSystemPack('warm-paper', project);
    assert.equal(warm.id, 'warm-paper');
    assert.match(warm.css, /--accent:#7a5c3e/);
    assert.match(warm.css, /\.ds-button/);
    assert.deepEqual(Object.keys(warm.components).sort(), ['Button', 'Card', 'Field', 'Tag']);
    assert.equal(designSystemPack(undefined, project).id, 'project', "a project's system applies by default");
    assert.equal(designSystemPack(NO_DESIGN_SYSTEM, project), null);
    assert.equal(designSystemPack(undefined, path.join(temp, 'elsewhere')), null);

    // Boards render with the system: tokens, classes, fonts, components and assets.
    const board = `<!doctype html><html><head><style>.label{color:var(--accent)}</style></head><body><main data-aegis-node-id="m">
<h1 class="title" data-aegis-node-id="t">Atlas</h1><p class="label" data-aegis-node-id="l">Accent</p>
<img data-aegis-node-id="logo" src="aegis-asset:logo" alt="">
<aegis-use data-aegis-node-id="b1" component="Badge" label="Inbox" count="7"></aegis-use>
<aegis-use data-aegis-node-id="b2" component="Button" label="Save" variant="secondary"></aegis-use></main></body></html>`;
    const merged = { ...pack, components: { ...pack.components, Button: warm.components.Button } };
    const w = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true } });
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(designFrameHtml(board, 'n0nce', false, { mode: 'play', system: merged }))}`);
    await w.webContents.executeJavaScript('window.__aegisRuntime ? window.__aegisRuntime.ready : null');
    const js = (c) => w.webContents.executeJavaScript(c);
    assert.equal(await js('getComputedStyle(document.querySelector(".label")).color'), 'rgb(46, 91, 255)', 'system tokens resolve');
    assert.match(await js('getComputedStyle(document.querySelector(".title")).fontFamily'), /Atlas Sans/);
    assert.ok(await js('document.querySelector("[data-aegis-node-id=logo]").naturalWidth') > 0, 'an asset renders');
    assert.equal(await js('document.querySelector("[data-aegis-node-id=b1]").textContent.trim()'), 'Inbox 7');
    assert.equal(await js('getComputedStyle(document.querySelector("[data-aegis-node-id=b1]")).backgroundColor'), 'rgb(46, 91, 255)', "a system component's styles apply");
    assert.match(await js('document.querySelector("[data-aegis-node-id=b2]").className'), /ds-button ds-button--secondary/);
    assert.deepEqual(await js('window.__aegisRuntime.errors'), []);
    w.destroy();

    // Adherence: colors outside the tokens, missing tokens, unregistered fonts, raw controls.
    const stray = `<html><head><style>.a{color:#ff0055;background:#00aa77}.b{color:var(--nope)}.c{font-family:"Comic Sans MS",cursive}</style></head><body><button>One</button><button>Two</button><aegis-use component="Ghost"></aegis-use></body></html>`;
    const warnings = adherenceWarnings(stray, merged);
    assert.ok(warnings.some((w) => /2 colors are written out/.test(w)), warnings.join('\n'));
    assert.ok(warnings.some((w) => /--nope/.test(w)));
    assert.ok(warnings.some((w) => /Comic Sans MS/.test(w)));
    assert.ok(warnings.some((w) => /2 raw <button>/.test(w)));
    assert.ok(warnings.some((w) => /Ghost/.test(w)));
    assert.deepEqual(adherenceWarnings(board, merged), [], 'a board that uses the system is clean');

    // The system check names what is wrong.
    const check = checkProjectDesignSystem(project);
    assert.match(check, /✓ README\.md guide/);
    assert.match(check, /components: Badge, Broken|2 components/);
    assert.match(check, /Broken\.html logic does not compile/);
    assert.match(check, /Broken\.md is missing/);
    assert.match(check, /--missing-token/);
    assert.match(check, /templates\/home\.html uses components the system doesn't have: Hero/);
    assert.match(checkProjectDesignSystem(path.join(temp, 'elsewhere')), /no design-system\/ folder/);
    // What the agent reads about it.
    const described = describePack(merged);
    assert.match(described, /--accent: #2e5bff/);
    assert.match(described, /<aegis-use component="Badge"/);
    assert.match(described, /aegis-asset:name/);
    assert.ok(!described.includes('base64'), 'data URLs are elided for the agent');

    // A design records its system; the system op changes it.
    const repo = new DesignRepository(path.join(temp, 'design.db'), () => {});
    let d = repo.create('s1', 'Atlas', '', 'c1', undefined, undefined, { system: 'quiet-slate' });
    assert.equal(d.system, 'quiet-slate');
    d = repo.update('s1', { documentId: d.id, operationId: 'sys', operations: [{ type: 'system', system: 'none', expectedRevision: d.revision }] });
    assert.equal(repo.read('s1', d.id).system, 'none');
    assert.throws(() => repo.update('s1', { documentId: d.id, operationId: 'bad', operations: [{ type: 'system', system: 'Bad Name!', expectedRevision: d.revision }] }));
    repo.close();
    console.log('PASS design systems: project and built-in packs, inlined imports/fonts/assets, rendering with tokens/components/assets, adherence warnings, system check, agent description, recorded system');
  } catch (error) {
    console.error(error);
    code = 1;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(code);
  }
});
