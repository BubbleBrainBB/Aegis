import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

// Settings > Usage with "All agents" picked: every agent's reports added
// together. The reports are fixtures; the store-side numbers are covered by
// verify:codex-usage-cost and the adding-up by usage-overview-model.test.ts.
const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const temp = await mkdtemp(path.join(root, '.aegis-design-qa/usage-overview-'));
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import '/src/ui/index.css';
// Calendar days, not 24-hour steps: a step lands on the wrong day late in the evening after a clock change.
const dateKey=ago=>{const d=new Date();d.setHours(12,0,0,0);d.setDate(d.getDate()-ago);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
// Deterministic "activity": a different rhythm per agent, some days idle.
const wave=(seed,ago)=>{const v=Math.sin((ago+1)*(seed+1)*12.9898)*43758.5453;const f=v-Math.floor(v);return f<.18?0:.3+f};
const AGENTS={
 claude:{yearCost:9000,costMode:'estimated',models:[['claude-opus-5-5',.8],['claude-fable-5-2',.2]],tokensPerUsd:3.2e6,split:[.01,.56,.24,.19]},
 codex:{yearCost:2400,costMode:'estimated',costBasis:'api-standard',models:[['gpt-5.6-sol',1]],tokensPerUsd:4.5e6,split:[.05,.45,0,.5]},
 kimi:{yearCost:600,costMode:'estimated',models:[['K2.7 Coding',1]],tokensPerUsd:6.5e6,split:[.1,.4,0,.5]},
 bubble:{yearCost:280,costMode:'actual',models:[['zai/glm-5.3',.7],['in-house-model',.3]],tokensPerUsd:5e6,split:[.2,.2,0,.3],unsplit:.3},
 deepseek:{yearCost:120,costMode:'estimated',models:[['deepseek-v4-pro',1]],tokensPerUsd:7.7e6,split:[.3,.1,0,.6]},
 opencode:{yearCost:55,costMode:'actual',models:[['big-pickle',1]],tokensPerUsd:2e6,split:[.4,.1,0,.5]},
 devin:{yearCost:0,costMode:'unavailable',models:[['swe-2-high',1]],tokens:4.1e6,billing:{agentMessages:312,credits:0}},
 qoder:{yearCost:0,costMode:'unavailable',models:[['Auto',1]],tokens:0,billing:{agentMessages:0,credits:12.4}},
};
const PROVIDERS=['claude','codex','opencode','kimi','grok','pi','qoder','bubble','deepseek','devin','mimo','minimax'];
function report(provider,days){
 const agent=AGENTS[provider];
 const daily=[];for(let ago=days-1;ago>=0;ago--)daily.push({date:dateKey(ago),totalTokens:0,byModel:{},byModelCostUsd:{}});
 const totals={inputTokens:0,outputTokens:0,totalTokens:0,totalCostUsd:0,sessionCount:0,cacheReadTokens:0,cacheHitRate:0};
 if(!agent)return {rangeDays:days,costMode:'actual',totals,models:[],daily,costByType:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,inputCostUsd:0,cacheReadCostUsd:0,cacheWriteCostUsd:0,outputCostUsd:0,unsplitCostUsd:0}};
 const seed=PROVIDERS.indexOf(provider);
 let yearWeight=0;for(let ago=0;ago<365;ago++)yearWeight+=wave(seed,ago);
 const models=agent.models.map(([model])=>({model,inputTokens:0,outputTokens:0,totalTokens:0,totalCostUsd:0,sessionCount:0,cacheReadTokens:0}));
 let cost=0,tokens=0,activeDays=0;
 daily.forEach((day,index)=>{
  const ago=days-1-index,share=wave(seed,ago)/yearWeight;if(!share)return;activeDays++;
  agent.models.forEach(([model,part],m)=>{
   const usd=agent.yearCost*share*part,count=Math.round((agent.tokens??agent.yearCost*agent.tokensPerUsd)*share*part);
   if(count)day.byModel[model]=count;if(usd)day.byModelCostUsd[model]=usd;day.totalTokens+=count;
   models[m].totalTokens+=count;models[m].inputTokens+=Math.round(count*.4);models[m].outputTokens+=Math.round(count*.6);models[m].cacheReadTokens+=count*6;models[m].totalCostUsd+=usd;
   cost+=usd;tokens+=count;
  });
 });
 models.forEach((model,m)=>{model.sessionCount=Math.max(1,Math.round(activeDays*(m?.4:1.6)))});
 Object.assign(totals,{inputTokens:Math.round(tokens*.4),outputTokens:Math.round(tokens*.6),totalTokens:tokens,totalCostUsd:cost,sessionCount:models.reduce((s,m)=>s+m.sessionCount,0),cacheReadTokens:tokens*6,cacheHitRate:.94});
 const result={rangeDays:days,costMode:agent.costMode,...(agent.costBasis?{costBasis:agent.costBasis}:{}),totals,models,daily};
 if(agent.billing){
  // Billed counts scale with the range like everything else; the year carries the full amounts.
  const part=activeDays/daily.length||0, yearPart=days===365?1:Math.min(1,days/365*1.4);
  result.billing={agentMessages:Math.round(agent.billing.agentMessages*yearPart),credits:Math.round(agent.billing.credits*yearPart*100)/100};
  if(provider==='qoder'){models[0].credits=result.billing.credits;daily[daily.length-1].byModelCredits={Auto:result.billing.credits};totals.sessionCount=3;models[0].sessionCount=3}
  else models[0].agentMessages=result.billing.agentMessages;
 }
 if(agent.split){
  const [input,read,write,output]=agent.split,unsplit=agent.unsplit||0;
  result.costByType={inputTokens:Math.round(tokens*.4),cacheReadTokens:tokens*6,cacheWriteTokens:Math.round(tokens*write*2),outputTokens:Math.round(tokens*.6),
   inputCostUsd:cost*input,cacheReadCostUsd:cost*read,cacheWriteCostUsd:cost*write,outputCostUsd:cost*output,unsplitCostUsd:cost*unsplit};
 }
 return result;
}
const calls=[];let held=null,fail=false;
window.electron={
 getKimiModelConfig:async()=>({availableModels:[],options:[]}),
 getAgentUsageReport:async(provider,days)=>{calls.push(provider+':'+days);if(held&&held.match(provider,days))await new Promise(resolve=>held.release.push(resolve));if(fail)throw Error('Offline');return report(provider,days)},
 getCodexRateLimits:async()=>null,getClaudePlanUsage:async()=>{throw Error('No subscription')},getGrokPlanUsage:async()=>{throw Error('No subscription')},getQoderPlanUsage:async()=>null,
};
const {useAppStore}=await import('/src/ui/store/useAppStore');
const {ClaudeUsageSettingsContent}=await import('/src/ui/components/settings/ClaudeUsageSettings');
useAppStore.getState().setTheme('light');
const sum=(days,pick)=>PROVIDERS.reduce((total,provider)=>total+pick(report(provider,days),provider),0);
// An agent counts in dollars when its usage has a cost; one billed in its own unit only has none.
const dollars=(r)=>r.totals.totalCostUsd;
window.qa={store:useAppStore,calls,
 expected:days=>({cost:sum(days,dollars),tokens:sum(days,r=>r.totals.totalTokens),sessions:sum(days,r=>r.totals.sessionCount),
  agentCost:provider=>dollars(report(provider,days)),
  day:date=>{const spent=PROVIDERS.flatMap(provider=>{const r=report(provider,days);const usd=Object.values(r.daily.find(d=>d.date===date)?.byModelCostUsd||{}).reduce((a,b)=>a+b,0);return usd>0?[[provider,usd]]:[]}).sort((a,b)=>b[1]-a[1]);return {total:spent.reduce((s,[,usd])=>s+usd,0),agents:spent.map(([provider])=>provider)}}}),
 // Devin as it is once its tokens have API prices: still billed in messages, and with an estimate in dollars.
 // A recent day Devin spent on.
 devinDay:days=>report('devin',days).daily.filter(d=>Object.keys(d.byModelCostUsd).length).at(-1).date,
 priceDevin:()=>{AGENTS.devin={yearCost:900,costMode:'estimated',models:[['claude-opus-5-5-high',1]],tokensPerUsd:3e6,split:[.1,.3,.4,.2],billing:{agentMessages:312,credits:0}}},
 hold:(provider,days)=>{held={match:(p,d)=>(!provider||p===provider)&&(!days||d===days),release:[]}},
 release:()=>{const pending=held.release;held=null;pending.forEach(resolve=>resolve())},
 frames:[],watch:()=>{window.qa.frames=[];window.qa.observer=new MutationObserver(()=>window.qa.frames.push(document.getElementById('root').innerText));window.qa.observer.observe(document.getElementById('root'),{subtree:true,childList:true,characterData:true})},
 dark:()=>useAppStore.getState().setTheme('dark'),light:()=>useAppStore.getState().setTheme('light'),
 mount:()=>createRoot(document.getElementById('root')).render(<main style={{maxWidth:1000,margin:'0 auto',padding:'44px 32px 0'}}><h1 style={{margin:'0 0 16px',fontSize:22,fontWeight:600}}>Usage</h1><ClaudeUsageSettingsContent/></main>),
};
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
// CI runners have Reduce Motion on; tests expect the default motion preference.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(process.env.QA_TEMP,'profile'));
app.whenReady().then(async()=>{
 try{
  const win=new BrowserWindow({width:1120,height:1240,show:true,webPreferences:{backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
  const js=code=>win.webContents.executeJavaScript(code,true).catch(error=>{console.error('Failed script:',code);throw error});
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await wait(50);}throw Error('Timed out: '+code)};
  const shot=async name=>{await wait(200);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG())};
  const text=selector=>js('document.querySelector('+JSON.stringify(selector)+')?.innerText.split(/\\s+/).join(" ").trim()');
  const money=(value,estimated)=>(estimated?'≈':'')+value.toLocaleString('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2});
  const compact=value=>{const trim=v=>v.endsWith('.0')?v.slice(0,-2):v;return value>=1e9?trim((value/1e9).toFixed(1))+'B':value>=1e6?trim((value/1e6).toFixed(1))+'M':value>=1e3?trim((value/1e3).toFixed(1))+'K':String(value)};
  const range=async label=>{await js('[...document.querySelectorAll("[data-usage-range] button")].find(b=>b.innerText.trim()==='+JSON.stringify(label)+').click()')};
  const hover=async selector=>{const r=await js('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
   win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(r.x),y:Math.round(r.y)-2});win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(r.x),y:Math.round(r.y)});await wait(120)};
  // A year's points sit about a pixel apart, so the plot is hovered by position and the tip says which day it is.
  // Everything about the tip is read in one go: the window is on screen, and a real pointer passing over it
  // can move the hover between two reads. A hover that was knocked off is tried again.
  const TIP=['(()=>{const tip=document.querySelector("[data-usage-cost-tip]");if(!tip)return null;',
   'const rows=[...tip.querySelectorAll("[data-usage-cost-tip-row]")],t=tip.getBoundingClientRect(),card=document.querySelector("[data-usage-daily-cost]").getBoundingClientRect(),dot=document.querySelector("[data-usage-cost-dot]").getBoundingClientRect();',
   'return {day:tip.dataset.usageCostTip,text:tip.innerText.split(/\\s+/).join(" ").trim(),rows:rows.map(row=>row.dataset.usageCostTipRow),',
   'logos:rows.every(row=>row.firstElementChild.tagName==="IMG"&&Math.round(row.firstElementChild.getBoundingClientRect().width)===14),',
   'dotsInTip:[...tip.querySelectorAll("span")].some(el=>el.classList.contains("rounded-full")),namesFit:rows.every(row=>[...row.querySelectorAll("span")].every(el=>el.scrollWidth<=el.clientWidth)),',
   'dots:document.querySelectorAll("[data-usage-cost-dot]").length,inside:t.left>=card.left&&t.right<=card.right,leftOfPoint:t.right<=dot.left,rightOfPoint:t.left>=dot.right}})()'].join('');
  const hoverTip=async(at)=>{
   for(let attempt=0;attempt<8;attempt++){
    const r=await js(typeof at==='number'
     ?'(()=>{const r=document.querySelector("[data-usage-cost-point]").parentElement.getBoundingClientRect();return {x:r.x+r.width*'+at+',y:r.y+r.height/2}})()'
     :'(()=>{const r=document.querySelector('+JSON.stringify(at)+').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(r.x),y:Math.round(r.y)-2});win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(r.x),y:Math.round(r.y)});await wait(120);
    const tip=await js(TIP);if(tip)return tip;
   }
   throw Error('No tip after hovering '+at);};
  const tipMatchesDay=async(days,tip)=>{
   const day=await js('qa.expected('+days+').day('+JSON.stringify(tip.day)+')');
   const label=new Date(tip.day+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});
   assert(tip.text.startsWith(label+' '+money(day.total,true)),'the tip names its day and that day\'s total: '+tip.text);
   assert.deepEqual(tip.rows,day.agents,'the agents that spent that day, most expensive first');
   assert.equal(tip.text.includes('Devin'),day.agents.includes('devin'),'an agent is in the tip when it spent dollars that day');assert(!tip.text.includes('Qoder'));};
  const agents=()=>js('[...document.querySelectorAll("[data-usage-agent]")].map(row=>row.dataset.usageAgent)');
  await win.loadURL(process.env.QA_URL);await until('!!window.qa');

  // "All agents" is the page Usage opens on. Agents answer one by one; nothing is drawn until all have.
  assert.equal(await js('qa.store.getState().usageSettingsProvider'),'all');
  await js('qa.hold("bubble",365);qa.watch();qa.mount()');
  await until('qa.calls.filter(c=>c.endsWith(":365")).length===12');await wait(200);
  assert.equal(await js('document.querySelector("[aria-label=\\"Usage provider\\"]").dataset.preferenceValue'),'all');
  assert.equal(await text('[aria-label="Usage provider"]'),'All agents');
  assert.equal(await js('document.querySelectorAll("[data-usage-agent]").length'),0,'no list from part of the agents');
  assert((await js('document.getElementById("root").innerText')).includes('Loading usage'));
  await js('qa.release()');await until('document.querySelectorAll("[data-usage-agent]").length===8');
  assert.equal(await js('qa.frames.some(frame=>frame.includes("Claude Code")&&!frame.includes("Bubble"))'),false,'the list never shows without an agent that is still loading');
  assert.equal(await js('qa.calls.some(c=>!c.endsWith(":365"))'),false,'"1 year" reads the year reports only');
  assert.equal(await js('!!document.querySelector("[data-plan-limits]")'),false,'plan limits belong to one agent');

  // The headline is the cost of the agents that count in dollars; Devin and Qoder stay out of it.
  let expected=await js('(()=>{const e=qa.expected(365);return {cost:e.cost,tokens:e.tokens,sessions:e.sessions,claude:e.agentCost("claude"),bubble:e.agentCost("bubble")}})()');
  assert(Math.abs(expected.cost-12455)<1e-6,'fixtures: the year adds up to $12,455');
  assert.equal(await text('[data-usage-total]'),money(expected.cost,true)+' at API prices '+compact(expected.tokens)+' tokens · '+expected.sessions.toLocaleString('en-US')+' sessions');
  // By agent: most expensive first, four colors then gray; own units last, without a color or a share.
  assert.deepEqual(await agents(),['claude','codex','kimi','bubble','deepseek','opencode','qoder','devin']);
  assert.equal(await text('[data-usage-agent="claude"]'),'Claude Code '+money(expected.claude,true)+' '+(expected.claude/expected.cost*100).toFixed(1)+'%');
  assert.equal(await text('[data-usage-agent="bubble"]'),'Bubble '+money(expected.bubble,false)+' '+(expected.bubble/expected.cost*100).toFixed(1)+'%','a reported amount carries no ≈');
  assert.equal(await text('[data-usage-agent="devin"]'),'Devin 312 messages');
  assert.equal(await text('[data-usage-agent="qoder"]'),'Qoder 12.4 credits');
  const dots=await js('[...document.querySelectorAll("[data-usage-agent]")].map(row=>getComputedStyle(row.firstElementChild).backgroundColor)');
  assert.equal(new Set(dots.slice(0,4)).size,4,'the top four have their own colors');
  assert.equal(dots[4],dots[5],'the rest share gray');assert(!dots.slice(0,4).includes(dots[4]));
  assert.equal(dots[6],'rgba(0, 0, 0, 0)');assert.equal(dots[7],'rgba(0, 0, 0, 0)');
  // Beside the chart the list takes only the width its longest row needs, so the chart gets the rest:
  // no name is cut, and the longest row has just the gap between its name and its amount.
  const listFit=await js('(()=>{const list=document.querySelector("[data-usage-agents]").getBoundingClientRect(),chart=document.querySelector("[data-usage-daily-cost]").getBoundingClientRect();const slack=[...document.querySelectorAll("[data-usage-agent]")].map(row=>{const name=row.querySelector("[data-usage-agent-name]"),range=document.createRange();range.selectNodeContents(name);return {cut:name.scrollWidth>name.clientWidth,gap:Math.round(row.querySelector("[data-usage-agent-cost], [data-usage-agent-own]").getBoundingClientRect().left-range.getBoundingClientRect().right)}});return {width:Math.round(list.width),chart:Math.round(chart.width),cut:slack.some(s=>s.cut),tightest:Math.min(...slack.map(s=>s.gap))}})()');
  assert.equal(listFit.cut,false,'no agent name is cut');
  assert(listFit.tightest>=16&&listFit.tightest<=24,'the longest row sets the width: '+JSON.stringify(listFit));
  assert(listFit.width<=336&&listFit.chart>listFit.width*1.8,'the chart has the rest of the card: '+JSON.stringify(listFit));
  // Every range draws a point per day, a year too (365 of them): a line for each of the top four, one gray line for the rest.
  assert.equal(await text('[data-usage-daily-cost] > div'),'Daily cost');
  assert.equal(await js('document.querySelectorAll("[data-usage-cost-point]").length'),365);
  assert.deepEqual(await js('[...document.querySelectorAll("[data-usage-cost-line]")].map(line=>line.dataset.usageCostLine)'),['other','bubble','kimi','codex','claude'],'drawn back to front, the most expensive on top');
  const lineShape=await js('(()=>{const pick=key=>document.querySelector("[data-usage-cost-line=\\""+key+"\\"] polyline");const ys=key=>pick(key).getAttribute("points").split(" ").map(p=>Number(p.split(",")[1]));const xs=pick("claude").getAttribute("points").split(" ").map(p=>Number(p.split(",")[0]));return {points:xs.length,first:xs[0],last:xs[xs.length-1],peak:Math.min(...ys("claude")),otherPeak:Math.min(...ys("other")),stroke:[...document.querySelectorAll("[data-usage-cost-line]")].map(line=>getComputedStyle(line.querySelector("polyline")).stroke),scaling:getComputedStyle(pick("claude")).vectorEffect}})()');
  assert.equal(lineShape.points,365);assert.equal(lineShape.first,0);assert.equal(lineShape.last,100);
  assert(lineShape.peak>4&&lineShape.peak<12,'the highest line nearly reaches the top of the plot: '+lineShape.peak);
  assert(lineShape.otherPeak>90,'lines share one scale, so small agents stay near the baseline: '+lineShape.otherPeak);
  assert.equal(new Set(lineShape.stroke).size,5,'each line has its own color');assert.equal(lineShape.scaling,'non-scaling-stroke');
  assert.equal(await js('!!document.querySelector("[data-usage-cost-dot], [data-usage-cost-tip]")'),false,'nothing is marked until a point is hovered');
  let tip=await hoverTip(0.9);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(tip.day),'the tip belongs to one day: '+tip.day);
  await tipMatchesDay(365,tip);
  // Each agent in the tip goes by its logo; the colored dots stay with the list and the lines.
  assert.equal(tip.logos,true,'a logo leads every row of the tip');assert.equal(tip.dotsInTip,false,'no dots in the tip');
  assert.equal(tip.namesFit,true,'every name fits beside its logo');
  assert.equal(tip.dots,5,'a dot on every line at the hovered point');
  assert.deepEqual([tip.inside,tip.leftOfPoint],[true,true],'the tip opens beside the point, inside the card');
  // A few pixels to the side is another day.
  const other=await hoverTip(0.92);assert.notEqual(other.day,tip.day,'days can be told apart');await tipMatchesDay(365,other);
  const early=await hoverTip(0.1);
  assert.deepEqual([early.inside,early.rightOfPoint],[true,true],'on the left half it opens to the right');await tipMatchesDay(365,early);
  await hover('[data-usage-total]');assert.equal(await js('!!document.querySelector("[data-usage-cost-tip]")'),false,'leaving the plot closes the tip');
  // Cost by type: four parts and what could not be split, adding up to the total.
  assert.deepEqual(await js('[...document.querySelectorAll("[data-usage-cost-type]")].map(el=>el.dataset.usageCostType)'),['input','cache-read','cache-write','output','other']);
  const typeSum=await js('[...document.querySelectorAll("[data-usage-cost-type]")].reduce((sum,el)=>sum+Number(el.innerText.match(/\\$([\\d,.]+)/)[1].replaceAll(",","")),0)');
  assert(Math.abs(typeSum-expected.cost)<0.05,'the types add up to the headline: '+typeSum);
  assert((await text('[data-usage-cost-type="cache-read"]')).startsWith('Cache read ≈$'));
  assert.equal(await text('[data-usage-cost-type="other"]'),'Other '+money(expected.bubble*.3,false));
  // By model: the single-agent table, every agent's models in it, its total the headline's.
  assert.deepEqual(await js('Array.from(document.querySelectorAll("[data-usage-ledger] thead th")).map(th=>th.innerText.trim())'),['Model','Tokens','Share','Estimated cost','Per 1M','Sessions','Cache hit','Last 13 weeks','Last used']);
  const total=await js('Array.from(document.querySelectorAll("[data-usage-model-row=\\"total\\"] td")).map(td=>td.innerText.trim())');
  assert.equal(total[1],compact(expected.tokens));assert.equal(total[3],money(expected.cost,true));assert.equal(total[5],expected.sessions.toLocaleString('en-US'));
  assert.equal(await js('document.querySelector("[data-usage-model-row=\\"claude-opus-5-5\\"]").parentElement.firstElementChild.dataset.usageModelRow'),'claude-opus-5-5','most tokens first');
  await js('document.querySelector("[data-usage-model-row=\\"others\\"] button").click()');
  assert.equal(await js('document.querySelector("[data-usage-model-row=\\"swe-2-high\\"]").children[3].innerText.trim()'),'—','a model billed in messages has no dollars');
  assert.equal(await js('!!document.querySelector("[data-usage-model-row=\\"Auto\\"]")'),false,'a model with credits only is not a row');
  assert.equal(await js('!!document.querySelector("[data-usage-activity]")'),true);
  assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
  await shot('year-light');

  // Another range keeps the page on screen while its reports load, then swaps; short ranges draw days.
  await js('qa.hold(null,30);qa.watch()');await range('30 days');
  await until('qa.calls.filter(c=>c.endsWith(":30")).length===12');await wait(150);
  assert.equal(await js('document.querySelectorAll("[data-usage-cost-point]").length'),365,'the year stays until the range has loaded');
  assert((await text('[data-usage-report-status]')).includes('Refreshing'));
  await js('qa.release()');await until('document.querySelectorAll("[data-usage-cost-point]").length===30');
  assert.equal(await js('qa.frames.some(frame=>frame.includes("Loading usage"))'),false,'no loading placeholder between ranges');
  expected=await js('(()=>{const e=qa.expected(30);return {cost:e.cost,tokens:e.tokens,sessions:e.sessions}})()');
  assert.equal(await text('[data-usage-daily-cost] > div'),'Daily cost');
  assert((await text('[data-usage-total]')).startsWith(money(expected.cost,true)+' at API prices'));
  assert.deepEqual(await js('Array.from(document.querySelectorAll("[data-usage-ledger] thead th")).map(th=>th.innerText.trim())').then(h=>h[7]),'Last 30 days');
  tip=await hoverTip('[data-usage-cost-point]:last-child');
  assert.equal(tip.day,await js('[...document.querySelectorAll("[data-usage-cost-point]")].at(-1).dataset.usageCostPoint'),'the last point is today');await tipMatchesDay(30,tip);
  await shot('month-hover');await hover('[data-usage-total]');await shot('month-light');
  await js('qa.dark()');await shot('month-dark');await js('qa.light()');
  win.setContentSize(520,1000);await wait(200);
  assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true,'the cards stack on a narrow window');
  assert.equal(await js('(()=>{const a=document.querySelector("[data-usage-agents]").getBoundingClientRect(),d=document.querySelector("[data-usage-daily-cost]").getBoundingClientRect();return d.top>=a.bottom-1})()'),true,'the chart goes under the list');
  await shot('month-narrow');win.setContentSize(1120,1240);await wait(200);

  // A row opens that agent's own page, in the same range; the picker leads back.
  await js('document.querySelector("[data-usage-agent=\\"codex\\"]").click()');
  await until('document.querySelector("[aria-label=\\"Usage provider\\"]").dataset.preferenceValue==="codex"');
  assert.equal(await js('qa.store.getState().usageSettingsProvider'),'codex');
  await until('!!document.querySelector("[data-usage-total]")&&!document.querySelector("[data-usage-overview]")');
  assert((await text('[data-usage-total]')).endsWith('tokens'),'an agent page counts tokens, as before');
  assert.equal(await js('document.querySelector("[data-usage-range] [aria-checked=true]").innerText.trim()'),'30 days');
  assert.equal(await js('!!document.querySelector("[data-usage-agents], [data-usage-cost-types]")'),false);
  assert.equal(await js('!!document.querySelector("[data-plan-limits]")'),true,'plan limits are back on the agent page');
  await js('document.querySelector("[aria-label=\\"Usage provider\\"]").click()');
  await until('!!document.querySelector("[data-preference-option=\\"all\\"]")');
  const options=await js('[...document.querySelectorAll("[data-preference-option]")].map(option=>option.dataset.preferenceOption)');
  assert.equal(options[0],'all');assert.equal(options.length,13);
  assert.equal(await js('document.querySelector("[data-preference-option=\\"all\\"]").nextElementSibling.getAttribute("role")'),'separator','a line sets All agents apart');
  await shot('picker');
  await js('document.querySelector("[data-preference-option=\\"all\\"]").click()');
  await until('!!document.querySelector("[data-usage-overview]")');
  assert.equal(await js('document.querySelectorAll("[data-usage-cost-point]").length'),30,'back on the overview, same range');

  // An agent billed in messages whose tokens have API prices counts in dollars like the rest: with an estimate,
  // Devin is in the total, the ranking, the lines and the tip. (Without one it shows its messages, as above.)
  await js('qa.priceDevin()');await range('90 days');
  await until('document.querySelectorAll("[data-usage-cost-point]").length===90');
  expected=await js('(()=>{const e=qa.expected(90),cost=p=>e.agentCost(p);const r=qa.devinDay(90);return {cost:e.cost,devin:cost("devin"),codex:cost("codex"),kimi:cost("kimi"),qoder:cost("qoder"),day:r}})()');
  assert(expected.devin<expected.codex&&expected.devin>expected.kimi&&expected.qoder===0,'fixtures: Devin ranks third, Qoder has no dollars');
  assert((await text('[data-usage-total]')).startsWith(money(expected.cost,true)+' at API prices'),'the headline includes Devin');
  assert.deepEqual(await agents(),['claude','codex','devin','kimi','bubble','deepseek','opencode','qoder']);
  assert.equal(await text('[data-usage-agent="devin"]'),'Devin '+money(expected.devin,true)+' '+(expected.devin/expected.cost*100).toFixed(1)+'%','dollars and a share, not messages');
  assert.deepEqual(await js('[...document.querySelectorAll("[data-usage-cost-line]")].map(line=>line.dataset.usageCostLine)'),['other','kimi','devin','codex','claude'],'Devin has its own line');
  tip=await hoverTip('[data-usage-cost-point="'+expected.day+'"]');
  assert.equal(tip.day,expected.day);assert(tip.rows.includes('devin')&&tip.text.includes('Devin'),'Devin is in the tip of a day it spent on: '+tip.text);await tipMatchesDay(90,tip);
  const typeSum90=await js('[...document.querySelectorAll("[data-usage-cost-type]")].reduce((sum,el)=>sum+Number(el.innerText.match(/\\$([\\d,.]+)/)[1].replaceAll(",","")),0)');
  assert(Math.abs(typeSum90-expected.cost)<0.05,'cost by type includes Devin: '+typeSum90);
  await hover('[data-usage-total]');await shot('devin-priced');

  assert.deepEqual(errors,[]);
  console.log('usage-overview: loading, headline, agents, daily lines, tip, cost by type, models, ranges, narrow, agent pages, picker and a priced Devin passed');app.exit(0);
 }catch(error){console.error(error);app.exit(1)}
});
`;
let server;
try {
  await writeFile(path.join(temp, 'index.html'), '<html><body style="margin:0;background:var(--bg-primary);color:var(--text-primary)"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(temp, 'harness.tsx'), harness);
  await writeFile(path.join(temp, 'main.cjs'), main);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.aegis-design-qa/**'] } } });
  await server.listen();
  const env = { ...process.env, QA_TEMP: temp, QA_URL: new URL(path.relative(root, temp) + '/index.html', server.resolvedUrls.local[0]).href, QA_CAPTURE: path.join(root, 'output/usage-overview') };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(temp, 'main.cjs')], { cwd: root, env, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(Error('Usage overview test timed out')); }, 90000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Usage overview test failed')); });
  });
} finally {
  await server?.close();
  await rm(temp, { recursive: true, force: true });
}
