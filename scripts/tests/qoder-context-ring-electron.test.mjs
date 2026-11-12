import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// The Qoder context ring in the real composer. qodercli 1.1.8x names a
// session's model as the picker shows it, so a task or a result saved from it
// can carry the name where Aegis expects the id; the ring has to show for both.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, 'dev-fixtures');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'qoder-context-ring-'));
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {Toaster} from 'sonner';
import {PromptInput} from '/src/ui/components/PromptInput.tsx';
import {useAppStore} from '/src/ui/store/useAppStore.ts';
import '/src/ui/index.css';
const a=useAppStore.getState();
const id=a.createDraftSession('/projects/coworker');
const base={...useAppStore.getState().sessions[id],isDraft:false,provider:'qoder',status:'idle',messages:[]};
const result=(model,used,total)=>({type:'result',subtype:'success',duration_ms:1,total_cost_usd:0,model,usage:{input_tokens:0,output_tokens:0,total_tokens:used,context_window:total},createdAt:Date.now()});
window.qa={id,store:useAppStore,
 set:(model,messages)=>useAppStore.setState(s=>({sessions:{...s.sessions,[id]:{...base,model,messages:messages.map(m=>result(...m))}}})),
 ring:()=>document.querySelector('[aria-label="Context window usage"]'),
 card:()=>document.querySelector('[aria-label="Context window usage"]')?.parentElement?.innerText.replace(/\\s+/g,' ').trim()||'',
 picker:()=>[...document.querySelectorAll('button')].map(b=>b.innerText.trim()).find(t=>/Qwen|Auto|Fast|ring_b|Ring B/.test(t))||''};
