// The composer's context ring card: Claude Code's breakdown in color, free
// space and the compaction buffer as reserve rows, deferred tools behind a
// toggle, no cost. Captures light and dark for review.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
const root=process.cwd();
await mkdir(path.join(root,'.aegis-design-qa'),{recursive:true});
const tmp=await mkdtemp(path.join(root,'.aegis-design-qa/context-popover-'));
const harness=`
import React,{useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {AppearancePreferences} from '/src/ui/components/AppearancePreferences';
import {PromptInput} from '/src/ui/components/PromptInput';
import {useAppStore} from '/src/ui/store/useAppStore';
import {subscribeAppPreferences} from '/src/ui/store/useAppPreferences';
import '/src/ui/index.css';
window.electron={...window.preferenceBridge,
 getSystemFonts:async()=>[],getSystemFontFamilies:async()=>[],
 getAgentUsageReport:async()=>{throw Error('No test usage');},
 getCodexRateLimits:async()=>{throw Error('No test account');},getClaudePlanUsage:async()=>{throw Error('No test account');},
 getGrokPlanUsage:async()=>{throw Error('No test account');},getQoderPlanUsage:async()=>{throw Error('No test account');},
 getBubbleProvidersConfig:async()=>({providers:[],defaultProviderId:null}),
 getRecentCwds:async()=>['/tmp'],getSessionUserPrompts:async()=>[],sendClientEvent:()=>{},
 getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),
 getSessionGoal:async id=>({sessionId:id,supported:false,goal:null,revision:0}),onSessionGoalChanged:()=>()=>{},
 getProjectGitSummary:async()=>({isGitRepository:false}),getProjectTree:async()=>null,
};
for(const p of ['Claude','Codex','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Devin','Mimo','Minimax'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
window.electron.getDevinThoughtLevels=async()=>({model:null,levels:[],defaultLevel:null});
window.electron.getMinimaxThinkingEfforts=async()=>({model:null,levels:[],defaultLevel:null});
const store=useAppStore.getState();const id=store.createDraftSession('/tmp');
useAppStore.setState(s=>({sessions:{...s.sessions,[id]:{...s.sessions[id],isDraft:false,provider:'claude',status:'idle',model:'claude-opus-5-5',messages:[],
 claudeContextUsage:{model:'claude-opus-5-5',totalTokens:451400,maxTokens:1000000,percentage:45,
  categories:[
   {name:'System prompt',tokens:11000,kind:'used'},{name:'System tools',tokens:18100,kind:'used'},
   {name:'MCP server instructions',tokens:1900,kind:'used'},{name:'MCP tools',tokens:16100,kind:'used'},
   {name:'MCP tools (deferred)',tokens:85400,kind:'deferred'},{name:'System tools (deferred)',tokens:21400,kind:'deferred'},
   {name:'Custom agents',tokens:303,kind:'used'},{name:'Memory files',tokens:2100,kind:'used'},{name:'Skills',tokens:10000,kind:'used'},
   {name:'Messages',tokens:391900,kind:'used'},{name:'Autocompact buffer',tokens:33000,kind:'buffer'},{name:'Free space',tokens:515600,kind:'free'}],
  counts:{mcpTools:186,memoryFiles:1,agents:3,skills:132}}}},pendingStart:false}));
window.qa={id,store:useAppStore};
function Harness(){
 useEffect(subscribeAppPreferences,[]);
 return <AppearancePreferences><Tooltip.Provider><div style={{height:'100vh',display:'flex',flexDirection:'column',justifyContent:'flex-end',background:'var(--bg-primary)',color:'var(--text-primary)'}}><PromptInput sessionId={id}/></div></Tooltip.Provider></AppearancePreferences>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const preload=String.raw`
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('preferenceBridge',{
 getEnvironmentEditorLaunchers:async()=>[],
 getAppPreferences:()=>ipcRenderer.invoke('prefs:get'),setAppPreferences:p=>ipcRenderer.invoke('prefs:set',p),
 getTerminalShellOptions:async()=>[],
 getNotificationSettings:async()=>({}),setNotificationSettings:async p=>p,
 onAppPreferencesChanged:()=>()=>{},
});
`;
const main=String.raw`
const {app,BrowserWindow,ipcMain}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const prefs=require(path.join(process.cwd(),'dist-electron/electron/libs/app-preferences.js'));
ipcMain.handle('prefs:get',()=>prefs.getAppPreferences());ipcMain.handle('prefs:set',(_,p)=>prefs.setAppPreferences(p));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:900,height:720,show:true,webPreferences:{backgroundThrottling:false,preload:path.join(__dirname,'preload.cjs')}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error'){errors.push(e.message);console.error(e.message);}});
 const js=c=>win.webContents.executeJavaScript(c,true);
 const until=async(c,label)=>{for(let i=0;i<100;i++){if(await js(c))return;await delay(100);}throw Error('Timed out: '+label);};
 const shot=async name=>{await delay(200);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 const center=async s=>js('(()=>{const r=document.querySelector('+JSON.stringify(s)+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
 const hover=async s=>{const p=await center(s);win.webContents.sendInputEvent({type:'mouseMove',...p});await delay(150);};
 const click=async s=>{const p=await center(s);win.webContents.sendInputEvent({type:'mouseMove',...p});win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await delay(200);};
 const ring='[aria-label="Context window usage"]',toggle='[data-context-deferred-toggle]';
 try{
  await win.loadURL(process.env.QA_URL);await until('!!document.querySelector('+JSON.stringify(ring)+')','context ring');
  await hover(ring);await until('document.body.innerText.includes("451.4k of 1M tokens")','card opens on hover');
  const text=await js('document.body.innerText');
  for(const row of ['45%','Messages','391.9k','MCP tools','186 tools','1 file','3 agents','132 skills','Free space','515.6k','Autocompact buffer','Deferred tools','106.8k'])assert(text.includes(row),'card shows '+row);
  assert(!/\$\d/.test(text),'card shows no cost');
  assert(!text.includes('Cache read')&&!text.includes('This session'),'card shows no token ledger');
  const order=await js('Array.from(document.querySelectorAll(".grid span.truncate")).map(e=>e.textContent)');
  assert.deepEqual(order.slice(0,3),['Messages','System tools','MCP tools'],'used rows sort by size');
  assert.equal(await js('document.querySelector('+JSON.stringify(toggle)+').getAttribute("aria-expanded")'),'false','deferred tools start collapsed');
  assert(!(await js('document.body.innerText')).includes('85.4k'),'collapsed rows are hidden');
  await shot('light-collapsed');
  // Moving onto the card and clicking the toggle keeps the card open.
  await click(toggle);
  await until('document.querySelector('+JSON.stringify(toggle)+')?.getAttribute("aria-expanded")==="true"','deferred expands');
  const expanded=await js('document.body.innerText');
  assert(expanded.includes('85.4k')&&expanded.includes('21.4k'),'deferred rows show');
  assert(!expanded.includes('(deferred)'),'deferred suffix is dropped under the toggle');
  await shot('light-expanded');
  await js('qa.store.getState().setTheme("dark")');await until('document.documentElement.classList.contains("dark")','dark theme');await delay(150);
  assert.equal(await js('getComputedStyle(document.documentElement).getPropertyValue("--context-messages").trim()'),'#58a2f2','dark theme swaps the hues');
  await shot('dark-expanded');
  await click(toggle);await until('document.querySelector('+JSON.stringify(toggle)+')?.getAttribute("aria-expanded")==="false"','deferred collapses');
  await shot('dark-collapsed');
  win.webContents.sendInputEvent({type:'mouseMove',x:20,y:20});await until('!document.querySelector('+JSON.stringify(toggle)+')','card closes on leave');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,captures:process.env.QA_CAPTURE}));app.exit(0);
 }catch(error){console.error(error);await shot('failure');app.exit(1);}
});
`;
let server;
try{
 await writeFile(path.join(tmp,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
 await writeFile(path.join(tmp,'harness.tsx'),harness);await writeFile(path.join(tmp,'preload.cjs'),preload);await writeFile(path.join(tmp,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),cacheDir:path.join(tmp,'.vite'),server:{host:'127.0.0.1',port:0,strictPort:false,watch:{ignored:['**/.aegis-design-qa/**']}}});await server.listen();
 const url=new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href;
 await new Promise((resolve,reject)=>{
  const env={...process.env,QA_URL:url,QA_CAPTURE:path.join(root,'output/playwright/context-popover')};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});let out='';
  child.stdout.on('data',c=>{out+=c;process.stdout.write(c);});child.stderr.on('data',c=>process.stderr.write(c));
  const timeout=setTimeout(()=>{child.kill();reject(Error('Context popover Electron test timed out'));},90000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0&&out.includes('"ok":true')?resolve():reject(Error('Context popover Electron test failed'));});
 });
}finally{await server?.close();await rm(tmp,{recursive:true,force:true});}
