// A run Claude starts itself after a background task ends (no prompt in
// between) keeps its own "Worked for" fold, and the task's outcome row opens
// the turn above onto the command that started the task, once: history
// arriving or switching sessions never replays it, and folds keep their state
// as older history loads.
import { createServer } from 'vite';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/woken-turn-'));
let server;
const harness = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ChatPane} from '/src/ui/components/ChatPane';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {useAppStore} from '/src/ui/store/useAppStore';
import {useAppPreferences} from '/src/ui/store/useAppPreferences';
import {AppearancePreferences} from '/src/ui/components/AppearancePreferences';
import '/src/ui/index.css';
window.electron = {
 sendClientEvent:()=>{},getProjectTree:async()=>null,getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),
 getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionUserPrompts:async()=>[],
 getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},
 getBubbleProvidersConfig:async()=>({providers:[]}),getProjectFolders:async()=>[],getModels:async()=>[],
};
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Devin','Mimo','Minimax','Codex'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
window.electron.getDevinThoughtLevels=async()=>({model:null,levels:[],defaultLevel:null});
window.electron.getMinimaxThinkingEfforts=async()=>({model:null,levels:[],defaultLevel:null});
const store=useAppStore;
const chatId=store.getState().createDraftSession('/tmp/woken-turn');
const otherId=store.getState().createDraftSession('/tmp/woken-turn-other');
const partialId=store.getState().createDraftSession('/tmp/woken-turn-partial');
const nestedId=store.getState().createDraftSession('/tmp/woken-turn-nested');
const laterId=store.getState().createDraftSession('/tmp/woken-turn-later');
const done=(createdAt,ms)=>({type:'result',subtype:'success',duration_ms:ms,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1},createdAt});
// Filler so the transcript scrolls and the reveal has somewhere to scroll from.
const filler=[];
for(let i=0;i<6;i++){
 filler.push({type:'user_prompt',prompt:'Earlier question '+i,createdAt:100+i*10});
 filler.push({type:'assistant',uuid:'f'+i,createdAt:101+i*10,message:{content:[{type:'text',text:'Earlier answer '+i+'. '+'Some context. '.repeat(40)}]}});
 filler.push(done(102+i*10,1000));
}
const run=[
 {type:'user_prompt',prompt:'Build the app',createdAt:1000},
 {type:'assistant',uuid:'a1',createdAt:1100,message:{content:[{type:'tool_use',id:'bash-build',name:'Bash',input:{command:'npm run build',description:'Build renderer/main and pack arm64 app locally',run_in_background:true}}]}},
 {type:'user',uuid:'a1r',createdAt:1200,message:{content:[{type:'tool_result',tool_use_id:'bash-build',content:'Command running in background with ID: b1'}]}},
 {type:'assistant',uuid:'a2',createdAt:1300,message:{content:[{type:'text',text:'Building in the background.'}]}},
 done(1400,85000),
 {type:'system',subtype:'background_task_ended',uuid:'ended',createdAt:1500,outcome:{status:'completed',toolUseId:'bash-build',taskType:'local_bash',description:'Build renderer/main and pack arm64 app locally',summary:'Background command completed (exit code 0)'}},
 {type:'assistant',uuid:'b1',createdAt:1600,message:{content:[{type:'tool_use',id:'read-log',name:'Read',input:{file_path:'/tmp/pack.log'}}]}},
 {type:'user',uuid:'b1r',createdAt:1700,message:{content:[{type:'tool_result',tool_use_id:'read-log',content:'packed'}]}},
 {type:'assistant',uuid:'b2',createdAt:1800,message:{content:[{type:'text',text:'The pack finished.'}]}},
 done(1900,84000),
];
const older=[{type:'user_prompt',prompt:'Even earlier',createdAt:50},{type:'assistant',uuid:'old',createdAt:51,message:{content:[{type:'text',text:'Even earlier answer'}]}},done(52,1000)];
// A subagent ran the background command, so it lives in the subagent's trace.
const nested=[
 {type:'user_prompt',prompt:'Delegate the build',createdAt:3000},
 {type:'assistant',uuid:'n0',createdAt:3001,message:{content:[{type:'tool_use',id:'task-1',name:'Task',input:{description:'Build',prompt:'build',subagent_type:'general-purpose'}}]}},
 {type:'assistant',uuid:'n1',createdAt:3002,parentToolUseId:'task-1',message:{content:[{type:'tool_use',id:'nested-build',name:'Bash',input:{command:'npm run build',description:'Nested build',run_in_background:true}}]}},
 {type:'user',uuid:'n0r',createdAt:3003,message:{content:[{type:'tool_result',tool_use_id:'task-1',content:'done'}]}},
 {type:'assistant',uuid:'n2',createdAt:3004,message:{content:[{type:'text',text:'Delegated.'}]}},
 done(3005,5000),
 {type:'system',subtype:'background_task_ended',uuid:'nested-ended',createdAt:3006,outcome:{status:'completed',toolUseId:'nested-build',taskType:'local_bash',description:'Nested build',summary:'done'}},
];
const put=(id,messages)=>store.setState(s=>({sessions:{...s.sessions,[id]:{...s.sessions[id],isDraft:false,hydrated:true,hasMoreHistory:false,provider:'claude',status:'completed',model:'claude-opus-5-5',messages}}}));
put(chatId,[...filler,...run]);
put(otherId,[{type:'user_prompt',prompt:'Something else',createdAt:5000},{type:'assistant',uuid:'x',createdAt:5001,message:{content:[{type:'text',text:'Another session'}]}},done(5002,1000)]);
// Older history not loaded yet: the page starts inside the first run.
put(partialId,run.slice(1));
put(nestedId,nested);
// The subagent's command is in older history that has not loaded yet.
put(laterId,nested.slice(-1));
store.setState(s=>({sessions:{...s.sessions,[laterId]:{...s.sessions[laterId],hasMoreHistory:true,historyCursor:'older-page'}}}));
window.electron.loadOlderSessionHistory=async(id)=>({sessionId:id,status:'completed',messages:id===laterId?nested.slice(0,-1):[],cursor:null,hasMore:false});
// Frames held on request, so a reveal can be caught mid-flight.
const realFrame=window.requestAnimationFrame.bind(window),realCancel=window.cancelAnimationFrame.bind(window);
let heldFrames=null,nextHeld=-1;
window.requestAnimationFrame=cb=>{if(heldFrames){const handle=nextHeld--;heldFrames.set(handle,cb);return handle;}return realFrame(cb);};
window.cancelAnimationFrame=handle=>{if(handle<0){heldFrames?.delete(handle);return;}realCancel(handle);};
// Every scrollIntoView, so a test can see what was scrolled to and how.
const scrolls=[];const realScroll=Element.prototype.scrollIntoView;
Element.prototype.scrollIntoView=function(options){scrolls.push({tool:this.getAttribute('data-workstream-tool-ids'),behavior:options&&options.behavior});return realScroll.call(this,options);};
useAppStore.getState().setTheme('light');
window.qa={store,chatId,otherId,partialId,nestedId,laterId,opened:null,scrolls,
 holdFrames:()=>{heldFrames=new Map();},
 // Held frames a component cancelled meanwhile stay cancelled.
 releaseFrames:()=>{const queued=[...(heldFrames?.values()??[])];heldFrames=null;queued.forEach(cb=>realFrame(cb));},
 setMessages:(id,messages)=>store.setState(s=>({sessions:{...s.sessions,[id]:{...s.sessions[id],messages}}})),
 runMessages:()=>run,fillerMessages:()=>filler,
 prepend:(id,messages)=>store.setState(s=>({sessions:{...s.sessions,[id]:{...s.sessions[id],messages:[...messages,...s.sessions[id].messages]}}})),
 reduceMotion:value=>useAppPreferences.setState({reduceMotion:value}),
 history:{older,firstPrompt:run[0],filler}};
