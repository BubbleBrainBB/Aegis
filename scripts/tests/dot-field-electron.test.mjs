// Themes with a dot-matrix backdrop, in the full app: picking Aurora (dark) or
// Hano (light) puts a canvas under the shell and turns the panels into tints
// over it; the new-task home leaves the dots sharp and a conversation frosts
// them; the picture moves, and rests while the open task is running or motion
// is off; the theme editor can change its strength and remove it.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const tmp = await mkdtemp(path.join(root, '.aegis-design-qa/dot-field-'));
const capture = path.join(root, 'output/playwright/dot-field');

const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AppearancePreferences} from '/src/ui/components/AppearancePreferences';
import {App} from '/src/ui/App';
import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';
window.addEventListener('blur',e=>e.stopImmediatePropagation(),true);
const reply='The dot field is painted by the page itself, so nothing is taken from the system. Panels only tint and blur what is behind them, which keeps long answers as readable as they are on a solid theme.';
window.qa={app:useAppStore,seed(){
 const a=useAppStore.getState();const draft=a.createDraftSession('/projects/coworker');const base=useAppStore.getState().sessions[draft];
 const now=Date.now();
 const messages=[{type:'user_prompt',prompt:'Does the sidebar keep its blur in fullscreen?',createdAt:now-60000},{type:'assistant',uuid:'a1',createdAt:now-50000,message:{role:'assistant',content:[{type:'text',text:[reply,reply,reply].join('\\n\\n')}]}}];
 useAppStore.setState({connected:true,sessionsLoaded:true,sidebarCollapsed:false,sidebarWidth:280,activeSessionId:'s1',sessions:{s1:{...base,id:'s1',isDraft:false,title:'Dot-matrix theme',cwd:'/projects/coworker',projectCwd:'/projects/coworker',provider:'claude',messages,permissionRequests:[],status:'completed',updatedAt:now,createdAt:now}}});
 useAppStore.getState().setActiveSession('s1');
},
// The dots canvas as a short fingerprint: equal strings mean the same picture.
picture(){const c=document.querySelector('.aegis-dot-field canvas:last-child');if(!c)return null;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let sum=0,lit=0;for(let i=3;i<d.length;i+=4){if(d[i]){lit++;sum=(sum+d[i]*(i%8191))%1000000007}}return lit+':'+sum}};
createRoot(document.getElementById('root')).render(<AppearancePreferences><App/></AppearancePreferences>);
`;

const main = String.raw`
const {app,BrowserWindow,ipcMain}=require('electron');
// CI runners have Reduce Motion on, which keeps the backdrop still; the test needs the default.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
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
 const win=new BrowserWindow({width:1440,height:900,show:true,titleBarStyle:'hidden',trafficLightPosition:{x:15,y:15},webPreferences:{backgroundThrottling:false,preload:path.join(root,'dist-electron/electron/preload.cjs')}});
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

  const root$=k=>js('document.documentElement.dataset['+JSON.stringify(k)+']||null');
  const style=(sel,prop)=>js('getComputedStyle(document.querySelector('+JSON.stringify(sel)+'))['+JSON.stringify(prop)+']');
  const pick=async(variant,preset)=>{await js('qa.app.getState().setTheme('+JSON.stringify(variant)+');qa.app.getState().setThemeVariantCodeThemeId('+JSON.stringify(variant)+','+JSON.stringify(preset)+')');await delay(500)};
  const home=async on=>{await js(on?'qa.app.getState().setShowNewSession(true)':'qa.app.getState().setShowNewSession(false);qa.app.getState().setActiveSession("s1")');await delay(400)};

  // A plain theme has no backdrop and no canvas.
  assert.equal(await root$('windowMaterial'),'solid');
  assert.equal(await js('!!document.querySelector(".aegis-dot-field")'),false,'no backdrop on a plain theme');

  // Aurora: the canvas sits under the shell and the picture is drawn.
  await pick('dark','aurora');
  assert.equal(await root$('windowMaterial'),'field');
  assert.equal(await root$('windowBackdrop'),'aurora');
  await until('!!qa.picture()&&Number(qa.picture().split(":")[0])>1000','aurora picture');
  assert.equal(await js('document.querySelectorAll(".aegis-dot-field canvas").length'),2,'aurora has a halo layer under its dots');
  assert.equal(await js('document.querySelector(".aegis-dot-field").parentElement.classList.contains("aegis-window-shell")'),true);
  assert.equal(await js('document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight'),false,'the canvas does not widen the window');

  // A conversation frosts the dots; the sidebar always does.
  assert.match(await style('.aegis-sheet','backdropFilter'),/blur\(30px\)/,'the reading sheet is frosted');
  assert.match(await style('.aegis-sidebar-panel','backdropFilter'),/blur\(28px\)/,'the sidebar is frosted');
  await until('document.body.innerText.includes("painted by the page itself")','the conversation is open');
  await shot('aurora-conversation');
  // The new-task home leaves them sharp.
  await home(true);
  await until('!!document.querySelector(".aegis-sheet .aegis-new-thread-landing")','home landing');
  assert.equal(await style('.aegis-sheet','backdropFilter'),'none','the home sheet is clear');
  await shot('aurora-home');

  // It moves; it rests while the open task runs, and when motion is off.
  const moves=async()=>{const before=await js('qa.picture()');await delay(1600);return before!==await js('qa.picture()')};
  assert.equal(await moves(),true,'the aurora moves');
  await home(false);
  await js('qa.app.setState(s=>({sessions:{...s.sessions,s1:{...s.sessions.s1,status:"running"}}}))');await delay(400);
  assert.equal(await moves(),false,'it rests while the open task is running');
  await js('qa.app.setState(s=>({sessions:{...s.sessions,s1:{...s.sessions.s1,status:"completed"}}}))');await delay(400);
  assert.equal(await moves(),true,'and picks up again after');
  await js('qa.app.getState().updateThemeVariant("dark",{backdropMotion:false})');await delay(400);
  assert.equal(await root$('backdropMotion'),'off');
  assert.equal(await moves(),false,'motion off keeps it still');
  await js('qa.app.getState().updateThemeVariant("dark",{backdropMotion:true})');await delay(300);

  // Strength, and turning it off, from the theme editor's own fields.
  await js('qa.app.getState().updateThemeVariant("dark",{backdropStrength:40})');await delay(300);
  assert.equal(await style('.aegis-dot-field','opacity'),'0.4');
  await js('qa.app.getState().updateThemeVariant("dark",{backdropStrength:100})');await delay(200);
  await js('qa.app.getState().updateThemeVariant("dark",{backdrop:undefined})');await delay(400);
  assert.equal(await root$('windowMaterial'),'solid','removing the backdrop returns to a plain window');
  assert.equal(await js('!!document.querySelector(".aegis-dot-field")'),false);
  await pick('dark','aurora');

  // The editor shows the controls.
  await js('qa.app.getState().setShowSettings(true)');await until('!!document.querySelector("[data-settings-nav]")','Settings nav');
  await js('[...document.querySelectorAll("[data-settings-nav] nav button")].find(b=>b.textContent==="Appearance").click()');await delay(400);
  await until('!!document.querySelector("[aria-label=\\"Dark Theme backdrop strength\\"]")','backdrop controls');
  assert.equal(await js('!!document.querySelector("[aria-label=\\"Dark Theme backdrop motion\\"]")'),true);
  await shot('aurora-settings');
  await js('qa.app.getState().setShowSettings(false)');await delay(300);

  // Hano: the light counterpart, contour lines in printed dots, no halo.
  await pick('light','hano');
  assert.equal(await root$('windowBackdrop'),'contour');
  await until('!!qa.picture()&&Number(qa.picture().split(":")[0])>1000','contour picture');
  assert.equal(await js('document.querySelectorAll(".aegis-dot-field canvas").length'),1,'printed dots have no halo');
  await home(false);await until('document.body.innerText.includes("painted by the page itself")','the conversation is open');
  await shot('hano-conversation');
  await home(true);await until('!!document.querySelector(".aegis-sheet .aegis-new-thread-landing")','home landing');
  await shot('hano-home');
  assert.equal(await moves(),true,'the contour lines move');

  // A different window size refits the grid.
  // (A small screen may not grant the size asked for, so compare with what the window got.)
  const before=await js('innerWidth+"x"+innerHeight');
  win.setContentSize(1000,700);await delay(600);
  assert.notEqual(await js('innerWidth+"x"+innerHeight'),before,'the window changed size');
  assert.equal(await js('(()=>{const c=document.querySelector(".aegis-dot-field canvas:last-child");const w=parseInt(c.style.width),h=parseInt(c.style.height);return w>=innerWidth&&w<innerWidth+6&&h>=innerHeight&&h<innerHeight+6})()'),true,'the grid covers the resized window');
  await shot('hano-home-small');
  assert.deepEqual(errors.filter(e=>!/No handler registered|Failed to load resource/.test(e)),[],'no renderer errors');
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
    const timer = setTimeout(() => { child.kill(); reject(new Error('Dot field QA timed out')); }, 120000);
    child.on('error', reject);
    child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  if (code !== 0) process.exitCode = 1;
} finally {
  await server?.close();
  await rm(tmp, { recursive: true, force: true });
}
