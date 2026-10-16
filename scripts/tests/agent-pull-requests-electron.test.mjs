import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'aegis-agent-pr-test-'));
const main = String.raw`
const {app}=require('electron');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root=process.env.QA_ROOT;
app.setPath('userData',path.join(__dirname,'profile'));app.setAppPath(__dirname);
const sessions=require(path.join(root,'dist-electron/electron/libs/session-store.js'));
const agent=require(path.join(root,'dist-electron/electron/libs/agent-pull-requests.js'));
const sidebar=require(path.join(root,'dist-electron/electron/libs/session-pull-requests.js'));
const repo=path.join(__dirname,'repo');fs.mkdirSync(repo);
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git('init','-b','master');git('-c','user.name=QA','-c','user.email=qa@example.invalid','commit','--allow-empty','-m','test');
git('remote','add','origin','git@github.com:test/project.git');
process.env.PATH=path.join(__dirname,'bin')+path.delimiter+process.env.PATH;
const url='https://github.com/test/project/pull/42';
const call=(id,command)=>({type:'assistant',uuid:id,message:{content:[{type:'tool_use',id,name:'Bash',input:{command}}]}});
const result=(id,content,is_error=false)=>({type:'user',uuid:id+'r',message:{content:[{type:'tool_result',tool_use_id:id,content,is_error}]}});
app.whenReady().then(async()=>{
 try {
  sessions.initialize();
  const a=sessions.createSession({title:'Agent PR',cwd:repo,provider:'claude'});
  const b=sessions.createSession({title:'Other',cwd:repo,provider:'codex'});

  // Only the output of the agent's own gh pr create names its PR.
  assert.equal(agent.pullRequestCreatedBy(a.id,call('t1','git push -u origin fix && gh pr create --title x --body "see '+url.replace('42','7')+'"')),null);
  assert.equal(agent.pullRequestCreatedBy(a.id,result('t1','Creating pull request\n'+url+'\n')),url,'last URL in the output wins');
  assert.equal(agent.pullRequestCreatedBy(a.id,result('t1',url)),null,'a result is consumed once');
  agent.pullRequestCreatedBy(a.id,call('t2','gh pr view 42'));
  assert.equal(agent.pullRequestCreatedBy(a.id,result('t2',url)),null,'reading a PR does not claim it');
  agent.pullRequestCreatedBy(a.id,call('t5','grep -rn "gh pr create" src'));
  assert.equal(agent.pullRequestCreatedBy(a.id,result('t5','notes.md: '+url)),null,'searching for the command is not running it');
  agent.pullRequestCreatedBy(a.id,call('t6','/bin/zsh -lc "cd repo && gh pr create --fill"'));
  assert.equal(agent.pullRequestCreatedBy(a.id,result('t6',url)),url,'shell-wrapped command');
  agent.pullRequestCreatedBy(a.id,call('t3','gh pr create --fill'));
  assert.equal(agent.pullRequestCreatedBy(b.id,result('t3',url)),null,'another session cannot take the result');
  agent.pullRequestCreatedBy(b.id,{type:'assistant',uuid:'t4',message:{content:[{type:'tool_use',id:'t4',name:'Bash',input:{command:['/bin/zsh','-lc','gh pr create --fill']}}]}});
  assert.equal(agent.pullRequestCreatedBy(b.id,result('t4','a pull request for branch "fix" into branch "master" already exists:\n'+url,true)),url,'argv commands and existing PRs');

  // Attaching re-reads the PR and only accepts this workspace's repositories.
  assert.equal(await agent.attachAgentPullRequest(a.id,'https://github.com/other/repo/pull/42'),false,'foreign repository');
  await assert.rejects(agent.attachAgentPullRequest(a.id,url.replace('42','404')),'unknown PR');
  assert.equal(await agent.attachAgentPullRequest('missing',url),false);
  assert.equal(await agent.attachAgentPullRequest(a.id,url),true);
  assert.equal(await agent.attachAgentPullRequest(a.id,url),false,'idempotent');
  const [pr]=sessions.listSessionPullRequests(a.id);
  assert.equal(pr.state,'open');assert.equal(pr.headBranch,'fix');assert.equal(pr.repoRoot,fs.realpathSync(repo));
  assert.equal((await sidebar.listSidebarPullRequests(false))[a.id].number,42,'sidebar shows the PR');
  assert.equal(sessions.listSessionPullRequests(b.id).length,0);
  sessions.close();console.log('agent-pull-requests: gh pr create detection, repository guard, verification, sidebar association passed');app.exit(0);
 }catch(error){console.error(error);app.exit(1)}
});
`;
const gh = `#!/usr/bin/python3
import sys, json
args = sys.argv[1:]
assert args[:2] == ['pr', 'view'] and args[3:] == ['--json', 'number,title,state,url,headRefName'], args
if not args[2].endswith('/pull/42'):
    print('no pull requests found', file=sys.stderr); sys.exit(1)
print(json.dumps(dict(number=42, title='Agent PR', state='OPEN', url=args[2], headRefName='fix')))
`;
try {
  await mkdir(path.join(tmp,'bin'));await mkdir(path.join(tmp,'profile'));
  await writeFile(path.join(tmp,'bin/gh'),gh,{mode:0o755});
  await writeFile(path.join(tmp,'main.cjs'),main);
  await new Promise((resolve,reject)=>{
    const env={...process.env,QA_ROOT:root};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:'inherit'});
    const timer=setTimeout(()=>{child.kill();reject(Error('agent PR test timed out'));},60000);
    child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('agent PR test failed: '+code))});
  });
} finally {await rm(tmp,{recursive:true,force:true});}
