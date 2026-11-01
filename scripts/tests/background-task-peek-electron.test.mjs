// The background task peek: a command chip opens its output tail and the
// links in it (a CI run folds its job URLs); the link opens externally,
// Escape closes it, and a subagent chip still opens its trace panel.
// Captures light and dark for review.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
const root=process.cwd();
await mkdir(path.join(root,'.aegis-design-qa'),{recursive:true});
const tmp=await mkdtemp(path.join(root,'.aegis-design-qa/background-task-peek-'));
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
 openExternalUrl:async url=>{window.qaOpened.push(url);return {ok:true};},
 readBackgroundTaskOutput:async(sessionId,taskId)=>{window.qaReads.push(taskId);return taskId==='b1'?{text:window.qaOutput,truncated:false,repo:'BubbleBrainBB/Aegis'}:null;},
};
window.qaOpened=[];window.qaReads=[];
const run='https://github.com/BubbleBrainBB/Aegis/actions/runs/18842391207';
window.qaOutput=['Refreshing checks status every 10 seconds. Press Ctrl+C to quit.','',
 'CI/Lint & Typecheck\\tpass\\t1m12s\\t'+run+'/job/53719921034','CI/Unit tests\\tpass\\t2m40s\\t'+run+'/job/53719921102',
 'CI/Test & Build (macOS)\\tpending\\t0\\t'+run+'/job/53719921187',''].join('\\n');
for(const p of ['Claude','Codex','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Devin','Mimo','Minimax'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
window.electron.getDevinThoughtLevels=async()=>({model:null,levels:[],defaultLevel:null});
window.electron.getMinimaxThinkingEfforts=async()=>({model:null,levels:[],defaultLevel:null});
const store=useAppStore.getState();const id=store.createDraftSession('/tmp');
const call={type:'assistant',uuid:'a1',createdAt:Date.now()-252000,message:{role:'assistant',content:[{type:'tool_use',id:'toolu_b1',name:'Bash',input:{command:'gh pr checks 103 --watch',run_in_background:true,description:'Wait for CI rerun to finish'}}]}};
useAppStore.setState(s=>({sessions:{...s.sessions,[id]:{...s.sessions[id],isDraft:false,provider:'claude',status:'idle',model:'claude-opus-5-5',messages:[call],
 backgroundTasks:[{taskId:'b1',toolUseId:'toolu_b1',description:'Wait for CI rerun to finish',taskType:'local_bash'},
  {taskId:'a2',toolUseId:'toolu_a2',description:'Find where usage chips render',taskType:'local_agent',subagentType:'Explore'}]}},pendingStart:false}));
window.qaPanels=[];useAppStore.setState({openSubagentPanel:t=>window.qaPanels.push(t)});
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

 const chip='[aria-label="Wait for CI rerun to finish output"]',peek='[data-testid="background-task-peek"]';
 const byText=t=>'document.evaluate('+JSON.stringify("//button[contains(., '"+t+"')]")+',document,null,9,null).singleNodeValue';
 const clickText=async t=>{const p=await js('(()=>{const r='+byText(t)+'.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');win.webContents.sendInputEvent({type:'mouseMove',...p});win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await delay(200);};
 try{
  await win.loadURL(process.env.QA_URL);await until('!!'+byText('Wait for CI rerun to finish'),'chips');
  assert.equal(await js('window.qaReads.length'),0,'nothing is read while the peek is closed');
  await clickText('Wait for CI rerun to finish');
  await until('!!document.querySelector('+JSON.stringify(peek)+')?.innerText.includes("Open CI run on GitHub")','peek opens with the run link');
  const text=await js('document.querySelector('+JSON.stringify(peek)+').innerText');
  for(const part of ['$ gh pr checks 103 --watch','Running · 4m','CI/Test & Build (macOS)','BubbleBrainBB/Aegis · run 18842391207','Show in transcript','Stop'])assert(text.includes(part),'peek shows '+part);
  assert.equal((text.match(/Open /g)||[]).length,1,'job URLs of one run fold into one link');
  assert.equal(await js('document.querySelectorAll("[data-testid=background-task-output] > span").length'),5,'the output tail, trailing newline dropped');
  // It follows the output while open.
  await js('window.qaOutput+="CI/Test & Build (macOS)\\tpass\\t5m3s\\thttps://github.com/BubbleBrainBB/Aegis/actions/runs/18842391207/job/53719921187\\n"');
  await until('document.querySelector("[data-testid=background-task-output]").innerText.includes("5m3s")','output refreshes');
  await shot('light-open');
  await clickText('Open CI run on GitHub');
  assert.deepEqual(await js('window.qaOpened'),['https://github.com/BubbleBrainBB/Aegis/actions/runs/18842391207'],'the run opens externally');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until('!document.querySelector('+JSON.stringify(peek)+')','Escape closes the peek');
  const reads=await js('window.qaReads.length');await delay(1500);
  assert.equal(await js('window.qaReads.length'),reads,'polling stops once closed');
  await js('qa.store.getState().setTheme("dark")');await until('document.documentElement.classList.contains("dark")','dark theme');
  await clickText('Wait for CI rerun to finish');await until('!!document.querySelector('+JSON.stringify(peek)+')','peek reopens');await delay(300);
  await shot('dark-open');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until('!document.querySelector('+JSON.stringify(peek)+')','closed again');
  // A subagent chip keeps opening its trace panel, with no peek.
  await clickText('Find where usage chips render');
  assert.deepEqual(await js('window.qaPanels'),['toolu_a2'],'subagent opens its panel');
  assert.equal(await js('!!document.querySelector('+JSON.stringify(peek)+')'),false,'no peek for a subagent');
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
  const env={...process.env,QA_URL:url,QA_CAPTURE:path.join(root,'output/playwright/background-task-peek')};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});let out='';
  child.stdout.on('data',c=>{out+=c;process.stdout.write(c);});child.stderr.on('data',c=>process.stderr.write(c));
  const timeout=setTimeout(()=>{child.kill();reject(Error('Background task peek Electron test timed out'));},90000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0&&out.includes('"ok":true')?resolve():reject(Error('Background task peek Electron test failed'));});
 });
}finally{await server?.close();await rm(tmp,{recursive:true,force:true});}
