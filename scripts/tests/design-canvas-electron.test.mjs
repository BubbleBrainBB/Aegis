import { createServer } from "vite";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
const root = process.cwd();
await mkdir(path.join(root, ".aegis-design-qa"), { recursive: true });
const fixture = await mkdtemp(path.join(root, ".aegis-design-qa/canvas-"));
const data = await mkdtemp(path.join(tmpdir(), "aegis-design-canvas-qa-"));
const capture = path.join(root, "output/playwright/design-canvas");
let server;
const harness = `
import React,{useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {RightUtilityWorkspace,RightPanelLauncherContent} from '/src/ui/App';
import {DesignPanel} from '/src/ui/components/design/DesignPanel';
import {useAppStore} from '/src/ui/store/useAppStore';
import {subscribeDesignChanges,useDesignStore} from '/src/ui/store/useDesignStore';
import {DesignCommentPromptRow} from '/src/ui/components/design/DesignCommentPromptRow';
import {useComposerQueueStore} from '/src/ui/store/useComposerQueueStore';
import '/src/ui/index.css';
// QA only: the person may switch apps while this runs; an OS-level window blur
// would cancel synthetic canvas gestures midway. Swallow it before the canvas sees it.
window.addEventListener('blur',e=>e.stopImmediatePropagation(),true);
const store=useAppStore;
const a=store.getState().createDraftSession('/qa/project');
const b=store.getState().createDraftSession('/qa/project');
store.setState(s=>({sessions:{...s.sessions,[a]:{...s.sessions[a],isDraft:false,title:'Design a travel journal',provider:'claude'},[b]:{...s.sessions[b],isDraft:false,title:'Another chat',provider:'claude'}}}));
store.getState().setActiveSession(a);
// Stands in for the chat composer (PromptInput): a submitted injection is sent
// as the session's next message, or queued as its own item while a turn runs.
store.subscribe((st)=>{const inj=st.pendingChatInjection;if(!inj||!inj.submit)return;st.consumeChatInjection(inj.nonce);
const outgoing={displayPrompt:inj.text,effectivePrompt:inj.effectivePrompt||inj.text,attachments:inj.attachments??[],references:{},design:inj.design};
if(st.sessions[inj.sessionId]?.status==='running'){useComposerQueueStore.getState().enqueue(inj.sessionId,{id:crypto.randomUUID(),...outgoing,exclusive:true});return}
window.electron.sendClientEvent({type:'session.continue',payload:{sessionId:inj.sessionId,prompt:outgoing.displayPrompt,effectivePrompt:outgoing.effectivePrompt,attachments:outgoing.attachments,design:inj.design}})});
function App(){const s=store();const titles=useDesignStore(x=>x.titles);useEffect(subscribeDesignChanges,[]);
const tab=s.activeRightUtilityTab;const show=tab==='design'||tab?.startsWith('design:');
return <Tooltip.Provider><div style={{height:'100vh',display:'flex',background:'var(--bg-primary)',color:'var(--text-primary)'}}>
<aside style={{width:195,borderRight:'1px solid var(--border)',padding:20}}><strong>Aegis</strong><p style={{marginTop:30,color:'var(--text-muted)'}}>Conversations</p><button onClick={()=>s.setActiveSession(a)}>Travel journal</button><br/><button onClick={()=>s.setActiveSession(b)}>Another chat</button></aside>
<main style={{flex:1,padding:'70px 28px',minWidth:250}}><small style={{color:'var(--text-muted)'}}>AEGIS · DESIGN</small><h2>Design a travel journal</h2><p style={{lineHeight:1.8}}>A quiet place for places worth remembering.<br/>Explore the home and journal boards on the right.</p><div style={{marginTop:30,border:'1px solid var(--border)',borderRadius:12,padding:16}}>Created two boards. Select an element to leave feedback.</div><div className="qa-chat" style={{display:'flex',flexDirection:'column',gap:16,marginTop:24}}>{(s.sessions[s.activeSessionId]?.messages??[]).filter(m=>m.type==='user_prompt'&&m.design).map(m=><DesignCommentPromptRow key={m.createdAt} prompt={m.prompt} design={m.design} sessionId={s.activeSessionId} attachments={m.attachments}/>)}</div><pre style={{fontSize:11,whiteSpace:'pre-wrap',marginTop:30}}>{s.pendingChatInjection?.text}</pre></main>
<RightUtilityWorkspace hidden={s.rightUtilityPanelHidden} instantReveal activePanel={show?'design':'launcher'} tabs={s.rightUtilityTabs.map(id=>({id,kind:id.startsWith('design')?'design':id,label:id.startsWith('design:')?'Design · '+(titles[id.slice(7)]||'Canvas'):id}))} activeTab={tab} browserAvailable width={770} maximumWidth={1100} resizable={false} fullscreen={!!s.rightPanelFullscreen} onWidthChange={()=>{}} onSelectTab={s.setActiveRightUtilityTab} onCloseTab={s.closeRightUtilityTab} onOpenLauncher={()=>{}} onTogglePanel={s.closeRightUtilityPanels} onToggleFullscreen={()=>s.setRightPanelFullscreen(s.rightPanelFullscreen?null:'design')}>
{show?<DesignPanel key={s.activeSessionId+':'+tab} sessionId={s.activeSessionId} documentId={tab.startsWith('design:')?tab.slice(7):undefined} hidden={false}/>:<RightPanelLauncherContent hidden={false} browserAvailable onOpenFiles={()=>s.openRightUtilityTab('files')} onOpenTerminal={()=>s.openRightUtilityTab('terminal')} onOpenBrowser={()=>s.openRightUtilityTab('browser')} onOpenReview={()=>s.openRightUtilityTab('review')} onOpenSideChat={()=>{}} onOpenDesign={()=>s.openRightUtilityTab('design')} onOpenUrl={()=>{}}/>}
</RightUtilityWorkspace></div></Tooltip.Provider>}
store.getState().openRightUtilityTab('design');createRoot(document.getElementById('root')).render(<App/>);window.qa={store,design:useDesignStore,a,b,queue:useComposerQueueStore,addPrompt:(sessionId,payload)=>store.setState(st=>({sessions:{...st.sessions,[sessionId]:{...st.sessions[sessionId],messages:[...st.sessions[sessionId].messages,{type:'user_prompt',prompt:payload.prompt,attachments:payload.attachments,design:payload.design,createdAt:payload.createdAt}]}}}))};
`;
const preload = `const {contextBridge,ipcRenderer}=require('electron');const design={};for(const m of ['list','listAll','create','read','update','history','restore','comment','reply','comments','resolve','focus','composer','preview','export','handoff'])design[m]=x=>ipcRenderer.invoke('design:'+m,x);design.onChanged=cb=>{const f=(_,e)=>cb(e);ipcRenderer.on('design:changed',f);return()=>ipcRenderer.removeListener('design:changed',f)};contextBridge.exposeInMainWorld('electron',{design,createInlineImageAttachment:(mime,bytes)=>ipcRenderer.invoke('qa-image',mime,bytes),sendClientEvent:event=>ipcRenderer.invoke('qa-send',event),getUserProfile:()=>Promise.resolve({displayName:'Chengsheng',handle:'chengsheng',customized:true}),selectAttachments:()=>Promise.resolve([])});`;
const main = String.raw`
const {app,BrowserWindow,ipcMain,dialog}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
app.setPath('userData',path.join(process.env.QA_DATA,'profile'));app.setPath('sessionData',path.join(process.env.QA_DATA,'chromium'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
fs.mkdirSync(path.join(process.env.QA_DATA,'profile'),{recursive:true});fs.writeFileSync(path.join(process.env.QA_DATA,'profile','user-profile.json'),JSON.stringify({displayName:'Chengsheng',handle:'chengsheng'}));
app.whenReady().then(async()=>{
const {registerDesignIpc}=require(path.join(process.env.QA_ROOT,'dist-electron/electron/design/ipc.js'));
const {getDesignRepository}=require(path.join(process.env.QA_ROOT,'dist-electron/electron/design/service.js'));
const {createNativeDesignTools}=require(path.join(process.env.QA_ROOT,'dist-electron/electron/design/tools.js'));
const {markDesignCommentSent,settleDesignTurn}=require(path.join(process.env.QA_ROOT,'dist-electron/electron/design/service.js'));
const sent=[];
const qaProject=path.join(process.env.QA_DATA,'project');fs.mkdirSync(qaProject,{recursive:true});require(path.join(process.env.QA_ROOT,'dist-electron/electron/design/styles.js')).setDesignProjectRoot(s=>s==='outsider'?path.join(process.env.QA_DATA,'elsewhere'):qaProject);
registerDesignIpc();ipcMain.handle('qa-image',(_e,mime,bytes)=>{const file=path.join(process.env.QA_DATA,'annotation.png');fs.writeFileSync(file,Buffer.from(bytes));return {id:'qa-image',name:'annotation.png',path:file,mimeType:mime,size:bytes.length,type:'image'}});
// Stands in for ipc-handlers' session.continue: record, mark the thread, echo the chat row.
ipcMain.handle('qa-send',async(_e,event)=>{const p=event.payload;const createdAt=Date.now();sent.push(p);if(p.design)markDesignCommentSent(p.sessionId,p.design,createdAt);await w.webContents.executeJavaScript('qa.addPrompt('+JSON.stringify(p.sessionId)+','+JSON.stringify({...p,createdAt})+')')});
// Export passes its window first when it has one: the options are the last argument.
dialog.showSaveDialog=async(...args)=>({canceled:false,filePath:path.join(process.env.QA_DATA,path.basename(args.at(-1).defaultPath))});
const w=new BrowserWindow({width:1440,height:980,show:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
// Native input events need an OS-focused window (a window blur cancels canvas gestures): keep it in front.
w.setAlwaysOnTop(true,'floating');app.focus({steal:true});
const errors=[];w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
const js=async s=>{try{return await w.webContents.executeJavaScript(s,true)}catch(e){console.error("Renderer script:",s,errors);throw e}};
const until=async(s,label)=>{for(let i=0;i<100;i++){if(await js(s))return;await delay(75)}throw Error('Timed out: '+label+'; '+errors.join('\n'))};
const click=async s=>{await js('document.querySelector('+JSON.stringify(s)+').click()');await delay(160)};
const text=async(label)=>{await js('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+');if(!b)throw Error("Missing '+label+'");b.click()})()');await delay(180)};
try {
await w.loadURL(process.env.QA_URL);await until('!!window.qa','renderer');
const a=await js('qa.a'),b=await js('qa.b');const abort=new AbortController();const tools=createNativeDesignTools(a);const call=async(name,args)=>{const r=await tools.find(t=>t.name===name).execute(args,{abortSignal:abort.signal});assert(!r.isError,r.content);return JSON.parse(r.content)};
await js('qa.store.getState().setRightPanelFullscreen("files")');
const d=await call('design_create',{title:'Fieldnotes',brief:'A warm, quiet travel journal',operationId:'create'});
await until('document.querySelector("[data-design-document]")','automatic panel opens');
await until('qa.store.getState().rightPanelFullscreen===null','a new design opens beside the chat, not in full view');
const html=(title,subtitle,color)=>'<style>body{font-family:system-ui;background:#f5f2eb;color:#24322d}nav{display:flex;justify-content:space-between;padding:28px 38px;border-bottom:1px solid #dcded2}main{padding:52px 38px}small{letter-spacing:3px;color:#667565}h1{font-family:Georgia;font-size:68px;font-weight:400;line-height:1.04;margin:24px 0}p{line-height:1.8;color:#667565;max-width:400px}.land{margin-top:36px;background:'+color+';height:210px;border-radius:90px 90px 8px 8px;display:flex;align-items:center;justify-content:center;font:italic 27px Georgia;color:#fff}button{background:#284a39;color:white;border:0;padding:14px 22px;border-radius:24px}</style><nav><b>fieldnotes.</b><span>Journal &nbsp; Places &nbsp; About</span></nav><main><small>PLACES THAT STAY WITH YOU</small><h1 data-aegis-node-id="hero">'+title+'</h1><p>'+subtitle+'</p><button>Start your journal ↗</button><div class="land">A slower kind of discovery.</div></main>';
const updated=await call('design_update',{documentId:d.id,operationId:'boards',operations:[{type:'add',name:'Home',width:720,height:900,html:html('Some places<br>become a part<br>of you.','Collect the moments, little discoveries and places you want to remember.','#81977b')},{type:'add',name:'Journal',width:720,height:900,html:html('Leave a little<br>room for<br>wonder.','A journal of roads taken slowly. Stories from the coast, mountains and everywhere in between.','#ad9478')}]});
await until('document.querySelectorAll("iframe").length===2','two live boards');await js('document.querySelector(".design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"0",code:"Digit0",metaKey:true,bubbles:true,cancelable:true}))');await delay(350);
const repo=getDesignRepository();assert.equal(repo.read(a,d.id).boards.length,2);
const frame=w.webContents.mainFrame.framesInSubtree.find(f=>f.url==='about:srcdoc');assert(frame);
assert.equal(await frame.executeJavaScript('typeof window.electron'), 'undefined');
assert.equal(await frame.executeJavaScript('(()=>{try{return typeof parent.electron}catch{return "isolated"}})()'),'isolated');
await frame.executeJavaScript('document.querySelector("h1").click()');await until('!!document.querySelector(".design-selection")','selection bridge');
const type=async(selector,value)=>js('(()=>{const el=document.querySelector('+JSON.stringify(selector)+');el.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event("input",{bubbles:true}))})()');
const buttonText=async(scope,prefix)=>{await js('(()=>{const b=[...document.querySelectorAll('+JSON.stringify(scope+' button')+')].find(b=>b.textContent.trim().startsWith('+JSON.stringify(prefix)+'));if(!b)throw Error("Missing '+prefix+'");b.click()})()');await delay(180)};
await until('!!document.querySelector(".design-float-bar")','selection toolbar');
// The element bar: text style, Edit text, Comment and Properties, with the size under the selection.
await until('!!document.querySelector(".design-float-bar .design-selection-tools[data-kind=text]")','text tools for a heading');
for(const label of ['Edit text','Comment','Properties','Bold','Text color'])assert(await js('!!document.querySelector(".design-float-bar [aria-label=\''+label+'\']")'),label+' in the element bar');
assert.match(await js('document.querySelector(".design-size-badge")?.textContent??""'),/^\d+ × \d+$/);
// One Comment action: mentioning the agent is on by default and hands the comment to it.
await click('.design-float-bar [aria-label="Comment"]');await until('!!document.querySelector(".design-composer .design-mention")','composer with the agent mention');
await type('.design-composer textarea','Make this headline more compact');await click('.design-composer .design-primary');
await until('document.querySelectorAll(".design-pin").length===1','pin on canvas');
for(let i=0;i<80&&!sent.length;i++)await delay(75);
assert.equal(sent.length,1,'comment sent to the agent');
const commentPayload=sent[0];
assert.equal(commentPayload.prompt,'Make this headline more compact');
assert(await js('document.querySelector(".design-composer .design-mention, .design-thread .design-mention")?.textContent.includes("@Claude Code") ?? true'),'the mention names the session agent');
assert(commentPayload.effectivePrompt.includes('<design_comment')&&commentPayload.effectivePrompt.includes(updated.boards[0].id));
assert.equal(commentPayload.attachments.length,1,'board screenshot attached');
const commentId=commentPayload.design.commentId;assert.equal(await js('document.querySelector(".design-pin").textContent'),'C','pin shows the author initial');
await until('!!document.querySelector(".design-pin.is-working")','thread is working');
await until('!!document.querySelector(".design-thread")&&document.querySelector(".design-thread").textContent.includes("Updating Home")','thread shows progress');
await until('!!document.querySelector(".qa-chat .design-chat-comment")','comment row in chat');
assert((await js('document.querySelector(".qa-chat .design-chat-comment").textContent')).includes('Comment on Fieldnotes · sent to the agent'));
// The agent addresses the comment and replies in the thread.
const home=repo.read(a,d.id).boards[0];
await call('design_update',{documentId:d.id,operationId:'compact-headline',summary:'Tightened hero headline on Home',commentId,operations:[{type:'content',boardId:home.id,expectedRevision:home.contentRevision,html:home.html.replace('data-aegis-node-id="hero"','data-aegis-node-id="hero" style="font-size: 48px"')}]});
const reply=await tools.find(t=>t.name==='design_reply').execute({documentId:d.id,commentId,text:'Reduced it to 48px.'},{toolCall:{id:'call-1'}});assert(!reply.isError,reply.content);
settleDesignTurn(a);
await until('document.querySelector(".design-thread")?.textContent.includes("· Compare")','reply links the new version');
assert(!(await js('!!document.querySelector(".design-pin.is-working")')),'working cleared');
// View thread from the chat focuses the canvas thread.
await click('[aria-label="Close thread"]');await until('!document.querySelector(".design-thread")','thread closed');
await buttonText('.qa-chat .design-chat-comment','View thread');await until('!!document.querySelector(".design-thread")&&!!document.querySelector(".design-thread-target")','View thread focuses the canvas');
assert.equal(await js('document.querySelector(".design-tabs [aria-selected=true]").textContent.startsWith("Comments")'),true);
assert((await js('document.querySelector(".design-comments").textContent')).includes('Make this headline more compact'));
fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,'design-comments-list.png'),(await w.webContents.capturePage()).toPNG());
// Compare from the thread.
await buttonText('.design-thread','v');await until('!!document.querySelector(".design-compare")','compare opens');
await until('!!document.querySelector(".design-diff-region")&&[...document.querySelectorAll(".design-change-prop")].some(e=>e.textContent.includes("Font size"))','diff region and font size change');
fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,'design-compare.png'),(await w.webContents.capturePage()).toPNG());
await buttonText('.design-compare-bar','Swipe');await until('!!document.querySelector(".design-compare-slider input[aria-label=\'Swipe position\']")','swipe mode');
await buttonText('.design-compare-bar','Overlay');await until('!!document.querySelector(".design-compare-slider input[aria-label=\'Overlay opacity\']")','overlay mode');
await buttonText('.design-compare-bar','Exit compare');await until('!document.querySelector(".design-compare")','exit compare');
// While the agent is busy, a reply waits in the queue as its own turn.
await js('qa.store.setState(s=>({sessions:{...s.sessions,[qa.a]:{...s.sessions[qa.a],status:"running"}}}))');
await type('.design-thread .design-composer textarea','Also tighten the spacing');await click('.design-thread .design-composer .design-primary');
await until('(qa.queue.getState().queues[qa.a]??[]).some(i=>i.design?.reply&&i.exclusive)','reply queued while busy');
assert.equal(sent.length,1,'queued reply is not sent mid-turn');
await js('qa.queue.getState().takeAll(qa.a);qa.store.setState(s=>({sessions:{...s.sessions,[qa.a]:{...s.sessions[qa.a],status:"idle"}}}))');
// Resolve hides the pin without minting a version.
const beforeResolve=repo.read(a,d.id).revision;
await click('[aria-label="Resolve comment"]');await until('document.querySelectorAll(".design-pin").length===0','resolved pin disappears');
assert.equal(repo.read(a,d.id).revision,beforeResolve,'resolve never mints a version');
// Removing the mention keeps a plain note.
await w.webContents.mainFrame.framesInSubtree.find(f=>f.url==='about:srcdoc').executeJavaScript('document.querySelector("p").click()');await until('(Object.values(qa.design.getState().selections).find(Boolean)?.label??"").split(" · ")[0]==="p"','second selection');await delay(250);
await click('.design-float-bar [aria-label="Comment"]');await until('!!document.querySelector(".design-composer .design-mention")','second composer');
await js('(()=>{const t=document.querySelector(".design-composer textarea");t.focus();t.setSelectionRange(0,0);t.dispatchEvent(new KeyboardEvent("keydown",{key:"Backspace",bubbles:true}))})()');
await until('!document.querySelector(".design-composer .design-mention")','chip removed');
await type('.design-composer textarea','Note only');await click('.design-composer .design-primary');
await until('document.querySelectorAll(".design-pin").length===1','note pin');await delay(300);
assert.equal(sent.length,1,'plain note is not sent');
await until('!!document.querySelector(".design-thread")','note thread opens');
fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,'design-canvas.png'),(await w.webContents.capturePage()).toPNG());
await click('[aria-label="Close thread"]');
// Code tab: layer tree at the selection, authored CSS and what it inherits.
await text('Code');await until('document.querySelector(".cx-css")?.textContent.includes("max-width: 400px;")','layer CSS');
const codeCss=await js('document.querySelector(".cx-css").textContent');
assert(codeCss.includes('line-height: 1.8;')&&codeCss.includes('color: #667565;'),'authored rule in source order, colors as hex');
assert(!codeCss.includes('data-aegis')&&!codeCss.includes('box-sizing'),'no editor attributes or frame styles');
assert.equal(await js('document.querySelector(".cx-head").textContent.startsWith("<p>")'),true);
assert(await js('[...document.querySelectorAll(".cx-inherit")].some(g=>g.textContent.includes("body")&&g.textContent.includes("font-family")&&!g.textContent.includes("color"))'),'inherited from body, minus what the layer overrides');
const treeSelected=await js('[...document.querySelectorAll(".design-inspector-layers [role=treeitem][aria-selected=true]")].map(r=>r.textContent).join("|")');
assert(treeSelected.includes('p · Collect the moments'),'tree expanded to the selected layer: '+treeSelected);
fs.writeFileSync(path.join(process.env.QA_CAPTURE,'design-code.png'),(await w.webContents.capturePage()).toPNG());
// Selecting from the tree moves the canvas selection.
await js('[...document.querySelectorAll(".design-inspector-layers .design-layer-name")].find(b=>b.textContent.includes("h1 · "))?.click()');
await until('document.querySelector(".cx-head")?.textContent.startsWith("<h1>")&&document.querySelector(".cx-css")?.textContent.includes("font-family: Georgia;")','tree selects h1');
// The inspector resizes from its left edge and remembers the width.
const inspW=()=>js('Math.round(document.querySelector(".design-inspector").getBoundingClientRect().width)');
const before=await inspW();
const hb=await js('(()=>{const r=document.querySelector(".design-inspector-resizer").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
// Synthetic drags are occasionally dropped while the window settles; retry a few times.
for(let attempt=0;attempt<3&&(await inspW())<before+100;attempt++){w.focus();w.webContents.sendInputEvent({type:'mouseMove',x:hb.x,y:hb.y});w.webContents.sendInputEvent({type:'mouseDown',x:hb.x,y:hb.y,button:'left',clickCount:1});
for(let i=1;i<=6;i++){w.webContents.sendInputEvent({type:'mouseMove',x:hb.x-i*20,y:hb.y,button:'left'});await delay(16)}
w.webContents.sendInputEvent({type:'mouseUp',x:hb.x-120,y:hb.y,button:'left',clickCount:1});await delay(250)}
await until('Math.round(document.querySelector(".design-inspector").getBoundingClientRect().width)>='+(before+100),'inspector wider');
assert.equal(await js('localStorage.getItem("aegis.design.inspectorWidth")'),String(await inspW()),'width remembered');
await js('document.querySelector(".design-inspector-resizer").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
await until('Math.round(document.querySelector(".design-inspector").getBoundingClientRect().width)==='+before,'double-click restores default');
// The zoom pill collapses the inspector; the choice is remembered.
await click('[aria-label="Hide inspector"]');await until('!document.querySelector(".design-inspector")&&!!document.querySelector("[aria-label=\'Show inspector\'][aria-pressed=false]")','inspector hidden');
assert.notEqual(await js('localStorage.getItem("aegis.design.inspectorOpen")'),'true','closed is remembered');
await click('[aria-label="Show inspector"]');await until('!!document.querySelector(".design-inspector .cx-css")','inspector back on the Code tab');
await text('Properties');
await js('qa.store.getState().setActiveSession(qa.b);qa.store.getState().openRightUtilityTab("design")');await until('!!document.querySelector(".design-library")','session B library');
// Designs belong to the project: chat B, in the same project, lists chat A's design too.
assert.equal(await js('document.querySelectorAll(".design-document-list button").length'),1,'the project design is listed in another chat');
await until('document.querySelectorAll(".design-document-list [data-design-cover] .design-cover-board").length>=1','the design card shows its boards');
assert.equal(await js('!!document.querySelector(".design-document-list .design-document-tag")'),false,'not one of chat B\'s designs');
await delay(400);fs.writeFileSync(path.join(process.env.QA_CAPTURE,'design-library.png'),(await w.webContents.capturePage()).toPNG());
await js('qa.store.getState().setActiveSession(qa.a)');await until('document.querySelectorAll("iframe").length===2','session A restored');
const first=repo.read(a,d.id).boards[0];
await call('design_update',{documentId:d.id,operationId:'updated-headline',operations:[{type:'content',boardId:first.id,expectedRevision:first.contentRevision,html:html('Remember<br>the journey.','A revised headline.','#81977b')}]});await delay(220);
// History and Export live in the design menu under the title.
const designMenu=async(prefix)=>{await until('!!document.querySelector(".design-title-button")&&!document.querySelector(".design-title-button").disabled','design menu ready');if(!(await js('!!document.querySelector(".design-export-actions")')))await click('.design-title-button');await until('!!document.querySelector(".design-export-actions")','design menu');await js('[...document.querySelectorAll(".design-export-actions button")].find(b=>b.textContent.trim().startsWith('+JSON.stringify(prefix)+')).click()');await delay(180)};
await designMenu('History');await until('document.querySelectorAll(".design-version-group").length>=1','history list');
// One row per version; the agent's saves fold into it.
assert(await js('document.querySelectorAll(".design-version-group").length<document.querySelectorAll(".design-version").length+'+repo.history(a,d.id).length),'saves are grouped');
assert.equal(await js('document.querySelector(".design-version-group").textContent.includes("Edited Home")'),true,'latest version names its newest save');
await js('document.querySelectorAll(".design-version-saves").forEach(b=>b.click())');
await until('document.querySelectorAll(".design-version-step").length>=3','saves inside the versions');
assert(await js('[...document.querySelectorAll(".design-version-step")].some(v=>v.textContent.includes("Tightened hero headline on Home"))'),'agent summary in its saves');
await click('.design-version-step[data-step-revision="2"]');await until('!!document.querySelector(".design-historical")','historical view');
await click('.design-version-step.is-active button');await delay(300);assert(repo.read(a,d.id).boards[0].html.includes('Some places'));
assert.equal(repo.history(a,d.id)[0].summary,'Restored v2');
await click('[aria-label="Close history"]');
const exportItem=(prefix)=>designMenu(prefix);
await exportItem('HTML bundle');for(let i=0;i<40&&!fs.existsSync(path.join(process.env.QA_DATA,'Fieldnotes.zip'));i++)await delay(75);assert(fs.existsSync(path.join(process.env.QA_DATA,'Fieldnotes.zip')));
// PDF: a page per board, each at the board's size.
await exportItem('PDF');const pdfFile=path.join(process.env.QA_DATA,'Fieldnotes.pdf');for(let i=0;i<120&&!fs.existsSync(pdfFile);i++)await delay(100);
const pdf=fs.readFileSync(pdfFile).toString('latin1');assert(pdf.startsWith('%PDF'));
const boardsNow=repo.read(a,d.id).boards;const boxes=[...pdf.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map(m=>[Math.round(+m[1]*96/72),Math.round(+m[2]*96/72)]);
assert.equal(boxes.length,boardsNow.length,'a page per board: '+JSON.stringify(boxes));
assert.deepEqual(boxes,boardsNow.map(b=>[b.width,b.height]),'pages at board size');
// A board's own download menu (the icon on its heading): sizes per format, and a one-page PDF of just that board.
const homeBoard=boardsNow.find(b=>b.name==='Home');
await until('!document.querySelector(".design-title-button").disabled','previous export done');
await click('[aria-label="Download Home"]');await until('!!document.querySelector(".design-board-download")','board download menu');
await delay(200);fs.writeFileSync(path.join(process.env.QA_CAPTURE,'design-board-download.png'),(await w.webContents.capturePage()).toPNG());
const downloadText=await js('document.querySelector(".design-board-download").textContent');
assert(downloadText.includes('PNG 1× '+homeBoard.width+' × '+homeBoard.height+' px')&&downloadText.includes('PNG 2× '+homeBoard.width*2+' × '+homeBoard.height*2+' px'),downloadText);
assert.equal(await js('[...document.querySelectorAll(".design-board-download button")].find(b=>b.textContent.startsWith("Selected boards")).disabled'),true,'selected boards needs two');
assert(!(await js('!!document.querySelector(".design-board-heading")?.textContent.match(/\\d+ × \\d+/)')),'no size label on the heading');
await js('[...document.querySelectorAll(".design-board-download button")].find(b=>b.textContent.startsWith("PDF")).click()');
const boardPdf=path.join(process.env.QA_DATA,'Fieldnotes - Home.pdf');for(let i=0;i<120&&!fs.existsSync(boardPdf);i++)await delay(100);
assert(fs.existsSync(boardPdf),'board PDF saved; files: '+fs.readdirSync(process.env.QA_DATA).join(', ')+' | panel: '+(await js('JSON.stringify({error:document.querySelector(".design-error")?.textContent,menu:!!document.querySelector(".design-board-download"),busy:document.querySelector(".design-title-button")?.disabled})')));
const onePage=[...fs.readFileSync(boardPdf).toString('latin1').matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map(m=>[Math.round(+m[1]*96/72),Math.round(+m[2]*96/72)]);
assert.deepEqual(onePage,[[homeBoard.width,homeBoard.height]],'one page, just this board');
// Board inspector: devices, export @2x and preview navigation.
await click('[data-board-id="'+first.id+'"] .design-board-label');await until('!!document.querySelector(".design-devices")','board inspector');
await js('[...document.querySelectorAll(".design-devices button")].find(b=>b.textContent.startsWith("Phone")).click()');await until('document.querySelector(".design-devices [aria-checked=true]")?.textContent.startsWith("Phone")','phone width');
assert.equal(repo.read(a,d.id).boards[0].width,390);
await buttonText('.design-inspector','Export Home');await delay(900);
const png=fs.readFileSync(path.join(process.env.QA_DATA,'Fieldnotes.png'));assert.equal(png.readUInt32BE(16),780,'PNG exported at 2x');
await buttonText('.design-float-bar','↗');await until('document.querySelector(".design-preview-nav")?.textContent.includes("1 / 2")','preview position');
await click('[aria-label="Next board"]');await until('document.querySelector(".design-preview-nav")?.textContent.includes("2 / 2")','preview next board');
await text('← Back to canvas');await until('!document.querySelector(".design-board-preview-overlay")','preview closed');
await designMenu('Hand off to project');await until('(qa.store.getState().pendingChatInjection?.text??"").includes("README.md")','implement hands the board over');
const handoffText=await js('qa.store.getState().pendingChatInjection.text');assert.match(handoffText,/Implement the "Home" board[\s\S]*\.aegis\/design\/[a-z0-9-]+\/ \(start with README\.md\): Home → home\.html/,handoffText);
const handoffDir=path.join(qaProject,handoffText.match(/(\.aegis\/design\/[a-z0-9-]+)\//)[1]);assert.deepEqual(fs.readdirSync(handoffDir).sort(),['README.md','home.html']);
// A comment whose layer is gone says so in its thread.
const lostHome=repo.read(a,d.id).boards.find(x=>x.name==='Home');
await js('window.electron.design.comment('+JSON.stringify({sessionId:a,documentId:d.id,boardId:lostHome.id,contentRevision:lostHome.contentRevision,text:'Was on a removed layer',anchor:{nodeId:'qa-gone-layer',rect:{x:40,y:40,width:120,height:40}},id:'qa-lost',toAgent:false})+')');
await until('!!document.querySelector(\'[data-comment-id="qa-lost"]\')','lost-layer pin shown');await click('[data-comment-id="qa-lost"]');
await until('document.querySelector(".design-thread [data-anchor-lost]")?.textContent.includes("gone from Home")','thread says the layer is gone');
await click('[aria-label="Resolve comment"]');await until('!document.querySelector(\'[data-comment-id="qa-lost"]\')','lost comment resolved');assert.match(fs.readFileSync(path.join(handoffDir,'README.md'),'utf8'),/- Home \(390 × \d+\): home\.html/);
const preview=await tools.find(t=>t.name==='design_preview').execute({documentId:d.id,boardId:first.id,revision:repo.read(a,d.id).revision},{});assert(preview.images?.[0]?.data.length>100);assert(!preview.isError,preview.content);fs.writeFileSync(path.join(process.env.QA_CAPTURE,'model-preview.png'),Buffer.from(preview.images[0].data,'base64'));
await require(path.join(process.env.QA_ROOT,'scripts/tests/design-canvas-interactions.cjs')).run({w,js,repo,sessionId:a,documentId:d.id,screenshotDir:process.env.QA_CAPTURE});
await require(path.join(process.env.QA_ROOT,'scripts/tests/design-direct-electron.cjs')).run({w,js,repo,sessionId:a,documentId:d.id,screenshotDir:process.env.QA_CAPTURE});
await require(path.join(process.env.QA_ROOT,'scripts/tests/design-comment-mode-electron.cjs')).run({w,js,repo,sessionId:a,documentId:d.id,screenshotDir:process.env.QA_CAPTURE,sent});
await require(path.join(process.env.QA_ROOT,'scripts/tests/design-spacing-electron.cjs')).run({w,js,repo,sessionId:a,documentId:d.id,screenshotDir:process.env.QA_CAPTURE});
await require(path.join(process.env.QA_ROOT,'scripts/tests/design-layers-electron.cjs')).run({w,js,repo,sessionId:a,documentId:d.id,screenshotDir:process.env.QA_CAPTURE});
await require(path.join(process.env.QA_ROOT,'scripts/tests/design-insert-electron.cjs')).run({w,js,repo,sessionId:a,documentId:d.id,screenshotDir:process.env.QA_CAPTURE});
// The agent sees which design is open and what the message was sent about (the composer chip); it continues there unless asked for a separate one.
const {designContextText}=require(path.join(process.env.QA_ROOT,'dist-electron/electron/design/focus.js'));
const {sanitizeDesignSelectionRef}=require(path.join(process.env.QA_ROOT,'dist-electron/shared/design-selection.js'));
await js('document.querySelector(".design-viewport").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
const homeNow=repo.read(a,d.id).boards[0];
await click('[data-board-id="'+homeNow.id+'"] .design-board-label');
await until('qa.design.getState().selections[qa.a]?.boardIds?.[0]==='+JSON.stringify(homeNow.id),'the chip holds the selected board');
const chip=await js('qa.design.getState().selections[qa.a]');
assert.deepEqual(chip,{documentId:d.id,boardIds:[homeNow.id],label:homeNow.name,contentRevision:homeNow.contentRevision},JSON.stringify(chip));
let ctx='';for(let i=0;i<40&&!ctx.includes('Open: "Fieldnotes"');i++){await delay(50);ctx=designContextText(a)}
assert(ctx.startsWith('\n\n<design_context>')&&ctx.includes('Open: "Fieldnotes" (documentId '+d.id),ctx);
assert(!ctx.includes('Selected'),'without the message snapshot the context names no selection: '+ctx);
ctx=designContextText(a,sanitizeDesignSelectionRef(chip));
assert(ctx.includes('Selected: board "'+homeNow.name+'" (boardId '+homeNow.id+', x='),ctx);
assert.equal(designContextText(b),'','no designs, no context');
const blocked=await tools.find(t=>t.name==='design_create').execute({title:'Another',operationId:'second-design'},{});
assert(blocked.isError&&blocked.content.includes('already has a design')&&blocked.content.includes(d.id),blocked.content);
assert.equal(repo.list(a).length,1,'nothing created without separate');
const separate=await call('design_create',{title:'Pricing page',operationId:'second-design',separate:true});
assert.equal(repo.list(a).length,2,'separate: true creates a second design');
let ctx2='';for(let i=0;i<40&&!ctx2.includes('Pricing page');i++){await delay(50);ctx2=designContextText(a)}
assert(ctx2.includes('Open: "Pricing page" (documentId '+separate.id)&&ctx2.includes('Other designs in this conversation: "Fieldnotes"'),ctx2);
const retried=await tools.find(t=>t.name==='design_create').execute({title:'Pricing page',operationId:'second-design'},{});assert(!retried.isError&&JSON.parse(retried.content).id===separate.id,'a retried create returns the same design: '+retried.content);
const boardsBefore=repo.read(a,d.id).boards.length;abort.abort();const stopped=await tools.find(t=>t.name==='design_update').execute({documentId:d.id,operationId:'cancelled',operations:[{type:'add',name:'Late'}]},{abortSignal:abort.signal});assert(stopped.isError);assert.equal(repo.read(a,d.id).boards.length,boardsBefore,'a stopped turn adds no board');
// Designs belong to the project: another chat there can read this one; a chat elsewhere cannot.
const sameProject=await createNativeDesignTools(b).find(t=>t.name==='design_read').execute({documentId:d.id},{});assert(!sameProject.isError,'a chat in the same project reads it: '+sameProject.content);
const cross=await createNativeDesignTools('outsider').find(t=>t.name==='design_read').execute({documentId:d.id},{});assert(cross.isError,'another project cannot');
console.log(JSON.stringify({ok:true,checks:['agent tools create/update','automatic panel','two HTML boards','iframe isolation','element selection','comment to the agent','pin initials','working thread','chat row + View thread','agent reply + compare','queued reply','resolve','plain note','session A/B/A','history summary + restore','devices','HTML and PNG@2x export','preview navigation','model preview image','stop and ownership'],screenshot:path.join(process.env.QA_CAPTURE,'design-canvas.png'),errors},null,2));
w.destroy();app.exit(0);
} catch(e){console.error(e);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,'failure.png'),(await w.webContents.capturePage()).toPNG());w.destroy();app.exit(1)}
});
`;
try {
  await writeFile(
    path.join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="./harness.tsx"></script>',
  );
  await writeFile(path.join(fixture, "harness.tsx"), harness);
  await writeFile(path.join(fixture, "preload.cjs"), preload);
  await writeFile(path.join(fixture, "main.cjs"), main);
  server = await createServer({
    root,
    configFile: path.join(root, "vite.config.ts"),
    cacheDir: path.join(fixture, "vite-cache"),
    plugins: [
      {
        name: "design-qa",
        enforce: "pre",
        transform(source, id) {
          if (id.endsWith("/src/ui/App.tsx"))
            return (
              source +
              "\nexport { RightUtilityWorkspace, RightPanelLauncherContent };"
            );
        },
      },
    ],
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const base = server.resolvedUrls.local[0];
  const url = new URL(
    path.relative(root, path.join(fixture, "index.html")),
    base,
  ).href;
  const env = {
    ...process.env,
    QA_DATA: data,
    QA_ROOT: root,
    QA_URL: url,
    QA_CAPTURE: capture,
    DEV_SERVER_URL: base,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      path.join(root, "node_modules/.bin/electron"),
      [path.join(fixture, "main.cjs")],
      { env, stdio: "inherit" },
    );
    child.on("error", reject);
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Error("Design QA timed out"));
    }, 90000);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  if (code !== 0) process.exitCode = 1;
} finally {
  await server?.close();
  await rm(fixture, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
}
