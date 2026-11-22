// Comments on diff lines, end to end in the renderer: the Changes panel's "+"
// opens an editor under the line, a saved comment shows under its lines and in
// the composer's one chip, Send carries every comment as text plus data, and a
// sent message draws them as pills. The main process is a mock, so no agent runs.
// Run: node scripts/tests/review-comments-electron.test.mjs
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/review-comments-'));

const PATCH = `diff --git a/src/scheduler.ts b/src/scheduler.ts
index 1111111..2222222 100644
--- a/src/scheduler.ts
+++ b/src/scheduler.ts
@@ -142,5 +142,8 @@ class Scheduler {
   private async tick() {
     const now = Date.now();
-    const due = list(now).slice(0, MAX);
+    const due = list(now);
+    const paused = listPaused(now - GRACE);
+    for (const row of paused) {
+      await this.start(row);
     for (const item of due) {
       void this.run(item);
`;

const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {PromptInput} from '/src/ui/components/PromptInput';
import {AegisDiffPanel} from '/src/ui/components/AegisDiffPanel';
import {MessageCard} from '/src/ui/components/MessageCard';
import {useAppStore} from '/src/ui/store/useAppStore';
import {useReviewCommentStore} from '/src/ui/store/useReviewCommentStore';
import '/src/ui/index.css';
localStorage.setItem('cowork.preferredProvider','deepseek');
const PATCH=${JSON.stringify(PATCH)};
window.electron={getProjectTree:async()=>null,cancelProjectTreeRead:async()=>{},getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionUserPrompts:async()=>[],getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},getBubbleProvidersConfig:async()=>({providers:[]}),getProjectFolders:async()=>[],getModels:async()=>[],listCodexSkills:async()=>({skills:[]}),
 getGitPatch:async(cwd,scope)=>({ok:true,scope,patch:PATCH,repoRoot:cwd,truncated:false}),getGitCommits:async()=>({ok:true,commits:[]}),getGitOverview:async()=>({ok:false}),getGitBranchChanges:async()=>({ok:false}),
 sendClientEvent:event=>qa.events.push(event)};
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Devin','Mimo','Minimax','Antigravity','Codex'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
window.electron.getDevinThoughtLevels=async()=>({model:null,levels:[],defaultLevel:null});
window.electron.getMinimaxThinkingEfforts=async()=>({model:null,levels:[],defaultLevel:null});window.electron.getAntigravityThoughtLevels=async()=>({model:null,levels:[],defaultLevel:null});
window.electron.getDeepseekModelConfig=async()=>({defaultModel:'deepseek-flash',options:['deepseek-flash'],availableModels:[{id:'deepseek-flash',name:'DeepSeek V4.1 Flash',reasoningEfforts:['none','high','max']}]});
const store=useAppStore,id=store.getState().createDraftSession('/tmp/review-qa');
store.setState(s=>({connected:true,projectCwd:'/tmp/review-qa',activeSessionId:id,sessions:{...s.sessions,[id]:{...s.sessions[id],isDraft:false,provider:'deepseek',model:'deepseek-flash',status:'completed',messages:[],hydrated:true}}}));
window.qa={store,id,events:[],comments:useReviewCommentStore};
function Harness(){
 const session=useAppStore(s=>s.sessions[id]);
 const sent=session.messages.filter(m=>m.type==='user_prompt');
 return <Tooltip.Provider><div style={{height:'100vh',display:'flex',overflow:'hidden',background:'var(--bg-primary)',color:'var(--text-primary)'}}>
  <div style={{width:520,flexShrink:0,display:'flex',flexDirection:'column'}}>
   <main data-qa-chat style={{flex:1,minHeight:0,overflow:'auto',padding:'0 24px'}}>{sent.map((m,i)=><MessageCard key={i} message={m} sessionId={id} toolStatusMap={new Map()} toolResultsMap={new Map()}/>)}</main>
   <div className="aegis-chat-composer px-6 pb-4"><PromptInput sessionId={id}/></div>
  </div>
  <div style={{flex:1,minWidth:0,position:'relative',borderLeft:'1px solid var(--border)'}}>
   <AegisDiffPanel collapsed={false} cwd="/tmp/review-qa" session={session} onClose={()=>{}} isFullscreen={false} onToggleFullscreen={()=>{}}/>
  </div>
 </div></Tooltip.Provider>}