useAppStore.setState(s=>({connected:true,projectCwd:'/projects/coworker',sessions:{...s.sessions,[id]:base}}));
a.setActiveSession(id);
window.electron.onServerEvent(e=>a.handleServerEvent(e));
createRoot(document.getElementById('root')).render(<Tooltip.Provider><div style={{height:'100vh',display:'flex',flexDirection:'column',background:'var(--bg-primary)',color:'var(--text-primary)',padding:24}}><div style={{flex:1}}/><PromptInput sessionId={id}/><Toaster/></div></Tooltip.Provider>);
`;
const main = `
const {app,BrowserWindow,ipcMain}=require('electron');
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
const root=process.env.QA_ROOT;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1040,height:760,show:true,webPreferences:{backgroundThrottling:false,preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error'){errors.push(e.message);console.error(e.message);}});
 for(const [channel,value] of [['get-ui-resume-state-sync',null],['renderer-state:get-all-sync',{}],['save-ui-resume-state-sync',true]])ipcMain.on(channel,e=>{e.returnValue=value;});
 ipcMain.on('renderer-state:set',()=>{});
 ipcMain.handle('get-devin-thought-levels',()=>({model:null,levels:[],defaultLevel:null}));
 ipcMain.handle('get-minimax-thinking-efforts',()=>({model:null,levels:[],defaultLevel:null}));
 for(const provider of ['claude','codex','kimi','grok','opencode','pi','bubble','deepseek','devin','mimo','minimax'])ipcMain.handle('get-'+provider+'-model-config',()=>({defaultModel:'gpt-5.6-sol',options:['gpt-5.6-sol'],availableModels:[{name:'gpt-5.6-sol',enabled:true,isDefault:true}]}));
 // The Qoder catalog: ids as values, the picker's names as display names.
 ipcMain.handle('get-qoder-model-config',()=>({defaultModel:'auto',options:['auto','fast','qmodel_latest','ring_a','ring_b'],models:[
  {value:'auto',displayName:'Auto',isDefault:true,isEnabled:true,contextWindow:200000},
  {value:'fast',displayName:'Fast',isEnabled:true,contextWindow:200000},
  {value:'qmodel_latest',displayName:'Qwen4-Max-Preview',isEnabled:true,contextWindow:200000},
  // One model's display name is the other's id.
  {value:'ring_a',displayName:'ring_b',isEnabled:true,contextWindow:200000},
  {value:'ring_b',displayName:'Ring B',isEnabled:true,contextWindow:200000}]}));
 for(const [channel,value] of [['get-git-branches',{branches:[],currentBranch:null}],['get-agent-runtime-directory',null],['codex-list-plugins',{plugins:[]}],['get-project-tree',[]],['set-theme',null],['get-recent-cwds',[]],['get-session-user-prompts',[]],['codex-list-skills',{skills:[]}],['get-bubble-providers-config',{providers:[]}],['get-provider-composer-capabilities',{}]])ipcMain.handle(channel,()=>value);
 const js=code=>win.webContents.executeJavaScript(code,true);
 const until=async(code,label)=>{for(let i=0;i<120;i++){if(await js(code))return;await delay(60);}throw new Error('Timed out: '+label+' (card '+JSON.stringify(await js('qa.card()'))+', picker '+JSON.stringify(await js('qa.picker()'))+')');};
 const snap=async name=>{if(process.env.QA_CAPTURE){fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG());}};
 // Open the ring's card the way the pointer does, without real pointer input.
 const hover=()=>js('(()=>{const e=qa.ring();e.dispatchEvent(new MouseEvent("mouseover",{bubbles:true}));})()');
 const shows=async(model,messages,expected,label,picker='Qwen4-Max-Preview')=>{
  await js('qa.set('+JSON.stringify(model)+','+JSON.stringify(messages)+')');
  await until('!!qa.ring()&&qa.picker()==='+JSON.stringify(picker),'picker on '+picker+': '+label);
  await hover();
  await until('qa.card().includes('+JSON.stringify(expected)+')',label);
 };
 try {
  await win.loadURL(process.env.QA_URL);await until('!!window.qa','harness');
  // The task and its result by id: the plain case.
  await shows('qmodel_latest',[['qmodel_latest',35239,200000]],'35.2k of 200k tokens','id and id');
  assert.ok((await js('qa.card()')).includes('18%'));
  await delay(300);await snap('1-ring');
  // A result saved under the picker's name (qodercli 1.1.8x before results went by id).
  await shows('qmodel_latest',[['Qwen4-Max-Preview',35239,200000]],'35.2k of 200k tokens','result saved by name');
  // A task saved under the name: the picker stays on its model, and the ring finds a result by id.
  await shows('Qwen4-Max-Preview',[['qmodel_latest',40000,200000]],'40k of 200k tokens','task saved by name');
  // Both by name.
  await shows('Qwen4-Max-Preview',[['Qwen4-Max-Preview',50000,200000]],'50k of 200k tokens','task and result by name');
  // Mixed history: the newest result counts, whichever name it was saved under.
  await shows('qmodel_latest',[['qmodel_latest',10000,200000],['Qwen4-Max-Preview',180000,200000]],'180k of 200k tokens','a newer result by name after an older one by id');
  // A turn with no window does not hide the one before it.
  await shows('qmodel_latest',[['qmodel_latest',20000,200000],['qmodel_latest',null,null]],'20k of 200k tokens','a result without a window is passed over');
  // Nothing from this model yet, or only another model's usage: still waiting.
  await shows('qmodel_latest',[['Fast',5000,200000]],'Waiting for Qoder usage from this model.','another model');
  await shows('qmodel_latest',[['qmodel_latest',null,null]],'Waiting for Qoder usage from this model.','no window at all');
  // A display name that is another model's id is no alias: that model's usage is not this one's.
  await shows('ring_a',[['ring_b',180000,200000]],'Waiting for Qoder usage from this model.','usage of the model whose id is the name of this one','ring_b');
  await shows('ring_a',[['ring_a',30000,200000],['ring_b',180000,200000]],'30k of 200k tokens','only its own results count','ring_b');
  await shows('ring_b',[['ring_b',180000,200000]],'180k of 200k tokens','the other model keeps its own','Ring B');
  assert.deepEqual(errors.filter(e=>!/No handler registered/.test(e)),[]);
  console.log(JSON.stringify({ok:true}));
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
  console.log('Qoder context ring Electron regression passed');
} finally { await server?.close(); await rm(tmp, { recursive: true, force: true }); }
