import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// The main bot, rendered with the real components against fixtures: its
// conversation is not a task in the Active list, a task it started draws as a
// chip with the task's state icon and its agent that opens it beside the
// conversation (here or on another Mac), a message or a stop is one line, and
// a link to a task in the bot's reply carries the state icon too.
// QA_CAPTURE=<dir> saves screenshots.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, 'dev-fixtures');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'main-bot-ui-'));
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {SidebarActiveTasks} from '/src/ui/components/sidebar/SidebarActiveTasks.tsx';
import {MainBotTaskLine} from '/src/ui/components/main-bot/MainBotTaskLine.tsx';
import {MainBotTaskChip} from '/src/ui/components/main-bot/MainBotTaskChip.tsx';
import {StructuredResponse} from '/src/ui/components/StructuredResponse.tsx';
import {DesignLinkSessionContext} from '/src/ui/utils/design-board-links.ts';
import {MessageCard} from '/src/ui/components/MessageCard.tsx';
import {useAppStore} from '/src/ui/store/useAppStore.ts';
import {useFollowUpStore} from '/src/ui/store/useFollowUpStore.ts';
import {getToolSummary, deriveReadableToolDisplay, classifyToolUse} from '/src/ui/utils/tool-summary.ts';
import '/src/ui/index.css';
const a=useAppStore.getState();const draft=a.createDraftSession('/projects/coworker');const base=useAppStore.getState().sessions[draft];
const now=Date.now();const min=60000;
const remote='rh-aaaaaaaaaaaa-s1';
const linked='11111111-1111-4111-8111-111111111111';
const rows=[
 ['main','Aegis',{status:'idle',isChat:true,provider:'bubble'},0],
 ['t1','Fix black screen after rotation',{status:'running'},2],
 ['t2','Bump Electron to 39',{status:'idle',permissionRequests:[{toolUseId:'p1',toolName:'Bash',input:{command:'npm i'}}]},18],
 ['t3','Write release notes',{status:'completed'},30],
 [remote,'Run the nightly regression',{status:'running',device:{id:'aaaaaaaaaaaa',name:'Mac mini',online:true}},6],
 [linked,'Ship the docs',{status:'completed'},40],
];
useAppStore.setState({mainBotSessionId:'main',sessions:Object.fromEntries(rows.map(([id,title,extra,age])=>[id,{...base,id,isDraft:false,title,cwd:'/projects/coworker',projectCwd:'/projects/coworker',provider:'claude',messages:[],permissionRequests:[],envMode:'local',worktreePath:null,...extra,updatedAt:now-age*min,createdAt:now-age*min-1000}]))});
useFollowUpStore.setState({loaded:true,proposals:{}});
window.qa={app:useAppStore,summary:(name,input)=>getToolSummary(name,input),display:(name,input,status)=>deriveReadableToolDisplay(name,input,status),kind:(name)=>classifyToolUse(name,{})};
const started=(sessionId,title,extra={})=>JSON.stringify({sessionId,title,agent:'Claude',device:'MacBook',project:'coworker',...extra});
function Harness(){
 return <Tooltip.Provider><div style={{display:'flex',height:'100vh',background:'var(--bg-primary)'}}>
 <aside className="aegis-sidebar" style={{width:250,flexShrink:0,padding:8,background:'var(--app-sidebar-panel)'}}><SidebarActiveTasks/></aside>
 <main style={{flex:1,padding:'20px 28px',overflow:'auto'}}>
  <div data-qa="rows" style={{maxWidth:560}}>
   <MainBotTaskChip input={{title:'Fix black screen after rotation',prompt:'x'}} resultText={started('t1','Fix black screen after rotation')}/>
   <MainBotTaskChip input={{title:'Bump Electron to 39',prompt:'x'}} resultText={started('t2','Bump Electron to 39')}/>
   <MainBotTaskChip input={{title:'Write release notes',prompt:'x'}} resultText={started('t3','Write release notes')}/>
   <MainBotTaskChip input={{title:'Nightly',prompt:'x'}} resultText={started(remote,'Nightly',{agent:'Codex',device:'Mac mini',project:'server'})}/>
   <MainBotTaskChip input={{title:'Tidy the docs',prompt:'x'}} resultText={null}/>
   <MainBotTaskLine toolName="start_task" input={{title:'Fix black screen after rotation',prompt:'x'}} resultText={started('t1','Fix black screen after rotation')} failed={false} pending={false}/>
   <MainBotTaskLine toolName="start_task" input={{title:'Tidy the docs',prompt:'x'}} resultText={null} failed={false} pending={true}/>
   <MainBotTaskLine toolName="start_task" input={{title:'Deploy',prompt:'x'}} resultText="Mac mini is offline, so nothing can start there now." failed={true} pending={false}/>
   <MainBotTaskLine toolName="message_task" input={{task:'#12',message:'Also cover quitting'}} resultText={started('t1','Fix black screen after rotation')} failed={false} pending={false}/>
   <MainBotTaskLine toolName="stop_task" input={{task:'#12'}} resultText={started('t1','Fix black screen after rotation')} failed={false} pending={false}/>
   <MainBotTaskLine toolName="message_task" input={{task:'Nope',message:'hi'}} resultText='There is no task "Nope".' failed={true} pending={false}/>
  </div>
  <div data-qa="returned" style={{maxWidth:560}}>
   {['Task report: Fix black screen after rotation','Task reports: One · Two','Sub-session finished: Fix it','Sub-sessions finished: A · B','Sub-session result: Fix it','Follow-up result: Fix it'].map((prompt)=>(
    <MessageCard key={prompt} sessionId="main" message={{type:'user_prompt',prompt,workflowPrompt:'follow-up',createdAt:now}}/>
   ))}
  </div>
  <div data-qa="link" className="markdown-content" style={{maxWidth:560}}><DesignLinkSessionContext.Provider value="main"><StructuredResponse content={'['+'Ship the docs](aegis://sessions/'+linked+') is ready.'} streaming={false}/></DesignLinkSessionContext.Provider></div>
  <div data-qa="plain-link" className="markdown-content" style={{maxWidth:560}}><DesignLinkSessionContext.Provider value="t1"><StructuredResponse content={'['+'Ship the docs](aegis://sessions/'+linked+') is ready.'} streaming={false}/></DesignLinkSessionContext.Provider></div>
  <div data-qa="here" style={{maxWidth:560}}><MessageCard sessionId="main" message={{type:'user_prompt',prompt:'Follow-up task: Fix empty file names',workflowPrompt:'follow-up',createdAt:now}}/></div>
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
app.whenReady().then(async()=>{
 ipcMain.on('get-ui-resume-state-sync',e=>{e.returnValue=null});ipcMain.on('renderer-state:get-all-sync',e=>{e.returnValue={}});ipcMain.on('save-ui-resume-state-sync',e=>{e.returnValue=true});
 ipcMain.on('renderer-state:set',()=>{});ipcMain.handle('set-theme',()=>{});
 ipcMain.handle('get-session-organization',()=>({sessions:{},sections:[],projectSources:{}}));
 ipcMain.handle('list-sidebar-pull-requests',()=>({}));
 ipcMain.handle('follow-up-list',()=>[]);
 ipcMain.handle('get-app-preferences',()=>({}));
 const win=new BrowserWindow({width:1100,height:760,show:true,webPreferences:{backgroundThrottling:false,preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const screenshot=async name=>{if(!process.env.QA_CAPTURE)return;fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())};
 try{
  await win.loadURL(process.env.QA_URL);
  await js('new Promise(r=>{const t=()=>document.querySelector("[data-qa=rows] [data-main-bot-task]")&&document.querySelector("[data-active-tasks]")?r():setTimeout(t,50);t()})');await delay(500);

  // Active: the bot's conversation is not a task; the tasks it started are ordinary top-level rows.
  const ids=await js('[...document.querySelectorAll("[data-active-tasks] [data-session-id]")].map(e=>e.dataset.sessionId)');
  assert.ok(!ids.includes('main'),'the main bot is not listed: '+ids);
  assert.ok(ids.includes('t1')&&ids.includes('t2')&&ids.includes('rh-aaaaaaaaaaaa-s1'),'its tasks are listed: '+ids);

  // A started task: a chip with the state icon My Tasks shows, the title and the agent; what it runs on is in the tooltip.
  const rows=await js('[...document.querySelectorAll("button[data-main-bot-task]")].map(e=>({id:e.dataset.mainBotTask,text:e.textContent,title:e.title,icon:(e.querySelector("[role=img]")||{getAttribute:()=>null}).getAttribute("aria-label"),disabled:e.disabled}))');
  assert.deepEqual(rows.map(r=>[r.id,r.text,r.icon,r.disabled]),[
   ['t1','Fix black screen after rotationClaude','Running',false],
   ['t2','Bump Electron to 39Claude','Needs input',false],
   ['t3','Write release notesClaude','Completed',false],
   ['rh-aaaaaaaaaaaa-s1','Run the nightly regressionCodex','Running',false],
   ['starting','Tidy the docs','Starting',true],
  ]);
  assert.equal(rows[0].title,'Running · Claude · coworker · MacBook');
  assert.equal(rows[1].title,'Needs input · Claude · coworker · MacBook');
  assert.equal(rows[2].title,'Completed · Claude · coworker · MacBook');
  assert.equal(rows[3].title,'Running · Codex · server · Mac mini');
  assert.equal(rows[4].title,'Starting');
  // The chip is all a start draws: no line in the trace for it, started or still starting. A start that failed says why.
  assert.equal(await js('document.querySelectorAll("[data-qa=rows] > *").length'),5+1+3,'chips, the failed start and three lines');
  assert.match(await js('document.querySelector("[data-main-bot-task=failed]").textContent'),/^Task not started: Mac mini is offline/);

  // A message or a stop: one line, named by the task's title.
  const lines=await js('[...document.querySelectorAll("[data-main-bot-task-line]")].map(e=>e.textContent)');
  assert.deepEqual(lines,['Sent to Fix black screen after rotation','Stopped Fix black screen after rotation','Could not send to Nope']);

  // A line to a task that is still working carries the same mark as its row; a stop does not.
  assert.equal(await js('(document.querySelector("[data-main-bot-task-line=message] [data-main-bot-task-mark]")||{dataset:{}}).dataset.mainBotTaskMark'),'working');
  assert.equal(await js('!!document.querySelector("[data-main-bot-task-line=stop] [data-main-bot-task-mark]")'),false);

  // A result coming back draws nothing: the row that sent the work shows how it stands.
  assert.equal(await js('document.querySelector("[data-qa=returned]").childElementCount'),0,'no row for a delivered result');
  assert.equal(await js('document.querySelector("[data-qa=here]").textContent'),'Fix empty file names','a task the user started here still names itself');

  // A link to a task in the bot's reply carries the task's state icon; the same link elsewhere is a plain one.
  assert.equal(await js('document.querySelector("[data-qa=link] a[data-main-bot-task-link] [role=img]").getAttribute("aria-label")'),'Completed');
  assert.equal(await js('document.querySelector("[data-qa=link] a").textContent'),'Ship the docs');
  assert.equal(await js('!!document.querySelector("[data-qa=plain-link] a")&&!document.querySelector("[data-qa=plain-link] a[data-main-bot-task-link]")'),true,'no task link outside the bot');

  // A chip opens its task beside the conversation, also one on another Mac: the view stays where it is.
  const before=await js('window.qa.app.getState().activeSessionId');
  const panel=()=>js('(()=>{const s=window.qa.app.getState();return {tab:s.activeRightUtilityTab,hidden:s.rightUtilityPanelHidden,active:s.activeSessionId,tabs:s.rightUtilityTabs}})()');
  await js('document.querySelector("button[data-main-bot-task=t2]").click()');await delay(100);
  assert.deepEqual(await panel(),{tab:'task:t2',hidden:false,active:before,tabs:['task:t2']});
  assert.equal(await js('document.querySelector("button[data-main-bot-task=t2]").getAttribute("aria-pressed")'),'true','the chip of the task that is showing is lit');
  await js('document.querySelector("button[data-main-bot-task=\\\\"rh-aaaaaaaaaaaa-s1\\\\"]").click()');await delay(100);
  assert.deepEqual(await panel(),{tab:'task:rh-aaaaaaaaaaaa-s1',hidden:false,active:before,tabs:['task:t2','task:rh-aaaaaaaaaaaa-s1']});
  assert.equal(await js('document.querySelector("button[data-main-bot-task=t2]").getAttribute("aria-pressed")'),'false');
  await js('document.querySelector("[data-main-bot-task-line=message] button").click()');await delay(100);
  assert.equal((await panel()).tab,'task:t1');
  await js('document.querySelector("[data-qa=link] a").click()');await delay(100);
  assert.equal((await panel()).tab,'task:11111111-1111-4111-8111-111111111111');
  await screenshot('1-main-bot');
  // With \u2318 held it opens as the full task.
  await js('document.querySelector("button[data-main-bot-task=t3]").dispatchEvent(new MouseEvent("click",{bubbles:true,metaKey:true}))');await delay(100);
  assert.equal(await js('window.qa.app.getState().activeSessionId'),'t3');

  // How the calls read where a trace is collapsed.
  assert.equal(await js('window.qa.summary("start_task",{title:"Fix it"})'),'Started Fix it');
  assert.equal(await js('window.qa.summary("message_task",{task:"#12"})'),'Sent to #12');
  assert.equal(await js('window.qa.summary("list_tasks",{})'),'Checked tasks');
  assert.equal(await js('window.qa.summary("list_projects",{})'),'Checked projects');
  assert.deepEqual(await js('window.qa.display("get_task",{task:"#12"},"success")'),{verb:'Checked',target:'#12'});
  assert.equal(await js('window.qa.kind("start_task")'),'subagent');
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
  console.log('Main bot UI Electron regression passed');
} finally { await server?.close(); await rm(tmp, { recursive: true, force: true }); }
