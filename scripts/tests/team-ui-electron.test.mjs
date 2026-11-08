import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// Team, rendered with the real components against fixtures: Team's tasks are
// top-level rows in Active with their own tasks nested under them, Team itself
// is not a task, the add/move lines in the chat, and Settings › Team (agents,
// editing a description). QA_CAPTURE=<dir> saves screenshots.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, 'dev-fixtures');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'team-ui-'));
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {SidebarActiveTasks} from '/src/ui/components/sidebar/SidebarActiveTasks.tsx';
import {TeamTaskLine} from '/src/ui/components/follow-up/TeamTaskLine.tsx';
import {TeamSettingsContent} from '/src/ui/components/settings/TeamSettings.tsx';
import {useAppStore} from '/src/ui/store/useAppStore.ts';
import {useFollowUpStore} from '/src/ui/store/useFollowUpStore.ts';
import '/src/ui/index.css';
const a=useAppStore.getState();const draft=a.createDraftSession('/projects/coworker');const base=useAppStore.getState().sessions[draft];
const now=Date.now();const min=60000;
const rows=[
 ['team','Team',{status:'idle'},0],
 ['t1','Fix black screen after rotation',{status:'running'},2],
 ['t2','Bump Electron to 39',{status:'running'},18],
 ['s1','Fix Windows build on Electron 39',{status:'running'},6],
 ['p1','Embedded iOS simulator integration',{status:'running'},40],
];
useAppStore.setState({teamSessionId:'team',sessions:Object.fromEntries(rows.map(([id,title,extra,age])=>[id,{...base,id,isDraft:false,title,cwd:'/projects/coworker',projectCwd:'/projects/coworker',provider:'claude',messages:[],permissionRequests:[],envMode:'local',worktreePath:null,...extra,updatedAt:now-age*min,createdAt:now-age*min-1000}]))});
const view=(id,parent,child,title,provider)=>({id,revision:2,kind:'session',parentSessionId:parent,toolUseId:'tu-'+id,title,reason:'',plan:'',acceptanceCriteria:'',provider,model:null,permissionMode:null,status:'started',childSessionId:child,place:'worktree',worktreeBranch:null,baseRef:null,lastError:null,detachedAt:null,reports:[],createdAt:now,updatedAt:now});
const proposals=[view('f1','team','t1','Fix black screen after rotation','claude'),view('f2','team','t2','Bump Electron to 39','claude'),view('f3','t2','s1','Fix Windows build on Electron 39','codex')];
useFollowUpStore.setState({loaded:true,proposals:Object.fromEntries(proposals.map(p=>[p.id,p]))});
window.qa={app:useAppStore};
function Harness(){
 return <Tooltip.Provider><div style={{display:'flex',height:'100vh',background:'var(--bg-primary)'}}>
 <aside className="aegis-sidebar" style={{width:250,flexShrink:0,padding:8,background:'var(--app-sidebar-panel)'}}><SidebarActiveTasks/></aside>
 <main style={{flex:1,padding:'20px 28px',overflow:'auto'}}>
  <div data-qa="lines" style={{maxWidth:560}}>
   <TeamTaskLine toolName="mcp__aegis-sessions__add_to_task" input={{task:'t1',message:'Also cover quitting'}} resultText={JSON.stringify({sessionId:'t1',title:'Fix black screen after rotation'})} failed={false} pending={false}/>
   <TeamTaskLine toolName="move_task" input={{task:'t1',provider:'codex'}} resultText={JSON.stringify({sessionId:'t1',title:'Fix black screen after rotation'})} failed={false} pending={false}/>
   <TeamTaskLine toolName="move_task" input={{task:'Nope',provider:'kimi'}} resultText="Kimi Code can't take work right now" failed={true} pending={false}/>
  </div>
  <div style={{maxWidth:768,marginTop:24}}><TeamSettingsContent/></div>
 </main></div></Tooltip.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = `
const {app,BrowserWindow,ipcMain}=require('electron');
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
const root=process.env.QA_ROOT;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let prefs={team:{coordinator:{provider:'claude',model:''},fallback:{provider:null,model:''},askWhenUnsure:true,agents:{
 claude:{enabled:true,description:'Engineering, debugging, UI work and anything that needs judgement.'},
 codex:{enabled:true,description:'Routine fixes, reports, monitoring and first-pass reviews.'},
 deepseek:{enabled:false,description:''}}}};
app.whenReady().then(async()=>{
 ipcMain.on('get-ui-resume-state-sync',e=>{e.returnValue=null});ipcMain.on('renderer-state:get-all-sync',e=>{e.returnValue={}});ipcMain.on('save-ui-resume-state-sync',e=>{e.returnValue=true});
 ipcMain.on('renderer-state:set',()=>{});ipcMain.handle('set-theme',()=>{});
 ipcMain.handle('get-session-organization',()=>({sessions:{},sections:[],projectSources:{}}));
 ipcMain.handle('list-sidebar-pull-requests',()=>({}));
 ipcMain.handle('follow-up-list',()=>[]);
 ipcMain.handle('get-app-preferences',()=>prefs);
 ipcMain.handle('set-app-preferences',(_e,patch)=>{prefs={...prefs,...patch};return prefs});
 ipcMain.handle('team-candidates',()=>[
  {provider:'claude',label:'Claude Code',unavailable:null},{provider:'codex',label:'Codex',unavailable:null},
  {provider:'deepseek',label:'DeepSeek Harness',unavailable:null},{provider:'kimi',label:'Kimi Code',unavailable:'not signed in'},
  {provider:'grok',label:'Grok Build',unavailable:'not installed or not working'}]);
 ipcMain.handle('team-models',(_e,provider)=>provider==='claude'?[{id:'haiku',label:'Haiku (latest)'},{id:'opus',label:'Opus (latest)'}]:[]);
 const win=new BrowserWindow({width:1240,height:900,show:true,webPreferences:{backgroundThrottling:false,preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const screenshot=async name=>{if(!process.env.QA_CAPTURE)return;fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())};
 const text=selector=>js('(document.querySelector('+JSON.stringify(selector)+')||{}).textContent||""');
 try{
  await win.loadURL(process.env.QA_URL);
  await js('new Promise(r=>{const t=()=>document.querySelector("[data-team-settings]")&&document.querySelector("[data-active-tasks]")?r():setTimeout(t,50);t()})');await delay(500);

  // Active: Team is not a task; its tasks are top-level, and a task's own tasks nest under it.
  const ids=await js('[...document.querySelectorAll("[data-active-tasks] [data-session-id]")].map(e=>e.dataset.sessionId)');
  assert.ok(!ids.includes('team'),'Team itself is not listed: '+ids);
  assert.ok(ids.includes('t1')&&ids.includes('t2'),'Team tasks are listed: '+ids);
  assert.equal(await js('!!document.querySelector("[data-active-family=t2] [data-session-id=s1]")'),true,'a split-off task nests under its task');
  assert.equal(await js('!!document.querySelector("[data-active-family=team]")'),false,'nothing nests under Team');

  // Lines in the chat.
  const lines=await js('[...document.querySelectorAll("[data-team-task-line]")].map(e=>e.textContent)');
  assert.equal(lines[0],'Added to Fix black screen after rotation');
  assert.equal(lines[1],'Moved Fix black screen after rotation to Codex');
  assert.equal(lines[2],'Could not move Nope to Kimi Code');

  // Settings: ready agents listed, skipped ones named.
  const agents=await js('[...document.querySelectorAll("[data-team-agent]")].map(e=>e.dataset.teamAgent)');
  assert.deepEqual(agents,['claude','codex','deepseek'],'ready agents only');
  assert.match(await text('[data-team-agent=deepseek]'),/Not in Team/);
  assert.match(await text('[data-settings-label="Skipped automatically"]'),/Kimi Code \\(not signed in\\)/);
  assert.doesNotMatch(await text('[data-settings-label="Skipped automatically"]'),/Grok/,'uninstalled agents are not named');
  await screenshot('1-team');
  // Editing a description saves it.
  await js('[...document.querySelectorAll("[data-team-agent=codex] button")].find(b=>b.textContent==="Edit").click()');await delay(150);
  await js('(()=>{const t=document.querySelector("[data-team-agent=codex] textarea");const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;set.call(t,"Routine fixes and reports.");t.dispatchEvent(new Event("input",{bubbles:true}))})()');await delay(100);
  await js('[...document.querySelectorAll("[data-team-agent=codex] button")].find(b=>b.textContent==="Save").click()');await delay(300);
  assert.equal(prefs.team.agents.codex.description,'Routine fixes and reports.');
  await screenshot('2-team-edited');
  assert.deepEqual(errors.filter(e=>!/No handler registered|Unable to load preload|ENOENT/.test(e)),[]);
  console.log(JSON.stringify({ok:true}));
  app.exit(0);
 }catch(e){console.error(e);console.error(errors);await screenshot('failure');app.exit(1)}
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
  await new Promise((resolve, reject) => {
    const env = { ...process.env, QA_ROOT: root, QA_URL: url, DEV_SERVER_URL: server.resolvedUrls.local[0] };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.env.QA_ELECTRON_EXECUTABLE || path.join(root, 'node_modules/.bin/electron'), [path.join(tmp, 'main.cjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; process.stdout.write(c); });
    child.stderr.on('data', (c) => { err += c; process.stderr.write(c); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Timed out\n' + out + '\n' + err)); }, 120000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timeout); code === 0 && out.includes('"ok":true') ? resolve() : reject(new Error(out + '\n' + err)); });
  });
  console.log('Team UI Electron regression passed');
} finally { await server?.close(); await rm(tmp, { recursive: true, force: true }); }
