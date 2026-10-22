// A glass window in native fullscreen has no desktop behind it, so both the
// window (main process) and the page (renderer) must paint solid there, from
// the moment fullscreen starts (Electron's 'enter-full-screen' only fires
// after the animation, which showed grey frames), and go back to glass on
// leaving fullscreen. Takes the screen fullscreen briefly.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
const root=process.cwd();
await mkdir(path.join(root,'.aegis-design-qa'),{recursive:true});
const tmp=await mkdtemp(path.join(root,'.aegis-design-qa/glass-fullscreen-'));
const harness=`
import {applyPreset,DEFAULT_APPEARANCE,renderAppearance,setWindowFullScreen} from '/src/ui/theme/themes';
import '/src/ui/index.css';
window.electron={...window.glassBridge,setTheme:async()=>({ok:true})};
renderAppearance({mode:'light',state:applyPreset(DEFAULT_APPEARANCE,'light','glass')});
window.electron.onWindowShellState(state=>setWindowFullScreen(state.fullScreen));
document.getElementById('root').textContent='glass fullscreen';
`;
const preload=String.raw`
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('glassBridge',{
 getWindowGlassSync:()=>ipcRenderer.sendSync('get-window-glass-sync'),
 onWindowShellState:fn=>{const listener=(_,s)=>fn(s);ipcRenderer.on('window-shell-state',listener);return()=>ipcRenderer.removeListener('window-shell-state',listener);},
});
`;
const main=String.raw`
const {app,BrowserWindow,ipcMain}=require('electron');
const assert=require('node:assert/strict'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const glass=require(path.join(process.cwd(),'dist-electron/electron/window-glass.js'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const SOLID='#FFFFFF';
// getBackgroundColor drops the alpha of a transparent window.
const seeThrough=color=>/^#000000(00)?$/.test(color);
app.whenReady().then(async()=>{
 if(!glass.glassSupported()){console.log(JSON.stringify({ok:true,skipped:'Liquid Glass unavailable'}));app.exit(0);return;}
 const options=glass.glassWindowOptions(true);
 assert.equal(options.transparent,true,'glass window opens transparent');
 const win=new BrowserWindow({width:900,height:600,show:true,...options,webPreferences:{backgroundThrottling:false,preload:path.join(__dirname,'preload.cjs')}});
 glass.registerGlassWindow(win,options);glass.setThemedMaterial('light','glass');glass.setThemedMaterial('dark','glass');
 ipcMain.on('get-window-glass-sync',e=>{e.returnValue={supported:true,active:glass.isGlassWindow(win)};});
 // The same wiring main.ts uses: material first, then tell the page.
 let solidAt=0;
 glass.watchFullScreen(win,()=>{glass.applyWindowMaterial(win,SOLID);const fullScreen=glass.isWindowFullScreen(win);if(fullScreen&&!solidAt)solidAt=Date.now();win.webContents.send('window-shell-state',{rounded:!fullScreen,fullScreen});});
 let enteredAt=0,pageSolidBeforeEnter=null;
 win.on('enter-full-screen',async()=>{enteredAt=Date.now();});
 const js=c=>win.webContents.executeJavaScript(c,true);
 const until=async(c,label)=>{for(let i=0;i<100;i++){if(await js(c))return;await delay(100);}throw Error('Timed out: '+label);};
 const event=name=>new Promise(r=>win.once(name,r));
 const material='document.documentElement.dataset.windowMaterial';
 try{
  await win.loadURL(process.env.QA_URL);await until('!!document.getElementById("root").textContent','harness');
  glass.applyWindowMaterial(win,SOLID);
  assert.equal(await js(material),'glass','windowed page is glass');
  assert(seeThrough(win.getBackgroundColor()),'windowed window is see-through');
  const entered=event('enter-full-screen');const startedAt=Date.now();win.setFullScreen(true);
  // The page must already be solid while AppKit animates into the Space.
  await until(material+'==="solid"','page paints solid as fullscreen starts');
  pageSolidBeforeEnter=!enteredAt;
  await entered;
  assert(solidAt>0,'the window turned solid');
  assert(solidAt<enteredAt,'the window turned solid before enter-full-screen ('+(solidAt-startedAt)+'ms vs '+(enteredAt-startedAt)+'ms)');
  assert.equal(pageSolidBeforeEnter,true,'the page turned solid before enter-full-screen');
  assert.equal(win.getBackgroundColor(),SOLID,'fullscreen window paints solid');
  console.log('timing: solid after '+(solidAt-startedAt)+'ms, enter-full-screen after '+(enteredAt-startedAt)+'ms');
  // A finished entry stays solid past the entry watchdog.
  await delay(2300);
  assert.equal(glass.isWindowFullScreen(win),true,'the entry watchdog leaves a finished entry alone');
  assert.equal(win.getBackgroundColor(),SOLID,'still solid after the watchdog window');
  const left=event('leave-full-screen');win.setFullScreen(false);await left;
  await until(material+'==="glass"','page returns to glass');
  assert(seeThrough(win.getBackgroundColor()),'window returns to glass');
  // Back-to-back round trips end where they started.
  for(let round=0;round<2;round++){
   const inAgain=event('enter-full-screen');win.setFullScreen(true);await inAgain;
   assert.equal(win.getBackgroundColor(),SOLID,'round '+round+': solid in fullscreen');
   const outAgain=event('leave-full-screen');win.setFullScreen(false);await outAgain;
   assert(seeThrough(win.getBackgroundColor()),'round '+round+': glass after leaving');
  }
  await until(material+'==="glass"','page ends on glass');
  // A watch callback that closes its own window must not touch the freed watch
  // (run with MallocScribble so a use-after-free crashes instead of passing).
  const addon=require(path.join(process.cwd(),'dist-electron/native/liquid-glass.node'));
  const doomed=new BrowserWindow({width:400,height:300,show:true,...options});
  let calls=0;
  assert.equal(addon.watchFullScreen(doomed.getNativeWindowHandle(),()=>{calls++;doomed.destroy();}),true,'watch installed');
  doomed.setFullScreen(true);
  for(let i=0;i<40&&!doomed.isDestroyed();i++)await delay(50);
  assert.equal(calls,1,'the watch fired once');
  assert.equal(doomed.isDestroyed(),true,'the callback closed its window');
  await delay(500);
  assert.equal(await js('1+1'),2,'the app keeps running after the watched window closed mid-callback');
  console.log(JSON.stringify({ok:true}));app.exit(0);
 }catch(error){console.error(error);if(win.isFullScreen())win.setFullScreen(false);await delay(800);app.exit(1);}
});
`;
let server;
try{
 await writeFile(path.join(tmp,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.ts"></script></body></html>');
 await writeFile(path.join(tmp,'harness.ts'),harness);await writeFile(path.join(tmp,'preload.cjs'),preload);await writeFile(path.join(tmp,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),cacheDir:path.join(tmp,'.vite'),server:{host:'127.0.0.1',port:0,strictPort:false,watch:{ignored:['**/.aegis-design-qa/**']}}});await server.listen();
 const url=new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href;
 await new Promise((resolve,reject)=>{
  const env={...process.env,QA_URL:url,MallocScribble:'1'};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});let out='';
  child.stdout.on('data',c=>{out+=c;process.stdout.write(c);});child.stderr.on('data',c=>process.stderr.write(c));
  const timeout=setTimeout(()=>{child.kill();reject(Error('Glass fullscreen Electron test timed out'));},90000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0&&out.includes('"ok":true')?resolve():reject(Error('Glass fullscreen Electron test failed'));});
 });
}finally{await server?.close();await rm(tmp,{recursive:true,force:true});}
