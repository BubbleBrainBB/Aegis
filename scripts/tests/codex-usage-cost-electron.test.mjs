import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const temp = await mkdtemp(path.join(root, '.aegis-design-qa/codex-usage-cost-'));
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import '/src/ui/index.css';
let clock=Date.now();Date.now=()=>clock;
let report=null;
window.electron={getKimiModelConfig:async()=>({availableModels:[],options:[]}),getAgentUsageReport:async()=>report,getCodexRateLimits:async()=>null,getQoderPlanUsage:async()=>null};
const {useAppStore}=await import('/src/ui/store/useAppStore');
const {prefetchAgentUsageReport}=await import('/src/ui/hooks/useAgentUsageReport');
const {ClaudeUsageSettingsContent}=await import('/src/ui/components/settings/ClaudeUsageSettings');
useAppStore.getState().setUsageSettingsProvider('codex');
useAppStore.getState().setTheme('light');
window.qa={load:async (next,provider='codex')=>{report=next;clock+=60001;await prefetchAgentUsageReport(provider,365);useAppStore.getState().setUsageSettingsProvider(provider);},dark:()=>useAppStore.getState().setTheme('dark'),light:()=>useAppStore.getState().setTheme('light')};
createRoot(document.getElementById('root')).render(<main style={{maxWidth:900,margin:'32px auto',padding:16}}><ClaudeUsageSettingsContent/></main>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
// CI runners have Reduce Motion on; tests expect the default motion preference.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.env.QA_ROOT,temp=process.env.QA_TEMP;
app.setPath('userData',path.join(temp,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
// Isolate both Codex search roots; tests must never read or write personal history.
require('node:os').homedir=()=>path.join(temp,'home');
process.env.CODEX_HOME=path.join(temp,'home','.codex');fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});
app.whenReady().then(async()=>{
 let store,db;
 try{
  const Database=require(path.join(root,'node_modules/better-sqlite3'));
  db=new Database(path.join(process.env.CODEX_HOME,'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,model TEXT,tokens_used INTEGER)');
  const rollout=path.join(temp,'rollout.jsonl');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run('cost-test',rollout,'gpt-5.5',0);
  store=require(path.join(root,'dist-electron/electron/libs/session-store.js'));store.initialize();
  const session=store.createSession({provider:'codex',model:'gpt-5.5',cwd:temp,title:'Usage cost regression'});
  store.updateCodexSessionId(session.id,'cost-test');
  function reportFor(segments){
   const cumulative={input_tokens:0,cached_input_tokens:0,output_tokens:0,cache_write_input_tokens:0,total_tokens:0};const lines=[];
   for(const [model,input,cached,output,age=0,writes=0] of segments){
    const last={input_tokens:input,cached_input_tokens:cached,output_tokens:output,cache_write_input_tokens:writes,total_tokens:input+output};
    for(const key of Object.keys(cumulative))cumulative[key]+=last[key];
    lines.push(JSON.stringify({type:'turn_context',payload:{model}}));
    const event=JSON.stringify({type:'event_msg',timestamp:new Date(Date.now()-age*86400000).toISOString(),payload:{type:'token_count',info:{last_token_usage:last,total_token_usage:{...cumulative}}}});
    lines.push(event,event); // Repeated native snapshots must not inflate coverage or tokens.
   }
   fs.writeFileSync(rollout,lines.join('\n'));
   store.updateSessionModel(session.id,'gpt-5.5'); // Normal store invalidation, not a private test hook.
   return store.getCodexUsageReport(365);
  }
  const known=['gpt-5.5',100000,50000,1000];
  const current=reportFor([known,['gpt-5.6-sol',100000,30000,2000,0,10000],['gpt-5.6-terra',100000,30000,2000,0,10000],['gpt-6-astra',100000,30000,2000,0,10000],['gpt-5.6-luna',100000,30000,2000,0,10000]]);
  assert.equal(current.costMode,'estimated');assert.equal(current.costBasis,'api-standard');
  assert.equal(current.totals.totalTokens,509000);assert(Math.abs(current.totals.totalCostUsd-1.6945)<1e-10);
  assert.deepEqual(current.costCoverage,{pricedTokens:509000,unpricedTokens:0,unpricedModels:[]});
  assert.equal(current.daily.reduce((sum,day)=>sum+day.totalTokens,0),509000);
  assert(Math.abs(current.daily.reduce((sum,day)=>sum+Object.values(day.byModelCostUsd).reduce((a,b)=>a+b,0),0)-1.6945)<1e-10);
  assert.equal(store.getCodexUsageReport(365),current,'cache retains cost basis and coverage');
  const mixed=reportFor([known,['future-unpriced-model',1000000,500000,100]]);
  assert.equal(mixed.costMode,'partial');assert(Math.abs(mixed.totals.totalCostUsd-.305)<1e-10);
  assert.deepEqual(mixed.costCoverage,{pricedTokens:101000,unpricedTokens:1000100,unpricedModels:['future-unpriced-model']});
  assert(!Object.hasOwn(mixed.daily.find(day=>day.totalTokens>0).byModelCostUsd,'future-unpriced-model'));
  const unknown=reportFor([['future-unpriced-model',1000,900,20]]);
  assert.equal(unknown.costMode,'unavailable');assert.equal(unknown.costCoverage.pricedTokens,0);
  const priced=reportFor([known]);assert.equal(priced.costMode,'estimated');assert.equal(priced.costCoverage.unpricedTokens,0);
  const ranged=reportFor([['unknown-older-model',1000,0,10,400],known]);
  assert.equal(ranged.costMode,'estimated');assert.equal(ranged.totals.totalTokens,101000,'out-of-range unknown usage must not affect coverage');
  const empty=reportFor([]);assert.equal(empty.costMode,'estimated');assert.equal(empty.totals.totalTokens,0);
  const zero=reportFor([['unpriced-zero',0,0,0],known]);assert.equal(zero.costMode,'estimated','zero usage needs no price');
  // Agent-reported prices remain authoritative; this change must not replace
  // an SDK amount with a token estimate, including a genuinely reported zero.
  const native=store.createSession({provider:'claude',model:'claude-sonnet-4-6',cwd:temp,title:'Reported cost'});
  store.addMessage(native.id,{type:'result',subtype:'success',duration_ms:1,total_cost_usd:12.34,usage:{input_tokens:1000,output_tokens:100}});
  store.addMessage(native.id,{type:'result',subtype:'success',duration_ms:1,total_cost_usd:0,usage:{input_tokens:1000,output_tokens:100}});
  const reported=store.getAgentUsageReport('claude',365);assert.equal(reported.totals.totalCostUsd,12.34);
  assert(!reported.costMode || reported.costMode==='actual');
  // Claude's total_cost_usd and modelUsage are running totals of its session
  // (usage is the turn alone): a turn counts for what it added to them.
  {
   const close=(actual,expected,what)=>assert(Math.abs(actual-expected)<1e-9,(what||'')+' '+actual+' != '+expected);
   const mu=(models)=>Object.fromEntries(Object.entries(models).map(([model,[inputTokens,outputTokens,costUSD,cacheReadInputTokens=0,cacheCreationInputTokens=0]])=>
     [model,{inputTokens,outputTokens,cacheReadInputTokens,cacheCreationInputTokens,costUSD,contextWindow:200000,maxOutputTokens:64000,webSearchRequests:0}]));
   const turn=(total,models,[input,output,cacheRead=0,cacheCreation=0],extra={})=>({type:'result',subtype:'success',duration_ms:1,total_cost_usd:total,
     usage:{input_tokens:input,output_tokens:output,cache_read_input_tokens:cacheRead,cache_creation_input_tokens:cacheCreation},modelUsage:mu(models),...extra});
   const claude=(title)=>store.createSession({provider:'claude',model:'claude-sonnet-4-6',cwd:temp,title}).id;
   const cost=(days=365)=>store.getAgentUsageReport('claude',days).totals.totalCostUsd;
   const model=(name,days=365)=>store.getAgentUsageReport('claude',days).models.find(m=>m.model===name);
   const dayAgo=(days)=>Date.now()-days*86400000;
   let before=cost();
   // Running totals 1, 3, 6 are 6 in all, and each model ends at the last row's figures.
   const running=claude('Running totals');
   store.addMessage(running,turn(1,{'run-main':[100,10,1,1000,50]},[100,10,1000,50]));
   store.addMessage(running,turn(3,{'run-main':[300,30,2.5,3000,50],'run-side':[40,4,.5]},[200,20,2000]));
   // A stopped turn's row has no totals: it is neither counted by them nor the next row's base.
   store.addMessage(running,{type:'result',subtype:'error_during_execution',duration_ms:1,total_cost_usd:0,usage:{input_tokens:0,output_tokens:0}});
   // A subagent's result is not a turn of this session either.
   store.addMessage(running,turn(.2,{'run-main':[20,2,.2]},[20,2],{parentToolUseId:'toolu_subagent'}));
   store.addMessage(running,turn(6,{'run-main':[600,60,5.25,6000,50],'run-side':[80,8,.75]},[300,30,3000]));
   close(cost()-before,6,'running totals count once');
   // The same totals again (nothing added) count for nothing.
   store.addMessage(running,turn(6,{'run-main':[600,60,5.25,6000,50],'run-side':[80,8,.75]},[0,0]));
   close(cost()-before,6,'an unchanged total adds nothing');
   const main=model('run-main'),side=model('run-side');
   assert.deepEqual([main.inputTokens,main.outputTokens,main.totalTokens,main.cacheReadTokens,main.sessionCount],[600,60,660,6000,1]);
   close(main.totalCostUsd,5.25);
   assert.deepEqual([side.inputTokens,side.outputTokens,side.sessionCount],[80,8,1]);close(side.totalCostUsd,.75);
   // A total below the one before is a new start and counts in full; the row after it carries on from it.
   before=cost();
   const restarted=claude('Restarted totals');
   store.addMessage(restarted,turn(5,{'restart-main':[500,50,5]},[500,50]));
   store.addMessage(restarted,turn(2,{'restart-main':[200,20,2]},[200,20]));
   store.addMessage(restarted,turn(3,{'restart-main':[300,30,3]},[100,10]));
   close(cost()-before,8,'5, then 2 from zero, then 1 more');
   assert.equal(model('restart-main').inputTokens,800);close(model('restart-main').totalCostUsd,8);
   // Rows that hold one turn each match their own usage as they stand, and count in
   // full even when a turn is larger than the one before. A side model's tokens are in
   // modelUsage only and do not change that.
   before=cost();
   const perTurn=claude('Per-turn rows');
   store.addMessage(perTurn,turn(1,{'turn-main':[100,10,1,1000]},[100,10,1000]));
   store.addMessage(perTurn,turn(4,{'turn-main':[400,40,3.9,5000],'turn-side':[30,3,.1]},[400,40,5000]));
   store.addMessage(perTurn,turn(2,{'turn-main':[200,20,2,2000]},[200,20,2000]));
   store.addMessage(perTurn,turn(2.5,{'turn-main':[250,25,2.5,2500]},[250,25,2500]));
   close(cost()-before,9.5,'per-turn rows add up');
   assert.equal(model('turn-main').inputTokens,950);assert.equal(model('turn-main').cacheReadTokens,10500);
   // A session that began before the range counts only what the range added.
   before=cost();const beforeWeek=cost(7);
   const ranged=claude('Across the range start');
   store.addMessage(ranged,turn(10,{'range-main':[1000,100,10]},[1000,100],{createdAt:dayAgo(10)}));
   store.addMessage(ranged,turn(12,{'range-main':[1200,120,12]},[200,20]));
   store.addMessage(ranged,turn(15,{'range-main':[1500,150,15]},[300,30]));
   close(cost(7)-beforeWeek,5,'the range counts what was added inside it');
   assert.equal(model('range-main',7).inputTokens,500);close(model('range-main',7).totalCostUsd,5);
   close(cost()-before,15);assert.equal(model('range-main').inputTokens,1500);
   // A copied result holds another task's totals: it is not counted and is no base, in or before the range.
   before=cost();const copyWeek=cost(7);
   const copied=claude('Copied history');
   store.addMessage(copied,turn(1,{'copy-main':[100,10,1]},[100,10],{createdAt:dayAgo(10),copiedFromSessionId:running}));
   store.addMessage(copied,turn(3,{'copy-main':[300,30,3]},[200,20]));
   close(cost(7)-copyWeek,3,'a copy before the range is no base');
   store.addMessage(copied,turn(4,{'copy-main':[400,40,4]},[100,10],{copiedFromSessionId:running}));
   store.addMessage(copied,turn(5,{'copy-main':[500,50,5]},[200,20]));
   close(cost()-before,5,'a copy in the range is no base either');
   assert.equal(model('copy-main').inputTokens,500);
   // Days and models add up to the total.
   for(const days of [7,365]){
    const report=store.getAgentUsageReport('claude',days);
    close(report.daily.reduce((sum,day)=>sum+Object.values(day.byModelCostUsd).reduce((a,b)=>a+b,0),0),report.totals.totalCostUsd,'daily costs');
    close(report.models.reduce((sum,m)=>sum+m.totalCostUsd,0),report.totals.totalCostUsd,'model costs');
   }
   // Totals that carry on have grown by at least the turn's own usage in every counter. Here every
   // total is above the one before, but output grew by 160 where the turn itself wrote 200: a new start
   // whose totals happen to be higher, counted in full. (By distance alone it reads as carrying on.)
   before=cost();
   const higher=claude('A new start above the old totals');
   store.addMessage(higher,turn(1,{'higher-main':[1000,100,1]},[1000,100]));
   store.addMessage(higher,turn(1.5,{'higher-main':[1100,260,1.5,50000]},[60,200,30000]));
   close(cost()-before,2.5,'a counter that grew by less than the turn is a new start');
   assert.equal(model('higher-main').outputTokens,360);
   // /cost adds a task up the same way: running totals by what each turn added, a new start in full,
   // copies left out, a subagent's result left out (the totals already hold it), and other agents'
   // results as the cost of their own turn.
   const taskCost=(id,provider='claude')=>store.sumUsageCostUsd(provider,store.getSessionHistory(id));
   close(taskCost(running),6,'/cost: running totals');close(taskCost(restarted),8,'/cost: restart');
   close(taskCost(perTurn),9.5,'/cost: per-turn rows');close(taskCost(ranged),15,'/cost: whole task, whatever the range');
   close(taskCost(copied),5,'/cost: copies are not this task\'s spend');close(taskCost(higher),2.5,'/cost: new start above the old totals');
   close(taskCost(native.id),12.34,'/cost: a row without totals is its own turn');
   close(taskCost(running,'kimi'),1+3+.2+6+6,'/cost: another agent\'s results are per turn');
   // The week still counts the task that began before it from its base (5), next to the tasks that began in it.
   close(cost(7)-beforeWeek,5+5+2.5,'only the task with earlier results gets a base');
   close(cost(),12.34+6+8+9.5+15+5+2.5);
  }
  // Codex's adapter emits a placeholder zero, not a reported bill.
  store.addMessage(session.id,{type:'result',subtype:'success',duration_ms:1,total_cost_usd:0,usage:{input_tokens:0,output_tokens:0}});
  assert(Math.abs(store.getCodexUsageReport(365).totals.totalCostUsd-.305)<1e-10);
  const clock=Date.now();
  reportFor([['future-unpriced-model',100000,30000,2000,-1/86400,10000],['gpt-6-astra',100000,30000,2000,-2/86400,10000]]);
  store.addMessage(session.id,{type:'result',subtype:'success',createdAt:clock+1250,duration_ms:1,total_cost_usd:999,
    costSource:'reported',sourceProvider:'claude',parentToolUseId:'delegated',usage:{input_tokens:1,output_tokens:1}});
  store.addMessage(session.id,{type:'result',subtype:'success',createdAt:clock+1500,duration_ms:1,total_cost_usd:42,costSource:'reported',usage:{input_tokens:100000,output_tokens:2000}});
  const combined=store.getCodexUsageReport(365);
  assert(Math.abs(combined.totals.totalCostUsd-42.855)<1e-10,'reported first turn replaces its estimate; next turn uses API fallback');
  assert.equal(combined.costBasis,'reported-and-api');assert.equal(combined.costMode,'estimated');assert.equal(combined.costCoverage.unpricedTokens,0);
  store.addMessage(session.id,{type:'result',subtype:'success',createdAt:clock+2500,duration_ms:1,total_cost_usd:0,costSource:'reported',usage:{input_tokens:100000,output_tokens:2000}});
  const nativeOnly=store.getCodexUsageReport(365);
  assert.equal(nativeOnly.totals.totalCostUsd,42,'explicitly reported zero overrides the fallback');assert.equal(nativeOnly.costMode,'actual');assert.equal(nativeOnly.costBasis,undefined);
  // Other runners must share the same priority rules, including a returned free zero.
  const near=(actual,expected)=>assert(Math.abs(actual-expected)<1e-9,actual+' != '+expected);
  const result=(extra={})=>({type:'result',subtype:'success',duration_ms:1,total_cost_usd:0,
    usage:{input_tokens:1000,output_tokens:100},...extra});
  const costTestSessions={};
  for(const provider of ['kimi','grok','qoder','pi','bubble']){
    const s=store.createSession({provider,model:'gpt-5.5',cwd:temp,title:provider+' cost priority'});costTestSessions[provider]=s.id;
    store.addMessage(s.id,result({total_cost_usd:9,costSource:'reported'}));
    store.addMessage(s.id,result({costSource:'reported'}));
    let r=store.getAgentUsageReport(provider,365);near(r.totals.totalCostUsd,9);assert.equal(r.costMode,'actual');
    store.addMessage(s.id,result({costSource:'unavailable'}));
    r=store.getAgentUsageReport(provider,365);near(r.totals.totalCostUsd,9.008);assert.equal(r.costMode,'estimated');
    store.addMessage(s.id,result({costSource:'unavailable',model:'unpriced-model'}));
    r=store.getAgentUsageReport(provider,365);near(r.totals.totalCostUsd,9.008);assert.equal(r.costMode,'partial');
    assert(r.note.includes('unpriced-model'));
    store.addMessage(s.id,result({total_cost_usd:999,costSource:'reported',sourceProvider:'claude',parentToolUseId:'delegation'}));
    near(store.getAgentUsageReport(provider,365).totals.totalCostUsd,9.008);
  }
  // Real adapter folds: one reported step, one missing step, one returned free step.
  const {emptyCostDetails}=require(path.join(root,'dist-electron/electron/libs/agent-cost.js'));
  const {PiSdkAdapter}=require(path.join(root,'dist-electron/electron/libs/provider/pi-sdk-adapter.js'));
  const {BubbleSdkAdapter}=require(path.join(root,'dist-electron/electron/libs/provider/bubble-sdk-adapter.js'));
  for(const provider of ['pi','bubble']){
    const adapter=provider==='pi'?new PiSdkAdapter():new BubbleSdkAdapter();const emitted=[];
    adapter.events.on('event',e=>{if(e.type==='message'&&e.message.type==='result')emitted.push(e.message)});
    const s={threadId:'cost-fold',model:'gpt-5.5',usage:{input_tokens:0,output_tokens:0},
      costDetails:emptyCostDetails(),session:{model:{provider:'openai',id:'gpt-5.5'}},
      ingestedUsageKeys:new Set(),currentAssistant:null,durationStartMs:Date.now()};
    for(const [i,usd] of [3,undefined,0].entries()){
      if(provider==='pi')adapter.ingestUsage(s,{role:'assistant',model:'gpt-5.5',timestamp:i+1,
        usage:{input:1000,output:100,...(usd===undefined?{}:{cost:{total:usd}})}});
      else adapter.handleBubbleEvent(s,{type:'turn_end',usage:{promptTokens:1000,completionTokens:100},
        ...(usd===undefined?{}:{cost:{currency:'USD',cost:usd}})});
    }
    adapter.emitResult(s);assert.equal(emitted.length,1);near(emitted[0].total_cost_usd,3.008);
    assert.equal(emitted[0].costDetails.reportedCount,2);assert.equal(emitted[0].costDetails.estimatedCount,1);
    const stored=store.createSession({provider,model:'gpt-5.5',cwd:temp,title:'Adapter persistence'});
    store.addMessage(stored.id,emitted[0]);near(store.getAgentUsageReport(provider,365).totals.totalCostUsd,12.016);
  }
  // OpenCode's native database: explicit cost 0 is free; an absent key needs fallback.
  const ocDir=path.join(temp,'home','.local','share','opencode');fs.mkdirSync(ocDir,{recursive:true});
  const oc=new Database(path.join(ocDir,'opencode.db'));
  oc.exec('CREATE TABLE message(session_id TEXT,time_created INTEGER,data TEXT)');
  const os=store.createSession({provider:'opencode',model:'gpt-5.5',cwd:temp,title:'Native cost presence'});
  store.updateOpencodeSessionId(os.id,'oc-cost');
  for(const cost of [0,undefined,7])oc.prepare('INSERT INTO message VALUES(?,?,?)').run('oc-cost',Date.now(),JSON.stringify({
    role:'assistant',modelID:'gpt-5.5',tokens:{input:1000,output:100},...(cost===undefined?{}:{cost})}));
  const or=store.getAgentUsageReport('opencode',365);near(or.totals.totalCostUsd,7.008);assert.equal(or.costMode,'estimated');oc.close();
  store.close();store.initialize();near(store.getAgentUsageReport('bubble',365).totals.totalCostUsd,12.016);
  // DeepSeek's historical double-fold repair and request-time estimates stay intact.
  const {estimateDeepseekUsageCost,DEEPSEEK_COST_ACCOUNTING}=require(path.join(root,'dist-electron/electron/libs/deepseek-pricing.js'));
  const ds=store.createSession({provider:'deepseek',model:'deepseek-v4-flash',cwd:temp,title:'Historical pricing repair'});
  const at=Date.now();
  store.addMessage(ds.id,result({createdAt:at,usage:{input_tokens:200,output_tokens:40,cache_read_input_tokens:10}}));
  const expected=estimateDeepseekUsageCost('deepseek-v4-flash',{inputTokens:100,outputTokens:20,cacheReadTokens:5},at);
  near(store.getAgentUsageReport('deepseek',365).totals.totalCostUsd,expected);
  assert.equal(store.getAgentUsageReport('deepseek',365).costMode,'estimated');
  store.addMessage(ds.id,result({usageAccounting:'deepseek-step-last-wins-v1',total_cost_usd:.003,
    costAccounting:DEEPSEEK_COST_ACCOUNTING,costEstimate:{usd:.003}}));
  near(store.getDeepseekSessionCost(ds.id).usd,expected+.003);
  store.addMessage(ds.id,result({costSource:'reported',total_cost_usd:4}));
  near(store.getDeepseekSessionCost(ds.id).usd,expected+.003+4);
  store.addMessage(ds.id,result({model:'unknown-deepseek',usageAccounting:'deepseek-step-last-wins-v1'}));
  assert.equal(store.getAgentUsageReport('deepseek',365).costMode,'partial');
  near(store.getAgentUsageReport('deepseek',365).totals.totalCostUsd,expected+.003+4);
  store.deleteSession(costTestSessions.kimi);
  const kimi=store.createSession({provider:'kimi',model:'kimi-code/k3',cwd:temp,title:'Kimi subscription API equivalent'});
  for(const model of ['kimi-code/k3','kimi-for-coding/k3','kimi-code/kimi-for-coding','kimi-for-coding/kimi-for-coding-highspeed']){
    store.addMessage(kimi.id,result({model,costSource:'unavailable',usage:{input_tokens:100000,output_tokens:1000,cache_read_input_tokens:50000,cache_creation_input_tokens:10000}}));
  }
  store.addMessage(kimi.id,result({model:'moonshot-cn/kimi-k2.7-code-highspeed',usage:{input_tokens:0,output_tokens:0}}));
  const kimiReport=store.getAgentUsageReport('kimi',365);assert.equal(kimiReport.costMode,'estimated');near(kimiReport.totals.totalCostUsd,1.316);
  store.close();store.initialize();near(store.getAgentUsageReport('kimi',365).totals.totalCostUsd,1.316);
  // MiniMax Code records its select value; a row is the model, priced at MiniMax list rates.
  const minimax=store.createSession({provider:'minimax',model:'m:minimax:MiniMax-M3.1-Flash:v:thinking',cwd:temp,title:'MiniMax estimate'});
  for(const model of ['m:minimax:MiniMax-M3.1-Flash:v:thinking','m:minimax:MiniMax-M3.1-Flash:v:thinking','m:minimax:MiniMax-M3:v:'])
    store.addMessage(minimax.id,result({model,costSource:'unavailable',usage:{input_tokens:21937,output_tokens:179,cache_read_input_tokens:66048,cache_creation_input_tokens:0}}));
  // A stopped batch's incurred usage (usage_unreported) is stored as an accounting-only usage_record.
  const usageRecord={type:'usage_record',uuid:'minimax-usage-qa',duration_ms:5,model:'m:minimax:MiniMax-M3.1-Flash:v:thinking',costSource:'estimated',total_cost_usd:(170*.15)/1e6,
    costDetails:{reportedUsd:0,estimatedUsd:(170*.15)/1e6,reportedCount:0,estimatedCount:2,unpricedCount:0},usage:{input_tokens:170,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}};
  assert.equal(store.addUsageRecord('missing-session',usageRecord),false,'a deleted session gets no record');
  assert.equal(store.addUsageRecord(minimax.id,result()),false,'only usage records are stored this way');
  assert.equal(store.addUsageRecord(minimax.id,usageRecord),true);
  const minimaxHistory=store.getSessionHistory(minimax.id);
  assert(!minimaxHistory.some(m=>m.type==='usage_record'),'not part of the transcript or of what agents read');
  assert.equal(minimaxHistory.filter(m=>m.type==='result').length,3,'no extra turn result');
  store.replaceSessionHistory(minimax.id,minimaxHistory);
  assert.equal(store.getSessionUsageRecords(minimax.id).length,1,'a history rewrite keeps the incurred usage');
  const minimaxReport=store.getAgentUsageReport('minimax',365);
  assert.deepEqual(minimaxReport.models.map(m=>m.model).sort(),['MiniMax-M3','MiniMax-M3.1-Flash'],'select values collapse to model names');
  assert.equal(minimaxReport.costMode,'estimated');
  near(minimaxReport.totals.totalCostUsd,(2*(21937*.15+66048*.015+179*.6)+(21937*.3+66048*.06+179*1.2)+170*.15)/1e6);
  assert.equal(minimaxReport.models.find(m=>m.model==='MiniMax-M3.1-Flash').inputTokens,2*21937+170,'the stopped usage row counts toward its model');
  // Devin's model ids are its own catalog: a Claude name is the model picked, not an SDK alias.
  const devin=store.createSession({provider:'devin',model:'claude-opus-5-5-medium',cwd:temp,title:'Devin on Opus'});
  store.addMessage(devin.id,result({model:'claude-opus-5-5-medium',costSource:'unavailable',usage:{input_tokens:1000,output_tokens:10}}));
  store.addMessage(devin.id,result({model:'swe-2-high',costSource:'unavailable',usage:{input_tokens:500,output_tokens:5}}));
  store.addMessage(devin.id,result({model:'claude-opus-5-5-medium',modelLabel:'Claude Opus 5.5',thoughtLevel:'high',thoughtLevelLabel:'High',costSource:'unavailable',usage:{input_tokens:2000,output_tokens:20}}));
  store.addMessage(devin.id,result({model:'claude-opus-5-5-medium',modelLabel:'Claude Opus 5.5',thoughtLevel:'xhigh',thoughtLevelLabel:'XHigh',costSource:'unavailable',usage:{input_tokens:300,output_tokens:3}}));
  // "max" ends a model name, not a level suffix: the level is appended.
  store.addMessage(devin.id,result({model:'gpt-5.1-codex-max',thoughtLevel:'xhigh',costSource:'unavailable',usage:{input_tokens:40,output_tokens:1}}));
  // A model without thinking control keeps its id, not its catalog name.
  store.addMessage(devin.id,result({model:'swe-2-medium',modelLabel:'SWE-2 Medium',costSource:'unavailable',usage:{input_tokens:20,output_tokens:1}}));
  // Malformed stored fields neither throw nor leak into the label.
  store.addMessage(devin.id,result({model:'swe-2-medium',modelLabel:42,thoughtLevel:' Low ',thoughtLevelLabel:{},costSource:'unavailable',usage:{input_tokens:5,output_tokens:0}}));
  const devinModels=store.getAgentUsageReport('devin',365).models;
  assert.deepEqual(devinModels.map(m=>m.model).sort(),['claude-opus-5-5-high','claude-opus-5-5-medium','claude-opus-5-5-xhigh','gpt-5.1-codex-max-xhigh','swe-2-high','swe-2-low','swe-2-medium'],'Devin rows keep their Claude id and split by recorded thinking level');
  assert.equal(devinModels.find(m=>m.model==='claude-opus-5-5-high').inputTokens,2000);
  // A row without a model id stays under the provider label, undecorated.
  const devinBare=store.createSession({provider:'devin',cwd:temp,title:'Devin without a model'});
  store.addMessage(devinBare.id,result({thoughtLevel:'high',costSource:'unavailable',usage:{input_tokens:7,output_tokens:0}}));
  assert(store.getAgentUsageReport('devin',365).models.some(m=>m.model==='Devin'),'no "Devin-high"');
  // Pricing uses the model id, not the label: a level does not change a row's price or coverage.
  const devinPriced=store.createSession({provider:'devin',model:'claude-opus-4-7',cwd:temp,title:'Devin priced'});
  const pricedUsage={input_tokens:1000000,output_tokens:10000};
  const before=store.getAgentUsageReport('devin',365);
  store.addMessage(devinPriced.id,result({model:'claude-opus-4-7',usage:pricedUsage}));
  const plain=store.getAgentUsageReport('devin',365);
  store.addMessage(devinPriced.id,result({model:'claude-opus-4-7',modelLabel:'Claude Opus 4.7',thoughtLevel:'high',usage:pricedUsage}));
  const leveled=store.getAgentUsageReport('devin',365);
  assert(plain.totals.totalCostUsd>before.totals.totalCostUsd,'the Devin id is priced');
  near(leveled.totals.totalCostUsd-plain.totals.totalCostUsd,plain.totals.totalCostUsd-before.totals.totalCostUsd);
  assert.equal(leveled.costMode,plain.costMode,'the level does not change cost coverage');
  // Devin bills in agent messages (quota plans) and credits (credit plans), per model and day.
  assert.deepEqual(leveled.billing,{agentMessages:0,credits:0},'rows recorded before billing count as nothing billed');
  const devinBilled=store.createSession({provider:'devin',model:'swe-2-high',cwd:temp,title:'Devin billed'});
  store.addMessage(devinBilled.id,result({model:'swe-2-high',costSource:'unavailable',devinBilling:{agentMessages:3,credits:0},usage:{input_tokens:10,output_tokens:1}}));
  store.addMessage(devinBilled.id,result({model:'swe-2-high',costSource:'unavailable',devinBilling:{agentMessages:2,credits:0},usage:{input_tokens:10,output_tokens:1}}));
  store.addMessage(devinBilled.id,result({model:'claude-opus-5-5-medium',thoughtLevel:'high',costSource:'unavailable',devinBilling:{agentMessages:1,credits:1.25},usage:{input_tokens:10,output_tokens:1}}));
  store.addMessage(devinBilled.id,result({model:'swe-2-high',costSource:'unavailable',devinBilling:{agentMessages:'x',credits:null},usage:{input_tokens:1,output_tokens:0}}));
  // A turn that failed after billing: messages, no tokens.
  store.addMessage(devinBilled.id,result({model:'adaptive',subtype:'error',costSource:'unavailable',devinBilling:{agentMessages:1,credits:0},usage:{input_tokens:0,output_tokens:0}}));
  const devinReport=store.getAgentUsageReport('devin',365);
  assert.deepEqual(devinReport.billing,{agentMessages:7,credits:1.25},'billing totals add up; malformed values count as zero');
  assert.equal(devinReport.models.find(m=>m.model==='swe-2-high').agentMessages,5);
  assert.equal(devinReport.models.find(m=>m.model==='claude-opus-5-5-high').credits,1.25,'billing goes under the leveled model label');
  assert.equal(devinReport.models.find(m=>m.model==='adaptive').agentMessages,1,'a zero-token billed turn still counts');
  const devinToday=devinReport.daily.at(-1);
  assert.deepEqual(devinToday.byModelAgentMessages,{'swe-2-high':5,'claude-opus-5-5-high':1,adaptive:1});
  assert.deepEqual(devinToday.byModelCredits,{'swe-2-high':0,'claude-opus-5-5-high':1.25,adaptive:0});
  assert.equal(store.getAgentUsageReport('minimax',365).billing,undefined,'other agents carry no Devin billing');
  const grok=store.createSession({provider:'grok',model:'claude-sonnet-4-6',cwd:temp,title:'Grok under an alias'});
  store.addMessage(grok.id,result({model:'claude-sonnet-4-6',costSource:'unavailable',usage:{input_tokens:100,output_tokens:1}}));
  const grokModels=store.getAgentUsageReport('grok',365).models.map(m=>m.model);
  assert(grokModels.includes('Grok')&&!grokModels.includes('claude-sonnet-4-6'),'an SDK alias still falls back to the provider label');
  const win=new BrowserWindow({width:1140,height:900,show:false,webPreferences:{backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
  const js=code=>win.webContents.executeJavaScript(code);
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async code=>{for(let i=0;i<80;i++){if(await js(code))return;await wait(40);}throw Error('Timed out: '+code)};
  const load=async (report,provider='codex')=>{await js('qa.load('+JSON.stringify(report)+','+JSON.stringify(provider)+')');await wait(100)};
  const shot=async name=>{fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG())};
  await win.loadURL(process.env.QA_URL);await until('!!window.qa');
  await load(current);await until('document.body.innerText.includes("API equivalent cost")');
  let copy=await js('document.body.innerText');
  assert(copy.includes('API equivalent cost'));assert(copy.includes('≈$1.69'));
  assert(!copy.includes('tokens excluded'));assert(!copy.includes('Standard API rates'));
  assert(!(await js('!!document.querySelector("[data-usage-api-basis], [data-usage-cost-note], [data-usage-cost-coverage]")')));
  await shot('api-equivalent-light');await js('qa.dark()');await wait(100);await shot('api-equivalent-dark');
  win.setContentSize(390,850);await wait(100);
  assert(await js('document.documentElement.scrollWidth<=innerWidth'),'API cost copy wraps on narrow windows');await shot('api-equivalent-narrow');
  await load(mixed);copy=await js('document.body.innerText');
  assert(copy.includes('Priced usage only'));assert(copy.includes('future-unpriced-model'));
  assert(!copy.includes('Cost covers only'));
  await load(unknown);assert((await js('document.body.innerText')).includes('Unavailable'));
  assert(!(await js('document.body.innerText')).includes('$0'),'unknown-only usage never appears free');
  await load(priced);assert((await js('document.body.innerText')).includes('API equivalent cost'));
  assert(!(await js('!!document.querySelector("[data-usage-cost-coverage]")')),'fully priced usage has no missing-price notice');
  await load(combined);assert((await js('document.body.innerText')).includes('Estimated cost'));
  await load(nativeOnly);assert((await js('document.body.innerText')).includes('Total cost'));
  assert(!(await js('document.body.innerText')).includes('≈$42'));
  win.setContentSize(1140,900);await js("window.document.documentElement.classList.remove('dark')");
  await load(kimiReport,'kimi');await until('document.body.innerText.includes("≈$1.32")');
  copy=await js('document.body.innerText');assert(copy.includes('Estimated cost'));assert(!copy.includes('Unavailable'));
  assert(!copy.includes('usage record(s)'));assert(!copy.includes('No reliable USD cost'));
  assert(!(await js('!!document.querySelector("[data-usage-api-basis], [data-usage-cost-note], [data-usage-cost-coverage]")')));
  await shot('kimi-estimated-clean');
  await load(minimaxReport,'minimax');await until('document.body.innerText.includes("MiniMax-M3.1-Flash")');
  copy=await js('document.body.innerText');assert(copy.includes('Estimated cost'));assert(!copy.includes('m:minimax:'));
  // Every cost label stays on one line: the cost header is as tall as its neighbours.
  const oneLine='(()=>{const c=document.querySelector("[data-usage-cost-label]"),m=c.parentElement.firstElementChild;return c.getBoundingClientRect().height===m.getBoundingClientRect().height})()';
  assert(await js(oneLine),'Estimated cost fits on one line');await shot('minimax-estimated');
  await load(current);await until('document.body.innerText.includes("API equivalent cost")');assert(await js(oneLine),'API equivalent cost fits on one line');
  await load(mixed);await until('document.body.innerText.includes("Priced usage only")');assert(await js(oneLine),'Priced usage only fits on one line');
  // Devin: messages and credits replace the cost columns. No By day table: the model table and the activity map cover it.
  await load(devinReport,'devin');await until('document.body.innerText.includes("7 agent messages")');
  copy=await js('document.body.innerText');
  assert(copy.includes('7 agent messages · 1.25 credits'),'headline shows billed totals');
  assert(!copy.includes('Estimated cost')&&!copy.includes('Per 1M'),'no USD cost columns for Devin');
  assert.equal(await js('document.querySelector("[data-usage-model-row=\\"swe-2-high\\"] [data-usage-messages]").textContent'),'5');
  assert.equal(await js('document.querySelector("[data-usage-model-row=\\"claude-opus-5-5-high\\"] [data-usage-credits]").textContent'),'1.25');
  assert.equal(await js('document.querySelector("[data-usage-model-row=\\"swe-2-high\\"] [data-usage-credits]").textContent'),'—','no credits reads as a dash, not 0');
  assert.equal(await js('!!document.querySelector("[data-usage-daily-billing]")'),false,'no By day table');
  assert(!copy.includes('By day'),'no By day heading');
  assert.deepEqual(await js('Array.from(document.querySelectorAll("[data-usage-ledger] thead th")).map(th=>th.innerText.trim())'),['Model','Tokens','Share','Messages','Credits','Sessions','Cache hit','Last 13 weeks','Last used'],'credits billed in the range bring the Credits column');
  await js('Array.from(document.querySelectorAll("[data-usage-model-row=\\"others\\"] button")).forEach(b=>b.click())');
  assert.equal(await js('document.querySelector("[data-usage-model-row=\\"adaptive\\"] [data-usage-messages]")?.textContent'),'1','a billed model without tokens stays in the ledger');
  // The folded row and the rows it opens line up with the header, the footer and the column widths.
  assert.equal(await js('!!document.querySelector("[data-usage-model-row=\\"others\\"]")'),true,'the fixture folds models into one row');
  const columns='(()=>{const t=document.querySelector("[data-usage-ledger] table");return {cols:t.querySelectorAll("col").length,rows:Array.from(new Set(Array.from(t.querySelectorAll("tr")).map(r=>r.children.length))),messages:Math.round(t.querySelectorAll("thead th")[3].getBoundingClientRect().width)}})()';
  assert.deepEqual(await js(columns),{cols:9,rows:[9],messages:84},'nine columns everywhere with credits');
  await shot('devin-billing');
  // Only billed, zero-token turns in the year: the report still shows instead of hiding.
  const billedOnly={...devinReport,totals:{...devinReport.totals,totalTokens:0,inputTokens:0,outputTokens:0,sessionCount:1},billing:{agentMessages:2,credits:0},
    models:[{model:'adaptive',inputTokens:0,outputTokens:0,totalTokens:0,totalCostUsd:0,sessionCount:1,cacheReadTokens:0,agentMessages:2,credits:0}],
    daily:devinReport.daily.map((d,i,all)=>({date:d.date,totalTokens:0,byModel:{},byModelCostUsd:{},byModelAgentMessages:i===all.length-1?{adaptive:2}:{},byModelCredits:i===all.length-1?{adaptive:0}:{}}))};
  await load(billedOnly,'devin');await until('document.body.innerText.includes("2 agent messages")');
  copy=await js('document.body.innerText');
  assert(!copy.includes('No usage recorded in the last year'),'billed-only usage is not reported as empty');
  assert(await js('!!document.querySelector("[data-usage-range]")'),'the range switch stays');
  assert.equal(await js('document.querySelector("[data-usage-model-row=\\"adaptive\\"] [data-usage-messages]")?.textContent'),'2');
  // A plan billed by message reports no credits: no Credits column of dashes.
  assert.deepEqual(await js('Array.from(document.querySelectorAll("[data-usage-ledger] thead th")).map(th=>th.innerText.trim())'),['Model','Tokens','Share','Messages','Sessions','Cache hit','Last 13 weeks','Last used']);
  assert.equal(await js('document.querySelectorAll("[data-usage-credits]").length'),0);
  assert.deepEqual(await js(columns),{cols:8,rows:[8],messages:84},'eight columns everywhere without credits');
  await shot('devin-messages-only');
  await load({...devinReport,billing:{agentMessages:0,credits:0},daily:devinReport.daily.map(d=>({...d,byModelAgentMessages:{},byModelCredits:{}}))},'devin');
  await until('document.querySelector("[data-usage-billing-total]")?.innerText.trim()==="0 agent messages"');
  assert(!(await js('document.body.innerText')).includes('No billed messages recorded'),'nothing billed leaves no empty table behind');
  // Qoder reports credits and no tokens: the whole page counts in credits.
  const noTokens={inputTokens:0,outputTokens:0,totalTokens:0,totalCostUsd:0,cacheReadTokens:0};
  const qoderReport={...devinReport,totals:{...noTokens,sessionCount:2,cacheHitRate:0},billing:{agentMessages:0,credits:36.21},
    models:[{model:'Fast',...noTokens,sessionCount:1,credits:6.01},{model:'Auto',...noTokens,sessionCount:2,credits:30.2}],
    daily:devinReport.daily.map((d,i,all)=>({date:d.date,totalTokens:0,byModel:{},byModelCostUsd:{},byModelAgentMessages:{},byModelCredits:i===all.length-1?{Auto:17.7,Fast:6.01}:i===all.length-2?{Auto:12.5}:{}}))};
  win.setContentSize(1140,900);await js('qa.light()');
  await load(qoderReport,'qoder');await until('document.querySelector("[data-usage-total]")?.innerText.includes("credits")');
  assert.equal(await js('document.querySelector("[data-usage-total]").innerText.split(/\\s+/).join(" ").trim()'),'36.21 credits','the headline counts in credits');
  assert.equal(await js('!!document.querySelector("[data-usage-billing-total]")'),false,'no second total beside it');
  assert.equal(await js('document.querySelector("[data-usage-ledger]").dataset.usageLedger'),'credits');
  assert.deepEqual(await js('Array.from(document.querySelectorAll("[data-usage-ledger] thead th")).map(th=>th.innerText.trim())'),['Model','Credits','Share','Sessions','Last 13 weeks','Last used']);
  assert.deepEqual(await js('Array.from(document.querySelectorAll("[data-usage-ledger] tbody tr")).map(r=>r.dataset.usageModelRow+" "+r.querySelector("[data-usage-credits]").innerText)'),['Auto 30.2','Fast 6.01'],'most credits first');
  assert.equal(await js('!!document.querySelector("[data-usage-daily-billing]")'),false,'no By day table');
  // Each model row carries the agent's logo, not a placeholder dot.
  const logos=await js('Array.from(document.querySelectorAll("[data-usage-ledger] tbody tr")).map(r=>{const i=r.querySelector("[data-usage-model-logo] img");return i?i.getAttribute("src"):null})');
  assert.equal(logos.length,2);assert.ok(logos.every(src=>src&&/qoder/.test(src)),'Qoder logo on every model row: '+JSON.stringify(logos));
  assert.equal(await js('document.querySelectorAll("[data-usage-ledger] tbody [data-usage-model-logo] img").length'),2);
  copy=await js('document.body.innerText');
  assert(!copy.includes('tokens')&&!copy.includes('agent message')&&!copy.includes('Cache hit'),'nothing on the page counts tokens: '+copy.slice(0,200));
  assert(copy.split(/\s+/).join(' ').includes('· 23.71'),'the activity strip counts the busiest day in credits');
  await shot('qoder-credits-light');await js('qa.dark()');await wait(100);await shot('qoder-credits-dark');
  // A report with tokens and credits and no billed messages names only what it has.
  await load({...devinReport,billing:{agentMessages:0,credits:3.5}},'devin');await until('!!document.querySelector("[data-usage-billing-total]")');
  assert.equal(await js('document.querySelector("[data-usage-billing-total]").innerText.trim()'),'3.5 credits');
  assert.deepEqual(errors,[]);store.close();db.close();
  console.log('codex-usage-cost: persisted rollouts, mixed/unknown/known/empty/range coverage, cache and Electron UI passed');app.exit(0);
 }catch(error){console.error(error);store?.close();db?.close();app.exit(1)}
});
`;
let server;
try {
  await writeFile(path.join(temp,'index.html'),'<html><body style="margin:0;background:var(--bg-primary)"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(temp,'harness.tsx'),harness);
  await writeFile(path.join(temp,'main.cjs'),main);
  server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,watch:{ignored:['**/.aegis-design-qa/**']}}});await server.listen();
  const env={...process.env,QA_ROOT:root,QA_TEMP:temp,QA_URL:new URL(path.relative(root,temp)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/codex-usage-cost')};delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve,reject)=>{
    const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(temp,'main.cjs')],{cwd:root,env,stdio:'inherit'});
    const timer=setTimeout(()=>{child.kill();reject(Error('Codex usage cost test timed out'));},60000);
    child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Codex usage cost test failed'))});
  });
} finally {await server?.close();await rm(temp,{recursive:true,force:true});}
