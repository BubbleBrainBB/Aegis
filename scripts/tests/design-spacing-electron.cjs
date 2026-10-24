const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
// N7 spacing handles on an auto layout container; N8 free moves with constraints.
exports.run = async ({ w, js, repo, sessionId, documentId, screenshotDir }) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, label) => {
    for (let i = 0; i < 120; i++) {
      if (await fn()) return;
      await wait(50);
    }
    throw Error("Spacing timeout: " + label);
  };
  const board = () => repo.read(sessionId, documentId).boards[0];
  const history = () => repo.history(sessionId, documentId);
  const frame = async () => {
    for (const f of w.webContents.mainFrame.framesInSubtree.filter((f) => f.url === "about:srcdoc"))
      if (await f.executeJavaScript('!!document.querySelector("[data-aegis-node-id=hero]")').catch(() => false)) return f;
  };
  const styleOf = (selector) =>
    frame().then((f) => f.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).getAttribute("style")||""`));
  const center = (selector) =>
    js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const mouse = (type, p, modifiers = []) =>
    w.webContents.sendInputEvent({ type, button: "left", clickCount: 1, x: Math.round(p.x), y: Math.round(p.y), modifiers });
  const drag = async (from, delta, modifiers = []) => {
    w.focus();
    mouse("mouseMove", from, modifiers);
    mouse("mouseDown", from, modifiers);
    for (let i = 1; i <= 8; i++) {
      mouse("mouseMove", { x: from.x + (delta.x * i) / 8, y: from.y + (delta.y * i) / 8 }, modifiers);
      await wait(45);
    }
    await wait(150);
    mouse("mouseUp", { x: from.x + delta.x, y: from.y + delta.y }, modifiers);
  };
  // An element's center in window coordinates: the board's offset plus the
  // element's position inside the board frame, scaled by the canvas zoom.
  // (The `.design-selection` box follows the hovered element while the
  // pointer is over one, so it is not a reliable stand-in for the selection.)
  const screenCenter = async (selector) => {
    const r = await (await frame()).executeJavaScript(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`
    );
    const b = await js(
      `(()=>{const r=document.querySelector('[data-board-id="${board().id}"]').getBoundingClientRect();return {x:r.x,y:r.y,zoom:+document.querySelector(".design-viewport").dataset.viewZoom}})()`
    );
    return { x: b.x + r.x * b.zoom, y: b.y + r.y * b.zoom };
  };
  const select = async (selector) => {
    // Wait until the selection box (not a hover box, not the previous
    // selection) sits on this element; re-click if the first click was missed.
    const onTarget = async () => {
      const box = await js('(()=>{const e=document.querySelector(".design-selection:not(.is-hover)");if(!e||!e.querySelector("[data-element-resize]"))return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
      if (!box) return false;
      const target = await screenCenter(selector);
      return Math.abs(box.x - target.x) < 3 && Math.abs(box.y - target.y) < 3;
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      await (await frame()).executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);
      for (let i = 0; i < 40; i++) {
        if (await onTarget()) return wait(60);
        await wait(50);
      }
    }
    await until(onTarget, "selected " + selector);
  };
  // The CI runner can drop synthetic mouse events mid-drag. A drag that saved
  // nothing is first finished with a mouseUp (in case only that was lost),
  // then repeated from the element's current position.
  const dragSaved = async (fromPoint, delta, modifiers, label) => {
    const revision = board().contentRevision;
    const saved = async (ms) => {
      for (let i = 0; i < ms / 50; i++) {
        if (board().contentRevision > revision) return true;
        await wait(50);
      }
      return board().contentRevision > revision;
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const from = await fromPoint();
      await drag(from, delta, modifiers);
      if (await saved(4000)) return;
      mouse("mouseUp", { x: from.x + delta.x, y: from.y + delta.y }, modifiers);
      if (await saved(1500)) return;
    }
    throw Error("Spacing timeout: " + label);
  };
  await js('document.querySelector(".design-viewport").focus()');

  // N7: the nav is a flex row. Guides start off; turned on from the zoom menu,
  // padding bands and a gap handle appear.
  await select("nav");
  await wait(200);
  assert(await js('document.querySelectorAll("[data-spacing]").length===0'), "layout guides are off by default");
  await js('document.querySelector(".design-zoom").click()');
  await until(() => js('!!document.querySelector(".design-zoom-menu [role=menuitemcheckbox]")'), "zoom menu");
  await js('document.querySelector(".design-zoom-menu [role=menuitemcheckbox]").click()');
  await js('document.querySelector(".design-zoom").click()');
  await until(() => js('document.querySelectorAll(\'[data-spacing^="pad:"]\').length===4'), "padding handles");
  assert(await js('document.querySelectorAll(\'[data-spacing^="gap:"]\').length>=1'), "gap handle between children");
  assert(await js('document.querySelectorAll(".design-spacing-band").length>=4'), "padding bands shown");
  const padBefore = parseFloat(await (await frame()).executeJavaScript('getComputedStyle(document.querySelector("nav")).paddingLeft'));
  let revision;
  await dragSaved(() => center('[data-spacing="pad:left"]'), { x: 24, y: 0 }, [], "padding saved");
  const padAfter = parseFloat(/padding-left:\s*([\d.]+)px/.exec(await styleOf("nav"))?.[1] ?? "0");
  assert(padAfter > padBefore + 10, `padding-left grew: ${padBefore} -> ${padAfter}`);
  assert(history()[0].summary.startsWith("Changed padding"), history()[0].summary);
  await select("nav");
  await until(() => js('!!document.querySelector(\'[data-spacing^="gap:"]\')'), "gap handle again");
  await dragSaved(() => center('[data-spacing^="gap:"]'), { x: 16, y: 0 }, [], "gap saved");
  assert(/column-gap:\s*\d+px/.test(await styleOf("nav")), "column-gap written");
  assert(history()[0].summary.startsWith("Changed gap"), history()[0].summary);

  // Inspector v2 controls on the container: direction, border style, effects.
  const pick = async (selector) => {
    revision = board().contentRevision;
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await until(() => board().contentRevision > revision, "saved " + selector);
  };
  await select("nav");
  // Properties are closed by default; the element bar opens them.
  if (!(await js('!!document.querySelector(".design-inspector")'))) await js('document.querySelector(\'.design-float-bar [aria-label="Properties"]\').click()');
  await until(() => js('!!document.querySelector(".design-inspector [aria-label=Direction]")'), "Layout section for a flex container");
  await pick('.design-inspector [aria-label=Direction] button[aria-label=Column]');
  await until(async () => /flex-direction:\s*column/.test(await styleOf("nav")), "direction written");
  await select("nav");
  await pick('.design-inspector [aria-label="Border style"] button[aria-label=Dashed]');
  await until(async () => /border-style:\s*dashed/.test(await styleOf("nav")), "border style written");
  await select("nav");
  await pick('.design-inspector [aria-label="Add shadow"]');
  await until(async () => /box-shadow:/.test(await styleOf("nav")), "shadow added");
  await until(() => js('!!document.querySelector(".design-inspector [aria-label=\'Remove shadow\']")'), "shadow row");
  fs.writeFileSync(path.join(screenshotDir, "design-inspector.png"), (await w.webContents.capturePage()).toPNG());
  // Per-dimension sizing: the headline hugs its content.
  await select("[data-aegis-node-id=hero]");
  await js('document.querySelector(".design-inspector button[aria-label=\'Width sizing\']").click()');
  await until(() => js('!!document.querySelector(".iv-menu")'), "sizing menu");
  assert((await js('document.querySelector(".iv-menu").textContent')).includes("Fit content"), "menu explains each mode");
  await pick('.iv-menu button:nth-child(1)');
  await until(async () => /width:\s*\d+px/.test(await styleOf("[data-aegis-node-id=hero]")), "Fixed writes a length");
  await select("[data-aegis-node-id=hero]");
  await js('document.querySelector(".design-inspector button[aria-label=\'Width sizing\']").click()');
  await pick('.iv-menu button:nth-child(2)');
  await until(async () => /width:\s*fit-content/.test(await styleOf("[data-aegis-node-id=hero]")), "Hug writes fit-content");

  // N8: ⌘-drag pulls the button out of flow, then it moves freely with constraints.
  await select("main .land");
  await dragSaved(() => screenCenter("main .land"), { x: 30, y: 24 }, ["meta"], "absolute saved");
  let style = await styleOf("main .land");
  assert(/position:\s*absolute/.test(style), "⌘ drag makes it absolute: " + style);
  // Anchored right/bottom (smaller windows, as on CI), the four offsets serialize as the `inset` shorthand.
  const longhands = /(left|right):\s*-?\d+px/.test(style) && /(top|bottom):\s*-?\d+px/.test(style);
  const inset = /inset:\s*(?:auto|-?\d+px)(?:\s+(?:auto|-?\d+px)){3}/.exec(style);
  assert(longhands || (inset && (inset[0].match(/-?\d+px/g) || []).length >= 2), "constraints written: " + style);
  assert(history()[0].summary.startsWith("Made "), history()[0].summary);
  // Without a positioned ancestor the board itself is the containing block.
  const placed = await (await frame()).executeJavaScript('(()=>{const r=document.querySelector("main .land").getBoundingClientRect();return {top:r.top,bottom:r.bottom,h:innerHeight}})()');
  assert(placed.top >= 0 && placed.top < placed.h, "absolute layer stays on the board: " + JSON.stringify(placed));
  await select("main .land");
  await until(() => js('document.querySelector(".design-inspector button[aria-label=Position]")?.textContent==="Absolute"'), "inspector shows Absolute");
  revision = board().contentRevision;
  const from = await screenCenter("main .land");
  w.focus();
  mouse("mouseMove", from);
  mouse("mouseDown", from);
  for (let i = 1; i <= 6; i++) {
    mouse("mouseMove", { x: from.x - 6 * i, y: from.y + 4 * i });
    await wait(45);
  }
  await until(() => js('!!document.querySelector(".design-distance")'), "distance labels while moving");
  fs.writeFileSync(path.join(screenshotDir, "design-absolute.png"), (await w.webContents.capturePage()).toPNG());
  mouse("mouseUp", { x: from.x - 36, y: from.y + 24 });
  await until(() => board().contentRevision > revision, "move saved");
  assert(history()[0].summary.startsWith("Moved "), history()[0].summary);
  style = await styleOf("main .land");
  assert(/position:\s*absolute/.test(style));
  console.log("PASS: inspector direction/border/effects/sizing menu, padding and gap handles, ⌘ drag to absolute, free move with constraints and distances");
};
