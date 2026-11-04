// The title bar's New tab button: hovering shows the menu without taking focus
// from the composer, a click opens the tab directly, and the keyboard reaches
// the menu without a pointer.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'vite';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const tmp = await mkdtemp(path.join(root, '.aegis-design-qa/new-tab-menu-'));
const profile = await mkdtemp(path.join(os.tmpdir(), 'aegis-new-tab-menu-'));
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {NewTabMenuButton} from '/src/ui/components/NewTabMenuButton';
import '/src/ui/index.css';
window.electron={getAppPreferences:async()=>({}),onAppPreferencesChanged:()=>()=>{}};
window.qa={opened:[]};
createRoot(document.getElementById('root')).render(<div style={{display:'flex',justifyContent:'flex-end',padding:8}}>
 <textarea id="composer" style={{marginRight:'auto'}}/>
 <NewTabMenuButton onNewTab={mode=>qa.opened.push(mode)}/>
</div>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.setPath('userData',process.env.QA_PROFILE);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:true,width:900,height:500,webPreferences:{backgroundThrottling:false}});
 const wc=win.webContents,js=s=>wc.executeJavaScript(s,true),delay=ms=>new Promise(r=>setTimeout(r,ms));
 const errors=[];wc.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
 const move=async(x,y)=>{wc.sendInputEvent({type:'mouseMove',x:x-2,y:y-2});await delay(30);wc.sendInputEvent({type:'mouseMove',x,y});await delay(80);};
 const click=async(x,y)=>{await move(x,y);wc.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});await delay(30);wc.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});await delay(80);};
 const key=async code=>{wc.sendInputEvent({type:'keyDown',keyCode:code});await delay(20);wc.sendInputEvent({type:'keyUp',keyCode:code});await delay(80);};
 const center=sel=>js('(()=>{const r=document.querySelector('+JSON.stringify(sel)+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
 const menu=()=>js('!!document.querySelector("[role=menu]")');
 const focused=()=>js('document.activeElement.id||document.activeElement.getAttribute("role")||document.activeElement.tagName');
 const opened=()=>js('qa.opened.splice(0)');
 try{
  await win.loadURL(process.env.QA_URL);
  for(let i=0;i<150;i++){if(await js('!!document.querySelector("[data-new-tab-button]")'))break;await delay(40);}
  await wc.capturePage();
  await js('document.getElementById("composer").focus()');
  const button=await center('[data-new-tab-button]');

  await move(button.x,button.y);
  assert.equal(await menu(),true,'hovering the button shows the menu');
  assert.equal(await focused(),'composer','hovering leaves focus in the composer');
  const item=await center('[role=menuitem]:nth-child(2)');
  await move(button.x,button.y+24);await move(item.x,item.y);
  assert.equal(await menu(),true,'the menu survives the trip from the button to an item');
  assert.equal(await focused(),'composer');
  await move(100,400);await delay(200);
  assert.equal(await menu(),false,'leaving closes it');
  assert.equal(await focused(),'composer');

  await click(button.x,button.y);
  assert.deepEqual(await opened(),['split'],'a click opens a New tab directly');
  assert.equal(await focused(),'composer','and leaves focus in the composer');
  assert.equal(await menu(),false,'without leaving the menu up');

  await move(100,400);await delay(200);await move(button.x,button.y);
  const fullView=await center('[role=menuitem]:nth-child(2)');
  await click(fullView.x,fullView.y);
  assert.deepEqual(await opened(),['full'],'the second item opens in full view');
  assert.equal(await menu(),false);
  await move(100,400);await delay(200);

  await js('document.querySelector("[data-new-tab-button]").focus()');
  await key('Down');
  assert.equal(await menu(),true,'ArrowDown opens the menu');
  assert.equal(await js('document.activeElement.innerText.startsWith("New tab\\n")||document.activeElement.innerText==="New tab"'),true,'on its first item');
  await key('Down');
  assert.match(await js('document.activeElement.innerText'),/full view/);
  await key('Escape');
  assert.equal(await menu(),false,'Escape closes it');
  assert.equal(await js('document.activeElement.hasAttribute("data-new-tab-button")'),true,'and returns to the button');

  assert.deepEqual(errors,[]);
  console.log('new tab menu Electron: hover without focus change, direct click, full view and keyboard passed');
  app.exit(0);
 }catch(e){console.error(e);app.exit(1);}
});
`;
let server;
try {
 await writeFile(path.join(tmp, 'index.html'), '<html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
 await writeFile(path.join(tmp, 'harness.tsx'), harness);
 await writeFile(path.join(tmp, 'main.cjs'), main);
 // Own dep cache: sharing node_modules/.vite breaks a running dev server.
 server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(tmp, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: { ignored: ['**/.aegis-design-qa/**'] } } });
 await server.listen();
 const env = { ...process.env, QA_PROFILE: profile, QA_URL: new URL(path.relative(root, tmp) + '/index.html', server.resolvedUrls.local[0]).href };
 delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve, reject) => {
  const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(tmp, 'main.cjs')], { env, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); reject(Error('New tab menu QA timed out')); }, 90000);
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('New tab menu QA failed: ' + code)); });
 });
} finally { await server?.close(); await rm(tmp, { recursive: true, force: true }); await rm(profile, { recursive: true, force: true }); }
