// The design component runtime in a real Chromium frame: template + logic +
// props render with layer ids intact; events and board links work only in
// play mode; a saved update keeps logic state; broken logic reports errors.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');

app.on('window-all-closed', () => {});
const dist = '../../dist-electron';
const { designFrameHtml } = require(`${dist}/shared/design-frame.js`);
const { isDesignComponent, setDesignLogic, setDesignProps, designLogicOf, designPropsOf, patchDesignLogic } = require(`${dist}/shared/design-component.js`);
const { sanitizeDesignHtml } = require(`${dist}/shared/design-html.js`);

const BOARD = `<!doctype html><html><head><style>.on{color:rgb(255, 0, 0)}</style></head><body>
<main data-aegis-node-id="main">
  <h1 data-aegis-node-id="title">{{ title }}</h1>
  <ul data-aegis-node-id="list"><li data-aegis-node-id="item" data-aegis-for="(n, i) in items" class="{{ i === active ? 'on' : '' }}" data-aegis-on-click="pick(i)">{{ n }}</li></ul>
  <p data-aegis-node-id="empty" data-aegis-if="!items.length">Empty</p><p data-aegis-node-id="count" data-aegis-else>{{ count }} items</p>
  <button data-aegis-node-id="toggle" data-aegis-on-click="open = !open">Toggle</button>
  <div data-aegis-node-id="panel" data-aegis-if="open">Panel</div>
  <a data-aegis-node-id="next" data-aegis-goto="Pricing" onclick="alert(1)" href="https://example.com">Next</a>
  <img data-aegis-node-id="pic" data-aegis-bind-src="'https://example.com/x.png'" alt="x">
</main>
<script type="text/x-aegis-logic">class Board extends AegisBoard {
  state = { active: 0, open: false };
  pick(i) { this.setState({ active: i }); }
  values() { return { count: this.props.items.length }; }
}</script>
<script type="application/x-aegis-props">{"title":{"type":"string","default":"Hello"},"items":{"type":"list","default":["A","B","C"]},"$preview":{"title":"Preview title"}}</script>
<script>window.evil = true</script>
</body></html>`;

async function open(html, mode) {
  const w = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(designFrameHtml(html, 'n0nce', false, { mode }))}`);
  await w.webContents.executeJavaScript('window.__aegisRuntime ? window.__aegisRuntime.ready : null');
  return w;
}
const js = (w, code) => w.webContents.executeJavaScript(code);

app.whenReady().then(async () => {
  let code = 0;
  try {
    // Format helpers and the sanitizer.
    const clean = sanitizeDesignHtml(BOARD);
    assert.ok(isDesignComponent(clean));
    assert.ok(!clean.includes('window.evil'), 'executable scripts are dropped');
    assert.ok(!/onclick/i.test(clean), 'event handler attributes are dropped');
    assert.ok(!clean.includes('https://example.com"'), 'remote href is dropped');
    assert.match(designLogicOf(clean), /class Board extends AegisBoard/);
    assert.equal(designPropsOf(clean).title.default, 'Hello');
    const relogic = patchDesignLogic(clean, 'active: 0', 'active: 2');
    assert.match(designLogicOf(relogic), /active: 2/);
    assert.throws(() => patchDesignLogic(clean, 'nope', 'x'), /PATCH_NOT_FOUND/);
    assert.equal(designLogicOf(setDesignLogic(clean, '')), null, 'empty logic removes the block');
    assert.throws(() => setDesignProps(clean, { bad: { type: 'weird' } }), /needs a type/);
    assert.ok(!isDesignComponent('<!doctype html><html><head></head><body><p>Static</p></body></html>'));
    assert.ok(!designFrameHtml('<p>Static</p>', 'n', true).includes('data-aegis-runtime'), 'static boards load no runtime');
    assert.ok(!designFrameHtml(BOARD, 'n', true, { mode: 'static' }).includes('data-aegis-runtime'), 'static mode loads no runtime');

    // Play mode: rendered with props ($preview wins), loop, if/else, values().
    const play = await open(BOARD, 'play');
    assert.equal(await js(play, 'document.querySelector("[data-aegis-node-id=title]").textContent'), 'Preview title');
    assert.deepEqual(await js(play, '[...document.querySelectorAll("[data-aegis-node-id=item]")].map(e=>[e.textContent,e.dataset.aegisInstance,e.className])'), [['A', '0', 'on'], ['B', '1', ''], ['C', '2', '']]);
    assert.equal(await js(play, 'document.querySelector("[data-aegis-node-id=count]").textContent'), '3 items');
    assert.equal(await js(play, '!!document.querySelector("[data-aegis-node-id=empty]")'), false);
    assert.equal(await js(play, '!!document.querySelector("[data-aegis-node-id=panel]")'), false);
    assert.equal(await js(play, 'document.querySelector("[data-aegis-node-id=pic]").getAttribute("src")'), null, 'a bound remote src is refused');
    assert.equal(await js(play, 'document.querySelector("[data-aegis-node-id=next]").getAttribute("href")'), null);
    // Events work in play mode.
    await js(play, 'document.querySelectorAll("[data-aegis-node-id=item]")[1].click()');
    assert.deepEqual(await js(play, '[...document.querySelectorAll("[data-aegis-node-id=item]")].map(e=>e.className)'), ['', 'on', '']);
    await js(play, 'document.querySelector("[data-aegis-node-id=toggle]").click()');
    assert.equal(await js(play, 'document.querySelector("[data-aegis-node-id=panel]")?.textContent'), 'Panel', 'assigning a state key from a handler updates state');
    // Board links post to the canvas.
    const goto = await js(play, 'new Promise(r=>{addEventListener("message",e=>{if(e.data?.event==="goto")r(e.data)});document.querySelector("[data-aegis-node-id=next]").click()})');
    assert.equal(goto.board, 'Pricing');
    assert.equal(goto.nonce, 'n0nce');
    // A saved update keeps logic state when the logic is unchanged.
    await js(play, `window.__aegisRuntime.update(${JSON.stringify(clean.replace('Preview title', 'Renamed'))})`);
    assert.equal(await js(play, 'document.querySelector("[data-aegis-node-id=title]").textContent'), 'Renamed');
    assert.deepEqual(await js(play, '[...document.querySelectorAll("[data-aegis-node-id=item]")].map(e=>e.className)'), ['', 'on', ''], 'state survives the update');
    assert.deepEqual(await js(play, 'window.__aegisRuntime.errors'), []);
    play.destroy();

    // Edit mode: the canvas owns input, so nothing reacts.
    const edit = await open(BOARD, 'edit');
    await js(edit, 'document.querySelectorAll("[data-aegis-node-id=item]")[2].click()');
    assert.deepEqual(await js(edit, '[...document.querySelectorAll("[data-aegis-node-id=item]")].map(e=>e.className)'), ['on', '', '']);
    edit.destroy();

    // Broken logic and expressions report errors; the template still renders.
    const broken = BOARD.replace('pick(i) {', 'pick(i) { this.setState({ active: i }) } }} oops {').replace('{{ n }}', '{{ n.missing.deep }}');
    const bad = await open(broken, 'play');
    const errors = await js(bad, 'window.__aegisRuntime.errors');
    assert.ok(errors.some((e) => /logic/.test(e)), `logic error reported: ${errors}`);
    assert.ok(errors.some((e) => /n\.missing\.deep/.test(e)), `expression error reported: ${errors}`);
    assert.equal(await js(bad, 'document.querySelectorAll("[data-aegis-node-id=item]").length'), 3, 'template renders without logic');
    bad.destroy();
    // Components: props from attributes and bindings, slots, own state per instance, styles, missing ones.
    const components = { Card: { html: '<style>.card{padding:4px}</style><div class="card"><h3 data-aegis-node-id="c-title">{{ title }}</h3><aegis-slot></aegis-slot><button data-aegis-node-id="c-btn" data-aegis-on-click="n = n + 1">{{ n }}</button></div>', logic: 'class Component extends AegisBoard { state = { n: 0 } }', props: { title: { type: 'string', default: 'Card' } } } };
    const USES = `<!doctype html><html><head></head><body><main data-aegis-node-id="m">
