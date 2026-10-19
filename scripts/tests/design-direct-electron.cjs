const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
// Direct manipulation on the canvas: resize handles, Hug, drag to reorder, Esc.
exports.run = async ({ w, js, repo, sessionId, documentId, screenshotDir }) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, label) => {
    for (let i = 0; i < 120; i++) {
      if (await fn()) return;
      await wait(50);
    }
    throw Error("Direct timeout: " + label);
  };
  const board = () => repo.read(sessionId, documentId).boards[0];
  const boardId = board().id;
  const frame = async () => {
    for (const f of w.webContents.mainFrame.framesInSubtree.filter((f) => f.url === "about:srcdoc"))
      if (await f.executeJavaScript('!!document.querySelector("[data-aegis-node-id=hero]")').catch(() => false)) return f;
  };
  const center = (selector) =>
    js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  const mouse = (type, p, clickCount = 1) => w.webContents.sendInputEvent({ type, button: "left", clickCount, x: Math.round(p.x), y: Math.round(p.y) });
  const drag = async (from, to, { escape = false } = {}) => {
    w.focus();
    mouse("mouseMove", from);
    mouse("mouseDown", from);
    for (let i = 1; i <= 8; i++) {
      mouse("mouseMove", { x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 });
      await wait(45);
    }
    await wait(150);
    if (escape) {
      w.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      w.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await wait(100);
    }
    mouse("mouseUp", to);
    await wait(200);
  };
  const select = async () => {
    await (await frame()).executeJavaScript('document.querySelector("[data-aegis-node-id=hero]").click()');
    await until(() => js('!!document.querySelector(\'[data-element-resize="e"]\')'), "selected layer shows resize handles");
  };
  const heroStyle = () => /data-aegis-node-id="hero"[^>]*style="([^"]*)"|style="([^"]*)"[^>]*data-aegis-node-id="hero"/.exec(board().html)?.slice(1).find(Boolean) ?? "";

  // Resize: drag the right edge; the frame previews it live, release saves Fixed width.
  await js('document.querySelector(".design-viewport").focus()');
  await select();
  const before = await (await frame()).executeJavaScript('document.querySelector("[data-aegis-node-id=hero]").getBoundingClientRect().width');
  let revision = board().contentRevision;
  const e = await center('[data-element-resize="e"]');
  await drag(e, { x: e.x - 40, y: e.y });
  await until(() => board().contentRevision > revision, "resize persisted");
  const fixed = /width:\s*(\d+)px\s*!important/.exec(heroStyle());
  assert(fixed && Number(fixed[1]) < before - 20, "resize writes a smaller fixed width: " + heroStyle());
  // A dragged width lifts layout limits; text keeps hugging its height.
  assert(/max-width:\s*none/.test(heroStyle()) && /flex-shrink:\s*0/.test(heroStyle()), "layout limits lifted: " + heroStyle());
  assert(!/(^|;)\s*height:/.test(heroStyle()), "text height stays Hug: " + heroStyle());
  assert.equal(repo.history(sessionId, documentId)[0].summary.startsWith("Resized"), true);

  // Double-clicking the handle hugs the content.
  await select();
  revision = board().contentRevision;
  const e2 = await center('[data-element-resize="e"]');
  mouse("mouseDown", e2, 1); mouse("mouseUp", e2, 1); mouse("mouseDown", e2, 2); mouse("mouseUp", e2, 2);
  await until(() => board().contentRevision > revision, "hug persisted");
  assert(/width:\s*fit-content/.test(heroStyle()), "double-click handle = Hug");

  // Only auto layout (flex/grid) children reorder: the nav logo moves past its links.
  const selectNode = async (selector) => {
    await (await frame()).executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);
    // Small layers render without handles at fit zoom; the selection box is enough.
    await until(() => js("!!document.querySelector(\".design-selection:not(.is-hover)\")"), "selected " + selector);
    await wait(60);
  };
  const order = () => {
    const h = board().html;
    const nav = h.slice(h.indexOf("<nav"), h.indexOf("</nav>"));
    return nav.indexOf("<span") < nav.search(/<b[\s>]/);
  };
  assert.equal(order(), false, "logo starts before the links");
  await selectNode("nav b");
  const span = await (await frame()).executeJavaScript('(()=>{const r=document.querySelector("nav span").getBoundingClientRect();return {x:r.right-4,y:r.y+r.height/2}})()');
  const b = await js(`(()=>{const r=document.querySelector('[data-board-id="${boardId}"]').getBoundingClientRect();return {x:r.x,y:r.y,zoom:+document.querySelector(".design-viewport").dataset.viewZoom}})()`);
  const target = { x: b.x + span.x * b.zoom, y: b.y + span.y * b.zoom };
  const grab = await center(".design-selection");
  // Esc mid-drag cancels without writing.
  revision = board().contentRevision;
  await drag(grab, target, { escape: true });
  await wait(300);
  assert.equal(board().contentRevision, revision, "Escape cancels the drag");
  assert.equal(order(), false);
  await selectNode("nav b");
  const grab2 = await center(".design-selection");
  w.focus();
  mouse("mouseMove", grab2);
  mouse("mouseDown", grab2);
  for (let i = 1; i <= 8; i++) {
    mouse("mouseMove", { x: grab2.x + ((target.x - grab2.x) * i) / 8, y: grab2.y + ((target.y - grab2.y) * i) / 8 });
    await wait(45);
  }
  await until(() => js('!!document.querySelector(".design-drag-ghost")&&!!document.querySelector(".design-drop-container")'), "drag ghost and drop container");
  await until(() => js('(document.querySelector(".design-size-label")?.textContent??"").startsWith("Position 2")'), "drop position label");
  fs.writeFileSync(path.join(screenshotDir, "design-drag.png"), (await w.webContents.capturePage()).toPNG());
  mouse("mouseUp", target);
  await until(() => board().contentRevision > revision, "reorder persisted");
  assert.equal(order(), true, "logo now follows the links");
  assert(repo.history(sessionId, documentId)[0].summary.startsWith("Reordered"), repo.history(sessionId, documentId)[0].summary);
  // ⌘Z / Ctrl+Z undoes the reorder; ⌘⇧Z / Ctrl+Shift+Z redoes it.
  const mod = process.platform === "darwin" ? "metaKey" : "ctrlKey";
  const press = (shift) =>
    js(`document.querySelector(".design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"z",${mod}:true,shiftKey:${shift},bubbles:true,cancelable:true}))`);
  // On the slower CI runner an edit can still be saving when the shortcut
  // lands, or the shortcut can miss: let the revision settle, press, and press
  // once more if nothing changed, then wait for the expected board.
  const pressUntil = async (shift, done, label) => {
    for (let stable = 0, last = board().contentRevision; stable < 600; stable += 100) {
      await wait(100);
      if (board().contentRevision !== last) { last = board().contentRevision; stable = -100; }
    }
    const before = board().contentRevision;
    const changed = () => board().contentRevision > before && done();
    await js('document.querySelector(".design-viewport").focus()');
    await press(shift);
    for (let i = 0; i < 40 && !changed(); i++) await wait(50);
    if (!changed() && board().contentRevision === before) await press(shift);
    await until(changed, label);
  };
  await pressUntil(false, () => !order(), "undo restores the previous order");
  assert(repo.history(sessionId, documentId)[0].summary.startsWith("Undo · Reordered"), repo.history(sessionId, documentId)[0].summary);
  await pressUntil(true, () => order(), "redo reapplies it");
  assert(repo.history(sessionId, documentId)[0].summary.startsWith("Redo · "));

  // A plain-flow child moves freely like in a Figma frame: no reorder, siblings stay put.
  const pStyle = () =>
    frame()
      .then((f) => f?.executeJavaScript('document.querySelector("main p").getAttribute("style")||""') ?? "")
      .catch(() => "");
  // The board frame re-renders after the save lands, so poll it (null while it reloads).
  const siblings = () =>
    frame()
      .then((f) => f?.executeJavaScript('[...document.querySelectorAll("main > :not(p)")].map(e=>Math.round(e.getBoundingClientRect().y)).join()'))
      .catch(() => null);
  const html = board().html;
  await selectNode("main p");
  let pinned;
  await until(async () => (pinned = await siblings()) != null, "siblings measured");
  revision = board().contentRevision;
  const pFrom = await center(".design-selection");
  w.focus();
  mouse("mouseMove", pFrom);
  mouse("mouseDown", pFrom);
  for (let i = 1; i <= 8; i++) {
    mouse("mouseMove", { x: pFrom.x + 5 * i, y: pFrom.y + 12 * i });
    await wait(45);
  }
  await wait(150);
  assert(await js('!document.querySelector(".design-drop-container")'), "plain flow shows no reorder target");
  mouse("mouseUp", { x: pFrom.x + 40, y: pFrom.y + 96 });
  await until(() => board().contentRevision > revision, "free move persisted");
  await until(async () => /position:\s*absolute/.test(await pStyle()), "plain-flow drag frees the layer").catch(async (error) => {
    assert.fail(error.message + ": " + (await pStyle()));
  });
  assert(repo.history(sessionId, documentId)[0].summary.startsWith("Made "), repo.history(sessionId, documentId)[0].summary);
  // The freed paragraph leaves flow; following siblings close the gap but never swap order.
  assert.equal(html.replace(/\s*style="[^"]*"/g, "").replace(/<p[^>]*>.*?<\/p>/, ""), board().html.replace(/\s*style="[^"]*"/g, "").replace(/<p[^>]*>.*?<\/p>/, ""), "no layers reordered");
  await pressUntil(false, () => !/position:\s*absolute/.test(board().html.match(/<p[^>]*>/)?.[0] ?? ""), "undo restores flow");
  await until(async () => (await siblings()) === pinned, "undo puts the siblings back").catch(async (error) => {
    assert.equal(await siblings(), pinned, error.message);
  });
  console.log("PASS: undo/redo of canvas edits, element resize handles, Hug on double-click, auto-layout drag reorder with drop indicator, Esc cancel, and free move in plain flow");
};
