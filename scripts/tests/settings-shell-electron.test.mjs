// Settings in the full app, Codex-style: the rail stays, the sidebar panel
// holds the Settings nav and the page sits on the main sheet like any other
// section. Back (button or shortcut) leaves Settings for the view you came
// from and Forward is off; a search or a revealed result lasts one visit; with
// the sidebar collapsed the page fills the sheet; at the window's minimum
// width nothing overflows.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const tmp = await mkdtemp(path.join(root, '.aegis-design-qa/settings-shell-'));
const capture = path.join(root, 'output/playwright/settings-shell');

const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AppearancePreferences} from '/src/ui/components/AppearancePreferences';
import {App} from '/src/ui/App';
import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';
window.addEventListener('blur',e=>e.stopImmediatePropagation(),true);
window.qa={app:useAppStore,seed(){
 const a=useAppStore.getState();const draft=a.createDraftSession('/projects/coworker');const base=useAppStore.getState().sessions[draft];
 const now=Date.now();
 useAppStore.setState({connected:true,sessionsLoaded:true,sidebarCollapsed:false,sidebarWidth:280,activeSessionId:'s1',sessions:{s1:{...base,id:'s1',isDraft:false,title:'Fix the relay',cwd:'/projects/coworker',projectCwd:'/projects/coworker',provider:'claude',messages:[],permissionRequests:[],status:'completed',updatedAt:now,createdAt:now}}});
 useAppStore.getState().setTheme('light');
}};
createRoot(document.getElementById('root')).render(<AppearancePreferences><App/></AppearancePreferences>);
`;

const main = String.raw`
const {app,BrowserWindow,ipcMain}=require('electron');
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
 ipcMain.handle('get-environment-editor-launchers',()=>[]);ipcMain.handle('get-terminal-shell-options',()=>[{value:'system',label:'System default'}]);
 // What the General page reads, so its screenshots show the page rather than load errors.
 const prefs=require(path.join(root,'dist-electron/electron/libs/app-preferences.js'));
 ipcMain.handle('get-app-preferences',()=>prefs.getAppPreferences());ipcMain.handle('get-app-version',()=>'0.0.0');
 ipcMain.handle('get-notification-settings',()=>({enabled:true,onlyWhenUnfocused:true,inputRequired:true,approvalRequired:true}));ipcMain.handle('pull-requests-list',()=>({prs:[],fetchedAt:Date.now(),cached:false}));
 const win=new BrowserWindow({width:1280,height:820,show:true,titleBarStyle:'hidden',trafficLightPosition:{x:15,y:15},webPreferences:{backgroundThrottling:false,preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const until=async(code,label)=>{for(let i=0;i<120;i++){if(await js(code))return;await delay(75)}throw new Error('Timed out: '+label)};
 const click=async sel=>{await js('document.querySelector('+JSON.stringify(sel)+').click()');await delay(200)};
 const key=async(keyCode,modifiers=[])=>{win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(200)};
 const capture=async(tries=5)=>{try{return await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})}catch(error){if(tries<=1)throw error;await delay(300);return capture(tries-1)}};
 const shot=async name=>{await delay(200);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await capture()).toPNG())};
 const state=()=>js('(()=>{const s=qa.app.getState();return {settings:s.showSettings,workspace:s.activeWorkspace}})()');
 const openSettings=async()=>{await js('qa.app.getState().setShowSettings(true)');await until('!!document.querySelector("[data-settings-nav]")','Settings nav')};
 const settingsNav=label=>'[...document.querySelectorAll("[data-settings-nav] nav button")].find(b=>b.textContent==='+JSON.stringify(label)+')';
 const typeSearch=async value=>{await js('(()=>{const el=document.querySelector("[aria-label=\\"Search settings\\"]");el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event("input",{bubbles:true}))})()');await delay(200)};
 const back='button[aria-label="Back"]',forward='button[aria-label="Forward"]';
 try{
  await win.loadURL(process.env.QA_URL);
  try{win.webContents.debugger.attach('1.3')}catch{}
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await until('!!window.qa','renderer');await delay(800);await js('qa.seed()');await delay(400);
  await until('!!document.querySelector("nav[aria-label=Sections]")','rail');

  // History with somewhere to go forward: My Tasks → Pull Requests, then back to My Tasks.
  await js('[...document.querySelectorAll(".aegis-sidebar button")].find(b=>b.getAttribute("aria-label")==="My Tasks").click()');await until('qa.app.getState().activeWorkspace==="tasks"','My Tasks');
  await click('nav[aria-label="Sections"] button[aria-label="Pull Requests"]');await until('qa.app.getState().activeWorkspace==="prs"','Pull Requests');
  await click(back);await until('qa.app.getState().activeWorkspace==="tasks"','back to My Tasks');
  assert.equal(await js('document.querySelector('+JSON.stringify(forward)+').disabled'),false,'Forward is available before Settings');

  // Settings: the rail stays with nothing current; the sidebar panel holds the nav; the page is on the main sheet.
  await openSettings();
  const shell=await js('(()=>{const panel=document.querySelector(".aegis-sidebar-panel").getBoundingClientRect(),sheet=document.querySelector(".aegis-sheet").getBoundingClientRect();return {rail:!!document.querySelector("nav[aria-label=Sections]"),current:document.querySelector("nav[aria-label=Sections] [aria-current=page]")?.getAttribute("aria-label")??null,active:!!document.querySelector("[data-active-heading]"),inSheet:!!document.querySelector(".aegis-sheet .aegis-settings main h1"),joined:Math.round(sheet.left-panel.right),right:Math.round(innerWidth-sheet.right),bottom:Math.round(innerHeight-sheet.bottom),sidebarBottom:Math.round(innerHeight-panel.bottom)}})()');
  assert.deepEqual(shell,{rail:true,current:null,active:false,inSheet:true,joined:0,right:4,bottom:4,sidebarBottom:4});
  await shot('settings-general');

  // Forward is off in Settings: nothing moves behind the page. Back leaves for the view you came from.
  assert.equal(await js('document.querySelector('+JSON.stringify(forward)+').disabled'),true,'Forward is off in Settings');
  assert.equal(await js('document.querySelector('+JSON.stringify(back)+').disabled'),false,'Back is on in Settings');
  await js('document.querySelector('+JSON.stringify(forward)+').click()');await delay(200);
  assert.deepEqual(await state(),{settings:true,workspace:'tasks'},'Forward changes nothing behind Settings');
  await click(back);
  assert.deepEqual(await state(),{settings:false,workspace:'tasks'},'Back returns to where Settings opened');
  assert.equal(await js('document.querySelector('+JSON.stringify(forward)+').disabled'),false,'Forward history is intact after Settings');

  // The Back shortcut leaves too, but not while typing in the search.
  await openSettings();
  await typeSearch('');await key('[',['meta']);
  assert.equal((await state()).settings,true,'Back shortcut in the search box stays in Settings');
  await js('document.activeElement.blur()');await key('[',['meta']);
  assert.equal((await state()).settings,false,'Back shortcut leaves Settings');

  // A search lasts one visit: leaving clears it, so reopening starts on the page list.
  await openSettings();await typeSearch('term');
  await until('!!document.querySelector("[aria-label=\\"Settings search results\\"]")','search results');
  await click('nav[aria-label="Sections"] button[aria-label="Pull Requests"]');
  assert.deepEqual(await state(),{settings:false,workspace:'prs'},'the rail leaves Settings');
  await openSettings();
  assert.equal(await js('document.querySelector("[aria-label=\\"Search settings\\"]").value'),'','search is cleared');
  assert.equal(await js('!!document.querySelector("[data-settings-nav] nav[aria-label=Settings]")'),true,'the page list shows');

  // So does a revealed result: reopening the page does not jump to it again.
  await typeSearch('terminal');await until('!!document.querySelector("[aria-label=\\"Settings search results\\"] button")','terminal result');
  await js('document.querySelector("[aria-label=\\"Settings search results\\"] button").click()');
  await until('document.activeElement?.dataset?.settingsLabel==="Terminal shell"','revealed row');
  await click(back);
  await openSettings();await delay(300);
  assert.equal(await js('document.activeElement?.dataset?.settingsLabel??null'),null,'the old result is not revealed again');
  assert.equal(await js('!!document.querySelector("[data-search-match]")'),false);

  // Collapsed sidebar: the nav goes with it and the page fills the sheet; expanding brings it back.
  await js('qa.app.getState().setSidebarCollapsed(true)');await delay(450);
  const collapsed=await js('(()=>{const rail=document.querySelector("nav[aria-label=Sections]").getBoundingClientRect(),sheet=document.querySelector(".aegis-sheet").getBoundingClientRect();return {navHidden:document.querySelector(".aegis-sidebar-panel").getAttribute("aria-hidden")==="true",fills:Math.round(sheet.left-rail.right)<=1,toggle:!!document.querySelector("[data-main-titlebar] button[aria-label=\\"Back\\"]")}})()');
  assert.deepEqual(collapsed,{navHidden:true,fills:true,toggle:true});
  await shot('settings-collapsed');
  await js('qa.app.getState().setSidebarCollapsed(false)');await delay(450);
  assert.equal(await js('document.querySelector(".aegis-sidebar-panel").getAttribute("aria-hidden")'),'false');

  // The window's minimum width: every page fits beside the expanded nav.
  win.setContentSize(560,800);await delay(300);
  for(const label of ['General','Appearance','Keyboard shortcuts','Providers','MCP Servers']){
   await js(settingsNav(label)+'.click()');await delay(250);
   assert.equal(await js('(()=>{const m=document.querySelector(".aegis-settings main");return m.scrollWidth>m.clientWidth})()'),false,label+' fits at 560px');
   assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false,label+' does not widen the window');
  }
  await js(settingsNav('General')+'.click()');await shot('settings-min-width');
  console.log(JSON.stringify({ok:true}));app.exit(0);
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
    const timer = setTimeout(() => { child.kill(); reject(new Error('Settings shell QA timed out')); }, 120000);
    child.on('error', reject);
    child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  if (code !== 0) process.exitCode = 1;
} finally {
  await server?.close();
  await rm(tmp, { recursive: true, force: true });
}
