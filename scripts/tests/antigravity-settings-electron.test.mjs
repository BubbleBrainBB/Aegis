import {createServer} from 'vite';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';

// Antigravity on the real Agents grid (Settings) and in the composer's mode
// picker: what the cell offers when agy is missing, signed out and ready; the
// setup panel (install command, agy's own sign-in command, the executable
// override, what agy offers over ACP, the usage notes); and that the mode
// picker lists exactly the modes agy reported, under agy's own names.
// QA_CAPTURE=<dir> saves a screenshot of each state.
const root=process.cwd();
await mkdir('.aegis-design-qa',{recursive:true});
const dir=await mkdtemp(path.join(root,'.aegis-design-qa/antigravity-settings-'));
let server;
const harness=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {AgentRuntimeSettings} from '/src/ui/components/settings/AgentRuntimeSettings';
import {PermissionModePicker} from '/src/ui/components/PermissionModePicker';
import {buildAntigravityPermissionModeOptions,resolveAntigravityPermissionMode} from '/src/ui/utils/antigravity-permission';
import {ANTIGRAVITY_USAGE_NOTES} from '/src/shared/human-driven-providers';
import '/src/ui/index.css';
import '/src/ui/components/settings/provider-settings.css';
const emptyResult=()=>{const done=()=>{};const result=Promise.resolve([]);for(const key of ['then','catch','finally'])done[key]=result[key].bind(result);return done};
const autoStub=()=>new Proxy(function(){},{get:(_,k)=>k==='then'?undefined:autoStub(),apply:emptyResult});
const AGY='/Users/qa/.local/bin/agy';
const INSTALL='curl -fsSL https://antigravity.google/cli/install.sh | bash';
const base={installCommand:INSTALL,docsUrl:'https://antigravity.google/docs/cli',checkedAt:1};
const STATES={
 missing:{...base,ready:false,cliAvailable:false,cliPath:null,cliVersion:null,acpAvailable:false,authState:'unknown',loginCommand:'agy acp --login',cliPathOverride:null,summary:'Antigravity CLI (agy) was not found.',detail:'Install it with \`'+INSTALL+'\`, or set the path of the agy executable.'},
 signedOut:{...base,ready:false,cliAvailable:true,cliPath:AGY,cliVersion:'1.5.14',acpAvailable:true,authState:'login_required',loginCommand:AGY+' acp --login',cliPathOverride:null,summary:'Antigravity needs sign-in.',detail:'Run '+AGY+' acp --login in a terminal to sign in with Google. agy keeps the credentials; Aegis never sees them.'},
 ready:{...base,ready:true,cliAvailable:true,cliPath:AGY,cliVersion:'1.5.14',acpAvailable:true,authState:'ready',loginCommand:AGY+' acp --login',cliPathOverride:null,summary:'Antigravity ACP is ready.',detail:'Aegis can start Antigravity sessions through \`agy acp\`.'},
};
const CATALOG={defaultModel:'gemini-4-neon',options:['gemini-4-neon','gemini-3.8-flash'],availableModels:[{id:'gemini-4-neon',label:'Gemini 4 Neon'},{id:'gemini-3.8-flash',label:'Gemini 3.8 Flash'}],
 modes:[{id:'default',label:'Default',description:'Ask before edits and commands, per your permission settings.'},{id:'accept-edits',label:'Accept edits',description:'Approve file edits in the workspace without asking.'},{id:'auto',label:'Auto',description:'Approve edits and safe commands; ask before irreversible actions.'},{id:'plan',label:'Plan',description:'Plan carefully before executing a task.'}],
 defaultMode:'default',authMethods:[{id:'oauth-personal',label:'Log in with Google'},{id:'gemini-api-key',label:'Gemini API key'}],imagePrompts:true,agentVersion:'1.5.14'};
const qa=window.qa={state:'missing',override:null,calls:[],opened:[],notes:ANTIGRAVITY_USAGE_NOTES,
 status(){return {...STATES[qa.state],...(qa.override?{cliPathOverride:qa.override,cliPath:qa.override}:{})}},
 modeOptions:catalog=>buildAntigravityPermissionModeOptions(catalog),
 resolveMode:(preferred,catalog)=>resolveAntigravityPermissionMode(preferred,catalog)};
