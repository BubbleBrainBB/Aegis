// End-to-end check of task titles with real agents in the real app (not part
// of npm test: it uses your provider accounts and takes a few minutes). For
// each agent a task starts, shows a loading bar where its title goes, then the
// title the agent itself wrote. The check also looks in the agent's own
// history: naming the task must not leave a conversation of its own there.
//
// Build first (npx tsc -p src/electron/tsconfig.json && node scripts/build-design-assets.mjs && npx vite build), then:
//   AEGIS_TITLES_E2E=claude,codex NODE_OPTIONS="--require ./scripts/smoke-session-titles.cjs" \
//     node node_modules/electron/cli.js .
// Results: output/session-titles-e2e/ (report.json and a screenshot per step).
const providers = (process.env.AEGIS_TITLES_E2E || '').split(',').map((p) => p.trim()).filter(Boolean);
// NODE_OPTIONS reaches the plain Node launcher too; only Electron's main process runs this.
if (providers.length && process.versions.electron && process.type === 'browser') setup();

function setup() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'output', 'session-titles-e2e');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-session-titles-e2e-'));
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
  process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '').replace(/--require\s+\S*smoke-session-titles\.cjs/, '').trim();
  if (!process.env.NODE_OPTIONS) delete process.env.NODE_OPTIONS;
  // Started from inside an agent session: the agent under test must not think it is nested.
  for (const key of Object.keys(process.env)) {
    if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID$|CLAUDE_EFFORT$|AEGIS_SESSION_|AEGIS_BROWSER_)/.test(key)) delete process.env[key];
  }
  // Set now, before the app's main script reads them; never touch the real or dev profile.
  process.env.AEGIS_USER_DATA_DIR = profile;
  // No dev server: the app loads the built renderer.
  process.env.DEV_SERVER_URL = 'http://127.0.0.1:9';
  // The electron module isn't ready while --require modules load: drive the app once its main script runs.
  setImmediate(() => drive({ fs, path, out, work, profile }));
}

function drive({ fs, path, out, work, profile }) {
  const assert = require('node:assert/strict');
  const os = require('node:os');
  const { app, BrowserWindow } = require('electron');

  const FULL = { claude: { claudeAccessMode: 'fullAccess' }, codex: { codexPermissionMode: 'fullAccess' } };
  const PROMPT = '侧边栏里新派发的任务排在最下面，等任务完成了才跳到最上面，这是为什么？只用一句话回答，不要用工具，不要改代码。';
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...args) => console.log('[session-titles-e2e]', ...args);
  const report = { providers, runs: [] };
  // Each agent's own history on disk: new conversations that mention this run's folder.
  const HISTORY = {
    claude: path.join(os.homedir(), '.claude', 'projects'),
    codex: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
  };
  const listFiles = (dir) => {
    const found = [];
    const walk = (d) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.jsonl')) found.push(p);
      }
    };
    walk(dir);
    return found;
  };

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
    win.setSize(1280, 760);
    win.show();
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const shot = async (name) => {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, `${name}.png`), image.toPNG());
    };
    const until = async (code, label, ms = 60_000, every = 50) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await js(code).catch(() => false)) return;
        await delay(every);
      }
      await shot(`failed-${label.replace(/\W+/g, '-')}`);
      throw new Error(`Timed out waiting for ${label}`);
    };
    await until('!!(window.electron && window.electron.sendClientEvent)', 'the preload API');

    const Database = require('better-sqlite3');
    const query = (sql, ...args) => {
      const db = new Database(path.join(profile, 'sessions.db'), { readonly: true, fileMustExist: true });
      try { return db.prepare(sql).all(...args); } finally { db.close(); }
    };

    for (const provider of providers) {
      const cwd = path.join(work, `repo-${provider}`);
      fs.mkdirSync(cwd, { recursive: true });
      const before = new Set(listFiles(HISTORY[provider]));
      const draftSessionId = `draft-titles-e2e-${provider}-${Date.now().toString(36)}`;
      const payload = { draftSessionId, prompt: PROMPT, cwd, projectCwd: cwd, scope: 'project', provider, ...(FULL[provider] ?? {}) };
      const started = Date.now();
      await js(`window.electron.sendClientEvent(${JSON.stringify({ type: 'session.start', payload })})`);
      let id;
      for (let i = 0; i < 300 && !id; i++) {
        try { id = query('SELECT id FROM sessions WHERE cwd=? ORDER BY created_at DESC LIMIT 1', cwd)[0]?.id; } catch {}
        if (!id) await delay(50);
      }
      if (!id) throw new Error(`${provider}: the task never started.`);
      const row = `document.querySelector('[data-active-tasks] [data-session-id="${id}"]')`;
      await until(`!!${row}`, `${provider}: the task in Active`);
      const sawLoading = await js(`!!${row}.querySelector('[data-title-loading]')`);
      if (sawLoading) await shot(`${provider}-1-naming`);
      await until(`!!${row} && !${row}.querySelector('[data-title-loading]')`, `${provider}: the title`, 45_000, 100);
      const namedAfterMs = Date.now() - started;
      await delay(400);
      await shot(`${provider}-2-named`);
      const title = query('SELECT title FROM sessions WHERE id=?', id)[0]?.title;
      assert.ok(await js(`${row}.textContent.includes(${JSON.stringify(title)})`), `${provider}: the sidebar shows the title`);
      // Let the task's own turn finish, so its history is all written.
      for (let i = 0; i < 240; i++) {
        const status = query('SELECT status FROM sessions WHERE id=?', id)[0]?.status;
        if (status && status !== 'running' && status !== 'stopping') break;
        await delay(1000);
      }
      await delay(3000);
      const added = listFiles(HISTORY[provider]).filter((file) => !before.has(file));
      const mentions = added.filter((file) => {
        try { return fs.readFileSync(file, 'utf8').includes(path.basename(cwd)); } catch { return false; }
      });
      const run = { provider, sessionId: id, title, sawLoading, namedAfterMs, historyAdded: mentions.length, historyFiles: mentions };
      report.runs.push(run);
      log(JSON.stringify(run));
      assert.ok(title && !/[<>]/.test(title), `${provider}: a clean title, got ${title}`);
      assert.notEqual(title, '侧边栏里新派发的任务排在最下面，等任务完成了才跳到最上面，这是为什么？'.slice(0, 49) + '…', `${provider}: the agent named it, not the fallback`);
      assert.equal(mentions.length, 1, `${provider}: only the task's own conversation is in the agent's history`);
    }
    report.ok = true;
  }).catch(async (error) => {
    report.ok = false;
    report.error = error instanceof Error ? error.message : String(error);
    console.error('[session-titles-e2e]', error);
  }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    log(report.ok ? 'PASS' : 'FAIL', report.error ?? '');
    app.exit(report.ok ? 0 : 1);
  });
}
