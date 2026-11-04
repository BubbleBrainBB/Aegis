import {createServer} from 'vite';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
const root=process.cwd();
await mkdir('.aegis-design-qa',{recursive:true});
const dir=await mkdtemp(path.join(root,'.aegis-design-qa/my-tasks-'));
let server;
const harness=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {Sidebar} from '/src/ui/components/Sidebar';
import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';
const emptyResult=()=>{const done=()=>{};const result=Promise.resolve([]);for(const key of ['then','catch','finally'])done[key]=result[key].bind(result);return done};
const autoStub=()=>new Proxy(function(){},{get:(_,k)=>k==='then'?undefined:autoStub(),apply:emptyResult});
const stubs={getUserProfile:async()=>({displayName:'BubbleBrain',handle:'bubblebrain',customized:true}),getBubbleProvidersConfig:async()=>({providers:[]}),getGitBranch:async()=>({ok:false})};
window.electron=new Proxy(stubs,{get:(t,k)=>k in t?t[k]:autoStub()});
const a=useAppStore.getState();const draft=a.createDraftSession('/projects/coworker');const base=useAppStore.getState().sessions[draft];
const titles=['PR merge CI speedup','Align New Task with the top right','Repair the stale project-file-navigation test','Remove Design Canvas Highlighted Element','Keep the design canvas test window focused','DeepSeek Harness upgrade check','Fix stale task-first e2e probe assertion','Give DeepSeek job tools readable trace labels','Make the browser type action reliable','Fix stopped-turn duration growth','Remove Screenshot Feature','Remove Environment Card Description Hint','Thread and Project grouping','Recent project updates','DeepSeek Harness plugin ideas','Release notes for the new version'];
const sessions=(count)=>Object.fromEntries(Array.from({length:count},(_,i)=>{const id='s'+i;return [id,{...base,id,isDraft:false,title:titles[i%titles.length],cwd:'/projects/coworker',projectCwd:'/projects/coworker',provider:'claude',messages:[],permissionRequests:[],status:i===0?'running':'completed',runtimeNotice:i>0&&i<6?'completed':undefined,updatedAt:Date.now()-i*60000,createdAt:Date.now()-i*60000}]}));
useAppStore.setState({sessions:sessions(16),sidebarCollapsed:false,sidebarWidth:280,showSettings:false,activeSessionId:'s10'});
useAppStore.getState().setTheme('light');
window.qa={store:useAppStore,sessions};
createRoot(document.getElementById('root')).render(<Tooltip.Provider><div style={{height:'100vh',display:'flex',background:'var(--bg-primary)',color:'var(--text-primary)'}}><Sidebar/><main style={{flex:1}}/></div></Tooltip.Provider>);
`;
const main=String.raw`
const {app,BrowserWindow}=require('electron');
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({webPreferences:{backgroundThrottling:false},width:640,height:620,show:true});const errors=[];
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=s=>win.webContents.executeJavaScript(s,true),delay=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async s=>{for(let i=0;i<100;i++){if(await js(s))return;await delay(80)}throw Error('Timeout: '+s)};
 const shot=async name=>{await delay(250);fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 const edge='document.querySelector("[data-sidebar-scroll-edge]")';
 const scroller='document.querySelector("[data-sidebar-scroll-region]")';
 const heading='[...document.querySelectorAll(".aegis-sidebar-panel div")].find(e=>e.textContent==="My Tasks")';
 const rect=s=>js('(()=>{const r=('+s+').getBoundingClientRect();return {x:r.x,y:r.y,bottom:r.bottom}})()');
 const state=()=>js(edge+'.dataset.sidebarScrollEdge');
 const opacity=()=>js('getComputedStyle('+edge+').opacity');
 const scrollTo=async top=>{await js(scroller+'.scrollTop='+top);await until(edge+'.dataset.sidebarScrollEdge==='+JSON.stringify(top>0?'visible':'hidden'));await delay(220)};
 try{
  await win.loadURL(process.env.QA_URL);await until('!!'+heading+'&&!!document.querySelector("[data-session-id=s0]")');
  const newTask=await rect('document.querySelector("[aria-label=\\"New Task\\"]")'),title=await rect(heading),label=await js('(()=>{const r=document.createRange();r.selectNodeContents('+heading+');const b=r.getBoundingClientRect();return {y:b.y,bottom:b.bottom}})()'),list=await rect(scroller);
  assert.ok(label.y-newTask.bottom>=20,'My Tasks sits clearly apart from New Task: '+JSON.stringify({newTask,label}));
  assert.ok(title.bottom<=list.y,'My Tasks stays above the scrolling list');
  assert.equal(await state(),'hidden','no edge at the top of the list');assert.equal(await opacity(),'0');
  await shot('top');
  assert.ok(await js(scroller+'.scrollHeight>'+scroller+'.clientHeight'),'list overflows');
  await scrollTo(60);
  assert.equal(await opacity(),'1','edge shows once rows slide under the header');
  assert.deepEqual(await rect(heading),title,'My Tasks does not scroll');
  await shot('scrolled');
  await scrollTo(0);assert.equal(await opacity(),'0','edge goes away back at the top');
  await js(scroller+'.scrollTop=60');await until(edge+'.dataset.sidebarScrollEdge==="visible"');
  await js('qa.store.setState({sessions:qa.sessions(1)})');await until(edge+'.dataset.sidebarScrollEdge==="hidden"');
  assert.equal(await js(scroller+'.scrollTop'),0,'a list that stops overflowing clears the edge');
  await js('qa.store.getState().setTheme("dark");qa.store.setState({sessions:qa.sessions(16)})');await delay(200);await scrollTo(60);await shot('scrolled-dark');
  assert.deepEqual(errors,[]);console.log('PASS: My Tasks heading, spacing and scroll edge');app.exit(0);
 }catch(e){console.error(e,errors);await shot('failure');app.exit(1)}
});
`;
try{
 await mkdir(path.join(root,'output/sidebar-my-tasks'),{recursive:true});
 await writeFile(path.join(dir,'index.html'),'<html><body style="margin:0"><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
 await writeFile(path.join(dir,'probe.tsx'),harness);await writeFile(path.join(dir,'main.cjs'),main);
 // Own dep cache: sharing node_modules/.vite breaks a running dev server.
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),cacheDir:path.join(dir,'vite-cache'),server:{host:'127.0.0.1',port:0}});await server.listen();
 const env={...process.env,QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/sidebar-my-tasks')};delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});const timer=setTimeout(()=>{child.kill();reject(Error('timeout'))},60000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('exit '+code))})});
}finally{await server?.close();await rm(dir,{recursive:true,force:true})}