store.setState({openSubagentPanel:id=>{window.qa.opened=id;}});
function Pane(){
 const [id,setId]=useState(chatId);
 window.qa.show=setId;
 return <div id="real-chat" style={{height:'100vh',display:'flex'}}><ChatPane paneId="qa" sessionId={id} isActive onActivate={()=>{}} /></div>;
}
createRoot(document.getElementById('root')).render(<AppearancePreferences><Tooltip.Provider><Pane/></Tooltip.Provider></AppearancePreferences>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1000,height:700,show:true,webPreferences:{backgroundThrottling:false}});
 const errors=[];w.webContents.on('console-message',e=>{if(e.level==='error'){errors.push(e.message);console.error(e.message);}});
 const js=c=>w.webContents.executeJavaScript(c,true);
 const until=async(c,label)=>{for(let i=0;i<100;i++){if(await js(c))return;await delay(100);}throw Error('Timed out: '+label);};
 const shot=async name=>{await delay(200);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await w.webContents.capturePage()).toPNG());};
 const folds='[...document.querySelectorAll("#real-chat .workstream-toggle-row button[aria-expanded]")].filter(b=>b.textContent.startsWith("Worked for"))';
 const foldState=async()=>js(folds+'.map(b=>b.textContent+"="+b.getAttribute("aria-expanded"))');
 const buildRow='[data-workstream-tool-ids~="bash-build"]';
 try{
  const scroller='[...document.querySelectorAll("#real-chat *")].find(e=>e.scrollHeight>e.clientHeight+50&&getComputedStyle(e).overflowY!=="visible")';
  const flashing='!!document.querySelector(".workstream-reveal-flash")';
  const openRow='document.querySelector("[data-background-task-ended] button").click()';
  await w.loadURL(process.env.QA_URL);
  await until(folds+'.length===2','two work folds');
  assert.deepEqual(await foldState(),['Worked for 1m 25s=false','Worked for 1m 24s=false']);
  // Opening the woken run leaves the turn above folded.
  await js(folds+'[1].click()');await delay(250);
  assert.deepEqual(await foldState(),['Worked for 1m 25s=false','Worked for 1m 24s=true'],'the woken run folds on its own');
  await js(folds+'[1].click()');await delay(250);
  assert.deepEqual(await foldState(),['Worked for 1m 25s=false','Worked for 1m 24s=false']);
  // Start from the bottom, as after the run finished.
  await js('(()=>{const s='+scroller+';s.scrollTop=s.scrollHeight})()');await delay(200);
  await shot('before-open');
  // The outcome row opens the turn above onto the command and points at it.
  await js(openRow);
  await until('!!document.querySelector('+JSON.stringify(buildRow)+')','the build command row is shown');
  assert.deepEqual(await foldState(),['Worked for 1m 25s=true','Worked for 1m 24s=false'],'only the turn that ran the command opens');
  await until('document.querySelector('+JSON.stringify(buildRow)+').classList.contains("workstream-reveal-flash")','the command row is highlighted');
  await delay(700);
  const inView=await js('(()=>{const r=document.querySelector('+JSON.stringify(buildRow)+').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()');
  assert.equal(inView,true,'the command row is scrolled into view');
  assert.equal(await js('document.querySelector('+JSON.stringify(buildRow)+').contains(document.activeElement)'),true,'focus moves to the command row');
  const contained=await js('(()=>{const row=document.querySelector('+JSON.stringify(buildRow)+');const r=row.getBoundingClientRect();const fold=[...document.querySelectorAll("#real-chat .workstream-toggle-row")][0].getBoundingClientRect();return r.right<=fold.right+1&&r.left>=fold.left-1})()');
  assert.equal(contained,true,'the highlight stays inside the transcript column');
  assert.equal(await js('[...document.querySelectorAll("#real-chat [data-message-index]")].some(e=>e.style.boxShadow)'),false,'no whole-group flash');
  await shot('opened-on-command');
  await until('!'+flashing,'the highlight fades');
  // Older history arriving afterwards does not replay the reveal or move the transcript.
  const scrollBefore=await js(scroller+'.scrollTop');
  await js('qa.prepend(qa.chatId,qa.history.older)');await delay(600);
  assert.equal(await js(flashing),false,'history arriving does not replay the reveal');
  assert.deepEqual(await foldState(),['Worked for 1m 25s=true','Worked for 1m 24s=false'],'folds keep their state as history arrives');
  assert.ok(Math.abs((await js(scroller+'.scrollTop'))-scrollBefore)<400,'no jump back to the command');
  // Switching sessions and back does not replay it either.
  await js('qa.show(qa.otherId)');await until('document.body.innerText.includes("Another session")','other session');
  await js('qa.show(qa.chatId)');await until(folds+'.length===2','back');await delay(600);
  assert.equal(await js(flashing),false,'coming back does not replay the reveal');
  assert.deepEqual(await foldState(),['Worked for 1m 25s=false','Worked for 1m 24s=false'],'coming back does not reopen the command');
  // Opening it again works.
  await js(openRow);
  await until('document.querySelector('+JSON.stringify(buildRow)+')?.classList.contains("workstream-reveal-flash")','a second open highlights again');
  await until('!'+flashing,'second highlight fades');
  // Reduced motion: the highlight holds still.
  await js('qa.reduceMotion("on")');await delay(100);
  await js(openRow);
  await until(flashing,'reduced-motion highlight');
  assert.equal(await js('getComputedStyle(document.querySelector(".workstream-reveal-flash")).animationName'),'none','no fade animation under reduced motion');
  await until('!'+flashing,'reduced-motion highlight clears');
  await js('qa.reduceMotion("system")');
  // A fold opened before its prompt loaded stays open once the prompt arrives,
  // and the woken run below never picks up its choice.
  await js('qa.show(qa.partialId)');await until(folds+'.length===2','partial history');
  await js(folds+'[0].click()');await delay(250);
  assert.deepEqual(await foldState(),['Worked for 1m 25s=true','Worked for 1m 24s=false'],'fold opened on a partial page');
  await js('qa.prepend(qa.partialId,[...qa.history.filler,qa.history.firstPrompt])');await delay(500);
  assert.deepEqual(await foldState(),['Worked for 1m 25s=true','Worked for 1m 24s=false'],'the fold survives its prompt arriving');
  await js(folds+'[1].click()');await delay(250);
  await js('qa.prepend(qa.partialId,qa.history.older)');await delay(400);
  assert.deepEqual(await foldState(),['Worked for 1m 25s=true','Worked for 1m 24s=true'],'both folds keep their own state through more history');
  // Mid-flight: the reveal is caught after it unfolded the turn but before it
  // pointed at the row. Whatever happens then, it runs at most once, in its own session.
  const caught=async()=>{await js('qa.holdFrames()');await js(openRow);await until(folds+'.length===2&&'+folds+'[0].getAttribute("aria-expanded")==="true"','reveal under way');await delay(150);assert.equal(await js(flashing),false,'the reveal is held before pointing');};
  const settleFrames=async()=>{await js('qa.releaseFrames()');await delay(500);};
  await js('qa.show(qa.chatId)');await until(folds+'.length===2','main session');
  // ...switching sessions: nothing runs there, and nothing replays on return.
  await caught();
  await js('qa.show(qa.otherId)');await until('document.body.innerText.includes("Another session")','switched mid-reveal');
  await settleFrames();
  assert.equal(await js(flashing),false,'a reveal does not run in another session');
  await js('qa.show(qa.chatId)');await until(folds+'.length===2','back again');await delay(500);
  assert.equal(await js(flashing),false,'a reveal interrupted by a switch does not replay');
  assert.deepEqual(await foldState(),['Worked for 1m 25s=false','Worked for 1m 24s=false'],'and does not reopen the turn');
  // ...older history arriving: it completes once, on the same command.
  await js('qa.scrolls.length=0');
  await caught();
  await js('qa.prepend(qa.chatId,[{type:"user_prompt",prompt:"Oldest",createdAt:10},{type:"assistant",uuid:"oldest",createdAt:11,message:{content:[{type:"text",text:"Oldest answer"}]}},{type:"result",subtype:"success",duration_ms:1,total_cost_usd:0,usage:{},createdAt:12}])');
  await delay(100);await settleFrames();
  assert.equal(await js('document.querySelector('+JSON.stringify(buildRow)+')?.classList.contains("workstream-reveal-flash")'),true,'it completes on the command after history arrives');
  const commandScrolls='qa.scrolls.filter(s=>s.tool==="bash-build").length';
  assert.equal(await js(commandScrolls),1,'it scrolls to the command exactly once');
  await until('!'+flashing,'that highlight fades');
  await js('qa.prepend(qa.chatId,[{type:"assistant",uuid:"older-still",createdAt:5,message:{content:[{type:"text",text:"Older still"}]}}])');await delay(800);
  assert.equal(await js(flashing),false,'and it does not run again');
  assert.equal(await js(commandScrolls),1,'not even after more history arrives');
  // ...the group going away: it is dropped, and does not come back with the group.
  await js(folds+'[0].click()');await delay(200);
  await caught();
  await js('qa.setMessages(qa.chatId,qa.fillerMessages())');await delay(150);
  await settleFrames();
  assert.equal(await js(flashing),false,'a reveal whose group is gone does nothing');
  await js('qa.setMessages(qa.chatId,[...qa.fillerMessages(),...qa.runMessages()])');await until(folds+'.length===2','group back');await delay(600);
  assert.equal(await js(flashing),false,'a dropped reveal does not come back with its group');
  // Focus lands on the row's own control, and scrolling follows the motion setting.
  await js('document.querySelector('+JSON.stringify(buildRow)+')');
  const scrollBehavior=async()=>{await js('qa.scrolls.length=0');await js(openRow);await until(flashing,'revealed');const behavior=await js('qa.scrolls.filter(s=>s.tool==="bash-build").map(s=>s.behavior).pop()');await until('!'+flashing,'faded');return behavior;};
  const dbg=w.webContents.debugger;dbg.attach();
  const systemMotion=async reduce=>dbg.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduce?'reduce':'no-preference'}]});
  await systemMotion(false);await js('qa.reduceMotion("system")');
  assert.equal(await scrollBehavior(),'smooth','system motion: smooth');
  assert.equal(await js('document.activeElement===document.querySelector('+JSON.stringify(buildRow)+').querySelector("button:not([disabled])")'),true,'focus lands on the row\'s button');
  await systemMotion(true);await delay(100);
  assert.equal(await scrollBehavior(),'instant','system reduced motion: instant');
  await js('qa.reduceMotion("off")');await delay(100);
  assert.equal(await scrollBehavior(),'smooth','app motion on despite the system: smooth');
  await js('qa.reduceMotion("on")');await systemMotion(false);await delay(100);
  assert.equal(await scrollBehavior(),'instant','app reduced motion: instant');
  await js('qa.reduceMotion("system")');dbg.detach();
  // A subagent's command found only by loading older history opens its subagent.
  await js('qa.opened=null;qa.show(qa.laterId)');await until('!!document.querySelector("[data-background-task-ended] button")','later outcome row');
  await js(openRow);
  await until('qa.opened==="task-1"','older history loads and the subagent opens');
  assert.equal(await js('qa.store.getState().historyNavigationTarget'),null,'the target is cleared');
  // A command a subagent ran opens in that subagent's trace.
  await js('qa.opened=null;qa.show(qa.nestedId)');await until('!!document.querySelector("[data-background-task-ended] button")','nested outcome row');
  await js(openRow);
  await until('qa.opened==="task-1"','a subagent command opens its subagent');
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
 const env={...process.env,QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/playwright/woken-turn')};
 delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});
  const timeout=setTimeout(()=>{child.kill();reject(Error('Electron test timed out'))},120000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(Error('Electron test failed: '+code))});
 });
} finally { await server?.close();await rm(dir,{recursive:true,force:true}); }
