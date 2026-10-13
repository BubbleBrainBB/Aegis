const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
exports.run = async ({ w, js, repo, sessionId, documentId, screenshotDir }) => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, label) => {
    for (let i = 0; i < 120; i++) {
      if (await fn()) return;
      await delay(50);
    }
    throw Error("Layers timeout: " + label);
  };
  const read = () => repo.read(sessionId, documentId);
  const boardId = read().boards[0].id;
  const board = () => read().boards.find((b) => b.id === boardId);
  const click = async (selector) => {
    w.focus();
    await js(
      `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`,
    );
    await delay(80);
    const p = await js(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
    );
    w.webContents.sendInputEvent({ type: "mouseMove", ...p });
    w.webContents.sendInputEvent({
      type: "mouseDown",
      button: "left",
      clickCount: 1,
      ...p,
    });
    w.webContents.sendInputEvent({
      type: "mouseUp",
      button: "left",
      clickCount: 1,
      ...p,
    });
    await delay(150);
  };
  const field = (label, property) =>
    js(
      `document.querySelector(${JSON.stringify('[aria-label="' + label + '"]')}).${property}`,
    );
  const tree = '[data-layer-id="hero"]';
  // ⌥L toggles the layer tree (it shares the Properties panel).
  const optionL = async () => {
    await js('document.querySelector(".design-viewport").focus()');
    w.webContents.sendInputEvent({ type: "keyDown", keyCode: "L", modifiers: ["alt"] });
    w.webContents.sendInputEvent({ type: "keyUp", keyCode: "L", modifiers: ["alt"] });
  };
  const layersShown = () => js('!!document.querySelector(".design-layers-popover")');
  if (await layersShown()) {
    await optionL();
    await until(async () => !(await layersShown()), "Option-L closes layers");
  }
  await optionL();
  await until(layersShown, "Option-L opens layers");
  await click(tree + " .design-layer-name");
  await until(
    () => js('!!document.querySelector(".design-selection")'),
    "tree selects actual rendered element",
  );
  assert.equal(
    await js(
      'document.querySelector("[data-layer-id=hero]").getAttribute("aria-selected")',
    ),
    "true",
  );
  assert(
    await field("Layer font-size", "placeholder.length > 0"),
    "computed CSS reaches inspector",
  );
  // Name, content and layer actions live under Advanced.
  await js('(()=>{const b=document.querySelector(".iv-adv-toggle");if(b.getAttribute("aria-expanded")!=="true")b.click()})()');
  await until(() => js('!!document.querySelector(\'[aria-label="Layer text"]\')'), "Advanced opens");
  const setField = async (label, value) => {
    // blur() only reaches React's onBlur when the window really has focus.
    w.focus();
    const revision = board().contentRevision;
    await js(
      `(()=>{const el=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');el.focus();Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new FocusEvent('focusout',{bubbles:true}))})()`,
    );
    await until(() => board().contentRevision > revision, label + " persisted");
    await until(
      async () => !(await field("Layer name", "disabled")),
      "selection refreshed after write",
    );
    await delay(100);
  };
  await setField("Layer text", "A layer you can edit");
  assert(board().html.includes("A layer you can edit"));
  await setField("Layer color", "#c05050");
  assert(board().html.includes("color: rgb(192, 80, 80) !important"));
  await setField("Layer name", "Hero title");
  assert(board().html.includes('data-aegis-layer-name="Hero title"'));
  const frame = () =>
    w.webContents.mainFrame.framesInSubtree.find(
      (f) => f.url === "about:srcdoc",
    );
  await until(
    async () =>
      (await frame().executeJavaScript(
        'document.querySelector("h1").textContent',
      )) === "A layer you can edit",
    "text rendered",
  );
  assert.equal(
    await frame().executeJavaScript(
      'getComputedStyle(document.querySelector("h1")).color',
    ),
    "rgb(192, 80, 80)",
  );
  await click('[aria-label="Hide Hero title"]');
  await until(
    () => board().html.includes('data-aegis-hidden="true"'),
    "hidden persisted",
  );
  await delay(250);
  assert.equal(
    await frame().executeJavaScript(
      'getComputedStyle(document.querySelector("h1")).display',
    ),
    "none",
  );
  await click('[aria-label="Show Hero title"]');
  await delay(250);
  await click('[aria-label="Lock Hero title"]');
  await until(
    () => board().html.includes('data-aegis-locked="true"'),
    "lock persisted",
  );
  await until(
    () => field("Layer text", "disabled"),
    "locked inspector disabled",
  );
  const lockedRevision = board().contentRevision;
  await js('document.querySelector(".design-viewport").focus()');
  w.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
  w.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
  await delay(200);
  assert.equal(
    board().contentRevision,
    lockedRevision,
    "locked keyboard delete cannot mutate",
  );
  assert.equal(read().boards.length, 2, "layer delete never deletes board");
  await click('[aria-label="Unlock Hero title"]');
  await until(async () => !(await field("Layer text", "disabled")), "unlock");
  await js('document.querySelector(".design-viewport").focus()');
  let previous = board().contentRevision;
  w.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
  w.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
  await until(() => board().contentRevision > previous, "layer nudge");
  assert(board().html.includes("left: 1px !important"), "nudge edits element");
  await until(
    async () => !(await field("Layer text", "disabled")),
    "after nudge",
  );
  const initialCount = await js(
    'document.querySelectorAll(".design-layer-tree [data-layer-id]").length',
  );
  previous = board().contentRevision;
  await js(
    '[...document.querySelectorAll("button")].find(b=>b.textContent==="Duplicate layer").click()',
  );
  await until(() => board().contentRevision > previous, "duplicate layer");
  await until(
    async () =>
      (await js(
        'document.querySelectorAll(".design-layer-tree [data-layer-id]").length',
      )) ===
      initialCount + 1,
    "duplicate in tree",
  );
  await until(
    async () => !(await field("Layer text", "disabled")),
    "after duplicate",
  );
  await js('document.querySelector(".design-viewport").focus()');
  previous = board().contentRevision;
  w.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
  w.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
  await until(
    () => board().contentRevision > previous,
    "delete selected layer",
  );
  assert(!board().html.includes('data-aegis-node-id="hero"'));
  assert.equal(read().boards.length, 2);
  // Select the copied title and capture the inspector with the live element.
  await js(
    '[...document.querySelectorAll(".design-layer-name")].find(b=>b.title==="Hero title").click()',
  );
  await delay(350);
  fs.writeFileSync(
    path.join(screenshotDir, "design-layers.png"),
    (await w.webContents.capturePage()).toPNG(),
  );
  // Color fields carry a picker; text layers edit in place on the canvas.
  await until(
    () => js('!!document.querySelector(\'[aria-label="Color color picker"]\')'),
    "color picker beside the text color",
  );
  // The tree lives in the Properties panel now: hide the panel to get it out of the way.
  await click('[aria-label="Hide inspector"]');
  await js('document.querySelector(".design-viewport").focus()');
  w.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  w.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  await until(
    () => js('!!document.querySelector(".design-inline-text")'),
    "Enter edits the selected text in place",
  );
  assert.equal(
    await js('document.querySelector(".design-inline-text").textContent'),
    "A layer you can edit",
  );
  const masked = w.webContents.mainFrame.framesInSubtree.filter((f) => f.url === "about:srcdoc");
  assert(
    (
      await Promise.all(
        masked.map((f) =>
          f.executeJavaScript('!!document.querySelector("[data-aegis-masked]")'),
        ),
      )
    ).some(Boolean),
    "original text is hidden under the editor",
  );
  previous = board().contentRevision;
  await js(
    '(()=>{const el=document.querySelector(".design-inline-text");el.textContent="Edited on canvas";el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))})()',
  );
  await until(() => board().contentRevision > previous, "in-place text persisted");
  assert(board().html.includes("Edited on canvas"));
  assert(!(await js('!!document.querySelector(".design-inline-text")')), "editor closes");
  console.log(
    "PASS: native tree selection, computed properties, text/style/name persistence, hide/show, lock guards, layer nudge/duplicate/delete, board preservation, color pickers and in-place text editing",
  );
};
