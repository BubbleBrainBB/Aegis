const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
exports.run = async ({ w, js, repo, sessionId, documentId, screenshotDir }) => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, label) => { for(let i=0;i<100;i++){if(await fn())return;await wait(40)}throw Error('Interaction timeout: '+label) };
  const read = () => repo.read(sessionId, documentId);
  const view = () => js('(()=>{const d=document.querySelector(".design-viewport").dataset;return {x:+d.viewX,y:+d.viewY,zoom:+d.viewZoom}})()');
  // Boards re-render after each save; wait briefly for the element before measuring it.
  const box = async selector => {for(let i=0;i<60&&!(await js('!!document.querySelector('+JSON.stringify(selector)+')'));i++)await new Promise(r=>setTimeout(r,50));return js('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()')};
  // Points on board content, nudged off comment pins and other canvas chrome left by earlier steps.
  const point = async (selector, fx=.5, fy=.5) => {const b=await box(selector);let p={x:Math.round(b.x+b.width*fx),y:Math.round(b.y+b.height*fy)};if(/\[data-board-id/.test(selector)&&!/ \./.test(selector))for(let i=0;i<6&&await js(`!!document.elementFromPoint(${p.x},${p.y})?.closest('.design-pin,.design-float-bar')`);i++)p={x:p.x,y:p.y+18};return p};
  const mouse = async (type,p,button='left',modifiers=[]) => {w.webContents.sendInputEvent({type,...p,button,clickCount:1,modifiers});await wait(35)};
  const click = async selector => {const p=await point(selector);await mouse('mouseMove',p);await mouse('mouseDown',p);await mouse('mouseUp',p);await wait(100)};
  const focus = () => js('document.querySelector(".design-viewport").focus()');
  const key = async (keyCode,modifiers=[],type='keyDown') => {w.webContents.sendInputEvent({type,keyCode,modifiers});await wait(60)};
  const stroke = async (code,modifiers=[]) => {await key(code,modifiers);await key(code,modifiers,'keyUp')};
  const drag = async (p,q,button='left',cancel=false) => {
    await mouse('mouseMove',p);await mouse('mouseDown',p,button);
    for(let i=1;i<=4;i++)await mouse('mouseMove',{x:Math.round(p.x+(q.x-p.x)*i/4),y:Math.round(p.y+(q.y-p.y)*i/4)},button);
    if(cancel)await stroke('Escape');
    await mouse('mouseUp',q,button);await wait(140);
  };
  const boardSelector = id => '[data-board-id="'+id+'"]';
  const first=read().boards[0], second=read().boards[1];
  const fit = async () => {await focus();await stroke('1',['shift']);await wait(100)};
  w.focus();await wait(200);
  await fit();
  assert.equal(await js('document.querySelector(".design-viewport iframe").tabIndex'),-1);
  assert.equal(await js('getComputedStyle(document.querySelector(".design-viewport iframe")).pointerEvents'),'none');
  let p=await point(boardSelector(first.id),.35,.35);
  let before=await view();
  await mouse('mouseMove',p);
  // Clear selection chrome (toolbars, popovers) that could sit under the pointer;
  // the first synthetic wheel after focus changes is also occasionally dropped.
  await js('document.querySelector(".design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await wait(120);
  let after=before;
  for(let i=0;i<5&&after.y===before.y;i++){await mouse('mouseMove',p);w.webContents.sendInputEvent({type:'mouseWheel',...p,deltaY:-80,deltaX:0,canScroll:true});await wait(150);after=await view()}
  if(after.y===before.y){const info=await js(`(()=>{const e=document.elementFromPoint(${p.x},${p.y});return {tag:e?.tagName,cls:e?.className&&String(e.className).slice(0,80),ui:!!e?.closest('[data-canvas-ui]'),active:document.activeElement?.className&&String(document.activeElement.className).slice(0,60),view:document.querySelector('.design-viewport').dataset,hasFocus:document.hasFocus()}})()`);console.log('WHEEL DEBUG',JSON.stringify(info),JSON.stringify(p));fs.writeFileSync(path.join(screenshotDir,'wheel-fail.png'),(await w.webContents.capturePage()).toPNG())}
  assert.notEqual(after.y,before.y,'wheel over actual board content pans the canvas');
  assert.equal(after.zoom,before.zoom);
  p=await point(boardSelector(first.id),.4,.3);
  const vp=await box('.design-viewport');
  before=await view();
  const world={x:(p.x-vp.x-before.x)/before.zoom,y:(p.y-vp.y-before.y)/before.zoom};
  w.webContents.sendInputEvent({type:'mouseWheel',...p,deltaY:45,deltaX:0,modifiers:['control'],canScroll:true});await wait(150);
  after=await view();
  assert.notEqual(after.zoom,before.zoom,'pinch/control-wheel reaches the canvas over HTML');
  assert(Math.abs((p.x-vp.x-after.x)/after.zoom-world.x)<.05,'zoom anchors X to cursor');
  assert(Math.abs((p.y-vp.y-after.y)/after.zoom-world.y)<.05,'zoom anchors Y to cursor');
  await fit();await focus();
  p=await point(boardSelector(first.id),.3,.3);
  const revision=read().revision;before=await view();
  await key('Space');await drag(p,{x:p.x+60,y:p.y+40});await key('Space',[],'keyUp');
  after=await view();assert.equal(Math.round(after.x-before.x),60);assert.equal(Math.round(after.y-before.y),40);
  assert.equal(read().revision,revision,'Space pan never moves a board in storage');
  assert(!(await js('document.querySelector(".design-viewport").classList.contains("is-pan")')),'space release resets hand');
  p=await point(boardSelector(first.id),.3,.3);before=await view();
  await drag(p,{x:p.x-35,y:p.y+20},'middle');after=await view();
  assert.equal(Math.round(after.x-before.x),-35);assert.equal(read().revision,revision);
  // Start from a clean selection: a selected element would make this an element drag.
  await js('document.querySelector(".design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await wait(300);
  await fit();
  // As in Figma, the body of an unselected board picks layers; select the board by its label first.
  await click(boardSelector(first.id)+' .design-board-label');
  p=await point(boardSelector(first.id),.3,.3);before=await view();
  const original=read().boards[0];
  await drag(p,{x:p.x+40,y:p.y+30});
  await until(()=>read().boards[0].placementRevision>original.placementRevision,'body drag persisted');
  let moved=read().boards[0];
  assert(Math.abs(moved.x-original.x-40/before.zoom)<2,'drag converts screen pixels to world units');
  assert(Math.abs(moved.y-original.y-30/before.zoom)<2);
  assert.equal(moved.contentRevision,original.contentRevision,'placement leaves generated HTML intact');
  const cancelRevision=read().revision;
  p=await point(boardSelector(first.id),.3,.3);
  await drag(p,{x:p.x+60,y:p.y+20},'left',true);
  assert.equal(read().revision,cancelRevision,'Escape cancels the drag without a write');
  // Direct resize handle, bounded by the repository contract.
  await fit();await click(boardSelector(first.id)+' .design-board-label');
  p=await point('.handle-se');before=await view();
  const resizeBefore=read().boards[0];
  await drag(p,{x:p.x+25,y:p.y+20});
  await until(()=>read().boards[0].width!==resizeBefore.width,'resize persisted');
  moved=read().boards[0];assert(moved.width>resizeBefore.width);assert(moved.height>resizeBefore.height);
  assert.equal(moved.x,resizeBefore.x);assert.equal(moved.contentRevision,resizeBefore.contentRevision);
  // Marquee starts on empty canvas and selects both boards.
  await fit();await stroke('Escape');
  const r1=await box(boardSelector(first.id)),r2=await box(boardSelector(second.id)),vpr=await box('.design-viewport');
  const start={x:Math.round(Math.min(r1.x,r2.x)-15),y:Math.round(Math.min(r1.y,r2.y)-35)};
  const end={x:Math.min(Math.round(vpr.x+vpr.width-5),Math.round(Math.max(r1.x+r1.width,r2.x+r2.width)+15)),y:Math.min(Math.round(vpr.y+vpr.height-5),Math.round(Math.max(r1.y+r1.height,r2.y+r2.height)+10))};
  await drag(start,end);assert.equal(await js('document.querySelectorAll(".design-board.is-selected").length'),2,'marquee selects boards');
  const groupBefore=read().boards.map(b=>({x:b.x,y:b.y}));
  p=await point(boardSelector(first.id),.3,.3);before=await view();
  await drag(p,{x:p.x+20,y:p.y+15});
  await until(()=>read().boards[1].x!==groupBefore[1].x,'multi-selection moves atomically');
  const groupAfter=read().boards;
  assert.equal(groupAfter[0].x-groupBefore[0].x,groupAfter[1].x-groupBefore[1].x);
  assert.equal(groupAfter[0].y-groupBefore[0].y,groupAfter[1].y-groupBefore[1].y);
  // Zoom shortcuts and preview return to the exact same canvas view.
  await focus();await stroke('0',['shift']);assert.equal((await view()).zoom,1);await fit();
  const saved=await view();
  await click(boardSelector(first.id)+' .design-board-preview');
  await until(()=>js('!!document.querySelector(".design-board-preview-overlay")'),'preview');
  await stroke('Escape');
  await until(()=>js('!document.querySelector(".design-board-preview-overlay")'),'return from preview');
  assert.deepEqual(await view(),saved,'preview never destroys canvas position');
  // Use the actual host -> sandbox hit-test bridge, with canvas-owned pointers.
  await fit();await click('[aria-label="Comment mode"]');
  const htmlFrame=w.webContents.mainFrame.framesInSubtree.find(f=>f.url==='about:srcdoc');
  const h=await htmlFrame.executeJavaScript('(()=>{const r=document.querySelector("h1").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  const brect=await box(boardSelector(first.id));const z=(await view()).zoom;
  p={x:Math.round(brect.x+h.x*z),y:Math.round(brect.y+h.y*z)};
  await mouse('mouseMove',p);await mouse('mouseDown',p);await mouse('mouseUp',p);
  await until(()=>js('!!document.querySelector(".design-selection")'),'element hit test');
  await until(()=>js('!!document.querySelector(".design-composer textarea")'),'comment mode opens the composer on the element');
  await js('document.querySelector(".design-composer textarea").focus()');const typedRevision=read().revision;
  await stroke('Backspace');assert.equal(read().revision,typedRevision,'typing in a comment never deletes a board');
  await js('document.querySelector(".design-composer textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await until(()=>js('!document.querySelector(".design-composer")'),'Escape closes the composer');
  await click('[aria-label="Select and move"]');
  // A single click selects text with resize handles; it never opens the editor.
  await js('document.querySelector(".design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await until(()=>js('!document.querySelector(".design-selection")'),'selection cleared');
  await mouse('mouseMove',p);await mouse('mouseDown',p);await mouse('mouseUp',p);
  await until(()=>js('!!document.querySelector(".design-selection [data-element-resize]")'),'single click shows resize handles');
  await wait(300);assert(!(await js('!!document.querySelector(".design-inline-text")')),'single click does not edit text');
  // Double-clicking text edits it in place; Escape without changes saves nothing.
  {const before=read().revision;
  for(const clickCount of [1,2]){w.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount,...p});w.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount,...p});await wait(60)}
  await until(()=>js('!!document.querySelector(".design-inline-text")'),'double-click edits text in place');
  assert((await js('document.querySelector(".design-inline-text").textContent')).includes('Some places'));
  assert.equal(await js('getSelection().isCollapsed'),true,'double-click places a caret, nothing is preselected');
  fs.writeFileSync(path.join(screenshotDir,'design-inline-text.png'),(await w.webContents.capturePage()).toPNG());
  await js('document.querySelector(".design-inline-text").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await until(()=>js('!document.querySelector(".design-inline-text")'),'editor closes');assert.equal(read().revision,before,'unchanged text is not saved');}
  // Clicking the page background selects the board itself.
  {const bg=await htmlFrame.executeJavaScript('(()=>{for(let y=innerHeight-4;y>0;y-=8)for(let x=4;x<innerWidth;x+=8){const e=document.elementFromPoint(x,y);if(e===document.body||e===document.documentElement)return {x,y}}})()');
  assert(bg,'board has visible page background');
  const br=await box(boardSelector(first.id)),bz=(await view()).zoom,q={x:Math.round(br.x+bg.x*bz),y:Math.round(br.y+bg.y*bz)};
  await mouse('mouseMove',q);await mouse('mouseDown',q);await mouse('mouseUp',q);
  await until(()=>js('!document.querySelector(".design-selection")&&document.querySelector('+JSON.stringify(boardSelector(first.id))+').classList.contains("is-selected")'),'background click selects the board');}
  await fit();
  // Read-only sessions may navigate/select but cannot mutate through canvas input.
  await js('qa.store.setState(s=>({sessions:{...s.sessions,[qa.a]:{...s.sessions[qa.a],readOnly:true}}}))');
  p=await point(boardSelector(first.id),.3,.3);await drag(p,{x:p.x+40,y:p.y+30});
  assert.equal(read().revision,typedRevision,'read-only drag is rejected');
  await js('qa.store.setState(s=>({sessions:{...s.sessions,[qa.a]:{...s.sessions[qa.a],readOnly:false}}}))');
  // Switch chats before the debounced viewport save fires.
  await js('document.querySelector(".design-viewport").dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,deltaY:37}))');
  const departing = await view();
  await js('qa.store.getState().setActiveSession(qa.b);qa.store.getState().openRightUtilityTab("design")');
  await until(()=>js('!!document.querySelector(".design-library")'),'leave canvas');
  await js('qa.store.getState().setActiveSession(qa.a)');
  await until(()=>js('!!document.querySelector(".design-viewport")'),'restore canvas');
  assert.deepEqual(await view(),departing,'immediate chat switch preserves viewport');
  await fit();await wait(200);
  fs.writeFileSync(path.join(screenshotDir,'design-interactions.png'),(await w.webContents.capturePage()).toPNG());
  console.log('PASS: native wheel/pinch over HTML, anchored zoom, Space/middle pan, body drag, Escape cancel, resize, marquee/group drag, shortcuts, preview return, element hit test and readonly/input guards');
};