const entry=()=>{const s=qa.status();return {provider:'antigravity',title:'Antigravity',state:s.ready?'ready':s.authState==='login_required'?'login_required':s.cliAvailable?'error':'not_installed',version:s.cliVersion,summary:s.summary,detail:s.detail,installCommand:null,canAutoInstall:false,loginCommand:s.cliAvailable?s.loginCommand:null,docsUrl:s.docsUrl,checkedAt:Date.now()}};
const stubs={
 getAgentRuntimeDirectory:async force=>{qa.calls.push('directory:'+Boolean(force));return {checkedAt:Date.now(),readyCount:1,entries:[{provider:'claude',title:'Claude Code',state:'ready',version:'2.1.0',summary:'Claude Code is ready.',detail:null,installCommand:null,canAutoInstall:true,loginCommand:null,docsUrl:null,checkedAt:Date.now()},entry()]}},
 getAntigravityRuntimeStatus:async refresh=>{qa.calls.push('status:'+Boolean(refresh));return qa.status()},
 getAntigravityModelConfig:async()=>{qa.calls.push('catalog');return CATALOG},
 setAntigravityCliPath:async value=>{qa.calls.push('path:'+value);if(value&&!value.startsWith('/opt/'))return {ok:false,message:'No file exists at this path.'};qa.override=value||null;return {ok:true,status:qa.status()}},
 openExternalUrl:async url=>{qa.opened.push(url)},
};
window.electron=new Proxy(stubs,{get:(t,k)=>k in t?t[k]:autoStub()});
function Modes({catalog,name}){const [mode,setMode]=React.useState('default');return <div data-qa={name}><PermissionModePicker value={mode} options={buildAntigravityPermissionModeOptions(catalog)} onChange={setMode} menuSide="bottom"/></div>}
function App(){const [round,setRound]=React.useState(0);qa.remount=()=>setRound(n=>n+1);
 return <Tooltip.Provider><div style={{minHeight:'100vh',padding:24,background:'var(--bg-primary)',color:'var(--text-primary)'}}>
  <div style={{display:'flex',gap:24,marginBottom:20}}><Modes name="modes-agy" catalog={CATALOG}/><Modes name="modes-unknown" catalog={null}/></div>
  <div className="providers-settings" style={{maxWidth:720}}><AgentRuntimeSettings key={round}/></div>
 </div></Tooltip.Provider>}
