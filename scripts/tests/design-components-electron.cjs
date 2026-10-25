const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
// Design components on the real canvas: logic renders, edit mode stays inert,
// a saved change re-renders in place, Play responds and follows board links,
// logic errors show on the board, and a hung board falls back to static.
exports.run = async ({ w, js, repo, sessionId, documentId, screenshotDir }) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, label, tries = 160) => {
    for (let i = 0; i < tries; i++) {
      if (await Promise.resolve().then(fn).catch(() => false)) return;
      await wait(50);
    }
    throw Error("Design components timeout: " + label);
  };
  const doc = () => repo.read(sessionId, documentId);
  const write = (id, operations) => repo.update(sessionId, { documentId, operationId: id, operations }, undefined, { kind: "user", name: "QA" });
  const PLANS = `<!doctype html><html><head><style>body{font:16px system-ui;margin:0}main{padding:32px}.plan{padding:12px;border:1px solid #ddd;margin:4px 0}.plan.on{border-color:#2e5bff;color:#2e5bff}</style></head><body><main data-aegis-node-id="plans-main">
<h1 data-aegis-node-id="plans-title">{{ heading }}</h1>
<div data-aegis-node-id="plan" class="plan {{ i === picked ? 'on' : '' }}" data-aegis-for="(p, i) in plans" data-aegis-on-click="pick(i)">{{ p }}</div>
<a data-aegis-node-id="to-checkout" data-aegis-goto="Checkout">Continue</a>
</main></body></html>`;
  write("components-add", [
    { type: "add", name: "Plans", x: 0, y: 1400, width: 600, height: 400, html: PLANS, js: "class Board extends AegisBoard { state = { picked: 0 }; pick(i) { this.setState({ picked: i }); } }", props: { heading: { type: "string", default: "Choose a plan" }, plans: { type: "list", default: ["Monthly", "Yearly", "Team"] } } },
    { type: "add", name: "Checkout", x: 700, y: 1400, width: 600, height: 400, html: '<main data-aegis-node-id="checkout"><h1>Checkout</h1></main>' },
  ]);
  const plans = () => doc().boards.find((b) => b.name === "Plans");
  // A hung board's frame never answers: every frame call is raced against a timeout.
  const ask = (fr, code) => Promise.race([fr.executeJavaScript(code), new Promise((_, no) => setTimeout(() => no(Error("frame busy")), 1000))]);
  const frames = () =>
    w.webContents.mainFrame.framesInSubtree
      .filter((f) => f.url === "about:srcdoc")
      .map((fr) => ({ executeJavaScript: (code) => ask(fr, code) }));
  const started = Date.now();
  const step = (label) => console.log("  components:", label, `${Date.now() - started}ms`, `uptime ${Math.round(process.uptime())}s`);
  // The canvas frame (edit mode) holding the Plans board.
  const plansFrame = async () => {
    for (const f of frames()) {
      const hit = await f.executeJavaScript(`!!document.querySelector('[data-aegis-node-id="plans-title"]') && window.__aegisRuntime?.mode !== "play"`).catch(() => false);
      if (hit) return f;
    }
    return null;
  };
  // Rendered by the runtime: loop instances keep their template layer id.
  await until(async () => (await (await plansFrame())?.executeJavaScript('document.querySelectorAll("[data-aegis-node-id=plan]").length')) === 3, "plans render");
  step("render");
  const f = await plansFrame();
  assert.equal(await f.executeJavaScript('document.querySelector("[data-aegis-node-id=plans-title]").textContent'), "Choose a plan");
  assert.equal(await f.executeJavaScript('document.body.textContent.includes("{{")'), false, "no raw template text");
  assert.deepEqual(await f.executeJavaScript('[...document.querySelectorAll("[data-aegis-node-id=plan]")].map(e=>e.dataset.aegisInstance)'), ["0", "1", "2"]);
  // Edit mode: the canvas owns input; a click in the frame does not run the board's handlers.
  await f.executeJavaScript('document.querySelectorAll("[data-aegis-node-id=plan]")[2].click()');
  await wait(100);
  assert.equal(await f.executeJavaScript('document.querySelectorAll(".plan.on").length'), 1);
  assert.equal(await f.executeJavaScript('document.querySelector(".plan.on").textContent'), "Monthly", "edit mode is inert");
  // A saved change re-renders in place (no new frame).
  const before = plans();
  write("components-rename", [{ type: "props", boardId: before.id, expectedRevision: before.contentRevision, props: { heading: { type: "string", default: "Pick your plan" }, plans: { type: "list", default: ["Monthly", "Yearly", "Team", "Enterprise"] } } }]);
  await until(async () => (await f.executeJavaScript('document.querySelector("[data-aegis-node-id=plans-title]")?.textContent')) === "Pick your plan", "props update");
  assert.equal(await f.executeJavaScript('document.querySelectorAll("[data-aegis-node-id=plan]").length'), 4);
  if (screenshotDir) fs.writeFileSync(path.join(screenshotDir, "design-components-canvas.png"), (await w.webContents.capturePage()).toPNG());

  step("play");
  // Play: handlers run, and a board link opens the target board.
  await js(`document.querySelector('[data-board-id="${plans().id}"] .design-board-preview').click()`);
  await until(() => js('!!document.querySelector(".design-board-preview-overlay")'), "play opens");
  const playFrame = async () => {
    for (const fr of frames())
      if (await fr.executeJavaScript('window.__aegisRuntime?.mode==="play" && !!document.querySelector("[data-aegis-node-id=plans-title]")').catch(() => false)) return fr;
    return null;
  };
  await until(async () => !!(await playFrame()), "play frame");
  const pf = await playFrame();
  await until(() => pf.executeJavaScript('document.querySelectorAll("[data-aegis-node-id=plan]").length===4'), "play render");
  await pf.executeJavaScript('document.querySelectorAll("[data-aegis-node-id=plan]")[1].click()');
  await until(() => pf.executeJavaScript('document.querySelector(".plan.on")?.textContent==="Yearly"'), "play click runs the handler");
  await pf.executeJavaScript('document.querySelector("[data-aegis-node-id=to-checkout]").click()');
  await until(() => js('document.querySelector(".design-board-preview-overlay strong")?.textContent==="Checkout"'), "board link navigates");
  if (screenshotDir) fs.writeFileSync(path.join(screenshotDir, "design-components-play.png"), (await w.webContents.capturePage()).toPNG());
  await js('[...document.querySelectorAll(".design-board-preview-overlay button")].find(b=>b.textContent.includes("Back to canvas")).click()');
  await until(() => js('!document.querySelector(".design-board-preview-overlay")'), "back to canvas");

  step("props panel");
  // The board inspector edits props by hand; the canvas re-renders from them.
  await js(`document.querySelector('[data-board-id="${plans().id}"] .design-board-label').click()`);
  if (await js('!!document.querySelector(\'[aria-label="Show inspector"]\')')) await js('document.querySelector(\'[aria-label="Show inspector"]\').click()');
  await until(() => js('!!document.querySelector(\'.design-inspector [aria-label="Prop heading"]\')'), "props panel shows");
  assert.equal(await js('document.querySelector(\'.design-inspector [aria-label="Prop heading"]\').value'), "Pick your plan");
  // As the layers test does: set the value, then the focusout React's onBlur listens to.
  w.focus();
  await js(`(()=>{const el=document.querySelector('.design-inspector [aria-label="Prop heading"]');el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'Plans for teams');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new FocusEvent('focusout',{bubbles:true}))})()`);
  await until(() => /Plans for teams/.test(plans().html), "prop edit saved");
  await until(() => f.executeJavaScript('document.querySelector("[data-aegis-node-id=plans-title]")?.textContent==="Plans for teams"'), "prop edit re-renders");
  assert.match(await js('document.querySelector(".design-logic summary")?.textContent||""'), /Logic · \d+ lines/);
  if (await js('!!document.querySelector(\'[aria-label="Hide inspector"]\')')) await js('document.querySelector(\'[aria-label="Hide inspector"]\').click()');
  step("error badge");
  // A logic error shows on the board.
  let b = plans();
  write("components-broken", [{ type: "logic_patch", boardId: b.id, expectedRevision: b.contentRevision, find: "pick(i) {", replace: "pick(i) { this.missing.call(); } values() { return { heading: nope.deep }; } other(i) {" }]);
  await until(() => js(`document.querySelector('[data-board-id="${plans().id}"] .design-board-issue')?.textContent==="Logic error"`), "logic error badge");
  step("watchdog");
  // A board whose logic never yields falls back to its static template.
  b = plans();
  write("components-hang", [{ type: "logic", boardId: b.id, expectedRevision: b.contentRevision, js: "class Board extends AegisBoard { mounted() { setTimeout(() => { for (;;) {} }, 50); } }" }]);
  await until(() => js(`document.querySelector('[data-board-id="${plans().id}"] .design-board-issue')?.textContent==="Logic paused"`), "watchdog", 400);
  await until(async () => {
    for (const fr of frames())
      if (await fr.executeJavaScript('!!document.querySelector("[data-aegis-node-id=plans-title]") && !window.__aegisRuntime').catch(() => false)) return true;
    return false;
  }, "static fallback frame");
  // The stuck sandbox process is gone: every other board answers again.
  await until(async () => {
    const answers = await Promise.all(frames().map((fr) => fr.executeJavaScript("1").catch(() => 0)));
    return answers.length >= 3 && answers.every((x) => x === 1);
  }, "other boards recover");
  step("recovery");
  // Fixing the logic brings the runtime back.
  b = plans();
  write("components-fixed", [{ type: "logic", boardId: b.id, expectedRevision: b.contentRevision, js: "class Board extends AegisBoard { state = { picked: 1 } }" }]);
  await until(() => js(`!document.querySelector('[data-board-id="${plans().id}"] .design-board-issue')`), "issue clears");
  await until(async () => {
    for (const fr of frames())
      if (await fr.executeJavaScript('window.__aegisRuntime && document.querySelector(".plan.on")?.textContent==="Yearly"').catch(() => false)) return true;
    return false;
  }, "runtime back");
  step("deck");
  // A deck: one slide on the canvas, ‹ › in its label, slides in Play, presenter view with notes.
  write("deck-add", [{ type: "add", name: "Pitch", x: 1400, y: 1400, width: 640, height: 360, html: '<!doctype html><html><head><style>html,body,main{margin:0;height:100%}section{height:100%;display:flex;align-items:center;justify-content:center;font:48px system-ui}</style></head><body><main data-aegis-deck><section data-aegis-slide data-aegis-notes="Welcome everyone"><h1>Hello</h1></section><section data-aegis-slide data-aegis-notes="The ask"><h1>The ask</h1></section></main></body></html>' }]);
  const pitch = () => doc().boards.find((b) => b.name === "Pitch");
  await until(() => js(`document.querySelector('[data-board-id="${pitch().id}"] .design-deck-nav [aria-label=Slide]')?.textContent==="1 / 2"`), "deck nav");
  const pitchFrame = async () => {
    for (const fr of frames())
      if (await fr.executeJavaScript('!!document.querySelector("[data-aegis-deck]") && !document.querySelector(".design-board-preview-overlay")').catch(() => false)) return fr;
    return null;
  };
  const visibleSlides = (fr) => fr.executeJavaScript('[...document.querySelectorAll("[data-aegis-slide]")].map(s=>getComputedStyle(s).display!=="none")');
  await until(async () => JSON.stringify(await visibleSlides(await pitchFrame())) === "[true,false]", "first slide shows");
  await js(`document.querySelector('[aria-label="Next slide of Pitch"]').click()`);
  await until(async () => JSON.stringify(await visibleSlides(await pitchFrame())) === "[false,true]", "next slide on the canvas");
  await js(`document.querySelector('[data-board-id="${pitch().id}"] .design-board-preview').click()`);
  await until(() => js('document.querySelector(".design-board-preview-overlay [aria-label=Slide]")?.textContent==="Slide 1 / 2"'), "play starts at slide 1");
  await js('document.querySelector(".design-board-preview-overlay [aria-label=\'Next slide\']").click()');
  await until(() => js('document.querySelector(".design-board-preview-overlay [aria-label=Slide]")?.textContent==="Slide 2 / 2"'), "play steps slides");
  await js('[...document.querySelectorAll(".design-board-preview-overlay button")].find(b=>b.textContent.includes("Presenter view")).click()');
  await until(() => js('document.querySelector(".design-presenter-notes p")?.textContent==="The ask"'), "presenter shows notes");
  await wait(400); // let the compositor paint the presenter before capturing
  if (screenshotDir) fs.writeFileSync(path.join(screenshotDir, "design-deck-presenter.png"), (await w.webContents.capturePage()).toPNG());
  await js('[...document.querySelectorAll(".design-board-preview-overlay button")].find(b=>b.textContent.includes("Back to canvas")).click()');
  step("images");
  // An image dropped on a board becomes an image layer there; dropped off the boards, a new board; pasted, too.
  const makePng = (color) => `(async()=>{const c=document.createElement('canvas');c.width=60;c.height=40;const x=c.getContext('2d');x.fillStyle='${color}';x.fillRect(0,0,60,40);const blob=await new Promise(r=>c.toBlob(r,'image/png'));return new File([blob],'${color.slice(1)}.png',{type:'image/png'})})()`;
  const checkout = () => doc().boards.find((b) => b.name === "Checkout");
  const checkoutRevision = checkout().contentRevision;
  await js(`(async()=>{const f=await ${makePng("#ff0000")};const dt=new DataTransfer();dt.items.add(f);const b=document.querySelector('[data-board-id="${checkout().id}"]').getBoundingClientRect();const v=document.querySelector('.design-viewport');v.dispatchEvent(new DragEvent('dragover',{dataTransfer:dt,bubbles:true,cancelable:true,clientX:b.x+b.width/2,clientY:b.y+b.height/2}));v.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true,clientX:b.x+b.width/2,clientY:b.y+b.height/2}))})()`);
  await until(() => checkout().contentRevision > checkoutRevision && /<img[^>]*src="aegis-asset:img_/.test(checkout().html), "dropped image becomes a layer");
  await until(async () => {
    for (const fr of frames())
      if (await fr.executeJavaScript('(()=>{const i=document.querySelector("img[alt=ff0000]");return !!i && i.complete && i.naturalWidth===60})()').catch(() => false)) return true;
    return false;
  }, "the image renders on the canvas");
  const boardsBefore = doc().boards.length;
  await js(`(async()=>{const f=await ${makePng("#00ff00")};const dt=new DataTransfer();dt.items.add(f);const v=document.querySelector('.design-viewport');const r=v.getBoundingClientRect();const boards=[...document.querySelectorAll('[data-board-id]')].map((b)=>b.getBoundingClientRect());let at=null;for(let y=r.bottom-8;y>r.y&&!at;y-=24)for(let x=r.x+8;x<r.right;x+=24)if(!boards.some((b)=>x>=b.left-4&&x<=b.right+4&&y>=b.top-4&&y<=b.bottom+4)&&v.contains(document.elementFromPoint(x,y))){at={x,y};break}if(!at)throw new Error('no empty canvas point');v.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true,clientX:at.x,clientY:at.y}))})()`);
  await until(() => doc().boards.length === boardsBefore + 1 && doc().boards.some((b) => b.name === "00ff00"), "dropped off the boards: a new board");
  const sized = doc().boards.find((b) => b.name === "00ff00");
  assert.deepEqual([sized.width, sized.height], [200, 133], "a new board takes the image's shape (at least 200 wide)");
  await js(`(async()=>{const f=await ${makePng("#0000ff")};const dt=new DataTransfer();dt.items.add(f);document.querySelector('.design-viewport').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}))})()`);
  await until(() => doc().boards.some((b) => b.name === "0000ff" || /alt="0000ff"/.test(b.html)), "a pasted image lands").catch((e) => {
    console.log("  paste debug", JSON.stringify(doc().boards.map((b) => [b.name, (b.html.match(/alt="[0-9a-f]+"/g) || []).join(" ")])));
    throw e;
  });
  console.log("PASS design components on canvas: runtime render with layer ids, inert edit mode, in-place props update, props panel edits, Play handlers, board links, logic error badge, watchdog static fallback and recovery, deck slides on canvas and in Play, presenter notes, dropped and pasted images");
};
