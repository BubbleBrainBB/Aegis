import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const tmp = await mkdtemp(path.join(root, '.aegis-design-qa/new-thread-'));
const capture = path.join(root, 'output/playwright/new-thread-landing');
const harness = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {Toaster} from 'sonner';
import {NewSessionView} from '/src/ui/components/NewSessionView';
import {ChatPane} from '/src/ui/components/ChatPane';
import {useAppStore} from '/src/ui/store/useAppStore';
import {startLeaseFor} from '/src/ui/utils/start-lease.ts';
import {useSessionGoalStore} from '/src/ui/hooks/useSessionGoal.ts';
import '/src/ui/index.css';
localStorage.setItem('cowork.preferredProvider','deepseek');
localStorage.setItem('cowork.preferredDeepseekModel','deepseek-flash');
const Alpha='/projects/My Personal Digital Garden';
const Beta='/projects/Beta';
const Notes='/projects/Notes';
const Long='/projects/A very long project name that should wrap naturally without truncating the destination or moving the composer away from the bottom';
window.qa={calls:[],Alpha,Beta,Notes,Long,store:useAppStore,browseResult:null,startLeaseFor,goals:useSessionGoalStore};
window.electron={
 getRecentCwds:async()=>[Alpha,Beta,Notes,Long],selectDirectory:async()=>qa.browseResult,
 getSessionUserPrompts:async()=>[],sendClientEvent:e=>qa.calls.push(e),
 getGitBranches:async cwd=>{await new Promise(r=>setTimeout(r,120));return cwd===Notes?{ok:false}:{ok:true,entries:[{name:'main',current:true,remote:false},{name:'feature',current:false,remote:false}]};},
 gitCheckoutBranch:async p=>{qa.calls.push(p);return {ok:true};},
 getProjectGitSummary:async()=>({isGitRepository:true}),getProjectTree:async()=>null,
 getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),
 chooseAttachments:async()=>({attachments:[{id:'file',name:'notes.txt',path:'/tmp/notes.txt',mimeType:'text/plain',size:10}],errors:[]}),
 getSessionGoal:async id=>({sessionId:id,supported:false,goal:null,revision:0}),onSessionGoalChanged:()=>()=>{},
};
for(const p of ['Claude','Codex','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Devin','Mimo','Minimax'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
window.electron.getDevinThoughtLevels=async()=>({model:null,levels:[],defaultLevel:null});
window.electron.getMinimaxThinkingEfforts=async()=>({model:null,levels:[],defaultLevel:null});
window.electron.getDeepseekModelConfig=async()=>({defaultModel:'deepseek-flash',options:['deepseek-flash'],availableModels:[{id:'deepseek-flash',name:'DeepSeek V4.1 Flash',reasoningEfforts:['none','high','max']}]});
const a=useAppStore.getState();a.setProjectCwd(Alpha);a.setShowNewSession(true);
a.setActiveChannelForProject(Beta,'beta-channel');
function Harness(){
 const [draft,setDraft]=useState(false);qa.setDraft=()=>{const id=a.createDraftSession(Alpha);qa.draftId=id;setDraft(true);};
 const [hidden,setHidden]=useState(false);qa.setLandingHidden=setHidden;
 const id=useAppStore(s=>s.activeSessionId);
 return <Tooltip.Provider><div style={{height:'100vh',display:'flex',flexDirection:'column',background:'var(--bg-primary)',color:'var(--text-primary)'}}>
 <header style={{height:48,flexShrink:0,padding:'14px 24px',fontSize:13}}>New task</header>
 {draft?<ChatPane paneId="primary" sessionId={id} isActive onActivate={()=>{}} codexModelConfig={{}} showHeader={false}/>:hidden?<main>Settings</main>:<NewSessionView/>}
 <Toaster/>
 </div></Tooltip.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
// CI runners have Reduce Motion on; tests expect the default motion preference.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 // Occluded windows are throttled on CI, which stalls requestAnimationFrame-driven animations.
const win=new BrowserWindow({width:1124,height:879,show:true,webPreferences:{backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error'){errors.push(e.message);console.error(e.message);}});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const until=async(code,label)=>{for(let i=0;i<100;i++){if(await js(code))return;await delay(100);}throw Error('Timed out: '+label);};
 const click=async selector=>{await js('document.querySelector('+JSON.stringify(selector)+').click()');await delay(180);};
 const key=async keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});await delay(180);};
 const shot=async name=>{await delay(200);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 const rect=selector=>js('document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect().toJSON()');
 const measure=async()=>({composer:await rect('.aegis-new-thread-composer'),heading:await rect('h1'),height:await js('innerHeight')});
 const checkContextTray=async()=>{
  const row=await rect('.aegis-composer-context-row');const surface=await rect('.aegis-new-thread-composer-surface');
  assert(row.top<surface.top,'environment controls are above the input');
  assert.equal(row.left-surface.left,14,'tray is inset on the left');
  assert.equal(surface.right-row.right,14,'tray is inset on the right');
  assert.equal(row.bottom-surface.top,12,'input overlaps the tray');
  assert(await js('Array.from(document.querySelectorAll(".aegis-composer-context-row button")).every(b=>b.getBoundingClientRect().bottom<=document.querySelector(".aegis-new-thread-composer-surface").getBoundingClientRect().top)'),'input does not cover environment controls');
 };
 const select=async(entrance,destination)=>{await click(entrance);assert.equal(await js('document.activeElement.getAttribute("aria-label")'),'Search projects');await js('Array.from(document.querySelectorAll("[cmdk-item][title]")).find(x=>x.title===qa.'+destination+').click()');await delay(250);};
 try{
  await win.loadURL(process.env.QA_URL);await until('!!window.qa && !!document.querySelector("[role=textbox]")','initial composer');
  await until('document.querySelector("h1").innerText.includes("build in")','git heading');
  const initial=await measure();assert(Math.abs(initial.height-initial.composer.bottom-16)<2,'composer is 16px from bottom');
  assert(initial.composer.top-initial.heading.bottom>100,'hero is separate from composer');
  await checkContextTray();
  const logo=await rect('.aegis-new-thread-logo');
  assert.equal(logo.width,40);assert.equal(logo.height,40);
  assert(Math.abs(initial.heading.top-logo.bottom-18)<1,'logo has 18px title gap');
  assert(Math.abs((logo.left+logo.width/2)-(initial.heading.left+initial.heading.width/2))<1,'logo is centered over title');
  assert.equal(await js('getComputedStyle(document.querySelector(".aegis-new-thread-logo")).opacity'),'0.3');
  await js('document.querySelector(".aegis-new-thread-logo").dispatchEvent(new PointerEvent("pointerup",{bubbles:true,button:0,pointerType:"mouse"}))');
  let logoTransform='none';
  for(let i=0;i<40&&logoTransform==='none';i++){await delay(50);logoTransform=await js('getComputedStyle(document.querySelector(".aegis-new-thread-logo")).transform');}
  assert.notEqual(logoTransform,'none','logo responds to pointer');
  await delay(1200);
  await shot('new-task-light');
  // The same anchor survives window resizing and longer input.
  win.setContentSize(920,1000);await delay(200);const tall=await measure();assert(Math.abs(tall.height-tall.composer.bottom-16)<2);
  await js('document.querySelector("[role=textbox]").focus();document.execCommand("insertText",false,"Keep this draft while switching projects")');
  await click('[aria-label="Add files or photos"]');
  await until('!!document.querySelector("[aria-label=\\"Remove attachment\\"]")','attachment');
  await select('[aria-label^="Switch project:"]','Beta');
  assert.equal(await js('qa.store.getState().showNewSession'),true,'heading selection keeps first-entry surface');
  assert((await js('document.querySelector("[role=textbox]").textContent')).includes('Keep this draft'));
  assert.equal(await js('document.querySelectorAll("[aria-label=\\"Remove attachment\\"]").length'),1);
  await select('[aria-label="Project folder"]','Notes');
  // The heading fills in once the project resolves; the CI runner can read it first.
  await until('(document.querySelector("h1")?.innerText||"").includes("work on in")','landing heading names the project');
  assert.equal(await js('!!document.querySelector("button[title=\\"Switch branch\\"]")'),false);
  // No stale Git controls from the previous project while new metadata loads.
  await select('[aria-label^="Switch project:"]','Long');
  await shot('long-project');
  win.setContentSize(390,700);await delay(200);
  const narrow=await measure();assert(Math.abs(narrow.height-narrow.composer.bottom-16)<2);
  await checkContextTray();
  assert(narrow.heading.height>48,'long title wraps');
  assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false);
  assert(await js('Array.from(document.querySelectorAll(".aegis-composer-toolbar button,.aegis-composer-context-row button")).every(b=>{const r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})'),'all controls remain inside viewport');
  await shot('new-task-narrow');
  // Portals open above the anchored input, escape closes, and focus returns.
  await click('[aria-label="Select agent and model"]');
  const menu=await rect('[role="menu"]');const model=await rect('[aria-label="Select agent and model"]');
  assert(menu.bottom<=model.top+1,'model menu opens upward');assert(menu.top>=0);
  await shot('model-menu-narrow');await key('Escape');
  await click('[data-composer-control="permission"]');
  assert((await rect('[role="menu"]')).bottom<=(await rect('[data-composer-control="permission"]')).top+1);
  await key('ArrowDown');await key('Escape');
  assert.equal(await js('document.activeElement.getAttribute("data-composer-control")'),'permission');
  await click('[data-composer-control="preset"]');
  assert((await rect('[role="menu"]')).bottom<=(await rect('[data-composer-control="preset"]')).top+1);
  await key('Escape');
  await click('[data-composer-control="permission"]');
  await js('qa.store.setState({pendingStart:true})');await delay(150);
  assert.equal(await js('!!document.querySelector("[role=menu]")'),false,'starting closes permission menu');
  await js('qa.store.setState({pendingStart:false})');
  await click('[data-composer-control="preset"]');await shot('preset-menu');
  await js('qa.store.setState({pendingStart:true})');await delay(150);
  assert.equal(await js('!!document.querySelector("[role=menu]")'),false,'starting closes preset menu');
  await js('qa.store.setState({pendingStart:false})');await delay(150);
  // Clicking the input surface (outside controls) focuses the editor.
  await js('document.activeElement.blur();document.querySelector(".aegis-new-thread-composer-surface").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0,cancelable:true}))');
  assert.equal(await js('document.activeElement.getAttribute("role")'),'textbox');
  await js('qa.store.getState().setTheme("dark")');await shot('new-task-dark');
  assert.equal(await js('getComputedStyle(document.querySelector(".aegis-new-thread-logo")).color'),await js('(()=>{const probe=document.createElement("span");probe.style.color="var(--text-primary)";document.body.append(probe);const color=getComputedStyle(probe).color;probe.remove();return color})()'),'logo follows theme text color');
  assert((await js('getComputedStyle(document.querySelector(".aegis-new-thread-composer-surface")).boxShadow')).includes('inset'));
  // Short windows scroll the independent regions without overlap or clipping.
  win.setContentSize(600,420);await delay(180);
  await js('const landing=document.querySelector(".aegis-new-thread-landing");landing.scrollTop=landing.scrollHeight');
  await delay(100);assert((await rect('.aegis-new-thread-composer')).bottom<=420);
  await shot('new-task-short');
  // "No project" in the picker turns the task into a chat that gets its own folder.
  win.setContentSize(1124,879);await delay(180);
  const pickNoProject=async(entrance,name)=>{await click(entrance);if(name)await shot(name);await js('Array.from(document.querySelectorAll("[cmdk-item]")).find(x=>x.textContent.startsWith("No project")).click()');await delay(250);};
  await pickNoProject('[aria-label^="Switch project:"]','picker-no-project');
  assert.equal(await js('document.querySelector("h1").textContent'),'What should we work on?');
  assert.equal(await js('document.querySelector("[aria-label=\\"Project folder\\"]").textContent'),'No project');
  assert.equal(await js('document.body.textContent.includes("Files go to")'),false,'no note about where files go');
  assert.equal(await js('!!document.querySelector("button[title=\\"Switch branch\\"]")'),false,'a chat has no branch');
  assert.equal(await js('qa.store.getState().projectCwd'),await js('qa.Long'),'the last project stays the default');
  await shot('new-task-no-project');
  const text=()=>js('document.querySelector("[role=textbox]").innerText');
  const chips=()=>js('document.querySelectorAll("[aria-label=\\"Remove attachment\\"]").length');
  const editable=()=>js('document.querySelector("[role=textbox]").getAttribute("contenteditable")');
  const starts=()=>js('qa.calls.filter(e=>e.type==="session.start").length');
  const fail=id=>js('qa.store.getState().handleServerEvent({type:"runner.error",payload:{message:"Could not create a folder for this chat."'+(id?',startId:'+JSON.stringify(id):'')+'}})').then(()=>delay(250));
  const lastStart=()=>js('qa.calls.filter(e=>e.type==="session.start").at(-1).payload.startId');
  // Two clicks in the same instant start one conversation: Send takes the
  // composer's lease before it prepares the message.
  await js('{const b=document.querySelector("[aria-label=\\"Send\\"]");b.click();b.click()}');
  await until('qa.calls.some(e=>e.type==="session.start")','chat start');await delay(200);
  assert.equal(await starts(),1,'one start for a double click');
  assert.deepEqual(await js('(({cwd,chat,createIsolatedWorkspace})=>({cwd:cwd??null,chat,createIsolatedWorkspace:createIsolatedWorkspace??null}))(qa.calls.find(e=>e.type==="session.start").payload)'),{cwd:null,chat:true,createIsolatedWorkspace:null});
  const sentStart=await lastStart();
  assert.ok(sentStart,'a composer start carries its id');
  // The message stays in the composer, locked, until its conversation exists.
  assert.match(await text(),/Keep this draft while switching projects/);
  assert.equal(await chips(),1);
  assert.equal(await editable(),'false','locked while starting');
  // An error that is not this start's (it clears the app-wide pending flag) leaves it locked.
  await fail(null);
  assert.equal(await editable(),'false','an unrelated error keeps it locked');
  await js('document.querySelector("[aria-label=\\"Send\\"]").click()');await delay(200);
  assert.equal(await starts(),1,'still no second start');
  // Its own failure unlocks it with the text untouched.
  await fail(sentStart);
  assert.equal(await editable(),'true','its own failure unlocks it');
  assert.equal((await text()).match(/Keep this draft/g).length,1,'the text is there once');
  assert.equal(await chips(),1);
  assert.equal(await js('qa.store.getState().pendingStart'),false);
  // Off screen when the start fails: the text is back when the page is.
  await click('[aria-label="Send"]');
  await until('qa.calls.filter(e=>e.type==="session.start").length===2','second chat start');
  const awayStart=await lastStart();
  assert.notEqual(awayStart,sentStart,'each start has its own id');
  await js('qa.setLandingHidden(true)');await delay(200);
  await fail(awayStart);
  await js('qa.setLandingHidden(false)');
  await until('!!document.querySelector("[role=textbox]") && document.querySelector("[role=textbox]").innerText.includes("Keep this draft")','text back after returning');
  assert.equal(await editable(),'true');
  assert.equal(await chips(),1);
  assert.equal(await js('qa.startLeaseFor("new-session")??null'),null,'shown, so nothing waits any more');
  // It comes back going where it was going: No project, not the last project.
  assert.equal(await js('document.querySelector("h1").textContent'),'What should we work on?');
  assert.equal(await js('document.querySelector("[aria-label=\\"Project folder\\"]").textContent'),'No project');
  // Back on screen while still starting: shown and locked; success clears it.
  await js('qa.goals.getState().setDraft("__new_session__",true)');
  await click('[aria-label="Send"]');
  await until('qa.calls.filter(e=>e.type==="session.start").length===3','third chat start');
  const liveStart=await lastStart();
  await js('qa.setLandingHidden(true)');await delay(200);
  await js('qa.setLandingHidden(false)');
  await until('!!document.querySelector("[role=textbox]") && document.querySelector("[role=textbox]").innerText.includes("Keep this draft")','pending text shown again');
  assert.equal(await js('qa.goals.getState().drafts.__new_session__'),true,'goal mode stays while starting');
  assert.equal(await editable(),'false','still locked while starting');
  await js('qa.store.getState().handleServerEvent({type:"session.status",payload:{sessionId:"chat-created",status:"running",startId:'+JSON.stringify(liveStart)+',title:"Chat",cwd:"/tmp/chats/2026-10-31/keep-this-draft",projectCwd:"/tmp/chats/2026-10-31/keep-this-draft",isChat:true,provider:"deepseek"}})');
  await until('document.querySelector("[role=textbox]").innerText.trim()===""','cleared once the conversation exists');
  assert.equal(await editable(),'true');
  assert.equal(await chips(),0);
  // A late error for a start that succeeded brings nothing back.
  await fail(liveStart);
  assert.equal((await text()).trim(),'','nothing comes back after success');
  await js('qa.store.getState().clearGlobalError()');
  // Goal mode ends with a successful start even when the page was away then.
  await js('qa.goals.getState().setDraft("__new_session__",true)');
  await js('{const t=document.querySelector("[role=textbox]");t.focus();document.execCommand("insertText",false,"Reach the goal")}');await delay(150);
  await click('[aria-label="Send"]');
  await until('qa.calls.filter(e=>e.type==="session.start").length===4','goal start');
  const goalStart=await lastStart();
  await js('qa.setLandingHidden(true)');await delay(200);
  await js('qa.store.getState().handleServerEvent({type:"session.status",payload:{sessionId:"chat-goal",status:"running",startId:'+JSON.stringify(goalStart)+',title:"Goal",cwd:"/tmp/chats/2026-10-31/reach-the-goal",projectCwd:"/tmp/chats/2026-10-31/reach-the-goal",isChat:true,provider:"deepseek"}})');await delay(150);
  assert.equal(await js('qa.goals.getState().drafts.__new_session__'),false,'goal mode ended while the page was away');
  await js('qa.setLandingHidden(false)');
  await until('!!document.querySelector("[role=textbox]")','landing back');
  assert.equal((await text()).trim(),'','a new page after success is empty');
  // A failed project start comes back to that project, even if the last
  // project changed meanwhile; sending again goes there.
  await select('[aria-label="Project folder"]','Beta');
  await js('{const t=document.querySelector("[role=textbox]");t.focus();document.execCommand("insertText",false,"Fix the Beta build")}');await delay(150);
  await click('[aria-label="Send"]');
  await until('qa.calls.filter(e=>e.type==="session.start").length===5','project start');
  const projectStart=await lastStart();
  assert.equal(await js('qa.calls.filter(e=>e.type==="session.start").at(-1).payload.cwd'),await js('qa.Beta'));
  await js('qa.setLandingHidden(true)');await delay(200);
  await js('qa.store.getState().setProjectCwd(qa.Alpha)');
  await fail(projectStart);
  await js('qa.setLandingHidden(false)');
  await until('!!document.querySelector("[role=textbox]") && document.querySelector("[role=textbox]").innerText.includes("Fix the Beta build")','project text back');
  await until('document.querySelector("h1").innerText.includes("Beta")','the Beta heading is back');
  await click('[aria-label="Send"]');
  await until('qa.calls.filter(e=>e.type==="session.start").length===6','project resend');
  assert.deepEqual(await js('(({cwd,chat})=>({cwd,chat:chat??null}))(qa.calls.filter(e=>e.type==="session.start").at(-1).payload)'),{cwd:await js('qa.Beta'),chat:null},'the resend goes to Beta');
  assert.equal(await js('qa.store.getState().projectCwd'),await js('qa.Alpha'),'the last project is left alone');
  await fail(await lastStart());
  await js('qa.store.getState().clearGlobalError()');
  // The real ChatPane draft entrance must preserve the session and its inputs.
  await js('qa.store.getState().setTheme("light");qa.setDraft()');
  await until('!!document.querySelector("h1") && document.querySelector("h1").innerText.includes("Garden")','draft entrance');
  await js('document.querySelector("[role=textbox]").focus();document.execCommand("insertText",false,"Draft session text")');
  await click('[aria-label="Add files or photos"]');await delay(150);
  await select('[aria-label="Project folder"]','Beta');
  assert.equal(await js('qa.store.getState().activeSessionId===qa.draftId'),true);
  assert.equal(await js('qa.store.getState().sessions[qa.draftId].channelId'),'beta-channel');
  assert((await js('document.querySelector("[role=textbox]").textContent')).includes('Draft session text'));
  assert.equal(await js('document.querySelectorAll("[aria-label=\\"Remove attachment\\"]").length'),1);
  await select('[aria-label^="Switch project:"]','Alpha');
  assert((await js('document.querySelector("[role=textbox]").textContent')).includes('Draft session text'));
  await shot('draft-task-light');
  await checkContextTray();
  assert.equal(await js('document.querySelectorAll(".aegis-new-thread-logo").length'),1,'draft entry uses the same home logo');
  const draft=await measure();assert(Math.abs(draft.height-draft.composer.bottom-16)<2);
  // "No project" on a draft keeps its text and starts it as a chat.
  await pickNoProject('[aria-label="Project folder"]');
  assert.equal(await js('qa.store.getState().activeSessionId===qa.draftId'),true);
  assert.equal(await js('qa.store.getState().sessions[qa.draftId].cwd'),'');
  assert.equal(await js('document.querySelector("h1").textContent'),'What should we work on?');
  assert.equal(await js('document.querySelector("[aria-label=\\"Project folder\\"]").textContent'),'No project');
  assert((await js('document.querySelector("[role=textbox]").textContent')).includes('Draft session text'));
  await shot('projectless');
  // Sending the draft starts a chat: one start for a double click, and the
  // text stays, locked, until the conversation exists or the start fails.
  await js('qa.calls.length=0');
  await js('{const b=document.querySelector("[aria-label=\\"Send\\"]");b.click();b.click()}');
  await until('qa.calls.some(e=>e.type==="session.start")','draft chat start');await delay(200);
  assert.equal(await starts(),1,'one draft start for a double click');
  assert.deepEqual(await js('(({cwd,chat,projectCwd,draftSessionId})=>({cwd:cwd??null,chat,projectCwd,draft:draftSessionId===qa.draftId}))(qa.calls.find(e=>e.type==="session.start").payload)'),{cwd:null,chat:true,projectCwd:null,draft:true});
  assert.equal(await editable(),'false','the draft editor is locked while starting');
  assert.ok((await text()).includes('Draft session text'));
  await fail(null);
  assert.equal(await editable(),'false','an unrelated error keeps the draft locked');
  await fail(await lastStart());
  assert.equal(await editable(),'true');
  assert.equal((await text()).match(/Draft session text/g).length,1,'draft text there once');
  assert.equal(await chips(),1,'draft attachment kept');
  await js('qa.store.getState().clearGlobalError()');
  // Each draft keeps its own unsent message: switching to another draft and
  // back brings it back, and it never shows up in the other draft.
  const draftB=await js('qa.store.getState().createDraftSession(qa.Beta)');
  await until('document.querySelector("h1") && document.querySelector("h1").innerText.includes("Beta")','draft B shown');
  assert.equal((await text()).trim(),'','draft B starts empty');
  assert.equal(await chips(),0);
  await js('{const t=document.querySelector("[role=textbox]");t.focus();document.execCommand("insertText",false,"Only in draft B")}');await delay(150);
  await js('qa.store.getState().setActiveSession(qa.draftId)');
  await until('document.querySelector("[role=textbox]") && document.querySelector("[role=textbox]").innerText.includes("Draft session text")','draft A text back');
  assert.equal((await text()).includes('Only in draft B'),false,'B text stays in B');
  assert.equal(await chips(),1,'draft A attachment back');
  await js('qa.store.getState().setActiveSession('+JSON.stringify(draftB)+')');
  await until('document.querySelector("[role=textbox]") && document.querySelector("[role=textbox]").innerText.includes("Only in draft B")','draft B text back');
  assert.equal((await text()).includes('Draft session text'),false);
  await js('qa.store.getState().setActiveSession(qa.draftId)');
  await until('document.querySelector("[role=textbox]") && document.querySelector("[role=textbox]").innerText.includes("Draft session text")','back on draft A');
  // Picking a project again brings the project heading back.
  await select('[aria-label="Project folder"]','Beta');
  await until('document.querySelector("h1").innerText.includes("Beta")','project again');
  // Two drafts starting at once: a start's result replaces only the draft it came from.
  const twoDrafts=await js('(()=>{const s=qa.store.getState();const a=s.createDraftSession(qa.Alpha);const b=s.createDraftSession(qa.Beta);qa.store.setState({pendingDraftSessionId:b});s.handleServerEvent({type:"session.status",payload:{sessionId:"chat-from-a",status:"running",startId:"start-a",draftSessionId:a,title:"A",cwd:qa.Alpha,projectCwd:qa.Alpha,provider:"deepseek"}});const st=qa.store.getState();return {aGone:!st.sessions[a],bKept:!!st.sessions[b]?.isDraft,pending:st.pendingDraftSessionId===b,created:!!st.sessions["chat-from-a"]};})()');
  assert.deepEqual(twoDrafts,{aGone:true,bKept:true,pending:true,created:true},'only draft A is promoted; B keeps its claim');
  // A landing start (no draft) never takes a draft that is starting meanwhile.
  const landingWithDraft=await js('(()=>{const s=qa.store.getState();const b=s.createDraftSession(qa.Beta);qa.store.setState({pendingDraftSessionId:b});s.handleServerEvent({type:"session.status",payload:{sessionId:"chat-from-landing",status:"running",startId:"start-landing",title:"L",cwd:qa.Alpha,projectCwd:qa.Alpha,provider:"deepseek"}});const st=qa.store.getState();return {bKept:!!st.sessions[b]?.isDraft,pending:st.pendingDraftSessionId===b};})()');
  assert.deepEqual(landingWithDraft,{bKept:true,pending:true});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,initial,tall,narrow,draft,captures:process.env.QA_CAPTURE}));app.exit(0);
 }catch(e){console.error(e);await shot('failure');app.exit(1);}
});
`;
let server;
try {
  await writeFile(path.join(tmp,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp,'harness.tsx'),harness);
  await writeFile(path.join(tmp,'main.cjs'),main);
  server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false,watch:{ignored:['**/.aegis-design-qa/**']}}});await server.listen();
  const url=new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href;
  await new Promise((resolve,reject)=>{
    const env={...process.env,QA_URL:url,QA_CAPTURE:capture};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    let out='';child.stdout.on('data',c=>{out+=c;process.stdout.write(c);});child.stderr.on('data',c=>process.stderr.write(c));
    const timeout=setTimeout(()=>{child.kill();reject(Error('New task Electron test timed out'));},90000);
    child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0&&out.includes('"ok":true')?resolve():reject(Error('New task Electron regression failed'));});
  });
} finally {await server?.close();await rm(tmp,{recursive:true,force:true});}
