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
 const sent=[];ipcMain.on('client-event',(_e,event)=>sent.push(typeof event==='string'?JSON.parse(event):event));
 setDesignPromptSource((sessionId)=>sessionId==='s1'?{prompt:'Design a landing page for Atlas',id:'s1:1'}:undefined);
 const call=async(sessionId,name,args)=>{const r=await createNativeDesignTools(sessionId).find(t=>t.name===name).execute(args,{});assert(!r.isError,r.content);return JSON.parse(r.content)};
 const page=(title,bg)=>'<main style="padding:48px;background:'+bg+';font-family:Georgia;min-height:100%"><p style="font:11px system-ui;letter-spacing:2px">NOTES · REIMAGINED</p><h1 style="font-size:56px;font-weight:400;margin:20px 0">'+title+'</h1><p style="font:15px system-ui;color:#555">Write freely. Atlas links what you write to what you already know.</p></main>';
 const atlas=await call('s1','design_create',{title:'Atlas website',operationId:'c1'});
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
  await until('!!window.qa','renderer');await delay(800);await js('qa.seed()');await delay(400);
  await js('localStorage.removeItem("aegis.design.dock")');
  // A pane left fullscreen in Home must not hide the Design section.
  await js('qa.app.getState().setRightPanelFullscreen("browser")');

  // Rail → Design: library, canvas, toolbar in the title bar, composer dock.
  await click('nav[aria-label="Sections"] button[aria-label="Design"]');
  await until('!!document.querySelector("[data-design-library]")','design library in the sidebar');
  await until('!!document.querySelector("[data-design-row='+atlas.id+']")','Atlas listed');
  assert.match(await js('document.querySelector("[data-design-library]").textContent'),/workflow-test[\s\S]*Atlas website[\s\S]*2 boards/);
  await until('document.querySelectorAll("[data-design-section] .design-board").length===2','canvas with two boards');
  await until('!!document.querySelector("[data-design-titlebar] .design-toolbar .design-title")','toolbar in the title bar');
  assert.equal(await js('!!document.querySelector("[data-design-titlebar] [aria-label=\'All designs\']")'),false,'no back arrow in the section');
  await until('!!document.querySelector("[data-design-dock=composer] [data-design-dock-composer]")','composer dock');
  assert.equal(await js('document.querySelector("[data-design-dock]").dataset.designDockCorner'),'br');
  await js('[...document.querySelectorAll(".design-toolbar button")].find(b=>b.textContent.trim()==="Fit")?.click()');await delay(300);
  await shot('design-section');

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

  // Layers panel: Layers, Components and History tabs.
  await js('document.querySelector(".design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"l",code:"KeyL",altKey:true,bubbles:true}))');
  await until('!!document.querySelector(".design-layers-popover [role=tab][aria-selected=true]")','layers panel');
  await js('[...document.querySelectorAll(".design-layers-popover [role=tab]")].find(b=>b.textContent==="Components").click()');
  await until('document.querySelector(".design-layers-popover")?.textContent.includes("show up here as components")','components tab');
  await js('[...document.querySelectorAll(".design-layers-popover [role=tab]")].find(b=>b.textContent==="History").click()');
  await until('!!document.querySelector(".design-history")&&!document.querySelector(".design-layers-popover")','history opens from its tab');
  // One request, one version: the create and the boards it drew fold together.
  await until('document.querySelectorAll(".design-version-group").length===1','one version for one request');
  assert.match(await js('document.querySelector(".design-version-group").textContent'),/“Design a landing page for Atlas”[\s\S]*2 saves/);
  await js('document.querySelector(".design-version-saves").click()');
  await until('document.querySelectorAll(".design-version-step").length===2','its saves');
  await shot('design-history');
  await click('[aria-label="Close history"]');

  // Show chat → the conversation; minimize → a pill; expand back.
  await js('[...document.querySelectorAll("[data-design-dock] button")].find(b=>b.textContent.includes("Show chat")).click()');
  await until('!!document.querySelector("[data-design-dock=chat] [data-design-dock-chat]")','chat shown');
  await shot('design-dock-chat');
  await click('[data-design-dock] [aria-label="Minimize"]');
  await until('!!document.querySelector("[data-design-dock=pill]")','minimized to a pill');
  assert.equal(JSON.parse(await js('localStorage.getItem("aegis.design.dock")')).mode,'pill','the dock remembers its state');
  await shot('design-dock-pill');

  // Drag the pill by its grip to the top left: it snaps there.
  const grip=JSON.parse(await js('(()=>{const r=document.querySelector("[data-design-dock] [aria-label=Move]").getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()'));
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
  await js('[...document.querySelectorAll("[data-design-library] button")].find(b=>b.textContent.trim()==="New design").click()');
  await until('!!document.querySelector("[data-design-start]")','start canvas');
  const draft=await js('qa.design.getState().section.sessionId');
  assert.equal(await js('qa.app.getState().sessions['+JSON.stringify(draft)+'].isDraft'),true);
  assert.equal(await js('qa.app.getState().activeWorkspace'),'design','the section stays');
  assert.equal(await js('qa.app.getState().activeSessionId'),'s2','Home keeps its own chat');
  assert.equal(await js('[...document.querySelectorAll("[data-design-dock] button")].some(b=>b.textContent.includes("Show chat"))'),false,'no chat to show for a draft');
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
  await until('!!document.querySelector("[data-design-row='+created.id+'][aria-current=true]")','listed and current');

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
  await until('document.querySelectorAll(".design-panel .design-board").length===2','design tab canvas');
  await shot('design-pane');

  console.log(JSON.stringify({ok:true,errors:errors.filter(e=>!/No handler registered|Failed to load resource/.test(e)).slice(0,6)}));app.exit(0);
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
