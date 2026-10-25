import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
const root=process.cwd();
await mkdir(path.join(root,'.aegis-design-qa'),{recursive:true});
const dir=await mkdtemp(path.join(root,'.aegis-design-qa/composer-markdown-'));
const harness=`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {PromptInput} from '/src/ui/components/PromptInput';
import {NewSessionView} from '/src/ui/components/NewSessionView';
import {useAppStore} from '/src/ui/store/useAppStore';
import {useAppPreferences} from '/src/ui/store/useAppPreferences';
import '/src/ui/index.css';
localStorage.setItem('cowork.preferredProvider','deepseek');
window.electron={getProjectTree:async()=>null,cancelProjectTreeRead:async()=>{},getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionUserPrompts:async()=>[],getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},getBubbleProvidersConfig:async()=>({providers:[]}),getProjectFolders:async()=>[],getModels:async()=>[],listCodexSkills:async()=>({skills:[]}),sendClientEvent:event=>qa.events.push(event)};
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Devin','Mimo','Minimax','Codex'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
window.electron.getDevinThoughtLevels=async()=>({model:null,levels:[],defaultLevel:null});
window.electron.getMinimaxThinkingEfforts=async()=>({model:null,levels:[],defaultLevel:null});
window.electron.getDeepseekModelConfig=async()=>({defaultModel:'deepseek-flash',options:['deepseek-flash'],availableModels:[{id:'deepseek-flash',name:'DeepSeek V4.1 Flash',reasoningEfforts:['none','high','max']}]});
const store=useAppStore,id=store.getState().createDraftSession('/tmp/composer-qa');
store.setState(s=>({connected:true,projectCwd:'/tmp/composer-qa',activeSessionId:id,sessions:{...s.sessions,[id]:{...s.sessions[id],isDraft:false,provider:'deepseek',model:'deepseek-flash',status:'completed',messages:[],hydrated:true}}}));
window.qa={store,id,events:[],prefs:useAppPreferences};
function Harness(){const [mode,setMode]=useState('new');qa.mode=setMode;
return <Tooltip.Provider><div style={{height:'100vh',display:'flex',flexDirection:'column',overflow:'hidden',background:'var(--bg-primary)',color:'var(--text-primary)'}}><header style={{height:56,flexShrink:0}}>Composer markdown QA</header>
{mode==='new'?<NewSessionView/>:<><main style={{flex:1,minHeight:0,overflow:'auto'}}>Conversation content</main><div className="aegis-chat-composer px-8 pb-4"><PromptInput sessionId={id}/></div></>}
</div></Tooltip.Provider>}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main=String.raw`
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:800,show:true,webPreferences:{backgroundThrottling:false}}),js=s=>win.webContents.executeJavaScript(s,true);
 const until=async(s,label)=>{for(let i=0;i<100;i++){if(await js(s))return;await delay(50)}throw Error('Timed out: '+label)};
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const shot=async name=>{win.webContents.invalidate();await delay(150);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 const typeText=async s=>{for(const ch of s){win.webContents.insertText(ch);await delay(20)}await delay(60)};
 const key=async(keyCode,modifiers=[])=>{win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(80)};
 // Editor children as [style, text]; "hidden" = collapsed syntax marker. Scaffolding (trailing break, empty caret anchor) is skipped.
 const editorDom='(()=>{const e=document.querySelector("[role=textbox]"),hidden=n=>n.hasAttribute("data-md-hide")&&!n.hasAttribute("data-md-active");const r=getSelection().rangeCount?getSelection().getRangeAt(0):null,rect=r&&(r.getClientRects()[0]||r.getBoundingClientRect());return {nodes:Array.from(e.childNodes).filter(n=>!(n.hasAttribute&&(n.hasAttribute("data-composer-trailing-break")||(n.hasAttribute("data-composer-caret-anchor")&&n.textContent==="\\u200B")))).map(n=>[n.nodeType===3?"":(n.className.replace(/composer-md(--)?/g,"").trim().replace(/\\s+/g," ")+(hidden(n)?" hidden":"")),n.textContent]),hiddenWidths:Array.from(e.querySelectorAll("[data-md-hide]:not([data-md-active])")).map(n=>n.getBoundingClientRect().width),activeMarkers:Array.from(e.querySelectorAll("[data-md-active]")).map(n=>[n.textContent,n.getBoundingClientRect().width>0]),caretHeight:rect?rect.height:0,weight:getComputedStyle(e.querySelector(".composer-md--strong")||e).fontWeight,raw:e.textContent.replaceAll("\\u200B","")}})()';
 const caretAt='(text,offset)=>{const e=document.querySelector("[role=textbox]");const w=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode())&&!n.textContent.includes(text));getSelection().collapse(n,offset);e.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}))}';
 const ime=win.webContents.debugger;
 try{
 ime.attach('1.3');
 await win.loadURL(process.env.QA_URL);await until('!!document.querySelector("[role=textbox]")','composer');
 const text='# Release notes\n\n**Bold** and \x60inline code\x60\n\n- first item\n- second item\n\n| a | b |\n| - | - |\n| 1 | 2 |';
 for(const mode of ['new','chat']){
  console.log('Testing composer:',mode);
  await js('qa.store.setState({pendingStart:false})');
  await js('qa.mode('+JSON.stringify(mode)+')');await delay(100);
  assert.equal(await js('!!document.querySelector("button[aria-label=\\"Preview Markdown\\"]")'),false,'no preview toggle '+mode);
  // Live styling: closing *好* renders italic at once and hides the asterisks.
  await js('document.querySelector("[role=textbox]").focus()');
  await typeText('*好*');
  let state=await js(editorDom);
  assert.deepEqual(state.nodes,[['marker hidden','*'],['em','好'],['marker hidden','*']],mode+' italic hides markers once closed');
  assert.deepEqual(state.hiddenWidths,[0,0],mode+' hidden markers take no space');
  assert(state.caretHeight>0,mode+' caret stays visible after a hidden closing marker');
  // IME composition right after the hidden marker stays visible and commits after it.
  await ime.sendCommand('Input.imeSetComposition',{text:'ni',selectionStart:2,selectionEnd:2});await delay(120);
  const composing=await js('(()=>{const w=document.createTreeWalker(document.querySelector("[role=textbox]"),NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode())&&!n.textContent.includes("ni"));return n?getComputedStyle(n.parentElement).fontSize:null})()');
  assert(composing&&composing!=='0px',mode+' IME composition text is visible ('+composing+')');
  await ime.sendCommand('Input.insertText',{text:'你'});await delay(150);
  state=await js(editorDom);
  assert.equal(state.raw,'*好*你',mode+' IME commit lands after the italic');
  assert.deepEqual(state.nodes.at(-1),['','你'],mode+' committed text is unstyled');
  await key('Backspace');
  assert.equal((await js(editorDom)).raw,'*好*',mode+' backspace removes the committed text');
  await typeText(' **加粗** 普通');
  state=await js(editorDom);
  assert.deepEqual(state.nodes.slice(3),[['',' '],['marker hidden','**'],['strong','加粗'],['marker hidden','**'],['',' 普通']],mode+' bold hides markers');
  assert.equal(state.weight,'600',mode+' bold renders semibold');
  assert.equal(state.raw,'*好* **加粗** 普通',mode+' raw text intact');
  await shot(mode+'-live-hidden');
  // Moving the caret into a token reveals its markers; leaving hides them again.
  for(let i=0;i<8&&!(await js(editorDom)).activeMarkers.length;i++)await key('Left');
  assert.deepEqual((await js(editorDom)).activeMarkers,[['**',true],['**',true]],mode+' caret inside bold reveals its markers');
  await shot(mode+'-live-revealed');
  for(let i=0;i<8&&(await js(editorDom)).activeMarkers.length;i++)await key('Right');
  assert.deepEqual((await js(editorDom)).activeMarkers,[],mode+' leaving bold hides markers');
  await js('('+caretAt+')("普通",3)');
  await key('Return',['shift']);await typeText('# 标题');
  state=await js(editorDom);
  assert.deepEqual(state.nodes.slice(-3),[['',' 普通\n'],['marker h1','# '],['h1','标题']],mode+' heading marker shows on its line');
  await js('('+caretAt+')("普通",1)');
  await until('(()=>{const m=document.querySelector("[role=textbox] .composer-md--h1.composer-md--marker");return m&&!m.hasAttribute("data-md-active")})()',mode+' heading marker hides off its line');
  await js('document.querySelector("[role=textbox]").blur()');
  assert.equal(await js('document.querySelectorAll("[role=textbox] [data-md-active]").length'),0,mode+' blur hides all markers');
  // Editing inside a styled run keeps it styled; breaking the syntax unstyles it.
  await js('document.querySelector("[role=textbox]").focus()');
  await js('('+caretAt+')("加粗",1)');
  await typeText('很');
  assert.deepEqual((await js(editorDom)).nodes[5],['strong','加很粗'],mode+' typing inside bold');
  await js('(()=>{const m=document.querySelector("[role=textbox] .composer-md--strong").nextSibling;getSelection().collapse(m.firstChild,1);m.parentElement.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}))})()');
  await key('Backspace');
  await until('!document.querySelector("[role=textbox] .composer-md--strong")',mode+' unclosed bold unstyles');
  assert.equal((await js(editorDom)).raw,'*好* **加很粗* 普通\n# 标题',mode+' raw text intact after edits');
  if(mode==='chat'){
   await js('qa.prefs.setState({plainTextComposer:true})');
   await until('!document.querySelector("[role=textbox] [data-composer-md]")','plain text input disables markdown styling');
   await js('qa.prefs.setState({plainTextComposer:false})');
   await until('!!document.querySelector("[role=textbox] [data-composer-md]")','markdown styling restored');
  }
  win.webContents.selectAll();await key('Backspace');
  await until('document.querySelector("[role=textbox]").textContent===""',mode+' cleared');
  await js('(()=>{const e=document.querySelector("[role=textbox]");e.focus();const data=new DataTransfer();data.setData("text/plain",'+JSON.stringify(text)+');e.dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}))})()');
  // Sending keeps the raw markdown.
  const before=await js('qa.events.length');
  await until('!!document.querySelector("button[aria-label=\\"Send\\"]") && !document.querySelector("button[aria-label=\\"Send\\"]").disabled','send enabled '+mode);
  await js('document.querySelector("button[aria-label=\\"Send\\"]").click()');
  await until('qa.events.length>'+before,'send '+mode);
  assert.equal((await js('qa.events.at(-1)')).payload.prompt,text,mode+' sends raw markdown');
 }
 assert.deepEqual(errors,[]);console.log('PASS: composer styles Markdown live while typing, and raw markdown is sent');app.exit(0);
 }catch(e){console.error(e,errors);await shot('failure');app.exit(1)}
});
`;
let server;
try{
 await writeFile(path.join(dir,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
 await writeFile(path.join(dir,'harness.tsx'),harness);await writeFile(path.join(dir,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),cacheDir:path.join(dir,'vite-cache'),server:{host:'127.0.0.1',port:0,watch:{ignored:['**/.aegis-design-qa/**']}}});await server.listen();
 const env={...process.env,BUBBLE_HOME:path.join(dir,'bubble-home'),QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/playwright/composer-markdown')};delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});const timer=setTimeout(()=>{child.kill();reject(Error('Composer markdown QA timed out'))},60000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Composer markdown QA failed: '+code))})});
}finally{await server?.close();await rm(dir,{recursive:true,force:true})}
