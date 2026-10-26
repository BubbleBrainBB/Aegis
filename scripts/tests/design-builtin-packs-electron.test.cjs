// Built-in styles' packs: bundled fonts registered on every board, the full
// token set, the built-in components (interactive ones respond in Play), and
// reference templates that render in every style and come from
// design_resources.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-design-builtin-'));
app.setPath('userData', path.join(temp, 'profile'));
app.on('window-all-closed', () => {});
const dist = path.join(__dirname, '../../dist-electron');

app.whenReady().then(async () => {
  let code = 0;
  try {
    const { designSystemPack, projectDesignPack } = require(`${dist}/electron/design/system-pack.js`);
    const { builtinDesignStyles } = require(`${dist}/electron/design/styles.js`);
    const { BUILTIN_TEMPLATES } = require(`${dist}/electron/design/builtin-templates.js`);
    const { designFrameHtml } = require(`${dist}/shared/design-frame.js`);
    const { getDesignRepository } = require(`${dist}/electron/design/service.js`);
    const { designResources } = require(`${dist}/electron/design/system-guide.js`);

    // Every style: its fonts inlined, the full token set, the same components.
    const styles = builtinDesignStyles();
    assert.ok(styles.length >= 10, `${styles.length} built-in styles`);
    const names = Object.keys(designSystemPack('quiet-slate', null).components);
    assert.ok(names.length >= 14, names.join(', '));
    for (const style of styles) {
      const pack = designSystemPack(style.id, null);
      const families = [...new Set(style.fonts.map((f) => f.family))];
      assert.ok(families.length >= 1, style.id);
      assert.deepEqual(pack.fonts, families);
      assert.equal((pack.css.match(/@font-face\{font-family:"[^"]+";src:url\("data:font\/woff2;base64,/g) ?? []).length, style.fonts.length, `${style.id}: every face is inlined`);
      for (const token of ['--background', '--surface', '--raised', '--text', '--muted', '--accent', '--on-accent', '--line', '--success', '--warning', '--danger', '--font-display', '--font-body', '--font-mono', '--radius', '--radius-control', '--shadow', '--space-1', '--space-8', '--duration-fast', '--ease', '--focus-ring'])
        assert.match(pack.css, new RegExp(`${token}:`), `${style.id} ${token}`);
      assert.match(style.type.body, /PingFang SC/, 'CJK falls back to the system face');
      assert.deepEqual(Object.keys(pack.components), names);
      assert.equal(designSystemPack(style.id, null), pack, 'built once');
      assert.ok(!Object.values(pack.components).some((c) => /<aegis-icon/.test(c.html)), 'component icons are inline SVG');
    }

    const w = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { sandbox: true, contextIsolation: true } });
    const js = (c) => w.webContents.executeJavaScript(c).catch((e) => { throw new Error(`${e.message}\n  in: ${c}`); });
    const load = async (html, system, mode = 'play') => {
      await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(designFrameHtml(html, 'n0nce', false, { mode, system }))}`);
      await js('window.__aegisRuntime ? window.__aegisRuntime.ready : null');
    };

    // Fonts load, components render and respond in Play.
    const warm = designSystemPack('warm-paper', null);
    await load(`<!doctype html><html><head></head><body><main>
<h1 data-aegis-node-id="h" style="font-family:var(--font-display)">Plan</h1>
<aegis-use data-aegis-node-id="tg" component="Toggle" label="Email" checked="false"></aegis-use>
<aegis-use data-aegis-node-id="cb" component="Checkbox" label="Agree"></aegis-use>
<aegis-use data-aegis-node-id="tb" component="Tabs" tabs="One, Two, Three"><p>panel</p></aegis-use>
<aegis-use data-aegis-node-id="sg" component="Segmented" options="Day, Week" active="1"></aegis-use>
<aegis-use data-aegis-node-id="se" component="Select" label="Zone" options="A, B, C" value="B"></aegis-use>
<aegis-use data-aegis-node-id="av" component="Avatar" name="Ada Lovelace"></aegis-use>
<aegis-use data-aegis-node-id="pr" component="Progress" value="140"></aegis-use>
<aegis-use data-aegis-node-id="al" component="Alert" tone="success" title="Saved">Done.</aegis-use>
<aegis-use data-aegis-node-id="fd" component="Field" label="Bio" multiline="true"></aegis-use>
<aegis-use data-aegis-node-id="bt" component="Button" label="Find"><svg data-aegis-icon="search" width="16" height="16"></svg></aegis-use>
<aegis-use data-aegis-node-id="bd" component="Button" label="Later" disabled="true"></aegis-use>
<aegis-use data-aegis-node-id="fe" component="Field" label="Workspace" value="acme" error="Taken."></aegis-use>
</main></body></html>`, warm);
    await js('document.fonts.ready');
    assert.equal(await js('document.fonts.check(\'400 32px "Newsreader"\') && document.fonts.check(\'400 15px "Source Sans 3"\')'), true, 'bundled fonts load');
    assert.match(await js('getComputedStyle(document.querySelector("[data-aegis-node-id=h]")).fontFamily'), /^"?Newsreader/);
    assert.equal(await js('getComputedStyle(document.body).backgroundColor'), 'rgb(246, 242, 234)', 'the page takes the background token');
    const q = (id) => `document.querySelector("[data-aegis-node-id=${id}]")`;
    assert.equal(await js(`${q('tg')}.classList.contains("is-on")`), false, 'checked="false" starts off');
    await js(`${q('tg')}.click()`);
    assert.equal(await js(`${q('tg')}.classList.contains("is-on")`), true, 'a toggle flips in Play');
    await js(`${q('cb')}.click()`);
    assert.equal(await js(`${q('cb')}.getAttribute("aria-checked")`), 'true');
    await js(`${q('cb')}.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }))`);
    assert.equal(await js(`${q('cb')}.getAttribute("aria-checked")`), 'false', 'space toggles a focused checkbox');
    assert.equal(await js(`${q('cb')}.tabIndex`), 0, 'reachable by keyboard');
    assert.equal(await js(`${q('bd')}.disabled`), true, 'disabled buttons are disabled');
    assert.equal(await js(`${q('fe')}.querySelector("input").getAttribute("aria-invalid")`), 'true');
    assert.equal(await js(`${q('fe')}.querySelector(".ds-field__error").textContent`), 'Taken.');
    assert.equal(await js(`getComputedStyle(${q('fe')}.querySelector("input")).borderColor`), await js('(() => { const d = document.createElement("i"); d.style.color = "var(--danger)"; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; })()'), 'invalid fields take the danger color');
    assert.deepEqual(await js(`[...${q('tb')}.querySelectorAll(".ds-tabs__tab")].map((t) => t.textContent)`), ['One', 'Two', 'Three']);
    await js(`${q('tb')}.querySelectorAll(".ds-tabs__tab")[2].click()`);
    assert.equal(await js(`${q('tb')}.querySelector(".is-active").textContent`), 'Three', 'tabs switch');
    assert.equal(await js(`${q('tb')}.textContent.includes("panel")`), true, 'children are the panel');
    assert.equal(await js(`${q('sg')}.querySelector(".is-active").textContent`), 'Week');
    assert.equal(await js(`${q('se')}.querySelector("select").value`), 'B');
    assert.equal(await js(`${q('av')}.textContent`), 'AL');
    assert.equal(await js(`${q('pr')}.querySelector(".ds-progress__bar").style.width`), '100%', 'progress is clamped');
    assert.match(await js(`${q('al')}.innerHTML`), /data-aegis-icon="circle-check"/);
    assert.equal(await js(`!!${q('fd')}.querySelector("textarea") && !${q('fd')}.querySelector("input")`), true, 'multiline is a textarea');
    assert.equal(await js(`${q('bt')}.firstElementChild.tagName.toLowerCase()`), 'svg', 'an icon child leads the label');
    assert.deepEqual(await js('window.__aegisRuntime.errors'), []);

    // Every template renders in every style without errors or missing components.
    for (const style of styles) {
      const pack = designSystemPack(style.id, null);
      for (const t of BUILTIN_TEMPLATES) {
        const { expandDesignIcons } = require(`${dist}/electron/design/icons.js`);
        await load(`<!doctype html><html><head></head><body>${expandDesignIcons(t.html)}</body></html>`, pack, 'edit');
        const errors = await js('window.__aegisRuntime ? window.__aegisRuntime.errors : []');
        assert.deepEqual(errors, [], `${style.id}/${t.id}`);
        assert.equal(await js('document.body.textContent.includes("Missing component")'), false, `${style.id}/${t.id}`);
        if (!["deck", "examples"].includes(t.id)) assert.ok(await js(`document.querySelectorAll("svg[data-aegis-icon]").length`) > 0, `${style.id}/${t.id} icons`);
      }
    }
    w.destroy();

    // design_resources lists and hands out templates for a design on a built-in style.
    const repo = getDesignRepository();
    const d = repo.create('s1', 'Slate', '', 'c1', undefined, undefined, { system: 'quiet-slate' });
    const index = designResources('s1', d.id);
    assert.match(index, /Loaded on every board: Quiet Slate/);
    assert.match(index, /- dashboard: An app dashboard/);
    assert.match(index, /Fonts it registers[^\n]*Geist/);
    assert.ok(!/base64,/.test(index), 'font data stays out of what the agent reads');
    const dash = designResources('s1', d.id, 'template', 'dashboard');
    assert.match(dash, /^# Template: Dashboard[\s\S]*1440 × 900[\s\S]*<aegis-use component="Stat"/);
    assert.match(designResources('s1', d.id, 'template', 'nope'), /No template named "nope"[\s\S]*- landing:/);
    assert.match(designResources('s1', d.id, 'component', 'Toggle'), /# Toggle[\s\S]*## Logic/);
    assert.match(dash, /Use it for: Admin and analytics[\s\S]*Capacity: /);
    for (const id of ['components', 'examples', 'deck']) assert.match(index, new RegExp(`- ${id}: `));
    const { BUILTIN_TEMPLATES: all } = require(`${dist}/electron/design/builtin-templates.js`);
    assert.equal((all.find((t) => t.id === 'deck').html.match(/<section data-aegis-slide/g) ?? []).length, 8, 'eight slide layouts');
    const { designStyleGuideFor, setDesignProjectRoot } = require(`${dist}/electron/design/styles.js`);
    const { setDesignComposerPrefs } = require(`${dist}/electron/design/focus.js`);
    setDesignProjectRoot(() => null);
    setDesignComposerPrefs('s1', { styleId: 'terracotta', variants: 1 });
    const guide = designStyleGuideFor('s1').text;
    assert.match(guide, /## Voice\n[^\n]+\n\n## Imagery\n[^\n]+/);
    assert.match(guide, /--space-1 … --space-8/);

    // Device frames and chrome from design_starter never count against the system.
    const { designStarter } = require(`${dist}/electron/design/starters.js`);
    const { adherenceWarnings } = require(`${dist}/electron/design/adherence.js`);
    const mint = designSystemPack('mint-fresh', null);
    for (const kind of ['ios-phone', 'android-phone', 'browser-window', 'macos-window']) {
      const framed = designStarter(kind).html.replace(/(data-aegis-starter="content"[^>]*>)/, '$1<p style="color:var(--text);font-family:var(--font-body)">Hello</p>');
      assert.deepEqual(adherenceWarnings(`<!doctype html><html><head></head><body>${framed}</body></html>`, mint), [], kind);
    }
    assert.match(adherenceWarnings('<main style="color:#123456;font-family:Comic Neue"><p style="background:#654321">x</p></main>', mint).join(' '), /2 colors[\s\S]*Comic Neue/, "the design's own colors and fonts still count");

    // A built-in style's fonts are loaded before a preview is taken: the first slide is not blank.
    const { previewDesign } = require(`${dist}/electron/design/service.js`);
    const { nativeImage } = require('electron');
    let deckDoc = repo.create('s1', 'Deck', '', 'c-deck', undefined, undefined, { system: 'terracotta' });
    deckDoc = repo.update('s1', { documentId: deckDoc.id, operationId: 'deck', operations: [{ type: 'add', name: 'Deck', width: 1920, height: 1080, html: '<main data-aegis-deck style="width:100%;height:100%"><section data-aegis-slide style="width:100%;height:100%;padding:120px;background:var(--background)"><h1 style="margin:0;font:500 120px/1.1 var(--font-display);color:var(--text)">把新鲜烘焙的咖啡送回社区</h1></section><section data-aegis-slide style="width:100%;height:100%;background:var(--background)"><h2 style="font:500 80px var(--font-display)">第二页</h2></section></main>' }] });
    const first = await previewDesign('s1', deckDoc.id, deckDoc.boards[0].id, deckDoc.revision, undefined, 1600, 1, true, 0);
    const shot = nativeImage.createFromDataURL(first.dataUrl);
    const { width: sw, height: sh } = shot.getSize();
    const px = shot.toBitmap();
    let dark = 0;
    for (let y = Math.round(sh * 0.08); y < Math.round(sh * 0.3); y += 2) for (let x = 0; x < Math.round(sw * 0.7); x += 2) { const i = (y * sw + x) * 4; if (px[i] + px[i + 1] + px[i + 2] < 300) dark++; }
    assert.ok(dark > 500, `the headline is painted on the first capture (${dark} dark pixels)`);

    // A project component with an unknown icon is reported, not fatal.
    const project = path.join(temp, 'project');
    fs.mkdirSync(path.join(project, 'design-system', 'components'), { recursive: true });
    fs.writeFileSync(path.join(project, 'design-system', 'components', 'Chip.html'), '<span class="chip"><aegis-icon name="star"></aegis-icon>{{ label }}</span>');
    fs.writeFileSync(path.join(project, 'design-system', 'components', 'Bad.html'), '<span><aegis-icon name="no-such-icon-x"></aegis-icon></span>');
    const report = projectDesignPack(project);
    assert.match(report.pack.components.Chip.html, /<svg data-aegis-icon="star"/);
    assert.equal(report.pack.components.Bad, undefined);
    assert.ok(report.warnings.some((x) => /Bad\.html: Unknown icon/.test(x)), report.warnings.join(' | '));
    console.log(`PASS design built-in packs: ${styles.length} styles with bundled fonts and full tokens, ${names.length} components (interactive ones respond), ${BUILTIN_TEMPLATES.length} templates render in every style, design_resources templates, starter chrome outside adherence, fonts loaded before previews, project component icons`);
  } catch (error) {
    console.error(error);
    code = 1;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(code);
  }
});