createRoot(document.getElementById('root')).render(<Harness/>);
`;

const main = String.raw`
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
// CI runners have Reduce Motion on; tests expect the default motion preference.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1280,height:820,show:true,webPreferences:{backgroundThrottling:false}}),js=s=>win.webContents.executeJavaScript(s,true);
 const until=async(s,label)=>{for(let i=0;i<120;i++){if(await js(s))return;await delay(50)}throw Error('Timed out: '+label)};
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const shot=async name=>{win.webContents.invalidate();await delay(200);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 const mouse=async(type,p,extra={})=>{win.webContents.sendInputEvent({type,x:Math.round(p.x),y:Math.round(p.y),button:'left',clickCount:1,...extra});await delay(60)};
 // The diff draws inside a shadow root; its line-number cells carry the numbers.
 const HOST='document.querySelector(".aegis-file-diff")';
 const lineCenter=n=>js('(()=>{const root='+HOST+'?.shadowRoot;if(!root)return null;const cells=[...root.querySelectorAll("[data-column-number]")].filter(c=>c.textContent.trim()==="'+n+'");const cell=cells.at(-1);if(!cell)return null;const r=cell.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
 const plusCenter=()=>js('(()=>{const b='+HOST+'.shadowRoot.querySelector("[data-utility-button]");if(!b)return null;const r=b.getBoundingClientRect();return r.width?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()');
 const hoverLine=async n=>{const p=await lineCenter(n);assert(p,'line '+n+' is drawn');await mouse('mouseMove',{x:p.x+60,y:p.y});await mouse('mouseMove',{x:p.x+70,y:p.y});for(let i=0;i<40;i++){const plus=await plusCenter();if(plus&&Math.abs(plus.y-p.y)<6)return plus;await delay(50)}throw Error('no + on line '+n)};
 const editorText=()=>js('document.querySelector("[data-review-comment-editor] textarea")?.value');
 const chip=()=>js('document.querySelector("[data-review-comments-chip]")?.innerText.replace(/\\s+/g," ").trim()??null');
 try{
 await win.loadURL(process.env.QA_URL);
 await until('!!document.querySelector("[role=textbox]")','composer');
 await until('!!'+HOST+'?.shadowRoot?.querySelector("[data-column-number]")','diff lines');
 assert.equal(await chip(),null,'no chip before any comment');
 assert.equal(await js('document.querySelector("button[aria-label=\\"Send\\"]").disabled'),true,'nothing to send yet');

 // --- one line: hover, click +, type, Enter ---
 let plus=await hoverLine(144);
 // The "+" sits in the gutter left of the line number, clear of it and of the code.
 const gutter=await js('(()=>{const root='+HOST+'.shadowRoot,b=root.querySelector("[data-utility-button]"),cell=b.closest("[data-column-number]"),walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let text=null;while(walker.nextNode()){if(walker.currentNode.textContent.trim()==="144"){text=walker.currentNode;break}}const r=document.createRange();r.selectNodeContents(text);const n=r.getBoundingClientRect(),p=b.getBoundingClientRect(),c=cell.getBoundingClientRect();return {plusLeft:p.left,plusRight:p.right,numberLeft:n.left,cellLeft:c.left,cellRight:c.right}})()');
 assert(gutter.plusRight<=gutter.numberLeft,'the + ends before the line number starts: '+JSON.stringify(gutter));
 assert(gutter.plusLeft>=gutter.cellLeft&&gutter.plusRight<=gutter.cellRight,'the + stays inside the number column: '+JSON.stringify(gutter));
 await shot('plus-hover');
 await mouse('mouseDown',plus);await mouse('mouseUp',plus);
 await until('!!document.querySelector("[data-review-comment-editor] textarea")','editor opens under the line');
 assert.equal(await js('document.activeElement===document.querySelector("[data-review-comment-editor] textarea")'),true,'the editor takes focus');
 assert.equal(await js('document.querySelector("[data-review-comment-editor]").innerText.includes("Line 144")'),true,'the editor names its line');
 assert.equal(await js('[...document.querySelectorAll("[data-review-comment-editor] button")].find(b=>b.textContent.includes("Comment")).disabled'),true,'Comment is off while empty');
 win.webContents.insertText('Keep the cap here.');await delay(120);
 await shot('editor-open');
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
 await until('document.querySelectorAll("[data-review-comment]").length===1','saved comment card');
 assert.equal(await editorText(),undefined,'the editor closes on save');
 assert.equal(await chip(),'Keep the cap here. scheduler.ts:144','one comment: the chip reads as the comment');
 assert.equal(await js('document.querySelector("[data-review-comment-count]")?.textContent.trim()'),'1','the file header counts it');
 const saved=await js('qa.comments.getState().comments[qa.id]');
 assert.equal(saved.length,1);
 assert.deepEqual([saved[0].filePath,saved[0].startLine,saved[0].endLine,saved[0].startSide,saved[0].code],['src/scheduler.ts',144,144,'additions',['+    const due = list(now);']]);
 assert.equal(saved[0].scope,'Uncommitted');

 // --- several lines: press + on 146, drag to 148 ---
 plus=await hoverLine(146);
 const end=await lineCenter(148);
 const held={modifiers:['leftButtonDown']};
 await mouse('mouseDown',plus);
 await mouse('mouseMove',{x:plus.x,y:(plus.y+end.y)/2},held);
 assert(await js(HOST+'.shadowRoot.querySelectorAll("[data-selected-line]").length')>=2,'lines are drawn selected while dragging');
 await mouse('mouseMove',{x:plus.x,y:end.y},held);
 await mouse('mouseUp',{x:plus.x,y:end.y});
 await until('!!document.querySelector("[data-review-comment-editor] textarea")','editor opens under the range');
 assert.equal(await js('document.querySelector("[data-review-comment-editor]").innerText.includes("Lines 146–148")'),true,'the editor names its lines');
 assert(await js(HOST+'.shadowRoot.querySelectorAll("[data-selected-line]").length')>=3,'the picked lines are drawn selected');
 // With the editor open the "+" stays on its lines; pressing another line's number picks that line instead.
 const other=await lineCenter(143);
 await mouse('mouseMove',other);await mouse('mouseDown',other);await mouse('mouseUp',other);
 await until('document.querySelector("[data-review-comment-editor]")?.innerText.includes("Line 143")','a line number starts a new pick');
 assert.equal(await js(HOST+'.shadowRoot.querySelectorAll("[data-line][data-selected-line]").length'),1,'only the new line is selected');
 // Escape closes without saving.
 win.webContents.insertText('never saved');await delay(80);
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
 await until('!document.querySelector("[data-review-comment-editor]")','Escape closes the editor');
 assert.equal(await js('qa.comments.getState().comments[qa.id].length'),1,'Escape saves nothing');
 plus=await hoverLine(146);
 await mouse('mouseDown',plus);await mouse('mouseMove',{x:plus.x,y:end.y},held);await mouse('mouseUp',{x:plus.x,y:end.y});
 await until('!!document.querySelector("[data-review-comment-editor] textarea")','editor reopens');
 win.webContents.insertText('Resume in the session\'s own mode.');await delay(120);
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
 await until('document.querySelectorAll("[data-review-comment]").length===2','second card');
 assert.equal(await chip(),'2 comments 1 file','several comments: one chip that counts them');
 assert.equal(await js('document.querySelector("[data-review-comment-count]")?.textContent.trim()'),'2');
 await shot('two-comments');

 // --- edit a saved comment ---
 await js('document.querySelector("[data-review-comment] button[aria-label=\\"Edit comment\\"]").click()');
 await until('document.querySelector("[data-review-comment-editor] textarea")?.value==="Keep the cap here."','editing starts from the saved text');
 win.webContents.insertText(' A backlog starts everything at once.');await delay(120);
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
 await until('document.querySelectorAll("[data-review-comment]").length===2&&!document.querySelector("[data-review-comment-editor]")','edit saved');
 assert.equal(await js('qa.comments.getState().comments[qa.id][0].text'),'Keep the cap here. A backlog starts everything at once.');

 // --- the chip's list ---
 await js('document.querySelector("[data-review-comments-chip] button").click()');
 await until('!!document.querySelector("[data-review-comments-list]")','the list opens');
 assert.equal(await js('document.querySelectorAll("[data-review-comments-list] button[aria-label^=\\"Remove comment on\\"]").length'),2);
 assert.equal(await js('document.querySelector("[data-review-comments-list]").innerText.includes("scheduler.ts:146–148")'),true);
 await shot('chip-list');
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
 await until('!document.querySelector("[data-review-comments-list]")','the list closes');

 // --- send with nothing typed: the comments are the message ---
 await until('document.querySelector("button[aria-label=\\"Send\\"]").disabled===false','comments alone can be sent');
 await js('document.querySelector("button[aria-label=\\"Send\\"]").click()');
 await until('qa.events.some(e=>e.type==="session.continue")','send');
 const sent=(await js('qa.events.filter(e=>e.type==="session.continue")')).at(-1).payload;
 assert.equal(sent.prompt,'','the bubble text is what was typed: nothing');
 assert.equal(sent.effectivePrompt,[
  'Review comments on the diff (Uncommitted):','',
  '1. src/scheduler.ts:144',
  '   +    const due = list(now);',
  '   Keep the cap here. A backlog starts everything at once.','',
  '2. src/scheduler.ts:146-148',
  '   +    for (const row of paused) {',
  '   +      await this.start(row);',
  '        for (const item of due) {',
  '   Resume in the session\'s own mode.',
 ].join('\n'),'the agent reads every comment with its lines');
 assert.deepEqual(sent.reviewComments.map(c=>[c.startLine,c.endLine]),[[144,144],[146,148]]);
 await until('!document.querySelector("[data-review-comments-chip]")&&document.querySelectorAll("[data-review-comment]").length===0','sending takes the comments');
 assert.equal(await js('document.querySelector("[data-review-comment-count]")'),null);

 // --- the sent message: one pill per comment ---
 // The main process echoes the prompt back with its comments; the store keeps them on the message.
 await js('qa.store.getState().handleServerEvent({type:"stream.user_prompt",payload:{sessionId:qa.id,prompt:"",createdAt:Date.now(),reviewComments:'+JSON.stringify(sent.reviewComments)+'}})');
 assert.equal(await js('qa.store.getState().sessions[qa.id].messages.filter(m=>m.type==="user_prompt").at(-1).reviewComments.length'),2);
 await until('document.querySelectorAll("[data-review-comment-pills] button").length===2','pills above the message');
 assert.equal(await js('document.querySelector("[data-review-comment-pills]").textContent.includes("scheduler.ts:146–148")'),true);
 // Long comments in a narrow chat column: the pills shrink to the column instead of spilling out of it.
 await js('qa.store.getState().handleServerEvent({type:"stream.user_prompt",payload:{sessionId:qa.id,prompt:"Fix these two.",createdAt:Date.now()+1,reviewComments:'+JSON.stringify(sent.reviewComments.map((c,i)=>({...c,id:'long'+i,filePath:'src/electron/libs/automation-scheduler-with-a-long-name.ts',text:'Keep the MAX_DUE_PER_TICK cap here. Without it a backlog starts every due automation in one tick.'})))+'}})');
 await until('document.querySelectorAll("[data-review-comment-pills]").length===2','second message');
 for(const width of [1280,760]){
  win.setContentSize(width,820);await delay(250);
  const fit=await js('(()=>{const chat=document.querySelector("[data-qa-chat]").getBoundingClientRect();return [...document.querySelectorAll("[data-review-comment-pills] button")].map(b=>{const r=b.getBoundingClientRect();return {left:Math.round(r.left-chat.left),right:Math.round(chat.right-r.right),width:Math.round(r.width)}})})()');
  assert(fit.every(p=>p.left>=0&&p.right>=0&&p.width>60),'pills stay inside the chat column at '+width+': '+JSON.stringify(fit));
  assert.equal(await js('(()=>{const pill=[...document.querySelectorAll("[data-review-comment-pills] button")].at(-1),box=pill.getBoundingClientRect();return [...pill.querySelectorAll("span")].some(s=>s.textContent===":146–148"&&s.getBoundingClientRect().right<=box.right&&s.scrollWidth<=s.clientWidth+1)})()'),true,'the line numbers stay readable when the file name is cut at '+width);
 }
 win.setContentSize(1280,820);await delay(200);
 await shot('sent');
 assert.deepEqual(errors,[]);
 console.log('PASS: diff line comments (one line, a range, edit, chip list, send, pills)');app.exit(0);
 }catch(e){console.error(e,errors);try{await shot('failure')}catch{};app.exit(1)}
});
`;

let server;
try {
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(dir, 'harness.tsx'), harness);
  await writeFile(path.join(dir, 'main.cjs'), main);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(dir, 'vite-cache'), server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.aegis-design-qa/**'] } } });
  await server.listen();
  const env = { ...process.env, BUBBLE_HOME: path.join(dir, 'bubble-home'), QA_URL: new URL(path.relative(root, dir) + '/index.html', server.resolvedUrls.local[0]).href, QA_CAPTURE: path.join(root, 'output/playwright/review-comments') };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(dir, 'main.cjs')], { env, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(Error('Review comments QA timed out')); }, 90000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Review comments QA failed: ' + code)); });
  });
} finally {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
}
