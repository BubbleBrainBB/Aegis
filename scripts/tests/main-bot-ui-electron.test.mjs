import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// The main bot, rendered with the real components against fixtures: its
// conversation is not a task in the Active list, a task it started draws as a
// chip with the task's state icon and its agent that opens it beside the
// conversation (here or on another Mac), a message or a stop is one line, and
// a link to a task in the bot's reply carries the state icon too. A task
// that waits on the person says so in words on its chip and its row, and a
// workflow one of the bot's tasks prepared is started or called off from a
// card in the conversation.
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
import {MainBotWorkflowCards} from '/src/ui/components/main-bot/MainBotWorkflowCards.tsx';
import {useWorkflowStore} from '/src/ui/store/useWorkflowStore.ts';
import {Toaster} from 'sonner';
import {StructuredResponse} from '/src/ui/components/StructuredResponse.tsx';
import {DesignLinkSessionContext} from '/src/ui/utils/design-board-links.ts';
import {MessageCard} from '/src/ui/components/MessageCard.tsx';
import {useAppStore} from '/src/ui/store/useAppStore.ts';
import {useFollowUpStore} from '/src/ui/store/useFollowUpStore.ts';
import {getToolSummary, deriveReadableToolDisplay, classifyToolUse} from '/src/ui/utils/tool-summary.ts';
import {getLatestBubbleContextSnapshot} from '/src/ui/utils/context-usage.ts';
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
 ['t4','Bump the Bubble SDK',{status:'completed',runtimeNotice:'completed'},3],
 ['t5','Tidy the changelog',{status:'completed',runtimeNotice:'completed'},50],
];
const member=(key,role,agent,provider,extra={})=>({key,role,agent,provider,model:null,modelLabel:null,focus:null,source:'user',permissionMode:null,permissionModeIsDefault:false,readOnlyMechanism:role==='implementer'?null:'confinedSandbox',degraded:[],unverified:false,currentSessionId:null,...extra});
const run=(id,sessionId,extra={})=>({id,title:'Codex reviews the SDK bump',goal:'Have Codex review the SDK bump',cwd:'/projects/coworker',location:'current',status:'awaiting_confirmation',revision:2,createdAt:now,updatedAt:now,description:'Codex reviews the SDK bump',members:[member('current','implementer','current','claude'),member('reviewer','reviewer','codex','codex',{model:'gpt-6.2-sol',modelLabel:'GPT-6.2-Sol',effort:'xhigh'})],acceptance:[],checks:[{stepId:'types',argv:['npm','run','typecheck'],authorization:'confirm',basis:null,highlight:false,reasons:[]}],unsupported:[],assumptions:['A review only: nothing is fixed without asking'],warnings:[],confirmReasons:['runs a command'],steps:[],needsInput:null,error:null,finalVersion:null,plannerSessionId:null,isolated:null,includesUserChanges:false,spec:null,parent:{sessionId,toolUseId:null,provider:'claude'},...extra});
// t4 is a task the bot handed work to; t5 is the person's own, with a workflow of its own waiting.
useWorkflowStore.setState({loaded:true,runs:{w1:run('w1','t4'),w2:run('w2','t5',{title:'Changelog pass',description:'Changelog pass'})}});
useAppStore.setState({mainBotSessionId:'main',sessions:Object.fromEntries(rows.map(([id,title,extra,age])=>[id,{...base,id,isDraft:false,title,cwd:'/projects/coworker',projectCwd:'/projects/coworker',provider:'claude',messages:[],permissionRequests:[],envMode:'local',worktreePath:null,...extra,updatedAt:now-age*min,createdAt:now-age*min-1000}]))});
useFollowUpStore.setState({loaded:true,proposals:{}});
const usage=(uuid,totalTokens)=>({type:'system',subtype:'token_usage',uuid,session_id:'main',provider:'bubble',model:'m',usage:{inputTokens:totalTokens,outputTokens:0,totalTokens,contextWindow:200000,estimated:false}});
const refreshed={type:'system',subtype:'context_refreshed',uuid:'r',session_id:'main',trigger:'auto'};
window.qa={workflows:useWorkflowStore,context:(after)=>{const s=getLatestBubbleContextSnapshot([usage('u1',120000),refreshed,...(after?[usage('u2',after)]:[])],'m');return s&&[s.used,s.total,s.percent]},app:useAppStore,summary:(name,input)=>getToolSummary(name,input),display:(name,input,status)=>deriveReadableToolDisplay(name,input,status),kind:(name)=>classifyToolUse(name,{})};
const started=(sessionId,title,extra={})=>JSON.stringify({sessionId,title,agent:'Claude',device:'MacBook',project:'coworker',...extra});
// As the bot's conversation mounts them: held back while the bot's own turn runs.
function Cards(){const busy=useAppStore(s=>s.sessions.main?.status==='running');return <MainBotWorkflowCards messageCount={0} busy={busy}/>}
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
   <MainBotTaskChip input={{title:'Bump the Bubble SDK',prompt:'x'}} resultText={started('t4','Bump the Bubble SDK')}/>
   <MainBotTaskLine toolName="start_task" input={{title:'Fix black screen after rotation',prompt:'x'}} resultText={started('t1','Fix black screen after rotation')} failed={false} pending={false}/>
   <MainBotTaskLine toolName="start_task" input={{title:'Tidy the docs',prompt:'x'}} resultText={null} failed={false} pending={true}/>
   <MainBotTaskLine toolName="start_task" input={{title:'Deploy',prompt:'x'}} resultText="Mac mini is offline, so nothing can start there now." failed={true} pending={false}/>
   <MainBotTaskLine toolName="message_task" input={{task:'#12',message:'Also cover quitting'}} resultText={started('t1','Fix black screen after rotation')} failed={false} pending={false}/>
   <MainBotTaskLine toolName="stop_task" input={{task:'#12'}} resultText={started('t1','Fix black screen after rotation')} failed={false} pending={false}/>
   <MainBotTaskLine toolName="message_task" input={{task:'Nope',message:'hi'}} resultText='There is no task "Nope".' failed={true} pending={false}/>
  </div>
  <div data-qa="waits" style={{maxWidth:560}}><MainBotTaskLine toolName="message_task" input={{task:'Bump the Bubble SDK',message:'Have Codex review it'}} resultText={started('t4','Bump the Bubble SDK')} failed={false} pending={false}/></div>
  <div data-qa="cards" style={{maxWidth:560}}><Cards/></div>
  <Toaster/>
  <div data-qa="returned" style={{maxWidth:560}}>
   {['Task report: Fix black screen after rotation','Task reports: One · Two','Sub-session finished: Fix it','Sub-sessions finished: A · B','Sub-session result: Fix it','Follow-up result: Fix it'].map((prompt)=>(
    <MessageCard key={prompt} sessionId="main" message={{type:'user_prompt',prompt,workflowPrompt:'follow-up',createdAt:now}}/>
   ))}
  </div>
  <div data-qa="link" className="markdown-content" style={{maxWidth:560}}><DesignLinkSessionContext.Provider value="main"><StructuredResponse content={'['+'Ship the docs](aegis://sessions/'+linked+') is ready.'} streaming={false}/></DesignLinkSessionContext.Provider></div>
  <div data-qa="plain-link" className="markdown-content" style={{maxWidth:560}}><DesignLinkSessionContext.Provider value="t1"><StructuredResponse content={'['+'Ship the docs](aegis://sessions/'+linked+') is ready.'} streaming={false}/></DesignLinkSessionContext.Provider></div>
  <div data-qa="fresh-auto" style={{maxWidth:560}}><MessageCard sessionId="main" message={{type:'system',subtype:'context_refreshed',uuid:'fresh-2',session_id:'main',trigger:'auto',createdAt:now}}/></div>
  <div data-qa="fresh" style={{maxWidth:560}}><MessageCard sessionId="main" message={{type:'system',subtype:'context_refreshed',uuid:'fresh-1',session_id:'main',createdAt:now}}/></div>
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
 const decided=[];
 let cardAsks=0;
 ipcMain.handle('main-bot-workflow-cards',()=>cardAsks++===0?{tasks:[],held:true}:{tasks:['t4'],held:false});
 ipcMain.handle('main-bot-waits',()=>[]);
 ipcMain.handle('main-bot-decide-workflow',(_e,taskId,run,start)=>{decided.push([taskId,run,start]);return taskId==='t4'?{ok:true}:{ok:false,error:'No workflow of this task waits to be started.'}});
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
   ['t2','Bump Electron to 39Needs you','Needs input',false],
   ['t3','Write release notesClaude','Completed',false],
   ['rh-aaaaaaaaaaaa-s1','Run the nightly regressionCodex','Running',false],
   ['starting','Tidy the docs','Starting',true],
   ['t4','Bump the Bubble SDKNeeds you','Needs input',false],
  ]);
  // A task that waits on the person says so in words, in place of the agent on its chip and of the age on its row;
  // one whose prepared workflow waits to be started is such a task.
  assert.deepEqual(await js('["t1","t2","t4"].map(id=>{const row=document.querySelector("[data-active-tasks] [data-session-id="+id+"]");return [(row.querySelector("[data-task-needs-you]")||{}).textContent||null,!!row.querySelector("[data-task-age]"),row.dataset.taskState]})'),
   [[null,true,'running'],['Needs you',false,'needs-input'],['Needs you',false,'needs-input']]);
  assert.equal(await js('document.querySelector("[data-qa=waits] [data-main-bot-task-mark]").dataset.mainBotTaskMark'),'warning','a line to it carries the mark too');
  assert.equal(rows[0].title,'Running · Claude · coworker · MacBook');
  assert.equal(rows[1].title,'Needs input · Claude · coworker · MacBook');
  assert.equal(rows[2].title,'Completed · Claude · coworker · MacBook');
  assert.equal(rows[3].title,'Running · Codex · server · Mac mini');
  assert.equal(rows[4].title,'Starting');
  // The chip is all a start draws: no line in the trace for it, started or still starting. A start that failed says why.
  assert.equal(await js('document.querySelectorAll("[data-qa=rows] > *").length'),6+1+3,'chips, the failed start and three lines');
  assert.match(await js('document.querySelector("[data-main-bot-task=failed]").textContent'),/^Task not started: Mac mini is offline/);

  // A message or a stop: one line, named by the task's title.
  const lines=await js('[...document.querySelectorAll("[data-qa=rows] [data-main-bot-task-line]")].map(e=>e.textContent)');
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

  // The workflow a task of the bot prepared: one card in the conversation, in short. The person's own task's is not here.
  const card=()=>js('[...document.querySelectorAll("[data-main-bot-workflow-card]")].map(e=>[e.dataset.mainBotWorkflowCard,e.textContent])');
  await js('new Promise(r=>{const t=()=>document.querySelector("[data-main-bot-workflow-card]")?r():setTimeout(t,50);t()})');
  assert.deepEqual(await card(),[['w1','Codex reviews the SDK bumpWaiting for youCodexreviewer, read-onlyRunsnpm run typecheck Start CancelStarting approves these commands for this run.Details']]);
  // While the bot writes, the card waits; it is back under the bot's last word when that turn is over.
  const botStatus=(status)=>js('window.qa.app.setState(s=>({sessions:{...s.sessions,main:{...s.sessions.main,status:"'+status+'"}}}));0');
  await botStatus('running');await delay(200);
  assert.deepEqual(await card(),[]);
  await botStatus('idle');
  await js('new Promise(r=>{const t=()=>document.querySelector("[data-main-bot-workflow-card]")?r():setTimeout(t,50);t()})');
  assert.equal((await card()).length,1);
  await screenshot('2-workflow-card');
  // Details unfolds it into the card the task itself shows: the same header, question, members, commands and what it assumes.
  await js('[...document.querySelectorAll("[data-main-bot-workflow-card] button")].find(b=>b.textContent==="Details").click()');await delay(100);
  assert.equal(await js('document.querySelector("[data-main-bot-workflow-open] [data-workflow-board=w1] [data-workflow-status]").textContent'),'Waiting for you');
  assert.equal(await js('document.querySelector("[data-main-bot-workflow-open] li").textContent'),'CodexGPT-6.2-Sol · xhigh · reviewer, read-only');
  assert.match(await js('document.querySelector("[data-main-bot-workflow-open]").textContent'),/Start this workflow\?.*Runsnpm run typecheck.*Assumes: A review only: nothing is fixed without asking.*Start.*Cancel/);
  await screenshot('3-workflow-card-details');
  // Its chevron folds it back; the title of the short card opens the task beside.
  await js('document.querySelector("[data-main-bot-workflow-open] [data-workflow-toggle]").click()');await delay(100);
  assert.equal(await js('!!document.querySelector("[data-main-bot-workflow-open]")'),false);
  await js('document.querySelector("[data-main-bot-workflow-card] button").click()');await delay(100);
  assert.equal(await js('window.qa.app.getState().activeRightUtilityTab'),'task:t4');
  // Unfolded, its Start is the same answer.
  await js('[...document.querySelectorAll("[data-main-bot-workflow-card] button")].find(b=>b.textContent==="Details").click()');await delay(100);
  // Start: the person's answer goes to Aegis; once the workflow runs, the card gives way to one line.
  await js('[...document.querySelectorAll("[data-main-bot-workflow-card] button")].find(b=>b.textContent.trim()==="Start").click()');await delay(200);
  assert.deepEqual(decided,[['t4',{id:'w1',revision:2},true]]);
  await js('window.qa.workflows.getState().upsert({...window.qa.workflows.getState().runs.w1,status:"running",revision:3});0');await delay(200);
  assert.deepEqual(await card(),[]);
  assert.deepEqual(await js('[...document.querySelectorAll("[data-qa=cards] [data-main-bot-task-line]")].map(e=>[e.dataset.mainBotTaskLine,e.textContent])'),[['workflow','Started the workflow of Bump the Bubble SDK']]);
  assert.equal(await js('document.querySelector("[data-active-tasks] [data-session-id=t4]").dataset.taskState'),'running');
  assert.equal(await js('document.querySelector("[data-qa=cards] [data-main-bot-task-mark]").dataset.mainBotTaskMark'),'working','the line shows the workflow at work');
  await screenshot('4-workflow-started');

  // How the calls read where a trace is collapsed.
  assert.equal(await js('window.qa.summary("start_task",{title:"Fix it"})'),'Started Fix it');
  assert.equal(await js('window.qa.summary("message_task",{task:"#12"})'),'Sent to #12');
  assert.equal(await js('window.qa.summary("list_tasks",{})'),'Checked tasks');
  assert.equal(await js('window.qa.summary("list_projects",{})'),'Checked projects');
  assert.deepEqual(await js('window.qa.display("get_task",{task:"#12"},"success")'),{verb:'Checked',target:'#12'});
  assert.equal(await js('window.qa.kind("start_task")'),'subagent');
  // What the bot keeps outside its conversation: looked up like its tasks, and a note it changes is named.
  assert.equal(await js('window.qa.summary("list_handed_out",{})'),'Checked handed-out work');
  assert.equal(await js('window.qa.summary("read_memory",{name:"person"})'),'Checked note person');
  assert.equal(await js('window.qa.summary("read_conversation",{query:"codex"})'),'Checked the conversation');
  assert.deepEqual(await js('window.qa.display("write_memory",{name:"person",content:"x"},"success")'),{verb:'Updated note',target:'person'});
  assert.equal(await js('window.qa.summary("write_memory",{name:"person",mode:"delete"})'),'Removed note person');
  // Where its agent started on an empty thread, the conversation shows a line.
  // A wavy rule with "New" in it; why the context is new is in its tooltip.
  assert.equal(await js('document.querySelector("[data-qa=fresh] [data-context-refreshed=manual]").textContent'),'New');
  assert.equal(await js('document.querySelector("[data-qa=fresh-auto] [data-context-refreshed=auto]").textContent'),'New');
  assert.match(await js('document.querySelector("[data-qa=fresh] [data-context-refreshed]").title'),/^Aegis starts from a fresh context here\\./);
  assert.match(await js('document.querySelector("[data-qa=fresh-auto] [data-context-refreshed]").title'),/^The context was nearly full/);
  assert.ok(await js('(()=>{const rule=document.querySelector("[data-qa=fresh] [data-context-refreshed] span[aria-hidden]");const style=getComputedStyle(rule);return rule.getBoundingClientRect().width>100&&(style.maskImage||style.webkitMaskImage).includes("svg")})()'),'the rule is drawn as a wave');
  // The composer's context ring starts from zero after it, until the agent says how full the new thread is.
  assert.deepEqual(await js('window.qa.context(0)'),[0,200000,0]);
  assert.deepEqual(await js('window.qa.context(12000)'),[12000,200000,6]);
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