<aegis-use data-aegis-node-id="card1" component="Card" title="First"><p data-aegis-node-id="slotp">Inside</p></aegis-use>
<aegis-use data-aegis-node-id="card2" component="Card" data-aegis-bind-title="'Second ' + 2"></aegis-use>
<aegis-use data-aegis-node-id="missing" component="Nope"></aegis-use></main></body></html>`;
    const cw = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true } });
    await cw.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(designFrameHtml(USES, 'n0nce', false, { mode: 'play', components }))}`);
    await js(cw, 'window.__aegisRuntime.ready');
    assert.equal(await js(cw, 'document.querySelector("[data-aegis-node-id=card1]").className'), 'card', 'the instance root takes the instance layer id');
    assert.equal(await js(cw, 'document.querySelector("[data-aegis-node-id=card1] h3").textContent'), 'First');
    assert.equal(await js(cw, 'document.querySelector("[data-aegis-node-id=card1] h3").hasAttribute("data-aegis-node-id")'), false, "a component's own layers are not board layers");
    assert.equal(await js(cw, 'document.querySelector("[data-aegis-node-id=card1] [data-aegis-node-id=slotp]")?.textContent'), 'Inside', 'slot content keeps its board layer');
    assert.equal(await js(cw, 'document.querySelector("[data-aegis-node-id=card2] h3").textContent'), 'Second 2');
    assert.equal(await js(cw, 'getComputedStyle(document.querySelector("[data-aegis-node-id=card1]")).paddingTop'), '4px', 'component styles apply');
    await js(cw, 'document.querySelector("[data-aegis-node-id=card1] button").click();document.querySelector("[data-aegis-node-id=card1] button").click();document.querySelector("[data-aegis-node-id=card2] button").click()');
    assert.deepEqual(await js(cw, '[...document.querySelectorAll(".card button")].map(b=>b.textContent)'), ['2', '1'], 'each instance has its own state');
    assert.match(await js(cw, 'document.querySelector("[data-aegis-node-id=missing]").textContent'), /Missing component Nope/);
    assert.ok((await js(cw, 'window.__aegisRuntime.errors')).some((e) => /Nope/.test(e)));
    cw.destroy();
    console.log('PASS design runtime: format helpers, sanitizer, props/$preview, loops, if/else, values, play-only events, state assignment, board links, updates keep state, error reporting, components (props, bindings, slots, per-instance state, styles, missing)');
  } catch (error) {
    console.error(error);
    code = 1;
  } finally {
    app.exit(code);
  }
});
