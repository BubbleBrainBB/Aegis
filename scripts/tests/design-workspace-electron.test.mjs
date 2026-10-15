// The Design section in the full app: the rail switches to it, its sidebar
// lists designs by project, the canvas fills the main area with its toolbar in
// the title bar, and the design's conversation floats as a dock that shows the
// chat, minimizes to a pill and snaps to the corner it is dragged to. A new
// design follows its draft chat when the chat starts and opens the canvas the
// agent creates; "Open as a chat" shows the design beside its chat instead.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const tmp = await mkdtemp(path.join(root, '.aegis-design-qa/workspace-'));
const capture = path.join(root, 'output/playwright/design-workspace');

const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AppearancePreferences} from '/src/ui/components/AppearancePreferences';
import {App} from '/src/ui/App';
import {useAppStore} from '/src/ui/store/useAppStore';
import {useDesignStore,openDesign} from '/src/ui/store/useDesignStore';
import '/src/ui/index.css';
window.addEventListener('blur',e=>e.stopImmediatePropagation(),true);
window.qa={app:useAppStore,design:useDesignStore,openDesign,seed(){
 const a=useAppStore.getState();const draft=a.createDraftSession('/projects/coworker');const base=useAppStore.getState().sessions[draft];
 const now=Date.now();
 const rows=[['s1','Atlas landing page','workflow-test'],['s2','Check Git Status Result','coworker']];
 useAppStore.setState({connected:true,sessionsLoaded:true,activeSessionId:'s2',sessions:Object.fromEntries(rows.map(([id,title,project],i)=>[id,{...base,id,isDraft:false,title,cwd:'/projects/'+project,projectCwd:'/projects/'+project,provider:'claude',messages:[],permissionRequests:[],status:'idle',envMode:'local',worktreePath:null,hydrated:true,updatedAt:now-i*60000,createdAt:now-i*60000-1000}]))});
}};
createRoot(document.getElementById('root')).render(<AppearancePreferences><App/></AppearancePreferences>);
`;

const main = String.raw`
const {app,BrowserWindow,ipcMain,nativeTheme}=require('electron');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
const root=process.env.QA_ROOT;const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 ipcMain.on('get-ui-resume-state-sync',e=>{e.returnValue=null});ipcMain.on('renderer-state:get-all-sync',e=>{e.returnValue={'aegis-onboarding-complete':'1'}});ipcMain.on('save-ui-resume-state-sync',e=>{e.returnValue=true});
 ipcMain.on('renderer-state:set',()=>{});ipcMain.handle('set-theme',()=>{});
 ipcMain.handle('get-session-organization',()=>({sessions:{},sections:[],projectSources:{}}));
 ipcMain.handle('list-sidebar-pull-requests',()=>({}));
 ipcMain.handle('get-agent-runtime-directory',()=>({entries:[],readyCount:1,checkedAt:Date.now()}));
 ipcMain.handle('get-user-profile',()=>({displayName:'Chengsheng',handle:'chengsheng'}));
 const {registerDesignIpc}=require(path.join(root,'dist-electron/electron/design/ipc.js'));
 const {createNativeDesignTools,setDesignPromptSource}=require(path.join(root,'dist-electron/electron/design/tools.js'));
 const {getDesignComposerPrefs}=require(path.join(root,'dist-electron/electron/design/focus.js'));
 registerDesignIpc();
 // Quick edits answer from a stand-in model: a rewrite, or a handoff on request.
 const {setQuickEditModel}=require(path.join(root,'dist-electron/electron/design/quick-edit.js'));
 setQuickEditModel(async({prompt})=>/second board/.test(prompt)?'HANDOFF: needs a new board':prompt.replace(/[\s\S]*?(<h1[^>]*>)/,'$1').replace(/<\/h1>[\s\S]*/,'</h1>').replace('style="','style="letter-spacing: -1px; '));
 const sent=[];ipcMain.on('client-event',(_e,event)=>sent.push(typeof event==='string'?JSON.parse(event):event));
 setDesignPromptSource((sessionId)=>sessionId==='s1'?{prompt:'Design a landing page for Atlas',id:'s1:1'}:undefined);
 const repoRead=()=>require(path.join(root,'dist-electron/electron/design/service.js')).getDesignRepository().read('s1',atlasId());
 let atlasRef=null;const atlasId=()=>atlasRef;
 const call=async(sessionId,name,args)=>{const r=await createNativeDesignTools(sessionId).find(t=>t.name===name).execute(args,{});assert(!r.isError,r.content);return JSON.parse(r.content)};
 const page=(title,bg)=>'<main style="padding:48px;background:'+bg+';font-family:Georgia;min-height:100%"><p style="font:11px system-ui;letter-spacing:2px">NOTES · REIMAGINED</p><h1 style="font-size:56px;font-weight:400;margin:20px 0">'+title+'</h1><p style="font:15px system-ui;color:#555">Write freely. Atlas links what you write to what you already know.</p></main>';
 const atlas=await call('s1','design_create',{title:'Atlas website',operationId:'c1'});
 atlasRef=atlas.id;
 await call('s1','design_update',{documentId:atlas.id,operationId:'u1',operations:[{type:'add',name:'Home',width:1440,height:900,html:page('Notes that think along with you.','#f6f2ea')},{type:'add',name:'Pricing',width:1440,height:900,html:page('Simple, calm pricing','#f3f4f7')}]});
 const win=new BrowserWindow({width:1440,height:900,show:true,titleBarStyle:'hidden',trafficLightPosition:{x:15,y:15},webPreferences:{backgroundThrottling:false,preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 win.setAlwaysOnTop(true,'floating');app.focus({steal:true});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const until=async(code,label)=>{for(let i=0;i<120;i++){if(await js(code))return;await delay(75)}throw new Error('Timed out: '+label+'\n'+errors.join('\n'))};
 const click=async sel=>{await js('document.querySelector('+JSON.stringify(sel)+').click()');await delay(150)};
 const shot=async name=>{fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())};
 try{
  await win.loadURL(process.env.QA_URL);
  // Another app may be in front while this runs: keep the page focused so real keys arrive.
  try{win.webContents.debugger.attach('1.3')}catch{}
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await until('!!window.qa','renderer');await delay(800);await js('qa.seed()');await delay(400);
  await js('localStorage.removeItem("aegis.design.dock")');
  // A pane left fullscreen in Home must not hide the Design section.
  await js('qa.app.getState().setRightPanelFullscreen("browser")');

  // Rail → Design: a home of design cards by project; a card opens its canvas, toolbar in the title bar, composer dock.
  const card=(id)=>'[data-design-home] [data-design-document-card="'+id+'"]';
  const goHome=async()=>{await click('[data-design-titlebar] [aria-label="All designs"]');await until('!!document.querySelector("[data-design-home]")','back to the designs home')};
  await click('nav[aria-label="Sections"] button[aria-label="Design"]');
  await until('!!document.querySelector("[data-design-home]")','designs home');
  await until('!!document.querySelector(\''+card(atlas.id)+'\')','Atlas card');
  assert.match(await js('document.querySelector("[data-design-home]").textContent'),/Designs[\s\S]*workflow-test[\s\S]*Atlas website[\s\S]*Edited/);
  await until('document.querySelectorAll(\''+card(atlas.id)+' .design-cover-board\').length===2','the card shows the canvas');
  assert.equal(await js('!!document.querySelector("[data-design-library]")'),false,'no separate design list in the sidebar');
  await shot('design-home');
  await click(card(atlas.id));
  await until('document.querySelectorAll("[data-design-section] .design-board").length===2','canvas with two boards');
  await until('!!document.querySelector("[data-design-titlebar] .design-toolbar .design-title")','toolbar in the title bar');
  assert.equal(await js('!!document.querySelector("[data-design-titlebar] [aria-label=\'All designs\']")'),true,'back to the home from the title bar');
  // The title is one control: a click opens the design menu, a double click renames in place.
  const titleAt=JSON.parse(await js('JSON.stringify((r=>({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}))(document.querySelector("[data-design-titlebar] .design-title-button").getBoundingClientRect()))'));
  const mouse=(clickCount)=>{for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,x:titleAt.x,y:titleAt.y,button:'left',clickCount})};
  mouse(1);await until('!!document.querySelector(".design-export-actions [role=menuitem]")','one click opens the design menu');
  assert.match(await js('document.querySelector(".design-export-actions").textContent'),/^Rename/);
  mouse(1);await until('!document.querySelector(".design-export-actions")','a second click closes it');
  mouse(1);mouse(2);await until('document.activeElement?.matches("[data-design-titlebar] input.design-title")','double click renames in place');
  await delay(350);assert.equal(await js('!!document.querySelector(".design-export-actions")'),false,'a double click never opens the menu');
  const key=(keyCode)=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode})};
  // Waits for the text to land, and presses Return again only if nothing happened (keys can drop on a busy runner).
  const renameTo=async(title)=>{
    await js('document.execCommand("selectAll")');win.webContents.insertText(title);
    await until('document.activeElement?.value==='+JSON.stringify(title),'typed '+title);
    for(let i=0;i<3&&await js('!!document.querySelector("[data-design-titlebar] input.design-title")');i++){key('Return');await delay(600)}
  };
  await renameTo('Atlas site');await until('document.querySelector("[data-design-titlebar] .design-title-text")?.textContent==="Atlas site"','renamed');
  assert.equal(repoRead().title,'Atlas site');
  mouse(1);mouse(2);await until('document.activeElement?.matches("[data-design-titlebar] input.design-title")','rename again');
  win.webContents.insertText('Not kept');await delay(100);key('Escape');await until('!!document.querySelector("[data-design-titlebar] .design-title-button")','Escape keeps the title');
  assert.equal(repoRead().title,'Atlas site');
  mouse(1);mouse(2);await until('document.activeElement?.matches("[data-design-titlebar] input.design-title")','rename back');
  await renameTo('Atlas website');await until('document.querySelector("[data-design-titlebar] .design-title-text")?.textContent==="Atlas website"','renamed back');
  await until('!!document.querySelector("[data-design-dock=composer] [data-design-dock-composer]")','composer dock');
  assert.equal(await js('document.querySelector("[data-design-dock]").dataset.designDockCorner'),'br');
  await js('[...document.querySelectorAll(".design-toolbar button")].find(b=>b.textContent.trim()==="Fit")?.click()');await delay(300);
  await shot('design-section');

  // Keyboard through the layer tree: Tab across siblings, Shift+Enter up, Escape out one level at a time.
  // Probing every srcdoc frame also tries the script-free thumbnails, which log a blocked-script notice.
  const homeFrame=async()=>{for(const f of win.webContents.mainFrame.framesInSubtree.filter(f=>f.url==='about:srcdoc'))if(await f.executeJavaScript('document.body.textContent.includes("Notes that think")').catch(()=>false))return f};
  await (await homeFrame()).executeJavaScript('document.querySelector("h1").click()');
  await until('(Object.values(qa.design.getState().selections).find(Boolean)?.label??"").split(" · ")[0]==="h1"','h1 selected');
  const press=(key,shift=false)=>js('document.querySelector("[data-design-section] .design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:'+JSON.stringify(key)+',shiftKey:'+shift+',bubbles:true,cancelable:true}))');
  await press('Tab');
  await until('(Object.values(qa.design.getState().selections).find(Boolean)?.label??"").split(" · ")[0]==="p"','Tab: next sibling');
  await press('Tab',true);
  await until('(Object.values(qa.design.getState().selections).find(Boolean)?.label??"").split(" · ")[0]==="h1"','Shift+Tab: previous sibling');
  await press('Enter',true);
  await until('(Object.values(qa.design.getState().selections).find(Boolean)?.label??"").split(" · ")[0]==="main"','Shift+Enter: parent');
  await press('Escape');
  await until('(Object.values(qa.design.getState().selections).find(Boolean)?.label??"").split(" · ")[0]==="Home"','Escape: out to the board');
  // Preview a board and come back: the canvas view is where it was.
  const view=()=>js('(()=>{const v=document.querySelector("[data-design-section] .design-viewport");const w=v.querySelector(".design-world");return v.dataset.viewZoom+"|"+w.style.transform})()');
  const viewBefore=await view();
  await press('Enter');
  await until('!!document.querySelector(".design-board-preview-overlay")','board preview');
  await press('Escape');
  await until('!document.querySelector(".design-board-preview-overlay")','preview closed');
  assert.equal(await view(),viewBefore,'the canvas view is kept across a preview');
  await press('Escape');
  await until('!Object.values(qa.design.getState().selections).find(Boolean)','Escape: nothing selected');

  // Prompt cards: the message behind each board, under it, with Re-run.
  await until('document.querySelectorAll(".design-prompt-card").length===2','a prompt card under each board');
  assert.match(await js('document.querySelector(".design-prompt-card").textContent'),/Design a landing page for Atlas[\s\S]*Re-run/);
  await js('document.querySelector(".design-prompt-card button").click()');
  for(let i=0;i<60&&!sent.some(e=>e.type==='session.continue');i++)await delay(75);
  const rerun=sent.find(e=>e.type==='session.continue');
  assert(rerun&&rerun.payload.sessionId==='s1'&&rerun.payload.prompt==='Design a landing page for Atlas','Re-run sends the message again: '+JSON.stringify(sent.map(e=>e.type)));

  // Styles: pick a style guide for the agent; the main process has it for the next turn.
  await click('[data-design-style-button]');
  await until('!!document.querySelector("[data-design-styles] [data-style-id=quiet-slate]")','style picker');
  await shot('design-styles');
  await click('[data-design-styles] [data-style-id=quiet-slate]');
  await js('[...document.querySelectorAll("[data-design-styles] button")].find(b=>b.textContent.trim()==="Use Quiet Slate").click()');
  await until('!document.querySelector("[data-design-styles]")&&document.querySelector("[data-design-style-button]").textContent.includes("Quiet Slate")','style picked');
  await click('[data-design-variants]');
  await until('document.querySelector("[data-design-variants]").textContent.includes("2×")','two variations');
  for(let i=0;i<40&&getDesignComposerPrefs('s1').variants!==2;i++)await delay(50);
  assert.deepEqual(getDesignComposerPrefs('s1'),{styleId:'quiet-slate',variants:2},'the next turn carries the picks');
  // Templates from the project's design system: picked here, new boards start from one.
  const qaProject=path.join(__dirname,'project');fs.mkdirSync(path.join(qaProject,'design-system','templates'),{recursive:true});
  fs.writeFileSync(path.join(qaProject,'design-system','templates','landing.html'),'<main style="padding:60px;font-family:Georgia;background:#f6f2ea"><h1 style="font-size:64px">A calm landing page</h1><p>Hero, three features, pricing.</p></main>');
  fs.writeFileSync(path.join(qaProject,'design-system','templates','landing.md'),'A product landing page: hero, features and pricing.');
  await js('qa.app.setState(s=>({sessions:{...s.sessions,s1:{...s.sessions.s1,cwd:'+JSON.stringify(qaProject)+',projectCwd:'+JSON.stringify(qaProject)+'}}}))');
  await click('[data-design-style-button]');
  await until('!!document.querySelector("[data-design-styles]")','style picker again');
  await js('[...document.querySelectorAll("[data-design-styles] [role=tab]")].find(b=>b.textContent==="Templates").click()');
  await until('!!document.querySelector("[data-design-styles] [data-template-id=landing]")','project template listed');
  await click('[data-design-styles] [data-template-id=landing]');
  await delay(300);await shot('design-templates');
  await js('[...document.querySelectorAll("[data-design-styles] button")].find(b=>b.textContent.trim()==="Start from Landing").click()');
  await until('!document.querySelector("[data-design-styles]")&&document.querySelector("[data-design-style-button]").textContent.includes("Landing")','template picked');
  for(let i=0;i<40&&getDesignComposerPrefs('s1').templateId!=='landing';i++)await delay(50);
  assert.equal(getDesignComposerPrefs('s1').templateId,'landing');

  // History, from the design menu under the title.
  await js('document.querySelector("[data-design-titlebar] .design-title-button").click()');
  await until('!!document.querySelector(".design-export-actions")','design menu');
  await js('[...document.querySelectorAll(".design-export-actions button")].find(b=>b.textContent.trim()==="History").click()');
  await until('!!document.querySelector(".design-history")','history opens from the design menu');
  // One request, one version: the create and the boards it drew fold together.
  // (The renames above are hand edits: a version of their own.)
  const requestVersion='[...document.querySelectorAll(".design-version-group")].find(g=>g.textContent.includes("Design a landing page for Atlas"))';
  await until('!!'+requestVersion,'one version for one request');
  assert.match(await js(requestVersion+'.textContent'),/“Design a landing page for Atlas”[\s\S]*2 saves/);
  assert.equal(await js('document.querySelectorAll(".design-version-group").length'),2,'the request and the hand edits');
  await js(requestVersion+'.querySelector(".design-version-saves").click()');
  await until('document.querySelectorAll(".design-version-step").length===2','its saves');
  await shot('design-history');
  await click('[aria-label="Close history"]');

  // An approval opens the dock's chat until it is answered, then the dock returns as it was.
  const prefBefore=await js('localStorage.getItem("aegis.design.dock")');
  await js('qa.app.setState(s=>({sessions:{...s.sessions,s1:{...s.sessions.s1,status:"running",permissionRequests:[{sessionId:"s1",toolUseId:"perm-1",toolName:"Bash",input:{command:"ls"}}]}}}))');
  await until('document.querySelector("[data-design-dock]")?.dataset.designDockAttention==="approval"&&!!document.querySelector("[data-design-dock-chat]")','an approval opens the chat');
  await until('document.querySelector("[data-design-dock-chat]").textContent.includes("Waiting")','the approval card shows');
  assert.match(await js('document.querySelector("[data-design-dock-status]").textContent'),/Waiting for your approval/);
  await shot('design-dock-approval');
  await js('qa.app.setState(s=>({sessions:{...s.sessions,s1:{...s.sessions.s1,status:"idle",permissionRequests:[]}}}))');
  await until('document.querySelector("[data-design-dock]")?.dataset.designDock==="composer"&&!document.querySelector("[data-design-dock-attention]")','back to the composer');
  assert.equal(await js('localStorage.getItem("aegis.design.dock")'),prefBefore,'the dock preference is untouched');

  // Value sources and tokens: a stylesheet value shows as such; a token pick writes var(); reset restores the rule.
  await call('s1','design_update',{documentId:atlas.id,operationId:'tok-1',operations:[{type:'add',name:'Tokens',width:600,height:300,html:'<style>:root{--accent:#4f5bd5;--ink:#23263a}.card{color:#222222;padding:24px}</style><div class="card" data-aegis-layer-name="Card">Card text</div><div data-aegis-layer-name="Row" style="position:relative;height:60px"><span style="position:absolute;left:0;top:0">Alpha</span><span style="position:absolute;left:140px;top:2px">Beta</span><span style="position:absolute;left:280px;top:0">Gamma</span></div>'}]});
  const tokensFrame=async()=>{for(const f of win.webContents.mainFrame.framesInSubtree.filter(f=>f.url==='about:srcdoc'))if(await f.executeJavaScript('document.body.textContent.includes("Card text")').catch(()=>false))return f};
  await until('document.querySelectorAll("[data-design-section] .design-board").length===3','token board');
  for(let i=0;i<40&&!(await tokensFrame());i++)await delay(75);
  await (await tokensFrame()).executeJavaScript('document.querySelector(".card").click()');
  await until('(Object.values(qa.design.getState().selections).find(Boolean)?.label??"").split(" · ")[0]==="Card"','card selected');
  // Properties are closed by default.
  if(await js('!!document.querySelector("[data-design-section] [aria-label=\'Show inspector\']")'))await click('[data-design-section] [aria-label="Show inspector"]');
  await until('document.querySelector(".design-inspector [aria-label=\'Layer color\']")?.closest(".iv-in")?.dataset.source==="rule"','color comes from the stylesheet');
  await js('document.querySelector(".design-inspector [aria-label=\'Use --accent\']").click()');
  const tokenHtml=()=>repoRead().boards.find(b=>b.name==='Tokens').html;
  for(let i=0;i<60&&!/color: var\(--accent\)/.test(tokenHtml());i++)await delay(75);
  assert.match(tokenHtml(),/color: var\(--accent\)/,'a token pick writes the reference');
  await until('document.querySelector(".design-inspector [aria-label=\'Layer color\']")?.closest(".iv-in")?.dataset.source==="local"&&!!document.querySelector(".design-inspector [aria-label=\'Reset Color\']")','now set on the layer, with a reset');
  await until('document.querySelector(".design-inspector [aria-label=\'Use --accent\']")?.getAttribute("aria-pressed")==="true"','the bound token shows');
  await shot('design-tokens');
  await js('document.querySelector(".design-inspector [aria-label=\'Reset Color\']").click()');
  for(let i=0;i<60&&/color: var\(--accent\)/.test(tokenHtml());i++)await delay(75);
  assert.doesNotMatch(tokenHtml(),/color: var\(--accent\)/,'reset removes the override');
  // Auto layout: Shift+A on a container reads its children's arrangement; on a leaf it wraps it.
  const shiftA=()=>js('document.querySelector("[data-design-section] .design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"A",code:"KeyA",shiftKey:true,bubbles:true,cancelable:true}))');
  await (await tokensFrame()).executeJavaScript('[...document.querySelectorAll("[data-aegis-layer-name=Row]")][0].dispatchEvent(new MouseEvent("click",{bubbles:true}))');
  await until('(Object.values(qa.design.getState().selections).find(Boolean)?.label??"").split(" · ")[0]==="Row"','row selected');
  await until('[...document.querySelectorAll(".design-inspector .iv-sec h4")].some(h=>h.textContent==="Auto layout")','auto layout offered');
  await shiftA();
  for(let i=0;i<60&&!/data-aegis-layer-name="Row" style="[^"]*display: flex !important; flex-direction: row !important/.test(tokenHtml());i++)await delay(75);
  assert.match(tokenHtml(),/data-aegis-layer-name="Row" style="[^"]*display: flex !important; flex-direction: row !important; gap: 12px !important"/,'laid out as a row');
  assert.doesNotMatch(tokenHtml(),/<span[^>]*position: ?absolute/,'children follow the layout');
  await until('[...document.querySelectorAll(".design-inspector .iv-sec h4")].some(h=>h.textContent==="Layout")&&![...document.querySelectorAll(".design-inspector .iv-sec h4")].some(h=>h.textContent==="Auto layout")','now laid out (Layout, no longer offered)');
  await (await tokensFrame()).executeJavaScript('document.querySelector(".card").click()');
  await until('(Object.values(qa.design.getState().selections).find(Boolean)?.label??"").split(" · ")[0]==="Card"','card selected again');
  await shiftA();
  for(let i=0;i<60&&!/data-aegis-layer-name="Auto layout"[^>]*><div class="card"/.test(tokenHtml());i++)await delay(75);
  assert.match(tokenHtml(),/data-aegis-layer-name="Auto layout" style="display: flex !important; flex-direction: column !important; gap: 12px !important"><div class="card"/,'a leaf is wrapped');
  await until('(Object.values(qa.design.getState().selections).find(Boolean)?.label??"").split(" · ")[0]==="Auto layout"','the wrapper is selected');
  await js('document.querySelector("[data-design-section] .design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await js('document.querySelector("[data-design-section] .design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');

  // Show chat → the conversation; minimize → a pill; expand back.
  // The header: the agent's logo, the chat, and three icon buttons; no grip, no agent name.
  assert.equal(await js('document.querySelector("[data-design-dock-agent]").getAttribute("aria-label")'),'Claude Code');
  assert.equal(await js('!!document.querySelector("[data-design-dock] [aria-label=Move]")'),false,'the header is the handle');
  assert.deepEqual(JSON.parse(await js('JSON.stringify([...document.querySelectorAll("[data-design-dock-handle] > button[aria-label]")].map(b=>b.getAttribute("aria-label")))')),['Show chat','Open as a chat','Minimize']);
  assert.equal(await js('document.querySelector("[data-design-dock-status]").textContent.trim()'),'','idle: no status');
  await click('[data-design-dock] [aria-label="Show chat"]');
  await until('!!document.querySelector("[data-design-dock=chat] [data-design-dock-chat]")','chat shown');
  await shot('design-dock-chat');
  await click('[data-design-dock] [aria-label="Minimize"]');
  await until('!!document.querySelector("[data-design-dock=pill]")','minimized to a pill');
  assert.equal(JSON.parse(await js('localStorage.getItem("aegis.design.dock")')).mode,'pill','the dock remembers its state');
  await shot('design-dock-pill');

  // Drag the pill by its logo to the top left: it snaps there.
  const grip=JSON.parse(await js('(()=>{const r=document.querySelector("[data-design-dock] [data-design-dock-agent]").getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()'));
  const stage=JSON.parse(await js('(()=>{const r=document.querySelector(".design-canvas-overlay").getBoundingClientRect();return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y)})})()'));
  win.focus();win.webContents.sendInputEvent({type:'mouseMove',x:grip.x,y:grip.y});
  win.webContents.sendInputEvent({type:'mouseDown',x:grip.x,y:grip.y,button:'left',clickCount:1});
  for(let i=1;i<=12;i++){const x=Math.round(grip.x+(stage.x+120-grip.x)*i/12),y=Math.round(grip.y+(stage.y+90-grip.y)*i/12);win.webContents.sendInputEvent({type:'mouseMove',x,y,button:'left',modifiers:['leftButtonDown']});await delay(16);if(i===6){await until('document.querySelectorAll(".design-dock-snap").length===4','snap targets while dragging');await shot('design-dock-dragging')}}
  win.webContents.sendInputEvent({type:'mouseUp',x:stage.x+120,y:stage.y+90,button:'left',clickCount:1});
  await until('document.querySelector("[data-design-dock]").dataset.designDockCorner==="tl"','snapped to the top left');
  assert.equal(await js('document.querySelectorAll(".design-dock-snap").length'),0);
  await click('[data-design-dock] [aria-label="Expand"]');
  await until('!!document.querySelector("[data-design-dock=composer]")','expanded again');

  // New design: an empty canvas whose chat is a draft until its first message.
  await goHome();
  await click('[data-design-home] .design-library-new');
  await until('!!document.querySelector("[data-design-start]")','start canvas');
  const draft=await js('qa.design.getState().section.sessionId');
  assert.equal(await js('qa.app.getState().sessions['+JSON.stringify(draft)+'].isDraft'),true);
  assert.equal(await js('qa.app.getState().activeWorkspace'),'design','the section stays');
  assert.equal(await js('qa.app.getState().activeSessionId'),'s2','Home keeps its own chat');
  assert.equal(await js('[...document.querySelectorAll("[data-design-dock] button")].some(b=>b.getAttribute("aria-label")==="Show chat")'),false,'no chat to show for a draft');
  await shot('design-new');
  // The chat starts: the section follows the real session…
  await js('(()=>{const s=qa.app.getState();const d=s.sessions['+JSON.stringify(draft)+'];qa.app.setState({sessions:{...s.sessions,s9:{...d,id:"s9",isDraft:false,title:"Pricing page",status:"running"}},draftPromotion:{from:'+JSON.stringify(draft)+',to:"s9"}})})()');
  await until('qa.design.getState().section.sessionId==="s9"','section follows the started chat');
  // …and opens the canvas its agent creates.
  const created=await call('s9','design_create',{title:'Pricing page',operationId:'c9'});
  await call('s9','design_update',{documentId:created.id,operationId:'u9',operations:[{type:'add',name:'Pricing',width:1440,height:900,html:page('Simple, calm pricing','#eef1f6')}]});
  await until('qa.design.getState().section.documentId==='+JSON.stringify(created.id),'section opens the created design');
  await until('document.querySelectorAll("[data-design-section] .design-board").length===1','its canvas');
  // While the agent writes a board, the canvas draws it and the dock says so.
  await js('qa.app.setState(s=>({sessions:{...s.sessions,s9:{...s.sessions.s9,status:"running"}}}))');
  const draftHtml='<main style="padding:48px;background:#f6f2ea;font-family:Georgia"><h1 style="font-size:56px;font-weight:400">What people write in Atlas</h1></main>';
  const pushDraft=(html,complete)=>js('qa.app.getState().handleServerEvent({type:"stream.message",payload:{sessionId:"s9",message:{type:"design_draft",toolUseId:"call-stories",documentId:'+JSON.stringify(created.id)+',boards:[{index:0,op:"add",name:"Stories",width:1440,height:900,html:'+JSON.stringify(html)+',complete:'+complete+'}]}}})');
  await pushDraft(draftHtml.slice(0,90),false);
  await until('document.querySelectorAll("[data-design-section] .design-board").length===2&&!!document.querySelector("[data-board-writing=true]")','draft board on the canvas');
  await until('document.querySelector("[data-design-dock-status]")?.textContent.includes("Writing Stories")','dock says what is being written');
  await pushDraft(draftHtml,true);
  await delay(400);
  await shot('design-writing');
  // The real version lands: the draft gives way to the saved board.
  await call('s9','design_update',{documentId:created.id,operationId:'u10',operations:[{type:'add',name:'Stories',width:1440,height:900,html:draftHtml}]});
  await until('document.querySelectorAll("[data-design-section] .design-board").length===2&&!document.querySelector("[data-board-writing]")&&![...document.querySelectorAll("[data-board-id]")].some(b=>b.dataset.boardId.startsWith("draft:"))','saved board replaces the draft');
  await js('qa.app.setState(s=>({sessions:{...s.sessions,s9:{...s.sessions.s9,status:"idle"}}}))');
  await until('(qa.design.getState().library??[]).some(d=>d.id==='+JSON.stringify(created.id)+')','listed');

  // A design has several chats: each keeps its conversation and works on the same canvas.
  const designRepo=()=>require(path.join(root,'dist-electron/electron/design/service.js')).getDesignRepository();
  await goHome();await click(card(atlas.id));
  await until('qa.design.getState().section?.documentId==='+JSON.stringify(atlas.id)+'&&qa.design.getState().section.sessionId==="s1"','Atlas opens with its latest chat');
  await until('document.querySelectorAll("[data-design-section] .design-board").length===3','Atlas canvas');
  await click('[data-design-chat-switcher]');
  await until('!!document.querySelector(".design-chat-menu [data-design-new-chat]")','the design\'s chats');
  assert.deepEqual(JSON.parse(await js('JSON.stringify([...document.querySelectorAll(".design-chat-menu [data-design-chat]")].map(b=>[b.dataset.designChat,b.getAttribute("aria-checked")]))')),[['s1','true']]);
  await shot('design-chats');
  await click('.design-chat-menu [data-design-new-chat]');
  await until('qa.design.getState().section.sessionId!=="s1"&&qa.design.getState().section.documentId==='+JSON.stringify(atlas.id),'a new chat on the same design');
  const newChat=await js('qa.design.getState().section.sessionId');
  assert.equal(await js('qa.app.getState().sessions['+JSON.stringify(newChat)+'].isDraft'),true);
  for(let i=0;i<40&&!designRepo().chats(atlas.id).includes(newChat);i++)await delay(50);
  assert(designRepo().chats(atlas.id).includes(newChat),'the new chat is one of the design\'s chats from the start');
  assert.match(await js('document.querySelector("[data-design-chat-switcher]").textContent'),/New chat/);
  assert.equal(await js('document.querySelectorAll("[data-design-section] .design-board").length'),3,'the canvas stays');
  // Its first message makes it a real chat (the design link moves along), and its agent draws on the same canvas.
  designRepo().moveSession(newChat,'s11');
  await js('(()=>{const s=qa.app.getState();const d=s.sessions['+JSON.stringify(newChat)+'];qa.app.setState({sessions:{...s.sessions,s11:{...d,id:"s11",isDraft:false,title:"Plan the diet app",status:"idle"}},draftPromotion:{from:'+JSON.stringify(newChat)+',to:"s11"}})})()');
  await until('qa.design.getState().section.sessionId==="s11"','the section follows the started chat');
  await call('s11','design_update',{documentId:atlas.id,operationId:'u11',operations:[{type:'add',name:'Diet',width:390,height:844,html:page('Eat well, slowly','#eef6ee')}]});
  await until('document.querySelectorAll("[data-design-section] .design-board").length===4','the new chat drew on the same canvas');
  assert.deepEqual(designRepo().chats(atlas.id),['s11','s1']);
  await until('(qa.design.getState().library??[]).find(d=>d.id==='+JSON.stringify(atlas.id)+')?.chats.length===2','the library knows its chats');
  // Back to the first chat: its conversation, and History says which chat made the new version.
  await click('[data-design-chat-switcher]');
  await until('document.querySelectorAll(".design-chat-menu [data-design-chat]").length===2','both chats listed');
  await click('.design-chat-menu [data-design-chat="s1"]');
  await until('qa.design.getState().section.sessionId==="s1"','back to the first chat');
  await js('document.querySelector("[data-design-titlebar] .design-title-button").click()');
  await until('!!document.querySelector(".design-export-actions")','design menu');
  await js('[...document.querySelectorAll(".design-export-actions button")].find(b=>b.textContent.trim()==="History").click()');
  await until('document.querySelector(".design-history [data-version-chat=s11]")?.textContent.includes("Plan the diet app")','History names the other chat');
  await shot('design-history-chats');
  await click('[aria-label="Close history"]');
  // Deleting a design (from its card on the home) asks first, then removes it; the chat that made it stays.
  await goHome();
  await js('document.querySelector("[data-design-delete=\\"'+created.id+'\\"]").click()');
  await until('[...document.querySelectorAll("[role=dialog] button, [role=alertdialog] button")].some(b=>b.textContent.trim()==="Delete design")','asks before deleting');
  await js('[...document.querySelectorAll("[role=dialog] button, [role=alertdialog] button")].find(b=>b.textContent.trim()==="Delete design").click()');
  await until('!document.querySelector(\''+card(created.id)+'\')','gone from the home');
  assert.throws(()=>designRepo().read('s9',created.id),/not found/i);
  assert.equal(await js('!!qa.app.getState().sessions.s9'),true,'its chat stays');
  assert(await js('!!document.querySelector(\''+card(atlas.id)+'\')'),'the other designs stay');
  await click(card(atlas.id));
  await until('document.querySelectorAll("[data-design-section] .design-board").length===4','Atlas again');

  // Dark theme: the canvas, dock and library follow the theme's tokens.
  nativeTheme.themeSource='dark';
  await until('document.documentElement.classList.contains("dark")','dark theme');
  await delay(300);
  const lum=(sel)=>js('(()=>{const c=getComputedStyle(document.querySelector('+JSON.stringify(sel)+')).backgroundColor.match(/[\\d.]+/g).map(Number);return (0.2126*c[0]+0.7152*c[1]+0.0722*c[2])/255})()');
  assert((await lum('[data-design-dock]'))<0.3,'the dock is dark');
  assert((await lum('[data-design-section] .design-viewport'))<0.3,'the canvas is dark');
  await shot('design-section-dark');
  nativeTheme.themeSource='light';
  await until('!document.documentElement.classList.contains("dark")','back to light');

  // Open as a chat: Home with the design beside its chat.
  await js('qa.app.getState().setRightPanelFullscreen(null)');
  await js('qa.openDesign({sessionId:"s1",documentId:'+JSON.stringify(atlas.id)+',where:"pane"})');
  await until('qa.app.getState().activeWorkspace==="chat"&&qa.app.getState().activeSessionId==="s1"','Home with the design chat');
  await until('qa.app.getState().activeRightUtilityTab==="design:'+atlas.id+'"','design tab beside it');
  await until('document.querySelectorAll(".design-panel .design-board").length===4','design tab canvas');
  await shot('design-pane');
  // Fullscreen from the pane's tab bar, for a design and for the Designs list.
  for(const tab of ['design:'+atlas.id,'design']){
    await js('qa.app.getState().setActiveRightUtilityTab('+JSON.stringify(tab)+')');await delay(200);
    await click('[aria-label="Enter fullscreen"]');
    await until('qa.app.getState().rightPanelFullscreen==="design"&&!!document.querySelector(\'[aria-label="Exit fullscreen"]\')',tab+' fullscreen');
    await delay(300);await shot('design-pane-fullscreen-'+(tab==='design'?'list':'canvas'));
    await click('[aria-label="Exit fullscreen"]');
    await until('qa.app.getState().rightPanelFullscreen===null',tab+' back from fullscreen');
  }

  console.log(JSON.stringify({ok:true,errors:errors.filter(e=>!/No handler registered|Failed to load resource|Blocked script execution in 'about:srcdoc'/.test(e)).slice(0,6)}));app.exit(0);
 }catch(e){console.error(e);await shot('failure').catch(()=>{});console.log(JSON.stringify({errors:errors.slice(0,10)}));app.exit(1)}
});
`;

let server;
try {
  await writeFile(path.join(tmp, 'index.html'), '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(tmp, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  const url = new URL(path.relative(root, tmp) + '/index.html', server.resolvedUrls.local[0]).href;
  const code = await new Promise((resolve, reject) => {
    const env = { ...process.env, QA_ROOT: root, QA_URL: url, QA_CAPTURE: capture, DEV_SERVER_URL: server.resolvedUrls.local[0] };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(tmp, 'main.cjs')], { cwd: root, env, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Design workspace QA timed out')); }, 150000);
    child.on('error', reject);
    child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  if (code !== 0) process.exitCode = 1;
} finally {
  await server?.close();
  await rm(tmp, { recursive: true, force: true });
}
