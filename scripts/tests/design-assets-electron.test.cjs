// Icons and images for boards: <aegis-icon> expands to the library's inline
// SVG when a board is saved, design_icons finds icons; images (files, data
// URLs, dropped bytes) are stored per design, scaled, deduplicated, rendered
// as aegis-asset:<id>, handed off as files and removed with the design.
const { app, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-design-assets-'));
app.setPath('userData', path.join(temp, 'profile'));
app.on('window-all-closed', () => {});
const dist = path.join(__dirname, '../../dist-electron');

/** A solid-color PNG of the given size. */
function png(width, height, [r, g, b]) {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) bitmap.set([b, g, r, 255], i * 4); // BGRA
  return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG();
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    const { expandDesignIcons, searchDesignIcons, iconCount } = require(`${dist}/electron/design/icons.js`);
    const { prepareDesignImage } = require(`${dist}/electron/design/images.js`);
    const { getDesignRepository, previewDesign } = require(`${dist}/electron/design/service.js`);
    const { setDesignProjectRoot } = require(`${dist}/electron/design/styles.js`);
    const { handOffDesign } = require(`${dist}/electron/design/handoff.js`);

    // Icons.
    assert.ok(iconCount() > 4000, `the library is loaded (${iconCount()})`);
    const svg = expandDesignIcons('<p>Find <aegis-icon name="search" size="24" stroke-width="1.5" class="ic" data-aegis-node-id="i1"></aegis-icon></p>');
    assert.match(svg, /<svg data-aegis-icon="search" [^>]*width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"[^>]*class="ic" data-aegis-node-id="i1" aria-hidden="true"><path d="M3 10a7 7 0 1 0 14 0/);
    assert.match(expandDesignIcons('<aegis-icon name="heart" variant="filled"/>'), /data-aegis-icon="heart:filled"[^>]*fill="currentColor" stroke="none"/);
    assert.throws(() => expandDesignIcons('<aegis-icon name="magnifying-glas"></aegis-icon>'), /Unknown icon "magnifying-glas"\./);
    assert.throws(() => expandDesignIcons('<aegis-icon name="arow-right">'), /Similar: .*arrow-right|Search the library/);
    // Quoted values may hold ">"; logic and props text is never expanded; size and count are capped first.
    const cond = expandDesignIcons('<span><aegis-icon data-aegis-if="n > 3" name="bell" size="16"></aegis-icon>!</span>');
    assert.match(cond, /^<span><svg data-aegis-icon="bell" .* data-aegis-if="n > 3" aria-hidden="true"><path [^<]*\/><path [^<]*\/><\/svg>!<\/span>$/);
    const logic = '<p><aegis-icon name="bell"></aegis-icon></p><script type="text/x-aegis-logic">const tag = \'<aegis-icon name="nope-nope">\';</script>';
    assert.match(expandDesignIcons(logic), /<script type="text\/x-aegis-logic">const tag = '<aegis-icon name="nope-nope">';<\/script>$/);
    let started = Date.now();
    assert.throws(() => expandDesignIcons('<aegis-icon name="brand-signal">'.repeat(200_000)), /at most 1 MB/);
    assert.ok(Date.now() - started < 1000, 'refused before expanding');
    assert.throws(() => expandDesignIcons('<aegis-icon name="bell">'.repeat(2001)), /at most 2000 icons/);
    // Without the library (a build that skipped build-design-assets): a clear error, and built-in components still load.
    const bare = path.join(temp, 'bare');
    fs.mkdirSync(bare);
    for (const f of ['icons.js', 'builtin-components.js']) fs.copyFileSync(`${dist}/electron/design/${f}`, path.join(bare, f));
    assert.throws(() => require(path.join(bare, 'icons.js')).expandDesignIcons('<aegis-icon name="bell">'), /icon library is not available/);
    const fallback = require(path.join(bare, 'builtin-components.js')).builtinComponents();
    assert.equal(fallback.complete, false);
    assert.ok(Object.values(fallback.components).every((c) => !/<aegis-icon/.test(c.html)), 'icons left out, not fatal');
    assert.equal(searchDesignIcons('arrow right')[0].name, 'arrow-right');
    assert.ok(searchDesignIcons('shopping').some((h) => /cart|shopping/.test(h.name)));
    const repo = getDesignRepository();
    let d = repo.create('s1', 'Assets', '', 'c1');
    d = repo.update('s1', { documentId: d.id, operationId: 'icons', operations: [{ type: 'add', name: 'Nav', width: 400, height: 200, html: '<nav><aegis-icon name="home" size="20"></aegis-icon> Home</nav>' }] });
    assert.match(d.boards[0].html, /<svg data-aegis-icon="home"[\s\S]*<path d=/, 'saved boards hold inline SVG');
    assert.ok(!d.boards[0].html.includes('aegis-icon '), 'no <aegis-icon> left');
    assert.throws(() => repo.update('s1', { documentId: d.id, operationId: 'bad-icon', operations: [{ type: 'add', html: '<aegis-icon name="nope-nope">' }] }), /Unknown icon/);

    // Images: from a file and a data URL, deduplicated, scaled, refused when not images.
    const redFile = path.join(temp, 'red.png');
    fs.writeFileSync(redFile, png(40, 30, [255, 0, 0]));
    const a = repo.addAsset('s1', d.id, prepareDesignImage({ path: redFile, name: 'Red' }));
    assert.match(a.id, /^img_[0-9a-f]{16}$/);
    assert.deepEqual([a.width, a.height, a.mime], [40, 30, 'image/png']);
    assert.equal(repo.addAsset('s1', d.id, prepareDesignImage({ dataUrl: `data:image/png;base64,${fs.readFileSync(redFile).toString('base64')}` })).id, a.id, 'same image, same id');
    const big = prepareDesignImage({ bytes: png(3000, 600, [0, 0, 255]), mime: 'image/png', name: 'wide' });
    assert.deepEqual([big.width, big.height], [2400, 480], 'scaled to 2400 px');
    const svgImg = prepareDesignImage({ bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="120" height="60"/></svg>'), mime: 'image/svg+xml', name: 'logo' });
    assert.deepEqual([svgImg.width, svgImg.height], [120, 60]);
    // A pixel bomb is refused from its header, before decoding.
    const bomb = Buffer.from(png(8, 8, [0, 0, 0]));
    bomb.writeUInt32BE(30000, 16);
    bomb.writeUInt32BE(30000, 20);
    started = Date.now();
    assert.throws(() => prepareDesignImage({ bytes: bomb, mime: 'image/png' }), /30000 × 30000 pixels; images must be at most 50 megapixels/);
    assert.ok(Date.now() - started < 500);
    // A PNG within the size limit but too big to store is re-encoded to fit.
    const noise = Buffer.alloc(2000 * 1500 * 4);
    require('node:crypto').randomFillSync(noise);
    for (let i = 3; i < noise.length; i += 4) noise[i] = 255;
    const heavy = nativeImage.createFromBitmap(noise, { width: 2000, height: 1500 }).toPNG();
    assert.ok(heavy.length > 8_000_000, `noise PNG is ${heavy.length} bytes`);
    const fitted = prepareDesignImage({ bytes: heavy, mime: 'image/png', name: 'noise' });
    assert.ok(fitted.bytes.length <= 8_000_000, `stored at ${fitted.bytes.length} bytes`);
    assert.deepEqual([fitted.width, fitted.height], [2000, 1500]);
    repo.addAsset('s1', d.id, fitted);
    fs.writeFileSync(path.join(temp, 'notes.png'), 'not really a png');
    assert.throws(() => prepareDesignImage({ path: path.join(temp, 'notes.png') }), /could not be read as an image/);
    fs.symlinkSync(redFile, path.join(temp, 'link.png'));
    assert.throws(() => prepareDesignImage({ path: path.join(temp, 'link.png') }), /not an image file/);
    assert.throws(() => prepareDesignImage({ path: 'relative.png' }), /absolute path/);
    assert.throws(() => repo.addAsset('intruder', d.id, prepareDesignImage({ path: redFile })), /not found/i);
    assert.ok(Object.keys(repo.assetData('s1', d.id)).includes(a.id));
    assert.match(repo.assetData('s1', d.id, [a.id])[a.id], /^data:image\/png;base64,/);

    // Boards show it as aegis-asset:<id> (previews included).
    d = repo.update('s1', { documentId: d.id, operationId: 'img', operations: [{ type: 'add', name: 'Photo', width: 200, height: 150, html: `<main style="margin:0"><img src="aegis-asset:${a.id}" alt="Red" style="display:block;width:200px;height:150px"></main>` }] });
    const photo = d.boards.find((b) => b.name === 'Photo');
    assert.match(photo.html, new RegExp(`src="aegis-asset:${a.id}"`), 'the reference survives the sanitizer');
    const shot = await previewDesign('s1', d.id, photo.id, d.revision);
    const img = nativeImage.createFromDataURL(shot.dataUrl);
    const { width, height } = img.getSize();
    const px = img.toBitmap();
    const at = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
    assert.ok(px[at + 2] > 240 && px[at + 1] < 20 && px[at] < 20, `the image renders (got ${px[at + 2]},${px[at + 1]},${px[at]})`);
    assert.ok(!shot.warnings.some((w) => /could not be loaded/.test(w)), shot.warnings.join(' | '));

    // Handed off as files; gone with the design.
    const project = path.join(temp, 'project');
    fs.mkdirSync(project);
    setDesignProjectRoot(() => project);
    const handoff = handOffDesign({ sessionId: 's1', documentId: d.id, boardIds: [photo.id] });
    assert.ok(handoff.files.some((f) => f.endsWith(`images/${a.id}.png`)), handoff.files.join(', '));
    assert.match(fs.readFileSync(path.join(project, handoff.folder, 'README.md'), 'utf8'), /## Images/);
    repo.deleteDocument(d.id);
    assert.equal(repo.db.prepare('SELECT count(*) AS n FROM design_assets WHERE document_id=?').get(d.id).n, 0);
    console.log('PASS design assets: icon expansion, filled style, unknown names, quoted >, script text untouched, size and count caps, missing library, search, inline SVG on save; pixel bombs, oversize re-encoding, images from files/data URLs, dedupe, scaling, SVG size, refusals, access, rendering, handoff files, removal with the design');
  } catch (error) {
    console.error(error);
    code = 1;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(code);
  }
});
