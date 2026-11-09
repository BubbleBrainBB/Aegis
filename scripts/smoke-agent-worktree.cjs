// End-to-end check of the Environment card following a worktree the agent made,
// with a real agent in the real app (not part of npm test: it uses your provider
// account and takes a few minutes).
//
// Build first (npx tsc -p src/electron/tsconfig.json && node scripts/build-design-assets.mjs && npx vite build), then:
//   AEGIS_WORKTREE_E2E=claude NODE_OPTIONS="--require ./scripts/smoke-agent-worktree.cjs" \
//     node node_modules/electron/cli.js .
// Results: output/agent-worktree-e2e/<provider>/ (report.json and a screenshot per step).
const provider = (process.env.AEGIS_WORKTREE_E2E || '').trim();
// NODE_OPTIONS reaches the plain Node launcher too; only Electron's main process runs this.
if (provider && process.versions.electron && process.type === 'browser') setup();

function setup() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');

  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'output', 'agent-worktree-e2e', provider);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-worktree-e2e-')));
  const profile = path.join(work, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  // The app's own settings, so the provider keeps its configuration; sessions start empty.
  const real = path.join(os.homedir(), 'Library', 'Application Support', 'aegis');
  for (const file of ['app-preferences.json', 'user-profile.json', 'font-settings.json']) {
    try {
      fs.copyFileSync(path.join(real, file), path.join(profile, file));
    } catch {}
  }
  fs.writeFileSync(path.join(profile, 'renderer-state.json'), JSON.stringify({ 'aegis-onboarding-complete': '1' }));
  // Agents' CLIs are child processes: they must not load this file too.
  process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '').replace(/--require\s+\S*smoke-agent-worktree\.cjs/, '').trim();
  if (!process.env.NODE_OPTIONS) delete process.env.NODE_OPTIONS;
  // Started from inside an agent session: the agent under test must not think it is nested.
  for (const key of Object.keys(process.env)) {
    if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID$|CLAUDE_EFFORT$|AEGIS_SESSION_|AEGIS_BROWSER_)/.test(key)) delete process.env[key];
  }
  // Set now, before the app's main script reads them; never touch the real or dev profile.
  process.env.AEGIS_USER_DATA_DIR = profile;
  // No dev server: the app loads the built renderer.
  process.env.DEV_SERVER_URL = 'http://127.0.0.1:9';

  const repoAt = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'master');
    git('config', 'user.name', 'QA');
    git('config', 'user.email', 'qa@example.invalid');
    fs.writeFileSync(path.join(dir, 'README.md'), '# Project\n');
    git('add', '.');
    git('commit', '-qm', 'first');
    return git;
  };
  const repo = path.join(work, 'project');
  const other = path.join(work, 'other-repo');
  repoAt(repo);
  repoAt(other);
  // The user's own uncommitted edit in the session's folder, as in the report.
  fs.appendFileSync(path.join(repo, 'README.md'), 'my own notes\nmore notes\nand more\n');
  // Started now: the app's main script reads the rest of the environment.
  setImmediate(() => drive({ fs, path, out, profile, repo, other, work }));
}

