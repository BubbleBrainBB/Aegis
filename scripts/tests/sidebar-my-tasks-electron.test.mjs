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
import {TasksView} from '/src/ui/components/TasksView';
import {SessionTitleActions} from '/src/ui/components/SessionTitleActions';
import {useAppStore} from '/src/ui/store/useAppStore';
import {useSidebarViewStore} from '/src/ui/store/useSidebarViewStore';
import '/src/ui/index.css';
const emptyResult=()=>{const done=()=>{};const result=Promise.resolve([]);for(const key of ['then','catch','finally'])done[key]=result[key].bind(result);return done};
const autoStub=()=>new Proxy(function(){},{get:(_,k)=>k==='then'?undefined:autoStub(),apply:emptyResult});
const stubs={getUserProfile:async()=>({displayName:'BubbleBrain',handle:'bubblebrain',customized:true}),getBubbleProvidersConfig:async()=>({providers:[]}),getGitBranch:async()=>({ok:false})};
window.electron=new Proxy(stubs,{get:(t,k)=>k in t?t[k]:autoStub()});
const a=useAppStore.getState();const draft=a.createDraftSession('/projects/coworker');const base=useAppStore.getState().sessions[draft];
const day=86400000,now=Date.now();
const task=(id,title,project,extra={})=>[id,{...base,id,isDraft:false,title,cwd:'/projects/'+project,projectCwd:'/projects/'+project,provider:'claude',messages:[],permissionRequests:[],status:'completed',updatedAt:now-day*5,createdAt:now-day*5,...extra}];
const fixed=[
 task('failed','Create a detailed voxel art model and keep every layer editable','test-opus-5.5',{runtimeNotice:'error',updatedAt:now-day*20}),
 task('waiting','Run the release script','coworker',{updatedAt:now-day*30,permissionRequests:[{sessionId:'waiting',toolUseId:'t1',toolName:'Bash',input:{command:'npm run release'}}]}),
 task('running','Rewrite the sidebar as a task page','coworker',{status:'running',provider:'codex',updatedAt:now-60000}),
 task('review','Move Search below New Task','coworker',{runtimeNotice:'completed',updatedAt:now-day*2}),
 task('done','Give this article a cyberpunk title','test',{updatedAt:now-day*4}),
];
const projects=['test','test-astra','test-mimo-2.6','test-glm-5','digital-garden','insight-daily','desktop-trust','desktop-basic','desktop-deny','podcasts','test-kimi-2.5','voxel-lab','launch-site','notes','pixel-pets','rust-book','tiny-compiler','color-tools','ink-garden','paper-plane'];
const filler=projects.map((p,i)=>task('p'+i,'Read README in '+p,p,{updatedAt:now-day*(6+i)}));
const sessions=()=>Object.fromEntries([...fixed,...filler]);
useAppStore.setState({sessions:sessions(),sidebarCollapsed:false,sidebarWidth:280,showSettings:false,activeSessionId:'done'});
useAppStore.getState().setTheme('light');
window.qa={store:useAppStore,view:useSidebarViewStore};
function Main(){const workspace=useAppStore(s=>s.activeWorkspace);const active=useAppStore(s=>s.sessions[s.activeSessionId]);return workspace==='tasks'?<TasksView/>:<main data-chat-stub style={{flex:1,minWidth:0}}><div data-chat-title style={{display:'flex',fontSize:13}}><SessionTitleActions session={active} showMenu={false} tasksCrumb/></div></main>;}
createRoot(document.getElementById('root')).render(<Tooltip.Provider><div style={{height:'100vh',display:'flex',background:'var(--bg-primary)',color:'var(--text-primary)'}}><Sidebar/><Main/></div></Tooltip.Provider>);
`;
const main=String.raw`
const {app,BrowserWindow}=require('electron');
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({webPreferences:{backgroundThrottling:false},width:1280,height:640,show:true});const errors=[];
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=s=>win.webContents.executeJavaScript(s,true),delay=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async s=>{for(let i=0;i<100;i++){if(await js(s))return;await delay(80)}throw Error('Timeout: '+s)};
 const shot=async name=>{await delay(250);fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 const edge='document.querySelector("[data-sidebar-scroll-edge]")';
 const scroller='document.querySelector("[data-sidebar-scroll-region]")';
 const nav=label=>'document.querySelector(".aegis-sidebar-panel [aria-label=\\"'+label+'\\"]")';
 const heading='[...document.querySelectorAll(".aegis-sidebar-panel div")].find(e=>e.textContent==="Workspace")';
 const project=name=>'document.querySelector("[data-workspace-project=\\"/projects/'+name+'\\"]")';
 const filter=label=>'[...document.querySelectorAll("[aria-label=\\"Filter tasks\\"] button")].find(e=>e.textContent==='+JSON.stringify(label)+')';
 const rect=s=>js('(()=>{const r=('+s+').getBoundingClientRect();return {x:r.x,y:r.y,bottom:r.bottom}})()');
 const state=()=>js(edge+'.dataset.sidebarScrollEdge');
 const opacity=()=>js('getComputedStyle('+edge+').opacity');
 const scrollTo=async top=>{await js(scroller+'.scrollTop='+top);await until(edge+'.dataset.sidebarScrollEdge==='+JSON.stringify(top>0?'visible':'hidden'));await delay(220)};
 const rows=()=>js('[...document.querySelectorAll("[data-task-list] [data-session-id]")].map(e=>e.dataset.sessionId)');
 const title=()=>js('document.querySelector("[data-main-titlebar] h1").textContent');
 try{
  await win.loadURL(process.env.QA_URL);await until('!!'+heading+'&&!!'+project('coworker'));
  // The sidebar: three actions, then Workspace and its projects.
  const newTask=await rect(nav('New Task')),search=await rect(nav('Search')),myTasks=await rect(nav('My Tasks')),label=await js('(()=>{const r=document.createRange();r.selectNodeContents('+heading+');const b=r.getBoundingClientRect();return {y:b.y,bottom:b.bottom}})()'),list=await rect(scroller);
  assert.equal(search.x,newTask.x,'Search lines up with New Task');
  assert.equal(myTasks.x,newTask.x,'My Tasks lines up with New Task');
  assert.ok(search.y>=newTask.bottom&&search.y-newTask.bottom<=4,'Search sits right under New Task: '+JSON.stringify({newTask,search}));
  assert.ok(myTasks.y>=search.bottom&&myTasks.y-search.bottom<=4,'My Tasks sits right under Search');
  assert.ok(label.y-myTasks.bottom>=20,'Workspace sits clearly apart from the actions: '+JSON.stringify({myTasks,label}));
  assert.ok(label.bottom<=list.y,'Workspace stays above the scrolling list');
  assert.equal(await js('!!document.querySelector(".aegis-sidebar-panel [data-session-id]")'),false,'tasks are no longer listed in the sidebar');
  assert.equal(await js(nav('My Tasks')+'.textContent.trim()'),'My Tasks2','the row counts tasks waiting on you');
  assert.equal(await js(nav('Search')+'.title.startsWith("Search")'),true,'Search keeps its tooltip');
  await js(nav('Search')+'.click()');await until('!!document.querySelector("input[placeholder^=\\"Search sessions\\"]")');
  await js('qa.store.getState().setSearchPaletteOpen(false)');await until('!document.querySelector("input[placeholder^=\\"Search sessions\\"]")');
  // Projects scroll under the pinned heading.
  assert.equal(await state(),'hidden','no edge at the top of the list');assert.equal(await opacity(),'0');
  assert.ok(await js(scroller+'.scrollHeight>'+scroller+'.clientHeight'),'list overflows');
  await scrollTo(60);
  assert.equal(await opacity(),'1','edge shows once rows slide under the header');
  await scrollTo(0);assert.equal(await opacity(),'0','edge goes away back at the top');
  // My Tasks opens the page, most urgent first.
  await js(nav('My Tasks')+'.click()');await until('!!document.querySelector("[data-task-list] [data-session-id]")');
  assert.equal(await title(),'My Tasks');
  assert.equal(await js(nav('My Tasks')+'.classList.contains("bg-[var(--sidebar-item-active)]")'),true,'the row shows where you are');
  assert.deepEqual((await rows()).slice(0,5),['failed','waiting','running','review','done'],'needs you, then running, then review, then done');
  assert.equal(await js('document.querySelector("[data-session-id=failed] [data-task-attention]").textContent'),'Stopped with an error');
  assert.equal(await js('document.querySelector("[data-session-id=waiting] [data-task-attention]").textContent'),'Run npm run release');
  assert.equal(await js('document.querySelector("[data-session-id=failed] [role=img]").getAttribute("aria-label")'),'Failed');
  assert.equal(await js('document.querySelector("[data-session-id=done] [role=img] circle").getAttribute("fill")'),'var(--success)','finished work gets the green check');
  assert.equal(await js('document.querySelector("[data-session-id=review] [role=img]").dataset.taskIcon'),'half','work to review is half filled');
  assert.equal(await js('document.querySelector("[data-session-id=review] [role=img]").getAttribute("aria-label")'),'Ready for review');
  assert.equal(await js('document.querySelector("[data-session-id=done] [role=img]").getAttribute("aria-label")'),'Completed');
  assert.equal(await js('document.querySelector("[data-session-id=done] [data-task-project]").textContent'),'test','rows name their project');
  assert.equal(await js('document.querySelector("[data-session-id=running] [data-task-date]").textContent'),'1m');
  await shot('page');
  // Filters follow the task states.
  assert.deepEqual(await js('[...document.querySelectorAll("[aria-label=\\"Filter tasks\\"] button")].map(e=>e.textContent)'),['All','Needs input','Running','Ready for review','Completed']);
  await js(filter('Needs input')+'.click()');await until(filter('Needs input')+'.getAttribute("aria-pressed")==="true"');
  assert.deepEqual(await rows(),['failed','waiting']);
  await js(filter('Running')+'.click()');await until('document.querySelectorAll("[data-task-list] [data-session-id]").length===1');
  assert.deepEqual(await rows(),['running']);
  await js(filter('All')+'.click()');await until('document.querySelectorAll("[data-task-list] [data-session-id]").length>5');
  // A project narrows the page, and its name stops repeating on every row.
  await js(project('coworker')+'.querySelector("button").click()');await until('document.querySelectorAll("[data-task-list] [data-session-id]").length===3');
  assert.equal(await title(),'coworker');
  assert.deepEqual(await rows(),['waiting','running','review']);
  assert.equal(await js('!!document.querySelector("[data-task-project]")'),false);
  assert.equal(await js(project('coworker')+'.querySelector("button").getAttribute("aria-current")'),'page');
  assert.equal(await js('qa.store.getState().projectCwd'),'/projects/coworker');
  await shot('project');
  assert.equal(await js('[...document.querySelectorAll("[data-main-titlebar] button")].some(e=>e.textContent.trim()==="New task")'),false,'the sidebar has New Task, the page does not repeat it');
  // The sidebar's New Task starts in the project on screen, not the last task's.
  await js(nav('New Task')+'.click()');await until('qa.store.getState().sessions[qa.store.getState().activeSessionId]?.isDraft===true');
  assert.equal(await js('qa.store.getState().sessions[qa.store.getState().activeSessionId].cwd'),'/projects/coworker');
  await js('qa.store.getState().setActiveSession("done");qa.store.getState().setActiveWorkspace("tasks")');await until('document.querySelectorAll("[data-task-list] [data-session-id]").length===3');
  // My Tasks goes back to everything; a task opens its chat.
  await js(nav('My Tasks')+'.click()');await until('document.querySelectorAll("[data-task-list] [data-session-id]").length>5');
  assert.equal(await title(),'My Tasks');
  await js('document.querySelector("[data-session-id=review]").click()');await until('!!document.querySelector("[data-chat-stub]")');
  assert.equal(await js('qa.store.getState().activeSessionId'),'review');
  assert.equal(await js('qa.store.getState().activeWorkspace'),'chat');
  // The title leads back to the list the task came from.
  const crumb='document.querySelector("[data-session-tasks-crumb]")';
  assert.equal(await js(crumb+'.textContent'),'My Tasks');
  await shot('crumb');
  await js(crumb+'.click()');await until('!!document.querySelector("[data-task-list] [data-session-id]")');
  assert.equal(await title(),'My Tasks');
  await js(project('coworker')+'.querySelector("button").click()');await until('document.querySelectorAll("[data-task-list] [data-session-id]").length===3');
  await js('document.querySelector("[data-session-id=review]").click()');await until('!!document.querySelector("[data-chat-stub]")');
  assert.equal(await js(crumb+'.textContent'),'coworker','opened from a project, the path names it');
  await js(crumb+'.click()');await until('document.querySelectorAll("[data-task-list] [data-session-id]").length===3');
  assert.equal(await title(),'coworker','and goes back to that project');
  // A task from elsewhere (search, a link) is not in that project's page.
  await js('qa.store.getState().setActiveSession("done");qa.store.getState().setActiveWorkspace("chat")');await until('!!document.querySelector("[data-chat-stub]")');
  assert.equal(await js(crumb+'.textContent'),'My Tasks','a project page it is not in is not its path');
  await js(crumb+'.click()');await until('document.querySelectorAll("[data-task-list] [data-session-id]").length>5');
  assert.equal(await title(),'My Tasks');
  await js('qa.store.getState().setActiveWorkspace("chat")');await until('!!document.querySelector("[data-chat-stub]")');
  // New task from a project row starts there.
  await js(project('podcasts')+'.querySelector("[aria-label=\\"New task in podcasts\\"]").click()');await until('qa.store.getState().sessions[qa.store.getState().activeSessionId]?.isDraft===true');
  assert.equal(await js('qa.store.getState().sessions[qa.store.getState().activeSessionId].cwd'),'/projects/podcasts');
  assert.equal(await js('!!document.querySelector("[data-chat-stub]")'),true);
  assert.equal(await js('!!document.querySelector("[data-session-tasks-crumb]")'),false,'an unsent chat is not a task yet');
  // Dark.
  await js('qa.store.getState().setTheme("dark")');await js(nav('My Tasks')+'.click()');await until('!!document.querySelector("[data-task-list] [data-session-id]")');await shot('page-dark');
  assert.deepEqual(errors,[]);console.log('PASS: sidebar actions, Workspace projects, the My Tasks page and its breadcrumb');app.exit(0);
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
