// Where handed-out work sits in a real chat. A start_session row comes after
// the turn's answer once the turn is done, so it is between "handed out" and
// the result that comes back, and the result itself adds no row. In the main
// bot's conversation a started task is a chip under the message that asked
// for it (on the left, above the answer, in a turn nobody typed), from the
// moment the call is made; a turn that only handed tasks out shows no trace
// row, and the chip opens the task beside the conversation.
// QA_CAPTURE=<dir> saves screenshots.
import { createServer } from 'vite';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/task-cards-'));
let server;
const harness = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ChatPane} from '/src/ui/components/ChatPane';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {useAppStore} from '/src/ui/store/useAppStore';
import {useFollowUpStore} from '/src/ui/store/useFollowUpStore';
import {AppearancePreferences} from '/src/ui/components/AppearancePreferences';
import '/src/ui/index.css';
window.electron = {
 sendClientEvent:()=>{},getProjectTree:async()=>null,getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),
 getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionUserPrompts:async()=>[],
 getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},
 getBubbleProvidersConfig:async()=>({providers:[]}),getProjectFolders:async()=>[],getModels:async()=>[],
 workflows:{list:async()=>[]},
};
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Devin','Mimo','Minimax','Codex'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
window.electron.getDevinThoughtLevels=async()=>({model:null,levels:[],defaultLevel:null});
window.electron.getMinimaxThinkingEfforts=async()=>({model:null,levels:[],defaultLevel:null});
const store=useAppStore;
const botId=store.getState().createDraftSession('/tmp/main-bot');
const parentId=store.getState().createDraftSession('/tmp/parent');
const liveId=store.getState().createDraftSession('/tmp/live');
const taskId=store.getState().createDraftSession('/tmp/task');
const childId=store.getState().createDraftSession('/tmp/child');
const reviewId=store.getState().createDraftSession('/tmp/review');
const done=(createdAt,ms)=>({type:'result',subtype:'success',duration_ms:ms,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1},createdAt});
const use=(uuid,createdAt,id,name,input)=>({type:'assistant',uuid,createdAt,message:{content:[{type:'tool_use',id,name,input}]}});
const result=(uuid,createdAt,id,content)=>({type:'user',uuid,createdAt,message:{content:[{type:'tool_result',tool_use_id:id,content,is_error:false}]}});
const say=(uuid,createdAt,text)=>({type:'assistant',uuid,createdAt,message:{content:[{type:'text',text}]}});
const started=JSON.stringify({sessionId:taskId,title:'Write the hello world doc',agent:'Qoder',device:'MacBook',project:'follow-up-test-repo'});
const bot=[
 {type:'user_prompt',prompt:'Write a hello world doc in follow-up-test-repo',createdAt:1000},
 use('a1',1100,'call-list','list_projects',{}),
 result('a1r',1150,'call-list','{"devices":[]}'),
 use('a2',1200,'call-start','start_task',{title:'Write the hello world doc',project:'follow-up-test-repo',prompt:'Write it'}),
 result('a2r',1300,'call-start',started),
 say('a3',1400,'HANDED-OUT: I gave Qoder the hello world doc in follow-up-test-repo.'),
 done(1500,8000),
 {type:'user_prompt',prompt:'Task report: Write the hello world doc',workflowPrompt:'follow-up',createdAt:2000},
 say('b1',2100,'CAME-BACK: The doc is written, in its own worktree and not committed.'),
 done(2200,3000),
 // A report the bot answers by starting a task on its own.
 {type:'user_prompt',prompt:'Task report: Write the hello world doc',workflowPrompt:'follow-up',createdAt:3000},
 use('c1',3100,'call-start-2','start_task',{title:'Review the hello world doc',project:'follow-up-test-repo',prompt:'Review it'}),
 result('c1r',3200,'call-start-2',JSON.stringify({sessionId:reviewId,title:'Review the hello world doc',agent:'Claude',device:'MacBook',project:'follow-up-test-repo'})),
 say('c2',3300,'FOLLOW-ON: I asked Claude to review the doc.'),
 done(3400,2000),
];
// The same in an ordinary session that started a sub-session.
const parent=[
 {type:'user_prompt',prompt:'Open a session to fix the export names',createdAt:1000},
 use('p1',1100,'tu-f1','mcp__aegis-sessions__start_session',{title:'Fix empty export file names',prompt:'Fix it'}),
 result('p1r',1200,'tu-f1',JSON.stringify({sessionId:childId,proposalId:'f1',status:'started'})),
 say('p2',1300,'HANDED-OUT: Started a session for the export names.'),
 done(1400,4000),
 {type:'user_prompt',prompt:'Sub-session finished: Fix empty export file names',workflowPrompt:'follow-up',createdAt:2000},
 say('p3',2100,'CAME-BACK: The export names are fixed on its branch.'),
 done(2200,2000),
];
// A turn that has not finished: the chip is there already, and the trace still shows.
const live=bot.slice(0,5);
const put=(id,messages,extra={})=>store.setState(s=>({sessions:{...s.sessions,[id]:{...s.sessions[id],isDraft:false,hydrated:true,hasMoreHistory:false,provider:'claude',status:'completed',model:'x',messages,...extra}}}));
put(botId,bot,{provider:'bubble',title:'Aegis',isChat:true});
put(parentId,parent,{title:'Export work'});
put(liveId,live,{provider:'bubble',status:'running',title:'Aegis'});
put(taskId,[],{title:'Write the hello world doc',provider:'qoder',status:'completed'});
put(reviewId,[],{title:'Review the hello world doc',status:'running'});
put(childId,[],{title:'Fix empty export file names',status:'completed'});
store.setState({mainBotSessionId:botId});
const now=Date.now();
useFollowUpStore.setState({loaded:true,proposals:{f1:{id:'f1',revision:2,kind:'session',parentSessionId:parentId,toolUseId:'tu-f1',title:'Fix empty export file names',reason:'',plan:'',acceptanceCriteria:'',provider:'claude',model:null,permissionMode:null,status:'started',childSessionId:childId,place:'worktree',worktreeBranch:null,baseRef:null,lastError:null,detachedAt:null,reports:[],createdAt:now,updatedAt:now}}});
useAppStore.getState().setTheme('light');
window.qa={store,botId,parentId,liveId,taskId,reviewId};
function Pane(){
 const [id,setId]=useState(botId);
 window.qa.show=setId;
 return <div id="real-chat" style={{height:'100vh',display:'flex'}}><ChatPane paneId="qa" sessionId={id} isActive onActivate={()=>{}} /></div>;
}
createRoot(document.getElementById('root')).render(<AppearancePreferences><Tooltip.Provider><Pane/></Tooltip.Provider></AppearancePreferences>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1000,height:760,show:true,webPreferences:{backgroundThrottling:false}});
 const errors=[];w.webContents.on('console-message',e=>{if(e.level==='error'){errors.push(e.message);console.error(e.message);}});
 const js=c=>w.webContents.executeJavaScript(c,true);
 const until=async(c,label)=>{for(let i=0;i<100;i++){if(await js(c))return;await delay(100);}throw Error('Timed out: '+label);};
 const shot=async name=>{if(!process.env.QA_CAPTURE)return;await delay(200);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await w.webContents.capturePage()).toPNG());};
 // The tops of: the answer that hands work out, each row for that work, the answer after its result.
 const layout=row=>js('(()=>{const top=e=>Math.round(e.getBoundingClientRect().top);const leaf=t=>[...document.querySelectorAll("#real-chat p,#real-chat span,#real-chat div")].filter(e=>e.children.length===0&&e.textContent.startsWith(t))[0];const out=leaf("HANDED-OUT"),back=leaf("CAME-BACK");return {out:out?top(out):null,back:back?top(back):null,rows:[...document.querySelectorAll("#real-chat '+row+'")].map(top)}})()');
 try{
  await w.loadURL(process.env.QA_URL);
  // The main bot: the task's chip under the message that asked for it, then the answer, then what came back.
  await until('!!document.querySelector("#real-chat button[data-main-bot-task]")','the task chip');
  const chips=()=>js('(()=>{const r=e=>{const b=e.getBoundingClientRect();return {top:Math.round(b.top),bottom:Math.round(b.bottom),left:Math.round(b.left),right:Math.round(b.right)}};const leaf=t=>[...document.querySelectorAll("#real-chat p,#real-chat span,#real-chat div")].filter(e=>e.children.length===0&&e.textContent.startsWith(t))[0];const at=t=>{const e=leaf(t);return e?r(e):null};const asked=leaf("Write a hello world doc");return {bubble:asked?r(asked.closest("div[style]")):null,out:at("HANDED-OUT"),back:at("CAME-BACK"),on:at("FOLLOW-ON"),chips:[...document.querySelectorAll("#real-chat button[data-main-bot-task]")].map(e=>({id:e.dataset.mainBotTask,text:e.textContent,icon:(e.querySelector("[role=img]")||{getAttribute:()=>null}).getAttribute("aria-label"),...r(e)}))}})()');
  let seen=await chips();
  assert.deepEqual(seen.chips.map(c=>[c.id,c.text,c.icon]),[[await js('qa.taskId'),'Write the hello world docQoder','Completed'],[await js('qa.reviewId'),'Review the hello world docClaude','Running']],'one chip per started task: '+JSON.stringify(seen));
  const [asked,own]=seen.chips;
  assert.ok(asked.top>=seen.bubble.bottom&&asked.top-seen.bubble.bottom<=12,'the chip hangs right under the message: '+JSON.stringify(seen));
  assert.ok(Math.abs(asked.right-seen.bubble.right)<=2,'flush with the right edge of the message: '+JSON.stringify(seen));
  assert.ok(asked.bottom<=seen.out.top&&seen.out.top<seen.back.top,'the chip, the answer, then what came back: '+JSON.stringify(seen));
  // A turn nobody typed: its chip is on the left, between the answer before it and its own.
  assert.ok(own.top>seen.back.bottom&&own.bottom<=seen.on.top&&Math.abs(own.left-seen.on.left)<=24,'the chip of a task the bot started on its own: '+JSON.stringify(seen));
  assert.equal(await js('document.querySelectorAll("#real-chat [data-follow-up-prompt]").length'),0,'the result adds no row');
  assert.equal(await js('[...document.querySelectorAll("#real-chat *")].some(e=>e.children.length===0&&/^Task report/.test(e.textContent))'),false,'the report label is not shown');
  // Turns that only handed work out show no trace row ("Worked for 8s").
  assert.equal(await js('document.querySelectorAll("#real-chat .workstream-toggle-row").length'),0,'no trace row for handing work out');
  assert.equal(await js('document.querySelector("#real-chat [data-message-index=\\"1\\"]").childElementCount'),0,'nothing is drawn for that work');
  // No copy button between the answer that hands out and the result: it comes after the last word.
  const copies=await js('(()=>{const r=e=>e.getBoundingClientRect();const leaf=t=>[...document.querySelectorAll("#real-chat p,#real-chat span,#real-chat div")].filter(e=>e.children.length===0&&e.textContent.startsWith(t))[0];const out=r(leaf("HANDED-OUT")),back=r(leaf("CAME-BACK")),on=r(leaf("FOLLOW-ON"));const tops=[...document.querySelectorAll("#real-chat button")].filter(b=>/copy/i.test(b.getAttribute("aria-label")||b.title||"")).map(b=>r(b).top);return {between:tops.filter(t=>t>out.top&&t<back.top).length,afterResult:tops.filter(t=>t>=back.bottom&&t<on.top).length}})()');
  assert.equal(copies.between,0,'no copy button between the two answers: '+JSON.stringify(copies));
  assert.equal(copies.afterResult,1,'the result answer keeps its copy button: '+JSON.stringify(copies));
  await shot('1-main-bot');
  // The chip opens the task beside the conversation, which stays where it is.
  const shown=await js('qa.store.getState().activeSessionId');
  await js('document.querySelector("#real-chat button[data-main-bot-task]").click()');await delay(150);
  assert.equal(await js('qa.store.getState().activeRightUtilityTab==="task:"+qa.taskId&&!qa.store.getState().rightUtilityPanelHidden'),true,'the chip opens its task in the right panel');
  assert.equal(await js('qa.store.getState().activeSessionId'),shown,'the conversation stays');
  assert.equal(await js('document.querySelector("#real-chat button[data-main-bot-task]").getAttribute("aria-pressed")'),'true');
  await shot('2-main-bot-task-open');

  // A sub-session: the same.
  await js('qa.show(qa.parentId)');
  await until('!!document.querySelector("#real-chat [data-sub-session=f1]")','the session row');
  at=await layout('[data-sub-session=f1]');
  assert.equal(at.rows.length,1,'the session has one row: '+JSON.stringify(at));
  assert.ok(at.out<at.rows[0]&&at.rows[0]<at.back,'the session row sits between the two answers: '+JSON.stringify(at));
  assert.equal(await js('!!document.querySelector("#real-chat [data-sub-sessions-finished]")'),false,'no finished row');
  await shot('3-sub-session');

  // A turn still running: the chip is under the message already, and the trace shows the work going on.
  await js('qa.store.setState({mainBotSessionId:qa.liveId});qa.show(qa.liveId)');
  await until('!!document.querySelector("#real-chat button[data-main-bot-task]")','the live task chip');
  seen=await chips();
  assert.equal(seen.chips.length,1,'one chip while the turn runs: '+JSON.stringify(seen));
  assert.ok(seen.chips[0].top>=seen.bubble.bottom&&seen.chips[0].top-seen.bubble.bottom<=12,'under the message while the turn runs: '+JSON.stringify(seen));
  assert.equal(await js('document.querySelector("#real-chat [data-message-index=\\"1\\"]").childElementCount'),1,'the running turn keeps its trace');
  await shot('4-running');
  assert.deepEqual(errors,[],'renderer errors');
  console.log(JSON.stringify({ok:true}));app.exit(0);
 }catch(e){console.error(e);await shot('failure');app.exit(1)}
});
`;
try {
 await writeFile(path.join(dir,'index.html'),'<html><body style="margin:0;background:var(--bg-primary)"><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
 await writeFile(path.join(dir,'probe.tsx'),harness);
 await writeFile(path.join(dir,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),cacheDir:path.join(dir,'vite-cache'),server:{host:'127.0.0.1',port:0,strictPort:false}});
 await server.listen();
 const env={...process.env,QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href};
 delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});
  const timeout=setTimeout(()=>{child.kill();reject(Error('Electron test timed out'))},120000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(Error('Electron test failed: '+code))});
 });
 console.log('Task card placement Electron regression passed');
} finally { await server?.close();await rm(dir,{recursive:true,force:true}); }