function drive({ fs, path, out, profile, repo, other, work }) {
  const assert = require('node:assert/strict');
  const { execFileSync } = require('node:child_process');
  const { app, BrowserWindow } = require('electron');

  const NO_QUESTIONS = 'Do not ask me anything. Do not use any subagent. Reply with one short sentence when done.';
  const MOVE = `In this git repository, run: git worktree add -b feat/agent-work .worktrees/agent-work HEAD. Then cd into .worktrees/agent-work, create hello.txt there with two lines of text, and commit nothing. Do not touch any file outside that worktree. ${NO_QUESTIONS}`;
  const READ_ONLY = `Without creating or changing anything, run these two commands: git -C ${JSON.stringify(other)} log -1 and ls ${JSON.stringify(other)}. ${NO_QUESTIONS}`;
  const DETACHED = `Run: git worktree add --detach ${JSON.stringify(path.join(work, 'scratch'))} HEAD. Then cd into it and create a file named build.log there with one line, as a throwaway check. ${NO_QUESTIONS}`;
  const MOVE_AGAIN = `Run: git worktree add -b feat/second .worktrees/second HEAD. Then cd into .worktrees/second and create notes.txt there with one line of text. Commit nothing. ${NO_QUESTIONS}`;
  const REMOVE = `Run: git worktree remove --force .worktrees/second. ${NO_QUESTIONS}`;
  const FULL = {
    claude: { claudeAccessMode: 'fullAccess' },
    codex: { codexPermissionMode: 'fullAccess' },
    grok: { grokPermissionMode: 'yolo' },
    opencode: { opencodePermissionMode: 'fullAccess' },
    devin: { devinPermissionMode: 'bypass' },
    kimi: { kimiPermissionMode: 'yolo' },
    minimax: { minimaxPermissionMode: 'bypassPermissions' },
    bubble: { bubblePermissionMode: 'bypassPermissions' },
    deepseek: { deepseekPermissionMode: 'danger-full-access' },
  };
  const TURN_LIMIT_MS = Number(process.env.AEGIS_WORKTREE_E2E_MINUTES || 8) * 60_000;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...args) => console.log('[worktree-e2e]', ...args);
  const report = { provider, steps: [] };

  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    if (path.resolve(app.getPath('userData')) !== path.resolve(profile))
      throw new Error(`Refusing to run: userData is ${app.getPath('userData')}, not the isolated profile.`);
    let win;
    for (let i = 0; i < 600 && !win; i++) {
      win = BrowserWindow.getAllWindows().find((w) => /dist-react|index\.html/.test(w.webContents.getURL()));
      if (!win) await delay(100);
    }
    if (!win) throw new Error('The app window never loaded the built renderer.');
    win.setSize(1400, 900);
    win.show();
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const shot = async (name) => {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, `${name}.png`), image.toPNG());
    };
    const until = async (code, label, ms = 20_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await js(code).catch(() => false)) return;
        await delay(200);
      }
      await shot(`failed-${label.replace(/\W+/g, '-')}`);
      throw new Error(`Timed out waiting for ${label}`);
    };
    await until('!!(window.electron && window.electron.sendClientEvent)', 'the preload API', 30_000);

    const Database = require('better-sqlite3');
    const query = (sql, ...args) => {
      const db = new Database(path.join(profile, 'sessions.db'), { readonly: true, fileMustExist: true });
      try {
        return db.prepare(sql).all(...args);
      } finally {
        db.close();
      }
    };
    const row = (id) => query('SELECT id, status, agent_worktree_path, cwd FROM sessions WHERE id=?', id)[0];
    const settle = async (id, since) => {
      let quiet = 0;
      while (Date.now() - since < TURN_LIMIT_MS) {
        await delay(2000);
        const current = row(id);
        if (!current) continue;
        if (current.status === 'running' || current.status === 'stopping') {
          quiet = 0;
          continue;
        }
        quiet ||= Date.now();
        if (Date.now() - quiet > 5000) return current;
      }
      throw new Error('The turn did not finish in time.');
    };
    const start = async (title, prompt) => {
      const known = new Set(query('SELECT id FROM sessions').map((r) => r.id));
      const payload = { draftSessionId: `draft-worktree-e2e-${Date.now().toString(36)}`, title, skipTitleGeneration: true, prompt, cwd: repo, projectCwd: repo, scope: 'project', provider, ...(FULL[provider] || {}) };
      const since = Date.now();
      await js(`window.electron.sendClientEvent(${JSON.stringify({ type: 'session.start', payload })})`);
      let id;
      while (!id && Date.now() - since < 60_000) {
        await delay(500);
        id = query('SELECT id FROM sessions WHERE cwd=? ORDER BY created_at DESC LIMIT 1', repo).map((r) => r.id).find((value) => !known.has(value));
      }
      if (!id) throw new Error('The session did not start.');
      log('started', title, id);
      await settle(id, since);
      return id;
    };
    const resume = async (id, prompt) => {
      const since = Date.now();
      await js(`window.electron.sendClientEvent(${JSON.stringify({ type: 'session.continue', payload: { sessionId: id, prompt, provider, ...(FULL[provider] || {}) } })})`);
      await delay(3000);
      await settle(id, since);
    };
    const open = async (id) => {
      await js(`window.electron.openExternalUrl(${JSON.stringify(`aegis://sessions/${id}`)})`);
      await delay(1500);
      // Docked by default, and this button toggles it.
      await js(`if(!document.querySelector('[aria-label="Environment options"]'))document.querySelector('[aria-label="Open environment panel"]')?.click()`);
      await until(`!!document.querySelector('[aria-label="Environment options"]')`, 'the Environment card');
      await js(`window.dispatchEvent(new Event('focus'))`);
    };
    // The card's rows, as the user reads them.
    const card = () => js(`(()=>{
      const section=document.querySelector('[aria-label="Environment options"]').parentElement.parentElement;
      const rows=[...section.querySelectorAll('button')].map(b=>({text:b.innerText.replace(/\\s+/g,' ').trim(),title:b.title})).filter(r=>r.text);
      return rows;
    })()`);
    const step = async (name, id, expected) => {
      const end = Date.now() + 20_000;
      let rows = [];
      while (Date.now() < end) {
        rows = await card().catch(() => []);
        const text = rows.map((r) => r.text);
        if (text.includes(expected.folder) && text.includes(expected.branch)) break;
        await delay(500);
      }
      const current = row(id);
      report.steps.push({ step: name, followed: current.agent_worktree_path, rows });
      log(name, JSON.stringify({ followed: current.agent_worktree_path, rows }));
      await delay(300);
      await shot(name);
      const text = rows.map((r) => r.text);
      assert.ok(text.includes(expected.folder), `${name}: the card names ${expected.folder}, got ${text.join(' | ')}`);
      assert.ok(text.includes(expected.branch), `${name}: the card shows branch ${expected.branch}, got ${text.join(' | ')}`);
      return rows;
    };
    const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));

    try {
      const wt = path.join(repo, '.worktrees/agent-work');
      const LOCAL = { folder: 'Local', branch: 'master' };
      const FOLLOWING = { folder: 'agent-work', branch: 'feat/agent-work' };

      // The reported case: the agent makes a worktree and works there.
      const moved = await start('Agent worktree', MOVE);
      assert.ok(fs.existsSync(path.join(wt, 'hello.txt')), 'the agent worked in the worktree');
      await open(moved);
      const rows = await step('1-follows-agent-worktree', moved, FOLLOWING);
      assert.equal(row(moved).agent_worktree_path, wt);
      assert.equal(rows.find((r) => r.text === 'agent-work').title, wt, 'the row names the full path');
      assert.equal(row(moved).cwd, repo, 'the session folder itself did not move');
      assert.equal(report.steps.at(-1).rows.find((r) => r.text.startsWith('Changes'))?.text, 'Changes +2 -0', 'the changes are the agent\'s');
      // The turn's changes card lists the agent's file, though the session's folder did not change.
      if (provider === 'claude') {
        const patches = query(`SELECT data FROM messages WHERE session_id=? AND data LIKE '%"turn_changes"%'`, moved).map((r) => JSON.parse(r.data).turnChanges.patch);
        assert.ok(patches.some((p) => /^diff --git a\/hello\.txt b\/hello\.txt$/m.test(p)), 'the turn diff covers the worktree, got: ' + JSON.stringify(patches).slice(0, 300));
        assert.ok(!patches.some((p) => /README\.md/.test(p)), 'the user\'s own notes are not the turn\'s');
      }
      await until(`[...document.querySelectorAll('button')].some(b=>/^1 file changed/.test(b.innerText.trim()))`, 'the turn changes card');
      await shot('1b-turn-changes-card');

      // False positives.
      const reader = await start('Reads another repo', READ_ONLY);
      await open(reader);
      await step('2-read-only-stays', reader, LOCAL);
      assert.equal(row(reader).agent_worktree_path, null);
      const scratch = await start('Detached check', DETACHED);
      await open(scratch);
      await step('3-detached-stays', scratch, LOCAL);
      assert.equal(row(scratch).agent_worktree_path, null);

      // Going back, from the row's menu, then forward is not automatic.
      await open(moved);
      await step('4-still-following', moved, FOLLOWING);

      // The rows act on the folder they name: Changes shows the agent's file, not
      // the user's notes, and Commit lands on the agent's branch.
      await js(`[...document.querySelectorAll('[data-environment-panel] button')].find(e=>e.innerText.trim().startsWith('Changes')).click()`);
      const diffPanel = `(()=>{let e=[...document.querySelectorAll('button')].find(b=>b.innerText.trim().startsWith('Uncommitted'));while(e&&!e.innerText.includes('hello.txt'))e=e.parentElement;return e?e.innerText:''})()`;
      await until(`${diffPanel}.includes('hello.txt')`, 'the agent file in Changes');
      await delay(500);
      await shot('4b-changes-panel');
      const diffText = await js(diffPanel);
      assert.ok(!/my own notes|In this git repository/.test(diffText), 'only the worktree\'s changes are listed, got: ' + diffText.slice(0, 200));
      await js(`if(!document.querySelector('[data-environment-panel]'))document.querySelector('[aria-label="Open environment panel"]').click()`);
      await until(`!!document.querySelector('[data-environment-panel]')`, 'the card again');
      await js(`[...document.querySelectorAll('[data-environment-panel] button')].find(e=>e.innerText.trim()==='Commit or push').click()`);
      await until(`!!document.querySelector('textarea[placeholder="Commit message..."], textarea[placeholder="Generating commit message..."]')`, 'the commit dialog');
      await until(`!!document.querySelector('textarea[placeholder="Commit message..."], textarea[placeholder="Generating commit message..."]')`, 'the commit dialog');
      await until(`!!document.querySelector('textarea[placeholder="Commit message..."]')`, 'the commit message', 60_000);
      await js(`(()=>{const t=document.querySelector('textarea[placeholder="Commit message..."]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'From the card');t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
      await delay(200);
      await shot('4c-commit-dialog');
      await js(`[...document.querySelectorAll('[role=dialog] button')].filter(b=>/^(Continue|Commit)$/.test(b.innerText.trim())).pop().click()`);
      const inWorktree = () => execFileSync('git', ['log', '-1', '--format=%s'], { cwd: wt, encoding: 'utf8' }).trim();
      for (let i = 0; i < 40 && inWorktree() !== 'From the card'; i++) await delay(250);
      assert.equal(inWorktree(), 'From the card', 'the commit is on the agent\'s branch');
      assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo, encoding: 'utf8' }).trim(), 'first', 'nothing committed in the session folder');
      assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), /README\.md/, 'the user\'s edit stays uncommitted');
      await delay(1000);
      await shot('4d-after-commit');
      await js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.title===${JSON.stringify(wt)});for(const t of ['pointerdown','mousedown','pointerup','mouseup','click'])b.dispatchEvent(new PointerEvent(t,{bubbles:true,button:0,pointerType:'mouse'}))})()`);
      await until(`[...document.querySelectorAll('[role=menuitem]')].some(e=>e.innerText.includes('Back to Local'))`, 'the Back to Local item');
      await delay(200);
      await shot('5-menu');
      await js(`[...document.querySelectorAll('[role=menuitem]')].find(e=>e.innerText.includes('Back to Local')).click()`);
      await step('6-back-to-local', moved, LOCAL);
      assert.equal(row(moved).agent_worktree_path, null);

      // A later worktree with work is followed, and the card comes back when it goes away.
      await resume(moved, MOVE_AGAIN);
      await open(moved);
      await step('7-follows-second-worktree', moved, { folder: 'second', branch: 'feat/second' });
      await resume(moved, REMOVE);
      assert.equal(fs.existsSync(path.join(repo, '.worktrees/second')), false, 'the agent removed the worktree');
      await step('8-worktree-removed', moved, LOCAL);
      assert.equal(row(moved).agent_worktree_path, null);
      report.ok = true;
      log('passed');
    } catch (error) {
      report.ok = false;
      report.error = String(error && error.stack || error);
      console.error(error);
      await shot('failure').catch(() => {});
    }
    save();
    app.exit(report.ok ? 0 : 1);
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
