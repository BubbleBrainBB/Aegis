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
import {useFollowUpStore} from '/src/ui/store/useFollowUpStore';
import '/src/ui/index.css';
const emptyResult=()=>{const done=()=>{};const result=Promise.resolve([]);for(const key of ['then','catch','finally'])done[key]=result[key].bind(result);return done};
const autoStub=()=>new Proxy(function(){},{get:(_,k)=>k==='then'?undefined:autoStub(),apply:emptyResult});
const org={sessions:{seen:{archived:false,unread:false,sectionId:null,manualStatus:null,keptOpen:true}},sections:[],projectSources:{}};const changes=[];
const stubs={getUserProfile:async()=>({displayName:'BubbleBrain',handle:'bubblebrain',customized:true}),getBubbleProvidersConfig:async()=>({providers:[]}),getGitBranch:async cwd=>cwd==='/projects/coworker'?{ok:true,branch:'feat/search-row'}:{ok:false},
 listSidebarPullRequests:async()=>({review:[{number:41,title:'Move Search',state:'merged',url:'https://github.com/acme/coworker/pull/41'},{number:42,title:'Search follow-up',state:'open',url:'https://github.com/acme/coworker/pull/42'}]}),onSessionPullRequestsChanged:()=>()=>{},
 getSessionOrganization:async()=>structuredClone(org),onSessionOrganizationChanged:()=>()=>{},
 changeSessionOrganization:async change=>{changes.push(change);if(change.kind==='status')org.sessions[change.sessionId]={archived:false,unread:false,sectionId:null,...org.sessions[change.sessionId],manualStatus:change.status};return structuredClone(org)}};
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
 // Ran since you last closed it and you have read the answer: still yours to close.
 task('seen','Explain why the build is slow','insight-daily',{updatedAt:now-day*5.5}),
 // A finished task whose sub-task still waits for review: the whole family stays in Active.
 task('parent','Ship the sidebar redesign','launch-site',{updatedAt:now-day*3.5}),
 task('child-a','Draw the tree line','launch-site',{runtimeNotice:'completed',updatedAt:now-day*3,createdAt:now-day*3.4}),
 task('child-b','Measure the row height','launch-site',{updatedAt:now-day*3.2,createdAt:now-day*3.5}),
];
const sub=(id,child)=>[id,{id,parentSessionId:'parent',childSessionId:child,detachedAt:null,kind:'session',status:'started'}];
useFollowUpStore.setState({loaded:true,proposals:Object.fromEntries([sub('fa','child-a'),sub('fb','child-b')])});
const projects=['test','test-astra','test-mimo-2.6','test-glm-5','digital-garden','insight-daily','desktop-trust','desktop-basic','desktop-deny','podcasts','test-kimi-2.5','voxel-lab','launch-site','notes','pixel-pets','rust-book','tiny-compiler','color-tools','ink-garden','paper-plane'];
// Results nobody has looked at yet: enough to make the sidebar's Active list scroll.
const filler=projects.map((p,i)=>task('p'+i,'Read README in '+p,p,{runtimeNotice:'completed',updatedAt:now-day*(6+i)}));
const sessions=()=>Object.fromEntries([...fixed,...filler]);
useAppStore.setState({sessions:sessions(),sidebarCollapsed:false,sidebarWidth:280,showSettings:false,activeSessionId:'done'});
useAppStore.getState().setTheme('light');
window.qa={store:useAppStore,view:useSidebarViewStore,changes};
function Main(){const workspace=useAppStore(s=>s.activeWorkspace);const active=useAppStore(s=>s.sessions[s.activeSessionId]);return workspace==='tasks'?<TasksView/>:<main data-chat-stub style={{flex:1,minWidth:0}}><div data-chat-title style={{display:'flex',fontSize:13}}><SessionTitleActions session={active} showMenu={false} tasksCrumb/></div></main>;}
createRoot(document.getElementById('root')).render(<Tooltip.Provider><div style={{height:'100vh',display:'flex',background:'var(--bg-primary)',color:'var(--text-primary)'}}><Sidebar/><Main/></div></Tooltip.Provider>);
`;
const main=String.raw`
const {app,BrowserWindow}=require('electron');
const qaLast=list=>list[list.length-1];
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
 const heading='document.querySelector("[data-active-heading]")';
 const active=()=>js('[...document.querySelectorAll("[data-active-tasks] [data-session-id]")].map(e=>e.dataset.sessionId)');
 const projectMenu='document.querySelector("[data-task-project-menu]")';
 const pickProject=async name=>{await js('document.querySelector("[data-task-project-filter]").click()');await until('!!'+projectMenu);await js('document.querySelector("[data-project-choice=\\"'+(name?'/projects/'+name:'')+'\\"]").click()');await until('!'+projectMenu)};
 const statusMenu='document.querySelector("[data-task-status-menu]")';
 const key=async k=>{for(const type of ['keyDown','char','keyUp'])win.webContents.sendInputEvent({type,keyCode:k});await delay(60)};
 const filter=label=>'[...document.querySelectorAll("[aria-label=\\"Filter tasks\\"] button")].find(e=>e.textContent==='+JSON.stringify(label)+')';
 const rect=s=>js('(()=>{const r=('+s+').getBoundingClientRect();return {x:r.x,y:r.y,bottom:r.bottom}})()');
 const state=()=>js(edge+'.dataset.sidebarScrollEdge');
 const opacity=()=>js('getComputedStyle('+edge+').opacity');
 // The edge fades over 150ms; a slow runner can still be mid-fade after a fixed wait, so wait for the fade to end.
 const scrollTo=async top=>{await js(scroller+'.scrollTop='+top);await until(edge+'.dataset.sidebarScrollEdge==='+JSON.stringify(top>0?'visible':'hidden'));await until('getComputedStyle('+edge+').opacity==='+JSON.stringify(top>0?'1':'0'))};
 const rows=()=>js('[...document.querySelectorAll("[data-task-list] [data-session-id]")].map(e=>e.dataset.sessionId)');
 const title=()=>js('document.querySelector("[data-main-titlebar] h1").textContent');
 try{
  await win.loadURL(process.env.QA_URL);await until('!!'+heading+'&&!!document.querySelector("[data-active-tasks] [data-session-id]")');
  // The sidebar: three actions, then the tasks you are working through.
  const newTask=await rect(nav('New Task')),search=await rect(nav('Search')),myTasks=await rect(nav('My Tasks')),label=await js('(()=>{const r=document.createRange();r.selectNodeContents('+heading+');const b=r.getBoundingClientRect();return {y:b.y,bottom:b.bottom}})()'),list=await rect(scroller);
  assert.equal(search.x,newTask.x,'Search lines up with New Task');
  assert.equal(myTasks.x,newTask.x,'My Tasks lines up with New Task');
  assert.ok(search.y>=newTask.bottom&&search.y-newTask.bottom<=4,'Search sits right under New Task: '+JSON.stringify({newTask,search}));
  assert.ok(myTasks.y>=search.bottom&&myTasks.y-search.bottom<=4,'My Tasks sits right under Search');
  assert.ok(label.y-myTasks.bottom>=20,'Active sits clearly apart from the actions: '+JSON.stringify({myTasks,label}));
  assert.ok(label.bottom<=list.y,'Active stays above the scrolling list');
  const sidebarRows=await active();
  assert.deepEqual(sidebarRows.slice(0,2),['running','review'],'latest activity first: a task you just started is on top');
  assert.equal(sidebarRows.at(-1),'waiting','an old task that needs you stays where its last activity puts it');
  assert.equal(sidebarRows.includes('done'),false,'finished work leaves the list');
  assert.equal(sidebarRows.includes('seen'),true,'a result you have read stays until you close it');
  assert.deepEqual(await js('[...document.querySelectorAll("[data-active-family=parent] [data-session-id]")].map(e=>e.dataset.sessionId)'),['parent','child-b','child-a'],
   'a finished parent stays with all its sub-tasks, in the order they started');
  assert.equal(await js('document.querySelectorAll("[data-active-family=parent] [class*=rounded-bl]").length'),1,'the last sub-task hooks the tree line');
  assert.equal(sidebarRows.indexOf('parent'),sidebarRows.indexOf('review')+1,'a family stands where its latest member does');
  await shot('sidebar');
  // While its agent names a task, its title is a loading bar, in the sidebar and the title bar; the name replaces it.
  const pending=(id,on)=>js('qa.store.setState(s=>({sessions:{...s.sessions,'+id+':{...s.sessions.'+id+',titlePending:'+on+'}}}))');
  await pending('review',true);await pending('done',true);
  await until('!!document.querySelector("[data-active-tasks] [data-session-id=review] [data-title-loading]")&&!!document.querySelector("[data-chat-title] [data-title-loading]")');
  assert.equal(await js('document.querySelector("[data-active-tasks] [data-session-id=review]").textContent.includes("Move Search")'),false,'no title while it is being named');
  await shot('title-loading');
  await pending('review',false);await pending('done',false);
  await until('!document.querySelector("[data-title-loading]")');
  assert.equal(await js('document.querySelector("[data-active-tasks] [data-session-id=review]").textContent.includes("Move Search below New Task")'),true);
  assert.equal(await js('document.querySelector("[data-chat-title]").textContent.includes("Give this article a cyberpunk title")'),true);
  assert.equal(await js('document.querySelector("[data-active-tasks] [data-session-id=review] [data-task-age]").textContent'),'2d');
  // A row shows its PRs and, when the pointer rests on it, the task's card.
  await until('!!document.querySelector("[data-active-tasks] [data-session-id=review] [data-pull-request-count]")');
  assert.equal(await js('document.querySelector("[data-active-tasks] [data-session-id=review] [data-pull-request-count]").getAttribute("aria-label")'),'2 pull requests · 1 open, 1 merged');
  await js('document.querySelector("[data-active-tasks] [data-session-id=review]").scrollIntoView({block:"nearest"})');await delay(60);
  const cardRow=await rect('document.querySelector("[data-active-tasks] [data-session-id=review]")');
  win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(cardRow.x+60),y:Math.round(cardRow.y+8)});
  await until('!!document.querySelector("[data-session-hover-card]")');await shot('sidebar-hover-card');
  const hoverCard=await js('document.querySelector("[data-session-hover-card]").textContent');
  assert.ok(hoverCard.includes('Move Search below New Task')&&hoverCard.includes('coworker'),'the hover card names the task and its project: '+hoverCard);
  await until('document.querySelector("[data-session-hover-card]").textContent.includes("feat/search-row")');await shot('sidebar-hover-card-branch');
  assert.equal(await js('(()=>{const c=document.querySelector("[data-session-hover-card]").getBoundingClientRect(),r=document.querySelector("[data-active-tasks] [data-session-id=review]").getBoundingClientRect();return c.left>=r.right&&Math.abs(c.top-r.top)<2})()'),true,'the card opens beside the row, level with it, and covers no other task');
  win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(cardRow.x+60),y:4});
  await until('!document.querySelector("[data-session-hover-card]")');
  assert.equal(await js(nav('My Tasks')+'.textContent.trim()'),'My Tasks2','the row counts tasks waiting on you');
  assert.equal(await js('getComputedStyle(document.querySelector("[data-nav-badge]")).color===getComputedStyle(document.documentElement).getPropertyValue("--warning").trim()||document.querySelector("[data-nav-badge]").className.includes("--warning")'),true,'in amber');
  assert.equal(await js(nav('Search')+'.title.startsWith("Search")'),true,'Search keeps its tooltip');
  await js(nav('Search')+'.click()');await until('!!document.querySelector("input[placeholder^=\\"Search sessions\\"]")');
  await js('qa.store.getState().setSearchPaletteOpen(false)');await until('!document.querySelector("input[placeholder^=\\"Search sessions\\"]")');
  // Tasks scroll under the pinned heading.
  assert.equal(await state(),'hidden','no edge at the top of the list');assert.equal(await opacity(),'0');
  assert.ok(await js(scroller+'.scrollHeight>'+scroller+'.clientHeight'),'list overflows');
  await scrollTo(60);
  assert.equal(await opacity(),'1','edge shows once rows slide under the header');
  await scrollTo(0);assert.equal(await opacity(),'0','edge goes away back at the top');
  // My Tasks opens the page, most urgent first.
  await js(nav('My Tasks')+'.click()');await until('!!document.querySelector("[data-task-list] [data-session-id]")');
  assert.equal(await title(),'My Tasks');
  assert.equal(await js(nav('My Tasks')+'.classList.contains("bg-[var(--sidebar-item-active)]")'),true,'the row shows where you are');
  const pageRows=await rows();
  assert.deepEqual(pageRows.slice(0,4),['failed','waiting','running','review'],'needs you, then running, then review');
  assert.equal(pageRows.at(-1),'done','then done');
  assert.equal(await js('document.querySelector("[data-session-id=failed] [data-task-attention]").textContent'),'Stopped with an error');
  assert.equal(await js('document.querySelector("[data-session-id=waiting] [data-task-attention]").textContent'),'Run npm run release');
  assert.equal(await js('document.querySelector("[data-session-id=failed] [role=img]").getAttribute("aria-label")'),'Failed');
  assert.equal(await js('document.querySelector("[data-session-id=done] [role=img] circle").getAttribute("fill")'),'var(--success)','finished work gets the green check');
  assert.equal(await js('document.querySelector("[data-session-id=review] [role=img]").dataset.taskIcon'),'half','work to review is half filled');
  assert.equal(await js('document.querySelector("[data-session-id=review] [role=img]").getAttribute("aria-label")'),'Ready for review');
  assert.equal(await js('document.querySelector("[data-session-id=done] [role=img]").getAttribute("aria-label")'),'Completed');
  assert.equal(await js('!!document.querySelector("[data-session-id=done] [data-task-project]")'),false,'rows leave the project to the hover card');
  assert.equal(await js('document.querySelector("[data-session-id=running] [data-task-date]").textContent'),'1m');
  await shot('page');
  await pending('review',true);await until('!!document.querySelector("[data-task-list] [data-session-id=review] [data-title-loading]")');
  await shot('page-title-loading');
  await pending('review',false);await until('!document.querySelector("[data-task-list] [data-title-loading]")');
  // Filters follow the task states.
  assert.deepEqual(await js('[...document.querySelectorAll("[aria-label=\\"Filter tasks\\"] button")].map(e=>e.textContent)'),['All','Needs input','Running','Ready for review','Completed']);
  await js(filter('Needs input')+'.click()');await until(filter('Needs input')+'.getAttribute("aria-pressed")==="true"');
  assert.deepEqual(await rows(),['failed','waiting']);
  await js(filter('Running')+'.click()');await until('document.querySelectorAll("[data-task-list] [data-session-id]").length===1');
  assert.deepEqual(await rows(),['running']);
  await js(filter('All')+'.click()');await until('document.querySelectorAll("[data-task-list] [data-session-id]").length>5');
  // A project narrows the page, and its name stops repeating on every row.
  await js('document.querySelector("[data-task-project-filter]").click()');await until('!!'+projectMenu);
  assert.equal(await js('document.querySelector("[data-project-choice=\\"/projects/coworker\\"]").textContent'),'coworker3','each project says how many tasks it has');
  await shot('project-menu');
  const desktopRow=await rect('document.querySelector("[data-project-choice=\\"/projects/coworker\\"]")');
  win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(desktopRow.x+80),y:Math.round(desktopRow.y+10)});await delay(150);
  assert.equal(await js('getComputedStyle(document.querySelector("[data-project-choice=\\"/projects/coworker\\"] [aria-label=\\"New task in coworker\\"]")).display!=="none"'),true,'hovering a project shows its actions');
  await shot('project-menu-hover');
  await js('document.querySelector("[data-project-choice=\\"/projects/coworker\\"]").click()');await until('document.querySelectorAll("[data-task-list] [data-session-id]").length===3');
  assert.equal(await title(),'coworker');
  assert.deepEqual(await rows(),['waiting','running','review']);
  assert.equal(await js('!!document.querySelector("[data-task-list] [data-task-project]")'),false);
  assert.equal(await js('document.querySelector("[data-task-project-filter]").getAttribute("aria-label")'),'Project: coworker');
  assert.equal(await js('qa.store.getState().projectCwd'),'/projects/coworker');
  assert.deepEqual((await active()).slice(0,2),['running','review'],'the sidebar is not filtered');
  await shot('project');
  assert.equal(await js('[...document.querySelectorAll("[data-main-titlebar] button")].some(e=>e.textContent.trim()==="New task")'),false,'the sidebar has New Task, the page does not repeat it');
  // The sidebar's New Task starts in the project on screen, not the last task's.
  await js(nav('New Task')+'.click()');await until('qa.store.getState().sessions[qa.store.getState().activeSessionId]?.isDraft===true');
  assert.equal(await js('qa.store.getState().sessions[qa.store.getState().activeSessionId].cwd'),'/projects/coworker');
  await js('qa.store.getState().setActiveSession("done");qa.store.getState().setActiveWorkspace("tasks")');await until('document.querySelectorAll("[data-task-list] [data-session-id]").length===3');
  // My Tasks keeps the filter; All projects goes back to everything; a task opens its chat.
  await js(nav('My Tasks')+'.click()');await until('document.querySelectorAll("[data-task-list] [data-session-id]").length===3');
  assert.equal(await title(),'coworker');
  await pickProject(null);await until('document.querySelectorAll("[data-task-list] [data-session-id]").length>5');
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
  // List rows leave the project out; a card's project chip offers the project's actions.
  assert.equal(await js('!!document.querySelector("[data-task-list] [data-task-project]")'),false,'list rows do not name the project');
  await js('qa.view.getState().setOption("layout","board")');await until('!!document.querySelector("[data-task-board] [data-session-id=review] [data-task-project]")');
  await js('document.querySelector("[data-task-board] [data-session-id=review] [data-task-project]").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))');await until('!!document.querySelector("[data-project-chip-menu]")');
  assert.deepEqual(await js('[...document.querySelectorAll("[data-project-chip-menu] [role=menuitem]")].map(e=>e.textContent)'),['Show only coworker','New task here','Show in Finder','Remove project…']);
  await shot('chip-menu');
  await key('Escape');await until('!document.querySelector("[data-project-chip-menu]")');
  // A card's project chip filters too.
  await js('document.querySelector("[data-task-board] [data-session-id=review] [data-task-project]").click()');await until('document.querySelectorAll("[data-task-board] [data-session-id]").length===3');
  assert.equal(await js('qa.store.getState().activeWorkspace'),'tasks','the chip filters instead of opening the task');
  await js('qa.view.getState().setOption("layout","list")');await until('document.querySelectorAll("[data-task-list] [data-session-id]").length===3');
  await js('document.querySelector("[data-task-list] [data-session-id=review]").click()');await until('!!document.querySelector("[data-chat-stub]")');
  assert.equal(await js(crumb+'.textContent'),'coworker','opened from a project, the path names it');
  await js(crumb+'.click()');await until('document.querySelectorAll("[data-task-list] [data-session-id]").length===3');
  assert.equal(await title(),'coworker','and goes back to that project');
  // A task from elsewhere (search, a link) is not in that project's page.
  await js('qa.store.getState().setActiveSession("done");qa.store.getState().setActiveWorkspace("chat")');await until('!!document.querySelector("[data-chat-stub]")');
  assert.equal(await js(crumb+'.textContent'),'My Tasks','a project page it is not in is not its path');
  await js(crumb+'.click()');await until('document.querySelectorAll("[data-task-list] [data-session-id]").length>5');
  assert.equal(await title(),'My Tasks');
  // Change status from the sidebar: the agent owns Needs input and Running, you pick the rest.
  const sideRow=id=>'document.querySelector("[data-active-tasks] [data-session-id='+id+']")';
  assert.equal(await js('!!'+sideRow('running')+'.querySelector("[data-task-status-trigger]")'),false,'a running task keeps its state');
  await js(sideRow('review')+'.querySelector("[data-task-status-trigger]").click()');await until('!!'+statusMenu);
  assert.deepEqual(await js('[...'+statusMenu+'.querySelectorAll("[data-task-status-option]")].map(e=>[e.dataset.taskStatusOption,e.hasAttribute("data-disabled"),e.textContent])'),
   [['needs-input',true,'Needs input'],['running',true,'Running'],['review',false,'Ready for review1'],['completed',false,'Completed2']]);
  assert.equal(await js('!!'+statusMenu+'.querySelector("[data-task-status-option=review] [aria-label=Current]")'),true,'the current state is checked');
  await shot('status-menu');
  await js(statusMenu+'.querySelector("[data-task-status-option=completed]").click()');await until('!'+sideRow('review'));
  assert.deepEqual(qaLast(await js('qa.changes')),{kind:'status',sessionId:'review',status:'completed'});
  assert.equal(await js('qa.store.getState().activeWorkspace'),'tasks','picking a status does not open the task');
  assert.equal(await js('document.querySelector("[data-task-list] [data-session-id=review] [role=img]").getAttribute("aria-label")'),'Completed');
  // Back to review from the list, with the keyboard: S on the focused row, then 1. It is where the task would be anyway, so the hand-set status goes.
  await js('document.querySelector("[data-task-list] [data-session-id=review]").focus()');await key('s');await until('!!'+statusMenu);
  await key('1');await until('!!'+sideRow('review'));
  assert.deepEqual(qaLast(await js('qa.changes')),{kind:'status',sessionId:'review',status:null});
  // S also works on the row under the pointer.
  await js('document.activeElement.blur()');
  assert.equal(await js('!!'+sideRow('waiting')+'.querySelector("[data-task-status-trigger]")'),false,'an approval the agent waits on is answered, not closed');
  await js(sideRow('failed')+'.scrollIntoView({block:"nearest"})');await delay(60);
  const r=await rect(sideRow('failed'));win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(r.x+60),y:Math.round(r.y+8)});await delay(120);
  await key('s');await until('!!'+statusMenu);
  await key('2');await until('!'+sideRow('failed'));
  assert.deepEqual(qaLast(await js('qa.changes')),{kind:'status',sessionId:'failed',status:'completed'});
  assert.equal(await js(nav('My Tasks')+'.textContent.trim()'),'My Tasks1','a task closed by hand stops counting as waiting on you');
  // S keeps working on the row under the pointer after that row re-renders.
  await js(sideRow('review')+'.scrollIntoView({block:"nearest"})');await delay(60);
  const hovered=await rect(sideRow('review'));win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(hovered.x+60),y:Math.round(hovered.y+8)});await delay(120);
  await js('qa.store.setState(s=>({sessions:{...s.sessions,review:{...s.sessions.review,title:"Move Search below New Task again"}}}))');await delay(120);
  await key('s');await until('!!'+statusMenu);await key('Escape');await until('!'+statusMenu);
  // A key something else already handled is left alone.
  await js('window.__claimS=e=>{if(e.key==="s")e.preventDefault()};window.addEventListener("keydown",window.__claimS,true)');
  await key('s');await delay(200);
  assert.equal(await js('!!'+statusMenu),false,'S handled elsewhere does not open the menu');
  await js('window.removeEventListener("keydown",window.__claimS,true)');
  // A hand-set state the task later reaches on its own still clears when you pick it.
  await js('document.querySelector("[data-task-list] [data-session-id=done] [data-task-status-trigger]").click()');await until('!!'+statusMenu);
  await js(statusMenu+'.querySelector("[data-task-status-option=review]").click()');await until('!!'+sideRow('done'));
  assert.deepEqual(qaLast(await js('qa.changes')),{kind:'status',sessionId:'done',status:'review'});
  await js('qa.store.setState(s=>({sessions:{...s.sessions,done:{...s.sessions.done,runtimeNotice:"completed"}}}))');await delay(120);
  await js(sideRow('done')+'.querySelector("[data-task-status-trigger]").click()');await until('!!'+statusMenu);
  await js(statusMenu+'.querySelector("[data-task-status-option=review]").click()');await until('!'+statusMenu);await delay(150);
  assert.deepEqual(qaLast(await js('qa.changes')),{kind:'status',sessionId:'done',status:null},'picking the state the task has anyway clears the hand-set one');
  // Reading a result does not close it: marking it Completed does.
  await js(sideRow('seen')+'.scrollIntoView({block:"nearest"})');
  await js(sideRow('seen')+'.querySelector("[data-task-status-trigger]").click()');await until('!!'+statusMenu);
  await js(statusMenu+'.querySelector("[data-task-status-option=completed]").click()');await until('!'+sideRow('seen'));
  assert.deepEqual(qaLast(await js('qa.changes')),{kind:'status',sessionId:'seen',status:'completed'});
  await js('qa.store.getState().setActiveWorkspace("chat")');await until('!!document.querySelector("[data-chat-stub]")');
  // New task from a project in the filter starts there.
  await js('qa.store.getState().setActiveWorkspace("tasks")');await until('!!document.querySelector("[data-task-project-filter]")');
  await js('document.querySelector("[data-task-project-filter]").click()');await until('!!'+projectMenu);
  await js('document.querySelector("[data-project-choice=\\"/projects/podcasts\\"] [aria-label=\\"New task in podcasts\\"]").click()');await until('qa.store.getState().sessions[qa.store.getState().activeSessionId]?.isDraft===true');
  assert.equal(await js('qa.store.getState().sessions[qa.store.getState().activeSessionId].cwd'),'/projects/podcasts');
  assert.equal(await js('!!document.querySelector("[data-chat-stub]")'),true);
  assert.equal(await js('!!document.querySelector("[data-session-tasks-crumb]")'),false,'an unsent chat is not a task yet');
  // Dark.
  await js('qa.store.getState().setTheme("dark")');await js(nav('My Tasks')+'.click()');await until('!!document.querySelector("[data-task-list] [data-session-id]")');await shot('page-dark');
  assert.deepEqual(errors,[]);console.log('PASS: sidebar actions, the Active list, Change status, the Project filter, the My Tasks page and its breadcrumb');app.exit(0);
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
