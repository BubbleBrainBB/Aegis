// Decks and verification in real Chromium: one slide shows at a time and
// switches by message; previews capture any slide; slide text under 24px is
// flagged; PDF and PowerPoint have a page/slide per deck slide with notes;
// design_verify stops on blocking checks, reviews every slide otherwise,
// and falls back to the checks when the reviewer can't run.
const { app, BrowserWindow, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-design-verify-'));
app.setPath('userData', path.join(temp, 'profile'));
app.on('window-all-closed', () => {});
const dist = path.join(__dirname, '../../dist-electron');

const DECK = `<!doctype html><html><head><style>html,body,main{margin:0;width:100%;height:100%}section{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font:64px system-ui}.s1{background:#ff0000}.s2{background:#00ff00}.s3{background:#0000ff}.tiny{font-size:12px}</style></head><body>
<main data-aegis-deck><section class="s1" data-aegis-slide data-aegis-notes="Say hello"><h1>One</h1></section><section class="s2" data-aegis-slide><h1>Two</h1><p class="tiny">fine print</p></section><section class="s3" data-aegis-slide data-aegis-notes="Thanks"><h1>Three</h1></section></main></body></html>`;

app.whenReady().then(async () => {
  let code = 0;
  try {
    const { designFrameHtml } = require(`${dist}/shared/design-frame.js`);
    const { getDesignRepository, previewDesign, designPdf } = require(`${dist}/electron/design/service.js`);
    const { buildPptx } = require(`${dist}/electron/design/pptx.js`);
    const { verifyDesign, setDesignReviewer, verificationText } = require(`${dist}/electron/design/verify.js`);
    const { unzipSync, strFromU8 } = require('fflate');

    // One slide at a time, switched by message without reloading.
    const w = new BrowserWindow({ show: false, width: 640, height: 360, webPreferences: { sandbox: true, contextIsolation: true } });
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(designFrameHtml(DECK, 'n0nce', false, { mode: 'play', slide: 0 }))}`);
    const shown = () => w.webContents.executeJavaScript('[...document.querySelectorAll("[data-aegis-slide]")].map(s=>getComputedStyle(s).display!=="none")');
    assert.deepEqual(await shown(), [true, false, false]);
    await w.webContents.executeJavaScript('new Promise(r=>{addEventListener("message",e=>{if(e.data?.type==="aegis-design-slide-shown")r()});postMessage({type:"aegis-design-slide",nonce:"n0nce",index:2},"*")})');
    assert.deepEqual(await shown(), [false, false, true], 'the canvas switches slides by message');
    w.destroy();

    // Previews capture a chosen slide; slide text under 24px is flagged.
    const repo = getDesignRepository();
    let d = repo.create('s1', 'Q3', '', 'c1');
    d = repo.update('s1', { documentId: d.id, operationId: 'add', operations: [{ type: 'add', name: 'Deck', width: 640, height: 360, html: DECK }] });
    const deck = d.boards[0];
    const pixel = (preview) => {
      const img = nativeImage.createFromDataURL(preview.dataUrl);
      const bmp = img.toBitmap(); // BGRA
      const { width, height } = img.getSize();
      const at = (Math.floor(height / 2) * width + 4) * 4;
      return [bmp[at + 2], bmp[at + 1], bmp[at]];
    };
    const p0 = await previewDesign('s1', d.id, deck.id, d.revision);
    const p1 = await previewDesign('s1', d.id, deck.id, d.revision, undefined, undefined, undefined, true, 1);
    // Display color management (profiles, Night Shift) shifts captured colors (pure green reads 87,255,0),
    // so check which primary the pixel is: its channel clearly leads the other two.
    const near = (a, b, label) => {
      const want = b.indexOf(255);
      assert.ok(a[want] >= 200 && a.every((v, i) => i === want || a[want] - v >= 120), `${label}: ${a} vs ${b}`);
    };
    near(pixel(p0), [255, 0, 0], 'slide 1 by default');
    near(pixel(p1), [0, 255, 0], 'slide 2 when asked');
    assert.ok(p1.warnings.some((x) => /Slide text under 24px/.test(x)), p1.warnings.join('\n'));
    assert.ok(!p0.warnings.some((x) => /under 24px/.test(x)));

    // PDF: a page per slide. PowerPoint: a slide per deck slide, notes kept.
    const pdf = Buffer.from(await designPdf(d.boards));
    assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length, 3, 'a PDF page per slide');
    const shots = [];
    for (let i = 0; i < 3; i++) {
      const p = await previewDesign('s1', d.id, deck.id, d.revision, undefined, 4096, 1, false, i);
      shots.push({ png: Buffer.from(p.dataUrl.split(',')[1], 'base64'), width: 640, height: 360, notes: ['Say hello', '', 'Thanks'][i] || undefined });
    }
    const files = unzipSync(buildPptx(shots, { width: 640, height: 360 }, 'Q3'));
    assert.deepEqual(Object.keys(files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort(), ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide3.xml']);
    assert.match(strFromU8(files['ppt/notesSlides/notesSlide3.xml']), /Thanks/);
    assert.match(strFromU8(files['ppt/presentation.xml']), /<p:sldSz cx="6096000" cy="3429000"\/>/);
    // Slide sides stay within what PowerPoint accepts, keeping the shape.
    const sizeOf = (w, h) => /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(strFromU8(unzipSync(buildPptx([{ png: shots[0].png, width: w, height: h }], { width: w, height: h }, 'x'))['ppt/presentation.xml'])).slice(1).map(Number);
    for (const [w, h] of [[60, 40], [8000, 4000], [390, 6000]]) {
      const [cx, cy] = sizeOf(w, h);
      assert.ok(cx >= 914400 && cx <= 51206400 && cy >= 914400 && cy <= 51206400, `${w}x${h} -> ${cx}x${cy}`);
    }
    // A PDF of a deck and a plain board: a page per slide, then the board.
    const plainBoard = { id: 'plain', html: '<main><h1>Plain</h1></main>', width: 400, height: 300 };
    const mixed = Buffer.from(await designPdf([...d.boards, plainBoard]));
    assert.equal((mixed.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length, 4);

    // Verification: every slide reviewed; the reviewer's verdict comes back.
    let seen = null;
    setDesignReviewer(async ({ boards, request }) => {
      seen = { names: boards.map((b) => b.name), request, pngs: boards.every((b) => b.png.length > 100) };
      return 'Looks fine overall. {"verdict":"needs_work","summary":"Slide 2 has fine print.","issues":[{"board":"Deck · slide 2","problem":"Fine print is unreadable","fix":"Raise it to 28px"}]}';
    });
    let v = await verifyDesign('s1', { documentId: d.id, request: 'A three-slide Q3 deck' });
    assert.deepEqual(seen.names, ['Deck · slide 1', 'Deck · slide 2', 'Deck · slide 3']);
    assert.equal(seen.request, 'A three-slide Q3 deck');
    assert.ok(seen.pngs);
    assert.equal(v.verdict, 'needs_work');
    assert.equal(v.source, 'review');
    assert.ok(v.issues.some((i) => i.fix === 'Raise it to 28px'));
    assert.ok(v.issues.some((i) => /under 24px/.test(i.problem)), 'check findings ride along');
    assert.match(verificationText(v), /Verdict: needs work \(visual review\)/);
    // The reviewer can't run: the checks still count.
    setDesignReviewer(async () => { throw new Error('Claude Code is not signed in'); });
    v = await verifyDesign('s1', { documentId: d.id });
    assert.equal(v.source, 'checks-only');
    assert.match(v.summary, /not signed in/);
    // Blocking checks stop before any review.
    let reviewed = false;
    setDesignReviewer(async () => { reviewed = true; return '{"verdict":"done"}'; });
    d = repo.update('s1', { documentId: d.id, operationId: 'broken', operations: [{ type: 'add', name: 'Broken', width: 400, height: 300, html: '<main><p>{{ nope.deep }}</p></main>', js: 'class Board extends AegisBoard {}' }] });
    v = await verifyDesign('s1', { documentId: d.id, boardIds: [d.boards[1].id] });
    assert.equal(v.source, 'checks');
    assert.equal(v.verdict, 'needs_work');
    assert.ok(v.issues.some((i) => /Logic error/.test(i.problem)));
    assert.equal(reviewed, false, 'no review while checks block');
    // Review skipped on request.
    v = await verifyDesign('s1', { documentId: d.id, boardIds: [deck.id], review: false });
    assert.equal(v.source, 'checks-only');
    console.log('PASS decks and verification: slide switching, slide previews, small slide text, PDF page per slide, PowerPoint with notes, review of every slide, reviewer fallback, blocking checks, skipped review');
  } catch (error) {
    console.error(error);
    code = 1;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(code);
  }
});
