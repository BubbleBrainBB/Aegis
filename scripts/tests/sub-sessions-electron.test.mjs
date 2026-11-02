import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// Sub-sessions (start_session): nesting under the top session in the
// sidebar with a fold and its summary, and in the chat the session row, the
// finished line, the brief and the breadcrumb, rendered with the real
// components against fixture sessions. QA_CAPTURE=<dir> saves screenshots.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, 'dev-fixtures');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'sub-sessions-'));
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {FolderTreeView} from '/src/ui/components/FolderTreeView.tsx';
import {SubSessionCard} from '/src/ui/components/follow-up/SubSessionCard.tsx';
import {SubSessionBriefCard, SubSessionsFinishedRow} from '/src/ui/components/follow-up/SubSessionPromptRows.tsx';
import {SessionTitleActions} from '/src/ui/components/SessionTitleActions.tsx';
import {useAppStore} from '/src/ui/store/useAppStore.ts';
import {useFollowUpStore} from '/src/ui/store/useFollowUpStore.ts';
import {useSidebarViewStore} from '/src/ui/store/useSidebarViewStore.ts';
import '/src/ui/index.css';
const a=useAppStore.getState();const draft=a.createDraftSession('/projects/coworker');const base=useAppStore.getState().sessions[draft];
const now=Date.now();const min=60000;
const rows=[
 ['p1','Usage settings redesign',{status:'idle'},0],
 ['c1','Fix empty export file names',{status:'running'},3],
 ['c2','Add ClaudeUsageSettings tests',{status:'completed',envMode:'worktree',worktreePath:'/projects/coworker/.worktrees/tests',associatedWorktreeBranch:'aegis/iso/usage-settings-tests'},4],
 ['g1','Refresh settings screenshots',{status:'running'},1],
 ['d1','Detached cleanup',{status:'completed'},6],
 ['o1','Devin ACP effort passthrough',{status:'completed'},60],
];
useAppStore.setState({sessions:Object.fromEntries(rows.map(([id,title,extra,age])=>[id,{...base,id,isDraft:false,title,cwd:'/projects/coworker',projectCwd:'/projects/coworker',provider:'claude',messages:[],permissionRequests:[],envMode:'local',worktreePath:null,...extra,updatedAt:now-age*min,createdAt:now-age*min-1000}]))});
a.setActiveSession('p1');
const view=(id,extra)=>({id,revision:2,kind:'session',parentSessionId:'p1',toolUseId:'tu-'+id,title:'',reason:'',plan:'',acceptanceCriteria:'',provider:'claude',model:null,permissionMode:null,status:'started',childSessionId:null,place:'shared',worktreeBranch:null,baseRef:null,lastError:null,detachedAt:null,reports:[],createdAt:now,updatedAt:now,...extra});
const proposals=[
 view('f1',{title:'Fix empty export file names',childSessionId:'c1'}),
 view('f2',{title:'Add ClaudeUsageSettings tests',childSessionId:'c2',place:'worktree',worktreeBranch:'aegis/iso/usage-settings-tests',reports:[{eventId:'e1',turnStatus:'completed',summary:'Six tests added.',createdAt:now,deliveredAt:now}]}),
 view('f3',{parentSessionId:'c1',title:'Refresh settings screenshots',childSessionId:'g1'}),
 view('f4',{title:'Detached cleanup',childSessionId:'d1',detachedAt:now}),
 view('f5',{title:'Bump the relay',status:'start_failed',lastError:'The starting session has no folder to share.'}),
];
useFollowUpStore.setState({loaded:true,proposals:Object.fromEntries(proposals.map(p=>[p.id,p]))});
useSidebarViewStore.setState({groupBy:'project'});
window.qa={app:useAppStore,followUps:useFollowUpStore,view:useSidebarViewStore};
const ok=id=>JSON.stringify({proposalId:id});
function Harness(){
 const s=useAppStore();
 return <Tooltip.Provider><div style={{display:'flex',height:'100vh',background:'var(--bg-primary)'}}>
 <aside style={{width:290,padding:'12px 8px',background:'var(--app-sidebar-surface)',overflow:'auto'}}>
  <FolderTreeView projectCwd="/projects/coworker" onSessionClick={s.setActiveSession} onSelectProjectFolder={()=>{}} onNewSessionForProject={()=>{}} />
 </aside>
 <main style={{flex:1,padding:'20px 28px',overflow:'auto',fontSize:14}}>
  <div data-qa="crumb" style={{fontSize:15,marginBottom:16}}><SessionTitleActions session={s.sessions.c1} showMenu={false}/></div>
  <SubSessionCard toolUseId="tu-f1" input={{title:'Fix empty export file names'}} resultText={ok('f1')} failed={false}/>
  <SubSessionCard toolUseId="tu-f2" input={{title:'Add ClaudeUsageSettings tests'}} resultText={ok('f2')} failed={false}/>
  <SubSessionCard toolUseId="tu-f5" input={{title:'Bump the relay'}} resultText="The session could not start" failed={true}/>
  <SubSessionCard toolUseId="tu-none" input={{title:'Not allowed'}} resultText="Only the user can ask for a new session here." failed={true}/>
  <SubSessionsFinishedRow text="Sub-sessions finished: Fix empty export file names · Add ClaudeUsageSettings tests"/>
  <SubSessionBriefCard sessionId="c1" createdAt={now-2*86400000} text={'Fix the empty export file name.\\n\\n- buildFileName falls back to **Untitled · date**\\n- add a unit test'}/>
 </main></div></Tooltip.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = `
const {app,BrowserWindow,ipcMain}=require('electron');
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
const root=process.env.QA_ROOT;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 ipcMain.on('get-ui-resume-state-sync',e=>{e.returnValue=null});ipcMain.on('renderer-state:get-all-sync',e=>{e.returnValue={}});ipcMain.on('save-ui-resume-state-sync',e=>{e.returnValue=true});
 ipcMain.on('renderer-state:set',()=>{});ipcMain.handle('set-theme',()=>{});
 ipcMain.handle('get-session-organization',()=>({sessions:{},sections:[],projectSources:{}}));
 ipcMain.handle('list-sidebar-pull-requests',()=>({}));
 ipcMain.handle('get-git-branch',()=>({ok:true,branch:'master'}));ipcMain.handle('get-environment-editor-launchers',()=>[]);
 ipcMain.handle('follow-up-list',()=>[]);
 const win=new BrowserWindow({width:1100,height:760,show:true,webPreferences:{backgroundThrottling:false,preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const point=async selector=>js('new Promise((resolve,reject)=>{const start=performance.now();const t=()=>{const e='+selector+';if(e){const r=e.getBoundingClientRect();resolve({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});return}if(performance.now()-start>5000){reject(Error("Missing element"));return}setTimeout(t,50)};t()})');
 const click=async selector=>{win.focus();win.webContents.focus();const p=await point(selector);win.webContents.sendInputEvent({type:'mouseMove',...p});win.webContents.sendInputEvent({type:'mouseDown',...p,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...p,button:'left',clickCount:1});await delay(220)};
 const screenshot=async name=>{if(!process.env.QA_CAPTURE)return;fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())};
 const rowIds=()=>js('[...document.querySelectorAll("[data-session-id]")].map(e=>e.dataset.sessionId)');
 const text=selector=>js('(document.querySelector('+JSON.stringify(selector)+')||{}).textContent||""');
 try{
  await win.loadURL(process.env.QA_URL);
  await js('new Promise(r=>{const t=()=>document.querySelector("[data-session-id]")?r():setTimeout(t,50);t()})');await delay(400);
  win.webContents.sendInputEvent({type:'mouseMove',x:1090,y:750});await delay(200);

  // Sidebar: children (and the grandchild) one level under the top session; a detached one stands alone.
  const nested=await js('[...document.querySelectorAll("[data-sub-sessions-of=p1] [data-session-id]")].map(e=>e.dataset.sessionId).sort()');
  assert.deepEqual(nested,['c1','c2','g1'],'sub-sessions nest under the top session, grandchildren included');
  assert.equal(await js('!!document.querySelector("[data-sub-sessions-of=c1]")'),false,'no second level');
  const ids=await rowIds();
  assert.ok(ids.indexOf('p1')<ids.indexOf('c1'),'children follow their parent');
  assert.equal(await js('!!document.querySelector("[data-sub-sessions-of] [data-session-id=d1]")'),false,'a detached session is top level');
  assert.equal(ids.filter(id=>id==='c1').length,1,'listed once');

  // Chat: running, done (with its branch) and failed rows; a refused call is a quiet line.
  const label=selector=>js('(document.querySelector('+JSON.stringify(selector)+')||{}).getAttribute?.("aria-label")||""');
  const hint=selector=>js('(document.querySelector('+JSON.stringify(selector)+')||{}).title||""');
  assert.equal(await text('[data-sub-session=f1]'),'Fix empty export file namescoworkerRunning','the row is the task, its project and where it stands');
  assert.equal(await label('[data-sub-session=f1]'),'Fix empty export file names · coworker · Running');
  assert.equal(await hint('[data-sub-session=f1]'),'Running · Shares this folder');
  assert.equal(await label('[data-sub-session=f2]'),'Add ClaudeUsageSettings tests · coworker · Ready for review');
  assert.equal(await hint('[data-sub-session=f2]'),'Ready for review · aegis/iso/usage-settings-tests');
  const mark=id=>js('document.querySelector("[data-sub-session='+id+'] [data-sub-session-mark]").dataset.subSessionMark');
  assert.equal(await mark('f1'),'working','a running task spins');
  assert.equal(await js('!!document.querySelector("[data-sub-session=f1] [data-sub-session-mark] svg.animate-spin")'),true);
  assert.equal(await mark('f2'),'review','work left in a worktree waits for review');
  const rect=sel=>js('(()=>{const r=document.querySelector('+JSON.stringify(sel)+').getBoundingClientRect();return {top:r.top,bottom:r.bottom}})()');
  assert.equal((await rect('[data-sub-session=f1]')).bottom,(await rect('[data-sub-session=f2]')).top,'tasks of one batch join into one card');
  assert.match(await text('[data-sub-session=f5]'),/no folder to share[\\s\\S]*Retry/);
  await click('document.querySelector("[data-sub-session=f2]")');
  assert.equal(await js('qa.app.getState().activeSessionId'),'c2','the row opens the session');
  assert.ok((await js('document.querySelector("main").textContent')).includes('Session not started: Only the user can ask'),'a refused start reads as a line');
  assert.match(await text('[data-sub-sessions-finished]'),/^2 sub-sessions finished$/);
  assert.match(await text('[data-sub-session-brief]'),/Started by Claude Code from[\\s\\S]*Usage settings redesign[\\s\\S]*Task[\\s\\S]*Fix empty export file names[\\s\\S]*Untitled · date/);
  assert.equal(await text('[data-session-parent-crumb]'),'Usage settings redesign','the breadcrumb names the parent');
  await screenshot('1-expanded');

  // Fold: the parent row sums its sub-sessions up (2 of 3 still running).
  await click('document.querySelector("[data-session-id=p1] [aria-label=\\\\"Hide sub-sessions\\\\"]")');
  assert.equal(await js('!!document.querySelector("[data-sub-sessions-of=p1]")'),false,'folded');
  assert.equal(await js('document.querySelector("[data-session-id=p1] [title=\\\\"2 of 3 sub-sessions running\\\\"]").textContent'),'1/3');
  await screenshot('2-folded');

  // A task that needs you unfolds its conversation; folded over that wait, the mark turns amber.
  await js('qa.app.setState(s=>({sessions:{...s.sessions,g1:{...s.sessions.g1,permissionRequests:[{toolUseId:"t",toolName:"Bash",input:{}}]}}}))');await delay(150);
  assert.equal(await js('!!document.querySelector("[data-sub-sessions-of=p1]")'),true,'a wait unfolds it');
  await click('document.querySelector("[data-session-id=p1] [aria-label=\\\\"Hide sub-sessions\\\\"]")');
  assert.equal(await js('!!document.querySelector("[data-sub-sessions-of=p1]")'),false,'it can be folded over that wait');
  assert.equal(await js('!!document.querySelector("[data-session-id=p1] [aria-label=\\\\"A sub-session needs you\\\\"]")'),true);
  // ...until another task needs you.
  await js('qa.app.setState(s=>({sessions:{...s.sessions,c1:{...s.sessions.c1,permissionRequests:[{toolUseId:"u",toolName:"Bash",input:{}}]}}}))');await delay(150);
  assert.equal(await js('!!document.querySelector("[data-sub-sessions-of=p1]")'),true,'a new wait unfolds it again');
  await js('qa.app.setState(s=>({sessions:{...s.sessions,c1:{...s.sessions.c1,permissionRequests:[]}}}))');await delay(150);
  assert.equal(await js('!!document.querySelector("[data-sub-sessions-of=p1]")'),false,'that wait over, the fold is back');

  // By state: the conversation sits with its most urgent task, its tasks under it.
  await js('qa.view.setState({groupBy:"state"})');await delay(200);
  const inState=state=>js('[...document.querySelectorAll("[data-sidebar-state='+state+'] [data-session-id]")].map(e=>e.dataset.sessionId)');
  assert.deepEqual(await inState('needs-input'),['p1'],'g1 waits, so p1 stands in Needs input, folded');
  assert.equal(await js('!!document.querySelector("[data-sidebar-state=needs-input] [data-sub-sessions-of=p1]")'),false,'that fold is kept across views');
  await click('document.querySelector("[data-session-id=p1] [aria-label=\\\\"Show sub-sessions\\\\"]")');
  assert.deepEqual((await inState('needs-input')).sort(),['c1','c2','g1','p1'],'its tasks nest under it there, whatever their own state');
  await screenshot('2-state-view');
  await js('qa.app.setState(s=>({sessions:{...s.sessions,g1:{...s.sessions.g1,permissionRequests:[]}}}))');await delay(150);
  assert.deepEqual((await inState('running')).includes('p1'),true,'the wait over, it moves to its next most urgent group');
  await js('qa.view.setState({groupBy:"project"})');await delay(200);

  // The breadcrumb opens the parent.
  await click('document.querySelector("[data-session-parent-crumb]")');
  assert.equal(await js('qa.app.getState().activeSessionId'),'p1');

  // Detaching (the store update the menu triggers) moves the session to the top level.
  await js('qa.followUps.getState().upsert({...qa.followUps.getState().proposals.f2,revision:3,detachedAt:Date.now()})');await delay(150);
  assert.deepEqual(await js('[...document.querySelectorAll("[data-sub-sessions-of=p1] [data-session-id]")].map(e=>e.dataset.sessionId).sort()'),['c1','g1']);
  assert.equal(await label('[data-sub-session=f2]'),'Add ClaudeUsageSettings tests · coworker · Detached');

  // Hover card: long values wrap in full, and the branch reads like the rows around it.
  const longTitle='Stop rendering dollar amounts as math in chat and keep the currency as plain text';
  await js('qa.app.setState(s=>({sessions:{...s.sessions,c2:{...s.sessions.c2,title:'+JSON.stringify(longTitle)+',associatedWorktreeBranch:"aegis/iso/stop-rendering-dollar-amounts-as-math-in-chat"}}}))');await delay(150);
  const hoverPoint=await point('document.querySelector("[data-session-id=c2]")');
  win.webContents.sendInputEvent({type:'mouseMove',...hoverPoint});
  const card='document.querySelector("[data-session-hover-card]")';
  await point(card);await delay(250);
  const cardFacts=await js('(()=>{const c='+card+';const r=c.getBoundingClientRect();const parts=[...c.querySelectorAll("span,div")].filter(e=>!e.children.length&&e.textContent);const branch=parts.find(e=>e.textContent.startsWith("aegis/iso/"));const project=parts.find(e=>e.textContent==="coworker");return{width:r.width,text:c.textContent,clipped:parts.filter(e=>e.scrollWidth>e.clientWidth+1).length,branchFont:branch&&getComputedStyle(branch).fontFamily,projectFont:project&&getComputedStyle(project).fontFamily,branchSize:branch&&getComputedStyle(branch).fontSize,projectSize:project&&getComputedStyle(project).fontSize}})()');
  assert.ok(cardFacts.text.includes(longTitle),'the full title shows');
  assert.equal(cardFacts.clipped,0,'nothing is cut off');
  assert.ok(cardFacts.width>224&&cardFacts.width<=400,'wider than before, capped: '+cardFacts.width);
  assert.equal(cardFacts.branchFont,cardFacts.projectFont,'branch uses the same font');
  assert.equal(cardFacts.branchSize,cardFacts.projectSize,'branch uses the same size');
  await screenshot('4-hover-card');

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
  console.log('Sub-sessions Electron regression passed');
} finally { await server?.close(); await rm(tmp, { recursive: true, force: true }); }
