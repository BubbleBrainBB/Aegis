import {createServer} from 'vite';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
const root=process.cwd();
await mkdir('.aegis-design-qa',{recursive:true});
const dir=await mkdtemp(path.join(root,'.aegis-design-qa/update-button-'));
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
window.qaCalls=[];
const idle={available:false,version:null,autoDetected:false,phase:'idle',progress:null,error:null};
const stubs={getUserProfile:async()=>({displayName:'BubbleBrain',handle:'bubblebrain',customized:true}),getBubbleProvidersConfig:async()=>({providers:[]}),getGitBranch:async()=>({ok:false}),
 getUpdateStatus:async()=>({...idle,available:true,version:'0.0.84',phase:'available'}),
 downloadUpdate:async()=>{qaCalls.push('download');return {ok:true}},installUpdate:async()=>{qaCalls.push('install');return {ok:true}}};
window.electron=new Proxy(stubs,{get:(t,k)=>k in t?t[k]:autoStub()});
useAppStore.setState({sidebarCollapsed:false,sidebarWidth:280,showSettings:false});
useAppStore.getState().setTheme('light');
window.qa={store:useAppStore,status:patch=>useAppStore.setState({updateStatus:{...idle,available:true,version:'0.0.84',...patch}}),idle:()=>useAppStore.setState({updateStatus:idle})};
createRoot(document.getElementById('root')).render(<Tooltip.Provider><div style={{height:'100vh',display:'flex',background:'var(--bg-primary)',color:'var(--text-primary)'}}><Sidebar/><main style={{flex:1}}/></div></Tooltip.Provider>);
`;
const main=String.raw`
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({webPreferences:{backgroundThrottling:false},width:900,height:560,show:true});const errors=[];
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=s=>win.webContents.executeJavaScript(s,true),delay=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async s=>{for(let i=0;i<100;i++){if(await js(s))return;await delay(80)}throw Error('Timeout: '+s)};
 const shot=async name=>{await delay(250);fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage({x:0,y:380,width:120,height:180})).toPNG())};
 const rail='document.querySelector("nav[aria-label=\\"Sections\\"]")';
 const button=label=>rail+'.querySelector("[aria-label^=\\"'+label+'\\"]")';
 const above=async s=>js('(()=>{const a=('+s+').getBoundingClientRect(),b='+rail+'.querySelector("[aria-label^=\\"Profile menu\\"]").getBoundingClientRect();return a.bottom<=b.top&&Math.abs((a.left+a.width/2)-(b.left+b.width/2))<1})()');
 try{
  await win.loadURL(process.env.QA_URL);
  // The rail reads the current status on mount, before any broadcast.
  await until('!!'+button('Download and install Aegis 0.0.84'));
  assert.equal(await above(button('Download and install')),true,'the update button sits right above the avatar');
  await shot('available');
  await js(button('Download and install')+'.click()');await until('qaCalls.includes("download")');
  await js('qa.status({phase:"downloading",progress:42})');await until('!!'+button('Downloading Aegis 0.0.84'));
  assert.equal(await js(button('Downloading')+'.getAttribute("aria-valuenow")'),'42');
  await shot('downloading');
  // macOS: the zip is in, Squirrel.Mac is still verifying it.
  await js('qa.status({phase:"downloading",progress:100})');await until('!!'+button('Preparing Aegis 0.0.84'));
  await js('qa.status({phase:"downloaded"})');await until('!!'+button('Restart to update to Aegis 0.0.84'));
  await shot('downloaded');
  await js(button('Restart to update')+'.click()');await until('qaCalls.includes("install")');
  await js('qa.status({phase:"error",error:"net::ERR_CONNECTION_RESET"})');await until('!!'+button('Update failed'));
  await shot('error');
  await js(button('Update failed')+'.click()');await until('qaCalls.filter(c=>c==="download").length===2');
  await js('qa.idle()');await until('!'+rail+'.querySelector("[aria-label*=\\"Aegis 0.0.84\\"],[aria-label^=\\"Update failed\\"]")');
  await js('qa.store.getState().setTheme("dark");qa.status({phase:"available"})');await until('!!'+button('Download and install'));await shot('available-dark');
  assert.deepEqual(errors,[]);console.log('PASS: rail update button follows available, downloading, downloaded and error');app.exit(0);
 }catch(e){console.error(e,errors);await shot('failure');app.exit(1)}
});
`;
try{
 await mkdir(path.join(root,'output/sidebar-update-button'),{recursive:true});
 await writeFile(path.join(dir,'index.html'),'<html><body style="margin:0"><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
 await writeFile(path.join(dir,'probe.tsx'),harness);await writeFile(path.join(dir,'main.cjs'),main);
 // Own dep cache: sharing node_modules/.vite breaks a running dev server.
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),cacheDir:path.join(dir,'vite-cache'),server:{host:'127.0.0.1',port:0}});await server.listen();
 const env={...process.env,QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/sidebar-update-button')};delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});const timer=setTimeout(()=>{child.kill();reject(Error('timeout'))},60000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('exit '+code))})});
}finally{await server?.close();await rm(dir,{recursive:true,force:true})}
