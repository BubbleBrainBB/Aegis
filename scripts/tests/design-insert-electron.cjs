const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
// Text and Frame tools: click to add text, draw a frame in a board, draw a new board.
exports.run = async ({ w, js, repo, sessionId, documentId, screenshotDir }) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, label) => {
    for (let i = 0; i < 120; i++) {
      if (await fn()) return;
      await wait(50);
    }
    throw Error("Insert tools timeout: " + label);
  };
  const doc = () => repo.read(sessionId, documentId);
  const home = () => doc().boards[0];
  const frame = async () => {
    for (const f of w.webContents.mainFrame.framesInSubtree.filter((f) => f.url === "about:srcdoc"))
      // Home's frame by its own copy: earlier steps remove the hero layer's id,
      // and the Journal board shares the rest of its markup.
      if (await f.executeJavaScript('document.body.textContent.includes("Collect the moments")').catch(() => false)) return f;
  };
  const toScreen = async (r) => {
    const b = await js(`(()=>{const r=document.querySelector('[data-board-id="${home().id}"]').getBoundingClientRect();return {x:r.x,y:r.y,zoom:+document.querySelector(".design-viewport").dataset.viewZoom}})()`);
    return { x: b.x + r.x * b.zoom, y: b.y + r.y * b.zoom };
  };
  const zoom = () => js('+document.querySelector(".design-viewport").dataset.viewZoom');
  const mouse = (type, p) => w.webContents.sendInputEvent({ type, button: "left", clickCount: 1, x: Math.round(p.x), y: Math.round(p.y) });
  const click = async (p) => {
    w.focus();
    mouse("mouseMove", p);
    await wait(60);
    mouse("mouseDown", p);
    mouse("mouseUp", p);
  };
  const drag = async (from, to) => {
    w.focus();
    mouse("mouseMove", from);
    mouse("mouseDown", from);
    for (let i = 1; i <= 8; i++) {
      mouse("mouseMove", { x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 });
      await wait(16);
    }
    mouse("mouseUp", to);
  };
  const tool = async (label) => {
    await js(`document.querySelector('[aria-label="${label}"]').click()`);
    await until(() => js(`document.querySelector('[aria-label="${label}"]').getAttribute("aria-pressed")==="true"&&!!document.querySelector(".design-mode-hint")`), label + " on");
  };
  const selectMode = () => js('document.querySelector(\'[aria-label="Select and move"]\').getAttribute("aria-pressed")==="true"');
  await js('document.querySelector(".design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  // Earlier steps leave the view zoomed on a comment; start from all boards in view.
  // Fit canvas (⌘0; the zoom menu has it too).
  await js('document.querySelector(".design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"0",code:"Digit0",metaKey:true,bubbles:true,cancelable:true}))');
  await wait(200);

  // Text: hovering below the paragraph previews the slot; a click opens an empty editor.
  await tool("Text tool");
  const p = await (await frame()).executeJavaScript('(()=>{const r=document.querySelector("p").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
  const below = await toScreen({ x: p.x + 20, y: p.y + p.height * 0.8 });
  w.focus();
  mouse("mouseMove", below);
  await until(() => js('!!document.querySelector(".design-insert-line.is-h")&&/· \\d+ of \\d+/.test(document.querySelector(".design-insert-tag")?.textContent||"")'), "hover insertion line");
  // Nothing typed: no new version, no leftover preview.
  const rev0 = doc().revision;
  await click(below);
  await until(() => js('!!document.querySelector(".design-inline-text[data-placeholder=Text]")'), "empty text editor");
  await js('document.querySelector(".design-inline-text").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await until(() => js('!document.querySelector(".design-inline-text")'), "editor closed");
  await wait(200);
  assert.equal(doc().revision, rev0, "an empty text layer is not saved");
  assert.equal(await (await frame()).executeJavaScript('document.querySelectorAll("[data-aegis-insert-preview]").length'), 0, "preview removed");
  assert(await selectMode(), "back to Select after the text tool");
  // Typed: saved after the paragraph, selected, one version.
  await tool("Text tool");
  w.focus();
  mouse("mouseMove", below);
  await wait(120);
  await click(below);
  await until(() => js('!!document.querySelector(".design-inline-text")'), "text editor");
  await js('(()=>{const e=document.querySelector(".design-inline-text");e.textContent="Free to start";e.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))})()');
  await until(() => doc().revision === rev0 + 1, "text saved");
  const html = home().html;
  assert(/<\/p>\s*<p data-aegis-node-id="aegis-layer-\d+">Free to start<\/p>\s*<button/.test(html), "new paragraph between the intro and the button: " + html.slice(Math.max(0, html.indexOf("Free to start") - 300), html.indexOf("Free to start") + 200));
  await until(() => js('(Object.values(qa.design.getState().selections).find(Boolean)?.label??"").split(" · ")[0].startsWith("p")'), "new text selected");
  assert.equal(repo.history(sessionId, documentId)[0].summary, "Added text to Home");

  // Frame inside a board: lands in the layout after the drop point, at the drawn size.
  await tool("Frame tool");
  const btn = await (await frame()).executeJavaScript('(()=>{const r=document.querySelector("button").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
  const z = await zoom();
  // Home is phone width by now (390): stay inside it.
  const from = await toScreen({ x: btn.x, y: btn.y + btn.height + 4 });
  const to = { x: from.x + 140 * z, y: from.y + 90 * z };
  await drag(from, to);
  await until(() => /data-aegis-layer-name="Frame"/.test(home().html), "frame saved");
  const style = /data-aegis-layer-name="Frame" style="([^"]+)"/.exec(home().html)[1];
  // About the drawn 140×90: the slower CI runner can drop the last moves of the drag.
  const drawn = /display: flex; flex-direction: column; gap: 12px; padding: 16px; width: (\d+)px; height: (\d+)px/.exec(style);
  assert(drawn && +drawn[1] >= 112 && +drawn[1] <= 160 && +drawn[2] >= 72 && +drawn[2] <= 104, style);
  await until(() => js('(Object.values(qa.design.getState().selections).find(Boolean)?.label??"").split(" · ")[0]==="Frame"'), "frame selected");
  // Properties may be closed by now; the element bar opens them.
  if (!(await js('!!document.querySelector(".design-inspector")'))) await js('document.querySelector(\'.design-float-bar [aria-label="Properties"]\').click()');
  await until(() => js('[...document.querySelectorAll(".design-inspector .iv-sec h4")].some(h=>h.textContent==="Layout")'), "the new frame shows its auto layout");
  assert(await selectMode(), "back to Select after the frame tool");
  fs.writeFileSync(path.join(screenshotDir, "design-insert.png"), (await w.webContents.capturePage()).toPNG());

  // Frame outside the boards: a new blank board, snapped to the phone width.
  await tool("Frame tool");
  // Earlier steps may have zoomed in on a comment: zoom out until there is empty canvas.
  let spot = null;
  for (let i = 0; i < 6 && !spot; i++) {
    const zz = await zoom();
    spot = await js(`(()=>{const v=document.querySelector(".design-viewport").getBoundingClientRect();const bs=[...document.querySelectorAll(".design-board")].map(b=>b.getBoundingClientRect());const right=Math.max(...bs.map(b=>b.right)),bottom=Math.max(...bs.map(b=>b.bottom));const w=${400 * zz},h=${300 * zz};if(bottom+30+h<v.bottom-30)return {x:v.left+60,y:bottom+30};if(right+30+w<v.right-320)return {x:right+30,y:v.top+90};return null})()`);
    if (!spot) {
      // Zoom out (⌘−; the zoom menu has it too).
      await js('document.querySelector(".design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"-",code:"Minus",metaKey:true,bubbles:true,cancelable:true}))');
      await wait(150);
    }
  }
  assert(spot, "free canvas space for a new board");
  const zb = await zoom();
  const count = doc().boards.length;
  await drag(spot, { x: spot.x + 400 * zb, y: spot.y + 300 * zb });
  await until(() => doc().boards.length === count + 1, "board created");
  const made = doc().boards.at(-1);
  assert.equal(made.width, 390, "snapped to the phone width");
  assert(made.html.includes("background: #ffffff"), "blank white board");
  await until(() => js(`document.querySelector('[data-board-id="${made.id}"]')?.classList.contains("is-selected")`), "new board selected");
  console.log("Insert tools: text hover/insert/empty, frame in layout, new board snapped passed");
};