createRoot(document.getElementById('root')).render(<App/>);
`;
const main=String.raw`
const {app,BrowserWindow}=require('electron');
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({webPreferences:{backgroundThrottling:false},width:900,height:900,show:true});const errors=[];
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=s=>win.webContents.executeJavaScript(s,true),delay=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(s,label)=>{for(let i=0;i<120;i++){if(await js(s))return;await delay(60)}throw Error('Timeout: '+(label||s)+'\n'+await js('document.body.innerText'))};
 const shot=async name=>{if(!process.env.QA_CAPTURE)return;await delay(250);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 const click=async selector=>{win.focus();win.webContents.focus();const box=await js('(()=>{const e='+selector+';e.scrollIntoView({block:"nearest"});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');win.webContents.sendInputEvent({type:'mouseMove',...box});win.webContents.sendInputEvent({type:'mouseDown',...box,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...box,button:'left',clickCount:1});await delay(120)};
 const type=async text=>{for(const ch of text){win.webContents.sendInputEvent({type:'char',keyCode:ch});}await delay(80)};
 const CELL='document.querySelector("[data-settings-id=\\"Agents:Antigravity\\"]")';
 const PANEL='document.querySelector("[data-testid=antigravity-settings-panel]")';
 const text=sel=>js('('+sel+')?.innerText||""');
 const state=async name=>{await js('qa.state='+JSON.stringify(name)+';qa.override=null;qa.calls=[];qa.remount()');await until('!!'+CELL,'the Antigravity cell');await delay(120)};
 try{
  await win.loadURL(process.env.QA_URL);

  // agy is not installed: the cell offers setup, the panel says how.
  await state('missing');
  assert.equal(await text(CELL+'.querySelector(".agent-cell-action")'),'Set up');
  assert.ok(await js(CELL+'.classList.contains("is-attention")'));
  await click(CELL+'.querySelector("button")');
  await until('!!'+PANEL,'the setup panel');
  let panel=await text(PANEL);
  assert.ok(panel.includes('Antigravity CLI (agy) was not found.'));
  assert.ok(panel.includes('curl -fsSL https://antigravity.google/cli/install.sh | bash'),'the official install command');
  assert.ok(!panel.includes('Sign in'),'no sign-in step before agy exists');
  assert.ok(!await js('!!document.querySelector("[data-testid=antigravity-offers]")'),'nothing is listed that agy did not report');
  await click('[...'+PANEL+'.querySelectorAll("button")].find(b=>b.textContent.includes("Antigravity CLI guide"))');
  assert.deepEqual(await js('qa.opened'),['https://antigravity.google/docs/cli']);
  // The usage notes are always there, word for word from the policy module.
  const notes=await js('[...document.querySelectorAll("[data-testid=antigravity-usage-notes] li")].map(e=>e.innerText)');
  assert.equal(notes.length,await js('qa.notes.length'));
  assert.deepEqual(notes,(await js('qa.notes')).map(n=>n.replaceAll(String.fromCharCode(96),'')),'the notes shown are the policy notes');
  assert.ok(notes[0].includes('unmodified agy acp')&&notes[0].includes('You type every message'));
  assert.ok(notes.some(n=>n.includes('Workflows, automations')&&n.includes('cannot send')));
  assert.ok(notes.some(n=>n.includes('never reads, copies or stores')));
  assert.ok(notes.some(n=>n.includes('no transcripts')));
  assert.ok(notes.some(n=>n.includes('Gemini API key or Vertex AI')));
  assert.ok(await js('document.querySelectorAll("[data-testid=antigravity-usage-notes] code").length>=2'),'commands are set as code');
  await shot('missing');

  // Installed but signed out: agy's own sign-in command, to run in a terminal.
  await state('signedOut');
  assert.equal(await text(CELL+'.querySelector(".agent-cell-action")'),'Sign in');
  await click(CELL+'.querySelector("button")');
  await until('!!'+PANEL);
  panel=await text(PANEL);
  assert.ok(panel.includes('Antigravity needs sign-in.')&&panel.includes('agy 1.5.14'));
  assert.ok(await js('[...'+PANEL+'.querySelectorAll(".agent-command code")].some(c=>c.textContent==="/Users/qa/.local/bin/agy acp --login")'),'the sign-in command');
  assert.ok(panel.includes('keeps the credentials itself'));
  assert.ok(!panel.includes('install.sh'),'no install step once agy is found');
  assert.ok(!await js('!!document.querySelector("[data-testid=antigravity-offers]")'),'the catalog is not read while signed out');
  assert.ok(!(await js('qa.calls')).includes('catalog'));
  await shot('signed-out');
  // "Check again" asks for a fresh answer and tells the grid.
  await js('qa.state="ready";qa.calls=[]');
  await click('[...'+PANEL+'.querySelectorAll("button")].find(b=>b.textContent.includes("Check again"))');
  await until('('+PANEL+')?.innerText.includes("Antigravity ACP is ready.")','the refreshed status');
  assert.ok((await js('qa.calls')).includes('status:true'),'a fresh check, not the cached one');
  await until('('+CELL+'.querySelector(".agent-cell-action")).innerText==="Ready"','the grid following');

  // Ready: the cell opens the same panel; it lists what agy reported.
  await state('ready');
  assert.equal(await text(CELL+'.querySelector(".agent-cell-action")'),'Ready');
  assert.ok(!await js('!!'+PANEL));
  await click(CELL+'.querySelector(".agent-cell-name")');
  await until('!!document.querySelector("[data-testid=antigravity-offers]")','what agy offers');
  const offers=await text('document.querySelector("[data-testid=antigravity-offers]")');
  assert.ok(offers.includes('Gemini 4 Neon, Gemini 3.8 Flash'));
  assert.ok(offers.includes('Default, Accept edits, Auto, Plan'));
  assert.ok(offers.includes('Log in with Google, Gemini API key'));
  panel=await text(PANEL);
  assert.ok(panel.includes('Detected at /Users/qa/.local/bin/agy'));
  assert.ok(!panel.includes('acp --login')||!panel.includes('Run this in your terminal'),'no sign-in step when signed in');
  await shot('ready');

  // The executable override: a bad path is reported and not saved.
  const INPUT='document.querySelector("#antigravity-cli-path")';
  const SAVE='[...'+PANEL+'.querySelectorAll("button")].find(b=>b.textContent==="Save")';
  assert.ok(await js(SAVE+'.disabled'),'nothing to save yet');
  await click(INPUT);await type('/nope/agy');
  await click(SAVE);
  await until('!!document.querySelector(".antigravity-panel [role=alert]")','the path error');
  assert.equal(await text('document.querySelector(".antigravity-panel [role=alert]")'),'No file exists at this path.');
  assert.equal(await js('qa.override'),null);
  // A good one is saved, shown as the file Aegis runs, and can be cleared.
  await js('(()=>{const e='+INPUT+';const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;set.call(e,"");e.dispatchEvent(new Event("input",{bubbles:true}))})()');
  await click(INPUT);await type('/opt/google/agy');
  await click(SAVE);
  await until('qa.override==="/opt/google/agy"','the saved override');
  await until('('+PANEL+').innerText.includes("Aegis runs this file as is, with acp.")');
  assert.ok(!await js('!!document.querySelector(".antigravity-panel [role=alert]")'));
  await shot('override');
  await click('[...'+PANEL+'.querySelectorAll("button")].find(b=>b.textContent==="Detect")');
  await until('qa.override===null','the override cleared');
  assert.equal(await js(INPUT+'.value'),'');

  // The composer's mode picker: exactly agy's modes, with agy's own words.
  assert.deepEqual(await js('qa.modeOptions({modes:[]})'),[{mode:'default',label:'Default',description:'Antigravity asks before edits and commands'}],'before agy has answered: the one mode every session starts in');
  assert.equal(await js('qa.resolveMode("bypassPermissions",{modes:[{id:"default",label:"Default"},{id:"plan",label:"Plan"}],defaultMode:"default"})'),'default','a saved mode agy no longer offers falls back to its own');
  assert.equal(await js('qa.resolveMode("plan",{modes:[{id:"default",label:"Default"},{id:"plan",label:"Plan"}],defaultMode:"default"})'),'plan');
  await js('window.scrollTo(0,0)');
  await click('document.querySelector("[data-qa=modes-agy] button")');
  await until('document.querySelectorAll("[role=menuitemradio],[role=menuitem],[role=option]").length>=4','the mode menu');
  const menu=await js('[...document.querySelectorAll("[role=menuitemradio],[role=menuitem],[role=option]")].map(e=>e.innerText.replace(/\\s+/g," ").trim())');
  assert.equal(menu.length,4,'no mode of Aegis\'s own, such as Full Access: '+JSON.stringify(menu));
  for(const [i,name] of ['Default','Accept edits','Auto','Plan'].entries())assert.ok(menu[i].startsWith(name),menu[i]);
  assert.ok(menu[1].includes('Approve file edits in the workspace without asking.'));
  await shot('modes');
  await click('[...document.querySelectorAll("[role=menuitemradio],[role=menuitem],[role=option]")].find(e=>e.innerText.includes("Accept edits"))');
  await until('document.querySelector("[data-qa=modes-agy] button").innerText.includes("Accept edits")','the picked mode');

  assert.deepEqual(errors,[]);console.log('PASS: Antigravity settings and mode picker');app.exit(0);
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
