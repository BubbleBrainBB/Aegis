import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// My Tasks display options (the Kanban replacement): list and board, filters, Group by
// Project/State/Date, derived session states, PR glyphs and the Archived
// entry, rendered with the real components against fixture sessions.
// QA_CAPTURE=<dir> saves a screenshot of each view.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, 'dev-fixtures');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'sidebar-view-'));
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {TasksView} from '/src/ui/components/TasksView.tsx';
import {useAppStore} from '/src/ui/store/useAppStore.ts';
import {useSidebarViewStore} from '/src/ui/store/useSidebarViewStore.ts';
import '/src/ui/index.css';
const a=useAppStore.getState();const draft=a.createDraftSession('/projects/coworker');const base=useAppStore.getState().sessions[draft];
const now=Date.now();const min=60000;
const permission=[{toolUseId:'t1',toolName:'Bash',input:{command:'rm -rf build'}}];
const rows=[
 ['s1','Screenshot editor polish','coworker',{status:'running',permissionRequests:permission},2],
 ['s2','Kimi image upload via /files','bubble-cowork',{status:'error',runtimeNotice:'error'},30],
 ['s3','Sidebar filter replaces Kanban','coworker',{status:'running'},1],
 ['s4','Design canvas snapping','qoder',{status:'running',envMode:'worktree',worktreePath:'/projects/qoder/.worktrees/snap',associatedWorktreeBranch:'aegis/snap'},5],
 ['s5','Stream perf P3 batching','coworker',{status:'completed',runtimeNotice:'completed'},12],
 ['s6','Compaction activity trace','coworker',{status:'completed'},60*26],
 ['s7','Worktree apply-back flow','coworker',{status:'completed',envMode:'worktree',worktreePath:'/projects/coworker/.worktrees/apply',associatedWorktreeBranch:'aegis/apply'},60*50],
 ['s8','Narrow pane composer pickers','coworker',{status:'completed'},60*72],
 ['s9','Review loop triage rules','bubble-cowork',{status:'completed'},60*80],
 ['s10','Release checklist v0.0.62','coworker',{status:'completed',pinned:true},60*3],
 ['s11','Old archived research','coworker',{status:'completed'},60*24*3],
 ['s12','Legacy onboarding copy','qoder',{status:'completed'},60*24*60],
];
useAppStore.setState({sessions:Object.fromEntries(rows.map(([id,title,project,extra,age])=>[id,{...base,id,isDraft:false,title,cwd:'/projects/'+project,projectCwd:'/projects/'+project,provider:id==='s4'||id==='s6'||id==='s8'?'codex':'claude',messages:[],permissionRequests:[],status:'idle',envMode:'local',worktreePath:null,...extra,updatedAt:now-age*min,createdAt:now-age*min-1000}]))});
a.setActiveSession('s3');
window.qa={app:useAppStore,view:useSidebarViewStore};
function Harness(){
 const s=useAppStore();
 return <Tooltip.Provider><div style={{display:'flex',height:'100vh',background:'var(--bg-primary)'}}>
 {s.showSettings?<main/>:<TasksView/>}</div></Tooltip.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = `
const {app,BrowserWindow,ipcMain}=require('electron');
// CI runners have Reduce Motion on; tests expect the default motion preference.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
const root=process.env.QA_ROOT;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 ipcMain.on('get-ui-resume-state-sync',e=>{e.returnValue=null});ipcMain.on('renderer-state:get-all-sync',e=>{e.returnValue={}});ipcMain.on('save-ui-resume-state-sync',e=>{e.returnValue=true});
 ipcMain.on('renderer-state:set',()=>{});ipcMain.handle('set-theme',()=>{});
 ipcMain.handle('get-session-organization',()=>({sessions:{s9:{unread:false},s11:{archived:true}},sections:[],projectSources:{}}));
 const pr=(number,state,extra={})=>({number,title:'PR '+number,state,url:'https://github.com/o/r/pull/'+number,...extra});
 ipcMain.handle('list-sidebar-pull-requests',()=>({s6:[pr(40,'merged',{additions:12,deletions:3}),pr(41,'open')],s8:[pr(38,'merged')],s4:[pr(44,'open')]}));
 ipcMain.handle('get-git-branch',()=>({ok:true,branch:'master'}));ipcMain.handle('get-environment-editor-launchers',()=>[]);
 const win=new BrowserWindow({width:760,height:820,show:true,webPreferences:{backgroundThrottling:false,preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=code=>win.webContents.executeJavaScript(code,true);
 // Menus render a little later on CI runners: wait for the element instead of failing at once.
 // A runner screen shorter than the window shrinks it: scroll the target into view first.
 const point=async selector=>js('new Promise((resolve,reject)=>{const start=performance.now();const t=()=>{const e='+selector+';if(e){e.scrollIntoView({block:"nearest"});const r=e.getBoundingClientRect();resolve({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});return}if(performance.now()-start>5000){reject(Error("Missing element"));return}setTimeout(t,50)};t()})');
 const byText=text=>'[...document.querySelectorAll("[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],button")].find(e=>e.textContent.trim().startsWith('+JSON.stringify(text)+'))';
 const click=async selector=>{win.focus();win.webContents.focus();const p=await point(selector);win.webContents.sendInputEvent({type:'mouseMove',...p});win.webContents.sendInputEvent({type:'mouseDown',...p,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...p,button:'left',clickCount:1});await delay(220)};
 const hover=async selector=>{const p=await point(selector);win.webContents.sendInputEvent({type:'mouseMove',...p});await delay(420)};
 const screenshot=async name=>{if(!process.env.QA_CAPTURE)return;fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())};
 const rowIds=()=>js('[...document.querySelectorAll("[data-session-id]")].map(e=>e.dataset.sessionId)');
 const setView=patch=>js('qa.view.setState('+JSON.stringify(patch)+')').then(()=>delay(150));
 try{
  await win.loadURL(process.env.QA_URL);
  await js('new Promise((r,x)=>{const start=Date.now();const t=()=>document.querySelector("[data-session-id]")?r():Date.now()-start>30000?x(Error("No task rows")):setTimeout(t,50);t()})');await delay(400);

  assert.equal(await js('document.querySelector("[aria-label=\\\\"Display options\\\\"]")!==null'),true,'default options leave the trigger untinted');
  assert.equal(await js('qa.view.getState().groupBy'),'none','a flat list is the default');
  assert.equal(await js('qa.view.getState().sortBy'),'state','most urgent first is the default');

  // Group by Project: pinned on top, archived hidden behind the entry at the bottom.
  await js('qa.view.setState({groupBy:"project"})');await delay(200);
  assert.equal(await js('document.querySelector("[aria-label=\\\\"Display options (customized)\\\\"]")!==null'),true,'changed options tint the trigger');
  const projectRows=await rowIds();
  assert.equal(projectRows[0],'s10','pinned threads lead');
  assert.equal(projectRows.includes('s11'),false,'archived threads stay out of Active');
  assert.equal(await js(byText('Archived')+'!==undefined'),true);
  assert.equal(await js('!!document.querySelector("[data-session-id=s4] [aria-label^=\\\\"Pull request #44 · Open\\\\"]")'),true,'PR status shows on the row');
  assert.equal(await js('document.querySelector("[data-session-id=s6] [data-pull-request-count]").getAttribute("aria-label")'),'2 pull requests · 1 open, 1 merged','several PRs show a count');
  assert.equal(await js('document.querySelector("[data-session-id=s6] [data-pull-request-count]").textContent'),'2');
  // Hovering the glyph lists every PR the session opened.
  await hover('document.querySelector("[data-session-id=s6] [data-pull-request-count]")');
  const card=await js('new Promise(r=>{const t=()=>{const e=document.querySelector("[role=dialog][aria-label^=\\\\"2 pull requests\\\\"],[aria-label^=\\\\"2 pull requests\\\\"]:not([data-pull-request-count])");e?r(e.textContent):setTimeout(t,50)};t()})');
  for(const text of ['PR 40','Merged','o/r','#40','+12','−3','PR 41','Open','#41'])assert.ok(card.includes(text),'PR list shows '+text);
  await screenshot('1b-pr-list');
  await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  win.webContents.sendInputEvent({type:'mouseMove',x:700,y:800});await delay(400);
  assert.equal(await js('document.querySelector("[data-session-id=s1] [data-task-attention]").textContent'),'Run rm -rf build','a waiting task says what it wants');
  await screenshot('1-project');

  // The panel drives the same store, and stays open while its selects are used.
  const panel='document.querySelector("[data-task-display-menu]")';
  const panelOpen=async()=>{for(let i=0;i<40;i++){if(await js('!!'+panel))return true;await delay(50)}return false};
  await click('document.querySelector("[aria-label^=\\\\"Display options\\\\"]")');
  if(!await panelOpen()){await click('document.querySelector("[aria-label^=\\\\"Display options\\\\"]")');await panelOpen();}
  for(const label of ['List','Board','Grouping','Sub-grouping','Ordering','Completed tasks','Status','Show sub-sessions','Display properties','Pull requests'])assert.equal(await js(panel+'.textContent.includes('+JSON.stringify(label)+')'),true,'panel row '+label);
  await screenshot('2-menu');
  const pick=async(select,option)=>{await click('document.querySelector("[data-task-display-menu] [aria-label=\\\\"'+select+'\\\\"]")');await click('[...document.querySelectorAll("[role=menuitemradio]")].find(e=>e.textContent.trim()==='+JSON.stringify(option)+')');await delay(120)};
  await pick('Grouping','State');
  assert.equal(await js('qa.view.getState().groupBy'),'state');
  assert.equal(await js('!!'+panel),true,'choosing an option leaves the panel open');
  await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await delay(200);

  // Group by State: most urgent first, derived from live status, unread and PRs.
  const order=await js('[...document.querySelectorAll("[data-sidebar-state]")].map(e=>e.dataset.sidebarState)');
  assert.deepEqual(order,['needs-input','running','review','completed']);
  const members=async state=>js('[...document.querySelectorAll("[data-sidebar-state='+state+'] [data-session-id]")].map(e=>e.dataset.sessionId).sort()');
  assert.deepEqual(await members('needs-input'),['s1','s2']);
  assert.deepEqual(await members('running'),['s3','s4']);
  assert.deepEqual(await members('review'),['s5','s6','s7'],'unseen result, open PR and live worktree wait on review');
  assert.deepEqual(await members('completed'),['s10','s12','s8','s9'].sort(),'Completed starts open; a merged PR lands in it');
  assert.equal(await js('document.querySelector("[data-session-id=s5] [data-task-project]").textContent'),'coworker','rows name their project');
  await screenshot('3-state');

  // Settings unmounts the list; coming back keeps what was folded.
  const openAndCloseSettings=async()=>{
    await js('qa.app.setState({showSettings:true})');await delay(200);
    assert.equal(await js('!!document.querySelector("[data-sidebar-state]")'),false,'Settings unmounts the list');
    await js('qa.app.setState({showSettings:false})');await delay(200);
  };
  await click('document.querySelector("[data-sidebar-state=completed] button")');
  assert.deepEqual(await members('completed'),[],'the header folds a group');
  await openAndCloseSettings();
  assert.deepEqual(await members('completed'),[],'a fold survives Settings');
  await click('document.querySelector("[data-sidebar-state=completed] button")');
  assert.equal((await members('completed')).length,4,'unfolding lists the whole group');

  // A new task nothing was sent from yet is in no list at all, and New Task goes back to it.
  await js('(()=>{const s=qa.app.getState().sessions;qa.app.setState({sessions:{...s,d1:{...s.s8,id:"d1",title:"New Chat",isDraft:true,status:"idle",updatedAt:Date.now()}}})})()');await delay(200);
  assert.equal((await rowIds()).includes('d1'),false,'a draft is not listed');
  assert.equal(await js('!!document.querySelector("[data-sidebar-state=draft]")'),false);
  await js('(()=>{const {d1,...s}=qa.app.getState().sessions;qa.app.setState({sessions:s})})()');await delay(200);

  const opened=await js('(()=>{const a=qa.app.getState();const first=a.openDraftSession("/projects/reuse");const again=qa.app.getState().openDraftSession("/projects/reuse");const other=qa.app.getState().openDraftSession("/projects/other");const detached=qa.app.getState().createDetachedDraftSession("/projects/design","New chat");const notDetached=qa.app.getState().openDraftSession("/projects/design");const s=qa.app.getState().sessions;const counts=Object.values(s).filter(x=>x.isDraft&&x.cwd==="/projects/reuse").length;const res={first,again,other,detached,notDetached,counts,active:qa.app.getState().activeSessionId};const rest=Object.fromEntries(Object.entries(s).filter(([id])=>![first,other,detached,notDetached].includes(id)));qa.app.setState({sessions:rest});return res})()');await delay(200);
  assert.equal(opened.again,opened.first,'New Task goes back to the unsent chat of that folder');
  assert.equal(opened.counts,1,'empty chats do not pile up');
  assert.notEqual(opened.other,opened.first,'another folder has its own');
  assert.notEqual(opened.notDetached,opened.detached,'a draft another view owns is left alone');
  assert.equal(opened.active,opened.notDetached);
  await js('qa.app.getState().setActiveSession("s3")');await delay(150);

  // A project folds, and the fold outlives Settings.
  await setView({groupBy:'project'});
  const projectHeader='document.querySelector("button[title=\\\\"/projects/coworker\\\\"][aria-expanded]")';
  const projectOpen=()=>js(projectHeader+'.getAttribute("aria-expanded")==="true"');
  await click(projectHeader);
  assert.equal(await projectOpen(),false,'the header folds a project');
  await openAndCloseSettings();
  assert.equal(await projectOpen(),false,'that fold survives Settings');
  await click(projectHeader);
  assert.equal(await projectOpen(),true);

  // Group by Date: every session has a bucket, old ones by month.
  await setView({groupBy:'date'});
  const dateHeaders=await js('[...document.querySelectorAll("[data-task-group]")].map(e=>e.dataset.taskGroup)');
  assert.ok(dateHeaders.includes('date:Today'));
  assert.equal((await rowIds()).includes('s12'),true,'sessions older than a week still appear');
  await screenshot('4-date');

  // Filters compose: activity window, project, status.
  await setView({activity:'7d'});
  assert.equal((await rowIds()).includes('s12'),false,'the window hides completed tasks older than it');
  await setView({activity:'1d'});
  assert.equal((await rowIds()).includes('s2'),true,'and never what is still open');
  await setView({activity:'all'});
  await setView({activity:'all',project:'/projects/bubble-cowork',groupBy:'none'});
  assert.deepEqual((await rowIds()).sort(),['s2','s9']);
  await setView({project:null,groupBy:'project'});
  await click(byText('Archived'));
  assert.equal(await js('qa.view.getState().status'),'archived');
  assert.deepEqual(await rowIds(),['s11']);
  await screenshot('5-archived');
  await click(byText('Back to active tasks'));
  assert.equal(await js('qa.view.getState().status'),'active');

  // Display properties.
  const allProperties=await js('qa.view.getState().properties');
  await setView({groupBy:'none',properties:allProperties.filter(p=>p!=='pull-requests')});
  assert.equal(await js('!!document.querySelector("[aria-label^=\\\\"Pull request #\\\\"],[data-pull-request-count]")'),false);
  await setView({properties:allProperties.filter(p=>p!=='project'&&p!=='agent'&&p!=='date'&&p!=='summary')});
  for(const hidden of ['[data-task-project]','[data-task-provider]','[data-task-date]','[data-task-attention]'])assert.equal(await js('!!document.querySelector('+JSON.stringify(hidden)+')'),false,hidden);
  await setView({properties:allProperties});

  // More ways to group, and a second level.
  const groupKeys=()=>js('[...document.querySelectorAll("[data-task-group]")].map(e=>e.dataset.taskGroup)');
  await setView({groupBy:'agent'});
  assert.deepEqual((await groupKeys()).sort(),['agent:claude','agent:codex']);
  await setView({groupBy:'pull-request'});
  assert.deepEqual(await groupKeys(),['pull-request:open','pull-request:merged','pull-request:none'],'open first, and tasks without one last');
  await setView({groupBy:'state',subGroupBy:'project'});
  assert.equal(await js('!!document.querySelector("[data-task-subgroup=\\\\"state:needs-input//projects/coworker\\\\"] button")'),true,'subgroups sit under their group');
  assert.equal(await js('!!document.querySelector("[data-task-project]")'),false,'a project subgroup does not repeat its name on each row');
  await screenshot('6-subgroup');
  await click('document.querySelector("[data-task-subgroup=\\\\"state:needs-input//projects/coworker\\\\"] button")');
  assert.equal(await js('!!document.querySelector("[data-task-group=\\\\"state:needs-input\\\\"] [data-session-id=s1]")'),false,'a subgroup folds');
  await setView({subGroupBy:'state'});
  assert.equal(await js('!!document.querySelector("[data-task-subgroup]")'),false,'a subgroup the same as its group is no subgroup');
  await setView({subGroupBy:'none',showEmptyGroups:true});
  await js('(()=>{const s=qa.app.getState().sessions;window.__allSessions=s;qa.app.setState({sessions:Object.fromEntries(Object.entries(s).filter(([id])=>id==="s5"))})})()');await delay(150);
  assert.deepEqual(await groupKeys(),['state:needs-input','state:running','state:review','state:completed'],'empty state groups stay listed when asked');
  await setView({showEmptyGroups:false});
  assert.deepEqual(await groupKeys(),['state:review']);

  // The board: same tasks and groups, in columns.
  await js('qa.app.setState({sessions:window.__allSessions})');await delay(150);
  await setView({layout:'board',groupBy:'none',status:'active'});
  const columns=()=>js('[...document.querySelectorAll("[data-task-column]")].map(e=>e.dataset.taskColumn)');
  assert.deepEqual(await columns(),['state:needs-input','state:running','state:review','state:completed'],'No grouping on a board means columns by state');
  assert.equal(await js('!!document.querySelector("[data-task-list]")'),false);
  assert.equal(await js('document.querySelector("[data-task-column=\\\\"state:needs-input\\\\"] [data-session-id=s1] [data-task-attention]").textContent'),'Run rm -rf build');
  assert.equal(await js('document.querySelector("[data-session-id=s5] [data-task-project]").textContent'),'coworker');
  await screenshot('7-board');
  await setView({groupBy:'project',subGroupBy:'state'});
  assert.ok((await columns()).includes('/projects/qoder'),'any grouping makes columns');
  assert.equal(await js('!!document.querySelector("[data-task-column=\\\\"/projects/qoder\\\\"] [data-task-subgroup]")'),true,'and sub-grouping splits a column');
  assert.equal(await js('!!document.querySelector("[data-session-id=s5] [data-task-project]")'),false,'a project column does not repeat its name');
  await screenshot('8-board-project');
  await setView({subGroupBy:'none',groupBy:'none'});
  await click('document.querySelector("[aria-label^=\\\\"Display options\\\\"]")');await panelOpen();
  assert.equal(await js(panel+'.textContent.includes("Columns")'),true,'on a board the first row names the columns');
  await click('document.querySelector("[data-task-display-menu] [aria-label=\\\\"Columns\\\\"]")');
  await delay(200);
  assert.equal(await js('[...document.querySelectorAll("[role=menuitemradio]")].some(e=>e.textContent.trim()==="No grouping")'),false,'a board always has columns');
  await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await delay(200);
  await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await delay(200);
  await click('document.querySelector("[data-session-id=s5]")');
  assert.equal(await js('qa.app.getState().activeSessionId'),'s5','a card opens its task');
  await setView({layout:'list'});

  assert.deepEqual(errors.filter(e=>!/No handler registered/.test(e)),[]);
  console.log(JSON.stringify({ok:true,checks:['project grouping with pinned and archived entry','view menu rows and submenu','derived state groups','group folds survive Settings','date buckets','completed window, project and status filters','display properties','agent, PR and sub-grouping','board columns, cards and sub-grouping']}));
  app.exit(0);
 }catch(e){console.error(e);console.error(errors);await screenshot('failure');app.exit(1)}
});
`;
let server;
try {
  await writeFile(path.join(tmp, 'index.html'), '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  // Own dep cache: sharing node_modules/.vite breaks a running dev server.
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
  console.log('Sidebar view Electron regression passed');
} finally { await server?.close(); await rm(tmp, { recursive: true, force: true }); }
