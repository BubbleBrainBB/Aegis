const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
// Comment mode: entry, click-to-comment at the clicked point, area comments, exit.
exports.run = async ({ w, js, repo, sessionId, documentId, screenshotDir, sent }) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, label) => {
    for (let i = 0; i < 120; i++) {
      if (await fn()) return;
      await wait(50);
    }
    throw Error("Comment mode timeout: " + label);
  };
  const board = () => repo.read(sessionId, documentId).boards[0];
  const comments = () => repo.comments(sessionId, documentId);
  const frame = async () => {
    for (const f of w.webContents.mainFrame.framesInSubtree.filter((f) => f.url === "about:srcdoc"))
      if (await f.executeJavaScript('!!document.querySelector("[data-aegis-node-id=hero]")').catch(() => false)) return f;
  };
  const toScreen = async (r) => {
    const b = await js(`(()=>{const r=document.querySelector('[data-board-id="${board().id}"]').getBoundingClientRect();return {x:r.x,y:r.y,zoom:+document.querySelector(".design-viewport").dataset.viewZoom}})()`);
    return { x: b.x + r.x * b.zoom, y: b.y + r.y * b.zoom };
  };
  const mouse = (type, p) => w.webContents.sendInputEvent({ type, button: "left", clickCount: 1, x: Math.round(p.x), y: Math.round(p.y) });
  const type = (selector, value) =>
    js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event("input",{bubbles:true}))})()`);
  const enter = async () => {
    await js('document.querySelector(\'[aria-label="Comment mode"]\').click()');
    await until(() => js('!!document.querySelector(".design-mode-hint")'), "comment mode hint");
  };

  // Entry from the toolbar: hint bar, pressed tool, Comments tab.
  await enter();
  assert.equal(await js('document.querySelector(\'[aria-label="Comment mode"]\').getAttribute("aria-pressed")'), "true");
  await until(() => js('document.querySelector(".design-tabs [aria-selected=true]").textContent.startsWith("Comments")'), "Comments tab");
  // Click a layer: the pin lands where it was clicked.
  const p = await (await frame()).executeJavaScript('(()=>{const r=document.querySelector("p").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
  const at = await toScreen({ x: p.x + p.width * 0.25, y: p.y + p.height * 0.5 });
  w.focus();
  mouse("mouseMove", at);
  mouse("mouseDown", at);
  mouse("mouseUp", at);
  await until(() => js('!!document.querySelector(".design-composer textarea")'), "click opens the composer");
  await js('(()=>{const t=document.querySelector(".design-composer textarea");t.focus();t.setSelectionRange(0,0);t.dispatchEvent(new KeyboardEvent("keydown",{key:"Backspace",bubbles:true}))})()');
  const before = comments().length;
  await type(".design-composer textarea", "Pin where I clicked");
  await js('document.querySelector(".design-composer .design-primary").click()');
  await until(() => comments().length === before + 1, "layer comment saved");
  // After sending, the canvas shows that thread, not another empty composer (reloads re-report the layer).
  await until(() => js('document.querySelector(".design-thread")?.textContent.includes("Pin where I clicked")'), "thread shows the new comment");
  await wait(600);
  assert(await js('[...document.querySelectorAll(".design-composer")].every(c=>c.closest(".design-thread"))'), "no new composer after sending");
  assert(await js('document.querySelector(".design-thread")?.textContent.includes("Pin where I clicked")'), "thread stays open");
  const placed = comments().at(-1);
  assert(placed.anchor.offset, "click offset stored");
  assert(Math.abs(placed.anchor.offset.x - p.width * 0.25) < 6, "offset.x matches the click: " + JSON.stringify(placed.anchor.offset));
  assert(await js('document.querySelector(".design-mode-hint")!==null'), "still in comment mode after commenting");
  assert(await js(`document.querySelector(".design-tabs [aria-selected=true]").textContent.startsWith("Comments")`), "commenting keeps the Comments tab");

  // Drag an area: the composer names it, the agent gets a close-up and the board.
  await js('document.querySelector(\'[aria-label="Close thread"]\')?.click()');
  const area = await (await frame()).executeJavaScript('(()=>{const rs=["small","[data-aegis-node-id=hero]","p","button"].map(s=>document.querySelector(s).getBoundingClientRect());const x=Math.min(...rs.map(r=>r.x))-6,y=Math.min(...rs.map(r=>r.y))-6;return {x,y,right:Math.max(...rs.map(r=>r.right))+6,bottom:Math.max(...rs.map(r=>r.bottom))+6}})()');
  const from = await toScreen({ x: area.x, y: area.y });
  const to = await toScreen({ x: area.right, y: area.bottom });
  mouse("mouseMove", from);
  mouse("mouseDown", from);
  for (let i = 1; i <= 8; i++) {
    mouse("mouseMove", { x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 });
    await wait(40);
  }
  await until(() => js('!!document.querySelector(".design-area")'), "area box while dragging");
  mouse("mouseUp", to);
  await until(() => js('!!document.querySelector(".design-composer textarea")&&!!document.querySelector(".design-area-screen")'), "area composer");
  assert(!(await js('/Area ·/.test(document.querySelector(".design-composer").textContent)')), "no descriptive label in the composer");
  assert(await js('!!document.querySelector(".design-area-screen")'), "area stays outlined while composing");
  fs.writeFileSync(path.join(screenshotDir, "design-comment-area.png"), (await w.webContents.capturePage()).toPNG());
  const sentBefore = sent.length;
  await type(".design-composer textarea", "Tighten this whole hero");
  await js('document.querySelector(".design-composer .design-primary").click()');
  for (let i = 0; i < 80 && sent.length === sentBefore; i++) await wait(75);
  assert.equal(sent.length, sentBefore + 1, "area comment sent to the agent");
  assert(comments().at(-1).anchor.nodeIds.length >= 4, "area covers the hero layers");
  const payload = sent.at(-1);
  assert.equal(payload.attachments.length, 2, "close-up plus whole board");
  assert(payload.design.layerName.startsWith("Area · "));
  const areaComment = comments().at(-1);
  assert.equal(areaComment.anchor.area, true);
  assert(areaComment.anchor.nodeIds.length >= 4);

  // Esc leaves comment mode once nothing else is open.
  await js('document.querySelector(\'[aria-label="Close thread"]\')?.click()');
  await js('document.querySelector(".design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await until(() => js('!document.querySelector(".design-mode-hint")'), "Esc exits comment mode");
  assert.equal(await js('document.querySelector(\'[aria-label="Select and move"]\').getAttribute("aria-pressed")'), "true");

  // Hide comments: pins go away; a list row shows only its own thread; ⇧C and comment mode bring them back.
  const pinCount = () => js('document.querySelectorAll(".design-pin").length');
  const shown = await pinCount();
  assert(shown >= 2, "pins before hiding: " + shown);
  await js('[...document.querySelectorAll(".design-tabs [role=tab]")].find(b=>b.textContent.startsWith("Comments")).click()');
  await until(() => js('!!document.querySelector(\'[aria-label="Hide comments"]\')'), "hide toggle on the Comments tab");
  await js('document.querySelector(\'[aria-label="Hide comments"]\').click()');
  await until(async () => (await pinCount()) === 0, "pins hidden");
  assert.equal(await js('localStorage.getItem("aegis.design.commentsHidden")'), "true", "remembered");
  assert.equal(await js('document.querySelector(\'[aria-label="Show comments"]\').getAttribute("aria-pressed")'), "true");
  assert(await js('document.querySelectorAll(".design-comment-row").length') >= 2, "the list still shows them");
  await js('document.querySelector(".design-comment-row").click()');
  await until(async () => (await pinCount()) === 1 && (await js('!!document.querySelector(".design-thread")')), "a list row shows its own pin and thread");
  await js('document.querySelector(\'[aria-label="Close thread"]\').click()');
  await until(async () => (await pinCount()) === 0, "hidden again after closing the thread");
  await js('document.querySelector(".design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"C",code:"KeyC",shiftKey:true,bubbles:true}))');
  await until(async () => (await pinCount()) === shown, "⇧C shows them");
  await js('document.querySelector(".design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"C",code:"KeyC",shiftKey:true,bubbles:true}))');
  await until(async () => (await pinCount()) === 0, "⇧C hides them");
  assert(!(await js('!!document.querySelector(".design-mode-hint")')), "⇧C does not enter comment mode");
  await js('document.querySelector(\'[aria-label="Comment mode"]\').click()');
  await until(async () => (await pinCount()) === shown, "comment mode shows them again");
  await js('document.querySelector(".design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await until(() => js('!document.querySelector(".design-mode-hint")'), "Esc exits comment mode again");
  console.log("PASS: comment mode entry, Comments tab, click-point pins, area comments with close-up, Esc exit, hide comments");
};
