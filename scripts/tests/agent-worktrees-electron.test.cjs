const {app}=require('electron');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const assert=require('node:assert/strict');
const {execFileSync,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'aegis-agent-worktree-test-')));
app.setPath('userData',path.join(base,'profile'));
const sessions=require(path.join(root,'dist-electron/electron/libs/session-store.js'));
const {observeAgentWorktree,worktreeBranchesAddedBy,createAgentWorktreeTurns}=require(path.join(root,'dist-electron/electron/libs/agent-worktrees.js'));
const {captureGitTreeSnapshot,diffGitTreeSnapshots}=require(path.join(root,'dist-electron/electron/libs/git-turn-snapshot.js'));
const gitIn=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const newRepo=name=>{
 const repo=path.join(base,name);fs.mkdirSync(repo);
 gitIn(repo,'init','-b','master');gitIn(repo,'config','user.name','QA');gitIn(repo,'config','user.email','qa@example.invalid');
 fs.writeFileSync(path.join(repo,'a.txt'),'one\n');gitIn(repo,'add','.');gitIn(repo,'commit','-m','one');
 return repo;
};
const repo=newRepo('repo');const other=newRepo('other');
const git=(...args)=>gitIn(repo,...args);
let seq=0;
// One shell call: its tool_use, really running it, then its tool_result.
const ran=(id,followed,input,{parent=null}={})=>{
 const useId='tool-'+(++seq);
 const fields=typeof input==='string'?{command:input}:input;
 const observe=message=>observeAgentWorktree(id,message,path=>followed.push(path));
 observe({type:'assistant',uuid:useId,parentToolUseId:parent,message:{content:[{type:'tool_use',id:useId,name:'Bash',input:fields}]}});
 const command=fields.command??fields.cmd;
 const argv=Array.isArray(command)?command:['/bin/sh','-c',command];
 const row=sessions.getSession(id);
 const run=spawnSync(argv[0],argv.slice(1),{cwd:fields.workdir||row.cwd,encoding:'utf8'});
 const content=run.stdout+run.stderr;
 observe({type:'user',uuid:useId+'r',parentToolUseId:parent,message:{content:[{type:'tool_result',tool_use_id:useId,content,is_error:run.status!==0}]}});
 return run;
};
const settled=()=>new Promise(resolve=>setTimeout(resolve,400));
const session=title=>{const row=sessions.createSession({title,cwd:repo,provider:'claude'});return {id:row.id,followed:[],path:()=>sessions.getSession(row.id).agent_worktree_path};};
const work=(where,file='new.txt')=>fs.writeFileSync(path.join(where,file),'work\n');
app.whenReady().then(async()=>{
 try {
  sessions.initialize();

  // How agents really write it (from stored transcripts of Claude, Codex, Devin, Bubble).
  const branches=c=>worktreeBranchesAddedBy(c);
  assert.deepEqual(branches('git worktree add -b feat/a .worktrees/a origin/master'),['feat/a']);
  assert.deepEqual(branches('git fetch -q origin && git worktree add -q -b feat/a /abs/a origin/master && cd /abs/a && ls'),['feat/a']);
  assert.deepEqual(branches(String.raw`/bin/zsh -lc "git worktree add -b codex/x /abs/x origin/main` +'\n'+ String.raw`git status --short"`),['codex/x']);
  assert.deepEqual(branches(`/bin/zsh -lc 'task=$(mktemp -d); git worktree add -b codex/y "$task" origin/main; echo "$task"'`),['codex/y']);
  assert.deepEqual(branches('git worktree add -q /tmp/existing fix/ci-flakes && cd /tmp/existing'),['fix/ci-flakes']);
  assert.deepEqual(branches('git worktree add ../auto-named'),['auto-named']);
  assert.deepEqual(branches('git -C /abs/repo worktree add -b feat/c /abs/c >/dev/null 2>&1'),['feat/c']);
  assert.deepEqual(branches('git worktree add -q -b one .w/one && git worktree add -q -b two .w/two'),['one','two']);
  assert.deepEqual(branches('git worktree add -q --detach /tmp/check HEAD'),[]);
  assert.deepEqual(branches(String.raw`grep -n "git worktree add" README.md`),[]);
  assert.deepEqual(branches('git worktree list'),[]);

  // The reported case: a branched worktree the agent then works in, changes first.
  const a=session('Agent worktree');
  const wtA=path.join(base,'repo/.worktrees/feat-a');
  ran(a.id,a.followed,'git worktree add -q -b feat/a .worktrees/feat-a HEAD');
  await settled();
  assert.equal(a.path(),null,'a new worktree alone does not move the card');
  ran(a.id,a.followed,'cd .worktrees/feat-a && git status');
  await settled();
  assert.equal(a.path(),null,'going there and reading does not move the card');
  work(wtA);
  ran(a.id,a.followed,{command:'echo done',workdir:wtA});
  await settled();
  assert.equal(a.path(),wtA,'uncommitted work there moves the card');
  assert.deepEqual(a.followed,[wtA],'the renderer is told once');
  assert.equal(git('status','--porcelain').includes('new.txt'),false,'the work is not in the session folder');
  assert.equal(gitIn(a.path(),'rev-parse','--abbrev-ref','HEAD'),'feat/a');

  // Several commands in one call, and work that is only commits: variable path, array command.
  const b=session('Commit only');
  const wtB=path.join(base,'wt-b');
  ran(b.id,b.followed,{command:['/bin/sh','-c',`WT=${wtB}; git worktree add -q -b feat/b "$WT" HEAD`]});
  await settled();
  assert.equal(b.path(),null);
  work(wtB);gitIn(wtB,'add','.');gitIn(wtB,'commit','-m','work');
  assert.equal(gitIn(wtB,'status','--porcelain'),'','clean tree: only the commit shows the work');
  ran(b.id,b.followed,{cmd:'git log -1'});
  await settled();
  assert.equal(b.path(),wtB,'a commit counts as work');

  // A shell that backgrounds the command: its tool_result arrives before the worktree exists.
  const bg=session('Backgrounded');
  const wtBg=path.join(base,'wt-background');
  const useId='tool-background';
  const observeBg=message=>observeAgentWorktree(bg.id,message,path=>bg.followed.push(path));
  observeBg({type:'assistant',uuid:useId,message:{content:[{type:'tool_use',id:useId,name:'run_terminal_command',input:{command:`git worktree add -q -b feat/bg ${wtBg} HEAD`}}]}});
  observeBg({type:'user',uuid:useId+'r',message:{content:[{type:'tool_result',tool_use_id:useId,content:'Background task started',is_error:false}]}});
  await settled();
  git('worktree','add','-q','-b','feat/bg',wtBg,'HEAD');
  work(wtBg);
  ran(bg.id,bg.followed,'ls');
  await settled();
  assert.equal(bg.path(),wtBg,'followed once the backgrounded add has happened and holds work');
  // A worktree seen without work and then removed stops being watched.
  const gone=session('Removed unworked');
  const wtGone=path.join(base,'wt-gone');
  ran(gone.id,gone.followed,`git worktree add -q -b feat/gone ${wtGone} HEAD`);
  await settled();
  ran(gone.id,gone.followed,`git worktree remove ${wtGone}`);
  await settled();
  git('worktree','add','-q',wtGone,'feat/gone');
  work(wtGone);
  ran(gone.id,gone.followed,'ls');
  await settled();
  assert.equal(gone.path(),null,'a removed worktree is forgotten');

  // A later worktree with work replaces the earlier one; other sessions stay put.
  const wtC=path.join(base,'wt-c');
  ran(b.id,b.followed,`git worktree add -q -b feat/c ${wtC} HEAD`);
  await settled();
  assert.equal(b.path(),wtB,'until it holds work the card stays');
  work(wtC);
  ran(b.id,b.followed,'git status');
  await settled();
  assert.equal(b.path(),wtC);

  // False positives: none of these may move the card.
  const f=session('False positives');
  const elsewhere=path.join(base,'plain-folder');fs.mkdirSync(elsewhere);work(elsewhere);
  ran(f.id,f.followed,`cd ${elsewhere} && ls`);
  ran(f.id,f.followed,`cd ${other} && git status && git log -1`);
  ran(f.id,f.followed,`git -C ${wtA} status`);
  await settled();
  assert.equal(f.path(),null,'commands in another folder, repository or existing worktree');
  // Same repository, with changes, but made by another session: not this agent's move.
  ran(f.id,f.followed,`cd ${wtC} && git diff`);
  await settled();
  assert.equal(f.path(),null,'a dirty worktree this session did not create');
  // Detached checkouts to build or test a commit, even if they get dirty.
  const wtD=path.join(base,'wt-detached');
  ran(f.id,f.followed,`git worktree add -q --detach ${wtD} HEAD && cd ${wtD} && ls`);
  work(wtD);
  ran(f.id,f.followed,'ls');
  const wtE=path.join(base,'wt-commitish');
  ran(f.id,f.followed,`git worktree add -q ${wtE} HEAD`);
  work(wtE);
  ran(f.id,f.followed,'ls');
  await settled();
  assert.equal(f.path(),null,'detached worktrees');
  // Checking out an existing branch only to read it. Its reflog history must not read as work.
  git('branch','existing','HEAD');
  git('commit','--allow-empty','-m','two');
  git('branch','-f','existing','HEAD');
  const wtF=path.join(base,'wt-existing');
  ran(f.id,f.followed,`git worktree add -q ${wtF} existing && cd ${wtF} && git log -3`);
  await settled();
  assert.equal(f.path(),null,'an existing branch checked out to read');
  // Another repository's worktree, with work and on a branch.
  const wtG=path.join(base,'wt-other-repo');
  ran(f.id,f.followed,`git -C ${other} worktree add -q -b other/x ${wtG} HEAD`);
  work(wtG);
  ran(f.id,f.followed,'ls');
  await settled();
  assert.equal(f.path(),null,"another repository's worktree");
  // A subagent's worktree is the subagent's, not where the session works.
  const wtH=path.join(base,'wt-subagent');
  ran(f.id,f.followed,`git worktree add -q -b sub/x ${wtH} HEAD`,{parent:'task-1'});
  work(wtH);
  ran(f.id,f.followed,'ls');
  await settled();
  assert.equal(f.path(),null,'a subagent worktree');
  // A failed add, words in a commit message, and a session in a folder that is no repository.
  assert.notEqual(ran(f.id,f.followed,`git worktree add -q -b feat/a ${path.join(base,'wt-fail')} HEAD`).status,0);
  ran(f.id,f.followed,'git commit --allow-empty -m "explain git worktree add -b feat/b"');
  await settled();
  assert.equal(f.path(),null,'a failed add and a commit message');
  assert.deepEqual(f.followed,[]);
  const plain=sessions.createSession({title:'No repo',cwd:elsewhere,provider:'claude'});
  const plainFollowed=[];
  ran(plain.id,plainFollowed,'git worktree add -q -b nope ../nope HEAD');
  ran(plain.id,plainFollowed,'ls');
  await settled();
  assert.equal(sessions.getSession(plain.id).agent_worktree_path,null,'no repository');

  // Turn cards: what each turn changed in the worktree the agent moved into.
  const t=session('Turn diffs');
  const turns=createAgentWorktreeTurns(t.id);
  await turns.start();
  assert.equal(await turns.end(false),null,'no worktree, no diff');
  const wtT=path.join(base,'wt-turns');
  ran(t.id,t.followed,`git worktree add -q -b feat/turns ${wtT} HEAD`);
  work(wtT,'first.txt');gitIn(wtT,'add','.');gitIn(wtT,'commit','-q','-m','first');
  fs.writeFileSync(path.join(wtT,'a.txt'),'one\ntwo\n');
  ran(t.id,t.followed,'ls');
  // No settled(): the turn ends right after the tool result and waits for the check itself.
  const first=await turns.end(false);
  assert.ok(first,'the turn the worktree appeared in has a diff');
  assert.match(first.patch,/^diff --git a\/first\.txt b\/first\.txt$/m,'work committed in the same turn still counts');
  assert.match(first.patch,/^\+two$/m);
  assert.equal(await turns.end(false),null,'a turn that changed nothing there');
  work(wtT,'second.txt');
  const second=await turns.end(true);
  assert.match(second.patch,/^diff --git a\/wt-turns\/second\.txt b\/wt-turns\/second\.txt$/m,'paths named by folder when the session folder changed too');
  assert.doesNotMatch(second.patch,/first\.txt/,'each turn starts where the last one ended');
  const restarted=createAgentWorktreeTurns(t.id);
  await restarted.start();
  work(wtT,'third.txt');
  const third=await restarted.end(false);
  assert.match(third.patch,/third\.txt/);
  assert.doesNotMatch(third.patch,/second\.txt/,'a new runner starts from its own snapshot');
  // A worktree made inside the session's folder is no change to that folder.
  const nest=newRepo('nested');
  const nestBefore=await captureGitTreeSnapshot(nest);
  gitIn(nest,'worktree','add','-q','-b','nested/x','.worktrees/x','HEAD');
  work(path.join(nest,'.worktrees/x'));
  work(nest,'own.txt');
  const nestDiff=await diffGitTreeSnapshots(nest,nestBefore,await captureGitTreeSnapshot(nest));
  assert.match(nestDiff.patch,/^diff --git a\/own\.txt b\/own\.txt$/m);
  assert.doesNotMatch(nestDiff.patch,/Subproject|\.worktrees/,'no gitlink for the nested worktree');
  sessions.setSessionAgentWorktree(t.id,null);
  work(wtT,'fourth.txt');
  assert.equal(await restarted.end(false),null,'back to Local: the worktree is no longer diffed');

  // Leaving: the user going back is not undone by the next tool result, and an
  // explicit move of the session (handoff) clears it too.
  sessions.setSessionAgentWorktree(a.id,null);
  ran(a.id,a.followed,'git status');
  work(wtA,'more.txt');
  ran(a.id,a.followed,'git status');
  await settled();
  assert.equal(a.path(),null,'stays back after the user chose to');
  assert.ok(b.path());
  sessions.updateSessionWorkspace(b.id,{envMode:'local',worktreePath:null});
  assert.equal(b.path(),null,'moving the session clears it');
  sessions.close();
  console.log('agent-worktrees: detection, git confirmation, false positives, turn diffs, going back passed');
  process.exitCode=0;
 }catch(error){console.error(error);process.exitCode=1}
 fs.rmSync(base,{recursive:true,force:true});
 app.exit(process.exitCode);
});
