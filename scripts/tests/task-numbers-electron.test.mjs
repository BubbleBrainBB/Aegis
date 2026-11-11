import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// Task numbers in the real composers and title bar: the number beside the
// title, the `#` menu, and which keys pick from it. QA_CAPTURE=<dir> saves screenshots.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, 'dev-fixtures');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'task-numbers-'));
const harness = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {Toaster} from 'sonner';
import {PromptInput} from '/src/ui/components/PromptInput.tsx';
import {NewSessionView} from '/src/ui/components/NewSessionView.tsx';
import {SessionTitleActions} from '/src/ui/components/SessionTitleActions.tsx';
import {useAppStore} from '/src/ui/store/useAppStore.ts';
import '/src/ui/index.css';
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.qa.copied=text}}});
const a=useAppStore.getState();
const id=a.createDraftSession('/projects/coworker');
const base={...useAppStore.getState().sessions[id],isDraft:false,provider:'codex',model:'gpt-5.6-sol',status:'idle',messages:[]};
const now=Date.now();
const others=[
 {id:'11111111-1111-4111-8111-111111111111',number:12,title:'Sidebar search row',updatedAt:now-3600000},
 {id:'22222222-2222-4222-8222-222222222222',number:128,title:'Search palette ranking',updatedAt:now-60000},
 {id:'33333333-3333-4333-8333-333333333333',number:129,title:'Workflow member',updatedAt:now,hiddenFromThreads:true},
 {id:'44444444-4444-4444-8444-444444444444',number:130,title:'On the studio Mac',updatedAt:now,device:{id:'mac',name:'Studio',online:true}},
];
useAppStore.setState(s=>({connected:true,projectCwd:'/projects/coworker',sessions:{[id]:{...base,number:5,title:'Update button'},...Object.fromEntries(others.map(o=>[o.id,{...base,...o}]))}}));
a.setActiveSession(id);
window.electron.onServerEvent(e=>a.handleServerEvent(e));
window.qa={store:useAppStore,id,editor:()=>document.querySelector('[role=textbox]'),
 rows:()=>[...document.querySelectorAll('[data-task-mention-menu] [data-task-number]')].map(e=>Number(e.dataset.taskNumber)),
 selected:()=>Number(document.querySelector('[data-task-mention-menu] [aria-selected=true]')?.dataset.taskNumber),
 chips:()=>[...document.querySelectorAll('[data-session-reference]')].map(e=>[e.dataset.sessionReference,e.textContent])};
