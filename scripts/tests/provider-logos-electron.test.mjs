import {createServer} from 'vite';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';

// Provider marks on the real Sidebar, composer control and pickers, in both
// themes: single-colour marks stand out from their surface, and colored marks
// are never flipped. Reads the pixels, since a mark can pass any style check
// and still be black on a near-black panel.
// QA_CAPTURE=<dir> saves a light and a dark screenshot of each surface.
const root=process.cwd();
await mkdir('.aegis-design-qa',{recursive:true});
const dir=await mkdtemp(path.join(root,'.aegis-design-qa/provider-logos-'));
let server;
const harness=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {TasksView} from '/src/ui/components/TasksView';
import {ComposerAgentModelPicker} from '/src/ui/components/ComposerAgentControls';
import {ProviderPicker} from '/src/ui/components/ProviderPicker';
import {ProviderIcon} from '/src/ui/components/AgentModelPicker';
import {PROVIDERS} from '/src/ui/utils/provider';
import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';
const emptyResult=()=>{const done=()=>{};const result=Promise.resolve([]);for(const key of ['then','catch','finally'])done[key]=result[key].bind(result);return done};
const autoStub=()=>new Proxy(function(){},{get:(_,k)=>k==='then'?undefined:autoStub(),apply:emptyResult});
const stubs={getUserProfile:async()=>({displayName:'QA',handle:'qa',customized:true}),getBubbleProvidersConfig:async()=>({providers:[]}),getGitBranch:async()=>({ok:false}),getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]})};
window.electron=new Proxy(stubs,{get:(t,k)=>k in t?t[k]:autoStub()});
const a=useAppStore.getState();const draft=a.createDraftSession('/projects/coworker');const base=useAppStore.getState().sessions[draft];
const sessions=Object.fromEntries(PROVIDERS.map((p,i)=>[p.id,{...base,id:p.id,isDraft:false,title:p.label+' task',cwd:'/projects/coworker',projectCwd:'/projects/coworker',provider:p.id,messages:[],permissionRequests:[],status:'completed',updatedAt:Date.now()-i*60000,createdAt:Date.now()-i*60000}]));
useAppStore.setState({sessions,sidebarCollapsed:false,sidebarWidth:280,showSettings:false});
window.qa={store:useAppStore,providers:PROVIDERS.map(p=>p.id)};
const models=Object.fromEntries(PROVIDERS.map(p=>[p.id,null]));
const noop=()=>{};
createRoot(document.getElementById('root')).render(<Tooltip.Provider><div style={{height:'100vh',display:'flex',background:'var(--bg-primary)',color:'var(--text-primary)'}}><div style={{width:560,flexShrink:0,display:'flex'}}><TasksView/></div><main style={{flex:1,display:'flex',flexDirection:'column',alignItems:'flex-start',gap:16,padding:'80px 24px 24px'}}>
 <div data-qa="composer"><ComposerAgentModelPicker agentProvider="claude" modelLabel="Default" modelValue={null} modelValueByProvider={models} allAgentModelOptions={{}} onAgentChange={noop} onModelChange={noop} menuSide="bottom"/></div>
 <div data-qa="provider-picker"><ProviderPicker value="claude" onChange={noop} embedded/></div>
 <div data-qa="provider-icons" style={{display:'flex',gap:12}}>{PROVIDERS.map(p=><span key={p.id} data-provider={p.id}><ProviderIcon provider={p.id}/></span>)}</div>
</main></div></Tooltip.Provider>);
`;
const main=String.raw`
const {app,BrowserWindow,nativeTheme}=require('electron');
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
const MONOCHROME=['claude','codex','kimi','grok'];
const COLORED=['devin','minimax'];
const GLYPH='img,span[style*="mask"],svg.h-4';
app.whenReady().then(async()=>{
 const win=new BrowserWindow({webPreferences:{backgroundThrottling:false},width:1000,height:820,show:true});const errors=[];
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=s=>win.webContents.executeJavaScript(s,true),delay=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async s=>{for(let i=0;i<100;i++){if(await js(s))return;await delay(80)}throw Error('Timeout: '+s)};
 const shot=async name=>{if(!process.env.QA_CAPTURE)return;await delay(250);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 // The window is captured fresh for each mark because scrolling a row into view moves the others.
 const measure=async selector=>{
  const box=await js('(()=>{const e='+selector+';if(!e)return null;e.scrollIntoView({block:"nearest"});const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,filter:getComputedStyle(e).filter}})()');
  assert.ok(box&&box.w>0,'mark not rendered: '+selector);
  await delay(30);
  const image=await win.webContents.capturePage();const size=image.getSize(),pixels=image.toBitmap(),scale=size.width/win.getContentSize()[0];
  const lum=(x,y)=>{const o=(y*size.width+x)*4;return 0.2126*pixels[o+2]+0.7152*pixels[o+1]+0.0722*pixels[o]};
  let min=255,max=0,chroma=0;
  for(let y=Math.round(box.y*scale);y<(box.y+box.h)*scale;y++)for(let x=Math.round(box.x*scale);x<(box.x+box.w)*scale;x++){const l=lum(x,y),o=(y*size.width+x)*4;min=Math.min(min,l);max=Math.max(max,l);chroma=Math.max(chroma,Math.max(pixels[o],pixels[o+1],pixels[o+2])-Math.min(pixels[o],pixels[o+1],pixels[o+2]))}
  const background=lum(Math.max(0,Math.round((box.x-3)*scale)),Math.round((box.y+box.h/2)*scale));
  return {...box,min,max,chroma,background};
 };
 const assertMark=(where,provider,theme,m)=>{
  const label=where+' '+provider+' in '+theme+': '+JSON.stringify(m);
  if(theme==='dark')assert.ok(m.max-m.background>60,'stands out from the surface, '+label);
  else assert.ok(m.background-m.min>60,'stands out from the surface, '+label);
 };
 const click=async selector=>{win.focus();win.webContents.focus();const box=await js('(()=>{const r=('+selector+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');win.webContents.sendInputEvent({type:'mouseMove',...box});win.webContents.sendInputEvent({type:'mouseDown',...box,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...box,button:'left',clickCount:1});await delay(200)};
 const row=p=>'document.querySelector("[data-session-id='+p+'] [data-task-provider]")?.querySelector('+JSON.stringify(GLYPH)+')';
 try{
  await win.loadURL(process.env.QA_URL);
  await until('!!document.querySelector("[data-session-id=claude]")');
  for(const theme of ['light','dark']){
   // The real app sets this in its set-theme handler; the self-theming SVGs read it.
   nativeTheme.themeSource=theme;
   await js('qa.store.getState().setTheme('+JSON.stringify(theme)+')');await delay(400);
   await until('!!document.querySelector("[data-session-id=minimax]")');await delay(150);
   await shot('sidebar-'+theme);
   const providers=await js('qa.providers');
   for(const p of providers){
    const m=await measure(row(p));
    assertMark('sidebar row',p,theme,m);
    if(MONOCHROME.includes(p))assert.equal(m.filter,theme==='dark'?'invert(1)':'none','sidebar '+p+' filter in '+theme);
    else assert.equal(m.filter,'none','only single-colour black marks are flipped: '+p+' in '+theme);
    if(COLORED.includes(p))assert.ok(m.chroma>60,p+' keeps its color in '+theme+': '+JSON.stringify(m));
    const icon=await measure('document.querySelector("[data-provider='+p+']").querySelector('+JSON.stringify(GLYPH)+')');
    assert.equal(icon.filter,m.filter,'ProviderIcon '+p+' matches the sidebar in '+theme);
    assertMark('ProviderIcon',p,theme,icon);
   }
   // Composer agent control, closed.
   const composer=await measure('document.querySelector("[data-qa=composer] button").querySelector('+JSON.stringify(GLYPH)+')');
   assertMark('composer control','claude',theme,composer);
   // Composer model picker menu.
   await click('document.querySelector("[data-qa=composer] button")');
   await until('document.querySelectorAll("[role=menuitem]").length>3');await delay(250);
   await shot('model-picker-'+theme);
   const menuRow=name=>'[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes('+JSON.stringify(name)+'))?.querySelector('+JSON.stringify(GLYPH)+')';
   for(const [p,label] of [['claude','Claude'],['codex','Codex']])assertMark('model picker',p,theme,await measure(menuRow(label)));
   win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
   await until('document.querySelectorAll("[role=menuitem]").length===0');await delay(150);
   // Provider picker, closed and open.
   assertMark('provider picker','claude',theme,await measure('document.querySelector("[data-qa=provider-picker] button").querySelector('+JSON.stringify(GLYPH)+')'));
   await js('document.querySelector("[data-qa=provider-picker] button").click()');await delay(200);
   await shot('provider-picker-'+theme);
   const options=await js('[...document.querySelectorAll("[data-qa=provider-picker] .popover-surface button")].length');
   assert.ok(options>3,'provider picker lists providers');
   assertMark('provider picker menu','claude',theme,await measure('[...document.querySelectorAll("[data-qa=provider-picker] .popover-surface button")].find(b=>b.textContent.includes("Claude")).querySelector('+JSON.stringify(GLYPH)+')'));
   await js('document.querySelector("[data-qa=provider-picker] .fixed.inset-0").click()');await delay(150);
  }
  assert.deepEqual(errors,[]);console.log('PASS: provider logos in light and dark');app.exit(0);
 }catch(e){console.error(e,errors);await shot('failure');app.exit(1)}
});
`;
try{
 await writeFile(path.join(dir,'index.html'),'<html><body style="margin:0"><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
 await writeFile(path.join(dir,'probe.tsx'),harness);await writeFile(path.join(dir,'main.cjs'),main);
 // Own dep cache: sharing node_modules/.vite breaks a running dev server.
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),cacheDir:path.join(dir,'vite-cache'),server:{host:'127.0.0.1',port:0}});await server.listen();
 const env={...process.env,QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href};delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});const timer=setTimeout(()=>{child.kill();reject(Error('timeout'))},120000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('exit '+code))})});
}finally{await server?.close();await rm(dir,{recursive:true,force:true})}