function Harness(){
 const [fresh,setFresh]=useState(false); window.qa.fresh=setFresh;
 const s=useAppStore();const session=s.sessions[id];
 return <Tooltip.Provider><div style={{height:'100vh',display:'flex',flexDirection:'column',background:'var(--bg-primary)',color:'var(--text-primary)',padding:24}}>
 <header style={{display:'flex',alignItems:'center',fontSize:13}}><SessionTitleActions session={session} showMenu={false} className="text-[13px] font-medium text-[var(--text-primary)]"/></header>
 {fresh?<NewSessionView/>:<><div style={{flex:1}}/><PromptInput sessionId={id}/></>}
 <Toaster/></div></Tooltip.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = `
const {app,BrowserWindow,ipcMain}=require('electron');
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
const root=process.env.QA_ROOT;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1040,height:760,show:true,webPreferences:{backgroundThrottling:false,preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error'){errors.push(e.message);console.error(e.message);}});
 for(const [channel,value] of [['get-ui-resume-state-sync',null],['renderer-state:get-all-sync',{}],['save-ui-resume-state-sync',true]])ipcMain.on(channel,e=>{e.returnValue=value;});
 ipcMain.on('renderer-state:set',()=>{});
 ipcMain.handle('get-devin-thought-levels',()=>({model:null,levels:[],defaultLevel:null}));
 ipcMain.handle('get-minimax-thinking-efforts',()=>({model:null,levels:[],defaultLevel:null}));
 for(const provider of ['claude','codex','kimi','grok','opencode','pi','bubble','qoder','deepseek','devin','mimo','minimax'])ipcMain.handle('get-'+provider+'-model-config',()=>({defaultModel:'gpt-5.6-sol',options:['gpt-5.6-sol'],availableModels:[{name:'gpt-5.6-sol',enabled:true,isDefault:true}]}));
 for(const [channel,value] of [['get-git-branches',{branches:[],currentBranch:null}],['get-agent-runtime-directory',null],['codex-list-plugins',{plugins:[]}],['get-project-tree',[]],['set-theme',null],['get-recent-cwds',[]],['get-session-user-prompts',[]],['codex-list-skills',{skills:[]}],['get-bubble-providers-config',{providers:[]}],['get-provider-composer-capabilities',{}]])ipcMain.handle(channel,()=>value);
 let sent=[];let started=0;ipcMain.on('client-event',(_e,json)=>{const event=JSON.parse(json);if(event.type==='session.start')started++;if(event.type==='session.continue'){sent.push(event.payload.prompt);win.webContents.send('server-event',JSON.stringify({type:'stream.user_prompt',payload:{sessionId:event.payload.sessionId,prompt:event.payload.prompt,createdAt:Date.now()}}));}});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const until=async(code,label)=>{for(let i=0;i<160;i++){if(await js(code))return;await delay(60);}throw new Error('Timed out: '+label+' (rows '+JSON.stringify(await js('qa.rows()'))+', text '+JSON.stringify(await js('qa.editor()?.textContent'))+')');};
 const snap=async name=>{if(process.env.QA_CAPTURE){fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG());}};
 // Focus the editor only when it lost focus: focusing it again moves the caret, and
 // webContents.focus() clears the page's focused element on a runner whose window is in the background.
 const focus=()=>js('(()=>{const e=qa.editor();if(document.activeElement!==e)e.focus();})()');
 const type=async text=>{await focus();const before=await js('qa.editor().textContent');await win.webContents.insertText(text);await until('qa.editor().textContent!=='+JSON.stringify(before),'typed '+text);};
 const clear=async()=>{await focus();await js('document.execCommand("selectAll");document.execCommand("delete")');await until('qa.editor().textContent===""','cleared');};
 const key=async(keyCode,modifiers=[])=>{await focus();win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});if(keyCode==='Enter')win.webContents.sendInputEvent({type:'char',keyCode:String.fromCharCode(13),modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(120);};
 // Press a key and wait for what it should cause. A slow runner drops keys: send it again only when nothing came of it for a while.
 const press=async(keyCode,expr,label)=>{for(let attempt=0;attempt<3;attempt++){await key(keyCode);for(let i=0;i<30;i++){if(await js(expr))return;await delay(50);}}throw new Error('Timed out: '+label+' after '+keyCode+' (rows '+JSON.stringify(await js('qa.rows()'))+', text '+JSON.stringify(await js('qa.editor()?.textContent'))+')');};
 const rows=()=>js('qa.rows()');
 try {
  await win.loadURL(process.env.QA_URL);await until('!!window.qa && !!qa.editor()','composer ready');win.focus();
  // A window in the background drops key events unless the page is told it has focus.
  try{win.webContents.debugger.attach('1.3')}catch{}
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});

  // The number sits beside the title; a click copies it as typed.
  assert.equal(await js('document.querySelector("[data-session-task-number]").textContent'),'#5');
  await js('document.querySelector("[data-session-task-number]").click()');
  await until('qa.copied==="#5"','number copied');
  await snap('1-title-number');

  // "#" offers the tasks a number names: not this one, hidden members or another Mac's.
  await type('PR #12');
  await until('qa.rows().length===2','menu for #12');
  assert.deepEqual(await rows(),[12,128],'the number itself, then numbers that start with it');
  assert.equal(await js('qa.selected()'),12);
  await snap('2-menu');
  // Enter still sends: the same text names pull requests.
  await press('Enter','qa.editor().textContent===""','sent');
  assert.deepEqual(sent,['PR #12']);
  assert.deepEqual(await rows(),[]);

  // Arrows take up the menu; Enter then picks, and nothing is sent.
  await type('see #1');
  await until('qa.rows().length===2','menu for #1');
  assert.deepEqual(await rows(),[128,12],'both start with 1: the newer first');
  await press('Down','qa.selected()===12','highlight moved');
  await press('Enter','qa.chips().length===1','picked with Enter');
  assert.deepEqual(await js('qa.chips()'),[[A,'↗Sidebar search row']]);
  assert.deepEqual(await rows(),[]);
  assert.equal(sent.length,1);
  await snap('3-chip');
  // The picked task goes out as its conversation link.
  await type('first');
  await press('Enter','qa.editor().textContent===""','sent with a reference');
  assert.equal(sent[1],'see aegis://sessions/'+A+' first');

  // Tab picks at once; titles match, and text written without spaces can lead.
  await type('接着#palette');
  await until('qa.rows().length===1','title match');
  await press('Tab','qa.chips().length===1','picked with Tab');
  assert.equal((await js('qa.chips()'))[0][0],B);
  await clear();

  // Shift+arrows select text and do not take up the menu: Enter still sends.
  await type('see #1');
  await until('qa.rows().length===2','menu before a modified arrow');
  await key('Down',['shift']);
  assert.equal(await js('qa.selected()'),128,'the highlight did not move');
  await press('Enter','qa.editor().textContent===""','sent after a modified arrow');
  assert.equal(sent[2],'see #1');

  // A pick replaces the number only: the bracket after it stays.
  await type('see (#12)');
  await press('Left','qa.rows().length===2','menu inside brackets');
  await press('Tab','qa.chips().length===1','picked inside brackets');
  await press('Enter','qa.editor().textContent===""','sent with brackets');
  assert.equal(sent[3],'see (aegis://sessions/'+A+')');

  // "@#12" belongs to the file menu: the task menu neither shows nor takes Tab.
  await type('@#12');
  await until('document.body.textContent.includes("Project Files")','file menu');
  assert.deepEqual(await rows(),[]);
  await key('Tab');
  assert.deepEqual(await js('qa.chips()'),[]);
  await clear();

  // So does a skill token: "$#12" is the skill menu's.
  await type('$#12');await delay(200);
  assert.deepEqual(await rows(),[]);
  await key('Enter');
  assert.deepEqual(await js('qa.chips()'),[]);
  await clear();

  // Nothing to offer: no menu.
  for(const text of ['#999','#5','#studio','#workflow','C#1','issue #']){
   await type(text);await delay(150);
   assert.deepEqual(await rows(),text==='issue #'?[128,12]:[],text);
   await clear();
  }

  // A runtime that cannot read other conversations gets no menu.
  await js('qa.store.setState(s=>({sessions:{...s.sessions,[qa.id]:{...s.sessions[qa.id],provider:"kimi"}}}))');
  await delay(300);await type('#12');await delay(200);
  assert.deepEqual(await rows(),[]);
  await clear();

  // A task on another Mac could not resolve a task from this one: no menu.
  await js('qa.store.setState(s=>({sessions:{...s.sessions,[qa.id]:{...s.sessions[qa.id],provider:"codex",cwd:"/aegis-remote/abcdef012345/p1/coworker"}}}))');
  await delay(300);await type('#12');await delay(200);
  assert.deepEqual(await rows(),[]);
  await clear();
  // And a reference already in the prompt is held back, not sent there.
  const before=sent.length;
  await type('see aegis://sessions/'+A+' ');
  await until('qa.chips().length===1','pasted reference');
  await press('Enter','document.body.textContent.includes("read tasks on this Mac")','remote reference refused');
  assert.equal(sent.length,before);
  assert.equal((await js('qa.chips()')).length,1,'the draft is kept');
  await clear();

  // Nor does a new task in a project on another Mac.
  await js('qa.store.setState({projectCwd:"/aegis-remote/abcdef012345/p1/coworker"})');
  await js('qa.fresh(true)');await until('!!qa.editor()','new task composer');
  await type('#128');await delay(200);
  assert.deepEqual(await rows(),[]);
  await clear();
  await js('qa.store.setState({projectCwd:"/projects/coworker"})');await delay(300);

  // The first-message composer has the same menu.
  await type('#128');
  await until('qa.rows().length===1','menu in the new task composer');
  await snap('4-new-task');
  await press('Tab','qa.chips().length===1','picked in the new task composer');
  assert.deepEqual(await js('qa.chips()'),[[B,'↗Search palette ranking']]);

  // Switching the project to one on another Mac afterwards holds the start back.
  await js('qa.store.setState({projectCwd:"/aegis-remote/abcdef012345/p1/coworker"})');await delay(300);
  await until('!document.body.textContent.includes("read tasks on this Mac")','earlier notice gone');
  await press('Enter','document.body.textContent.includes("read tasks on this Mac")','remote start refused');
  assert.equal(started,0);
  assert.equal((await js('qa.chips()')).length,1,'the draft is kept');

  assert.deepEqual(errors.filter(e=>!/No handler registered/.test(e)),[]);
  console.log(JSON.stringify({ok:true,sent}));
  app.exit(0);
 }catch(e){console.error(e);await snap('failure');app.exit(1);}
});
`;
let server;
try {
  await writeFile(path.join(tmp, 'index.html'), '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  const url = new URL(path.relative(root, tmp) + '/index.html', server.resolvedUrls.local[0]).href;
  await new Promise((resolve, reject) => {
    const env = { ...process.env, QA_ROOT: root, QA_URL: url, DEV_SERVER_URL: server.resolvedUrls.local[0] };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(tmp, 'main.cjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; process.stdout.write(c); });
    child.stderr.on('data', (c) => { err += c; process.stderr.write(c); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Timed out\n' + out + '\n' + err)); }, 90000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timer); code === 0 && out.includes('"ok":true') ? resolve() : reject(new Error(out + '\n' + err)); });
  });
  console.log('Task numbers Electron regression passed');
} finally { await server?.close(); await rm(tmp, { recursive: true, force: true }); }
