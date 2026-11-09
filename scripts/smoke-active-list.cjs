// End-to-end check of the sidebar's Active list with a real agent in the real
// app (not part of npm test: it uses your provider account and takes a few
// minutes). Two short tasks run one after the other. Each lands on top of the
// list as it starts, stays there after you have read its answer, and leaves
// only when you mark it Completed.
//
// Build first (npx tsc -p src/electron/tsconfig.json && node scripts/build-design-assets.mjs && npx vite build), then:
//   AEGIS_ACTIVE_LIST_E2E=claude NODE_OPTIONS="--require ./scripts/smoke-active-list.cjs" \
//     node node_modules/electron/cli.js .
// Results: output/active-list-e2e/ (report.json and a screenshot per step).
const provider = (process.env.AEGIS_ACTIVE_LIST_E2E || '').trim();
// NODE_OPTIONS reaches the plain Node launcher too; only Electron's main process runs this.
if (provider && process.versions.electron && process.type === 'browser') setup();

function setup() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'output', 'active-list-e2e');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-active-list-e2e-'));
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
  process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '').replace(/--require\s+\S*smoke-active-list\.cjs/, '').trim();
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
  const { app, BrowserWindow } = require('electron');

  const FULL = {
    claude: { claudeAccessMode: 'fullAccess' },
    codex: { codexPermissionMode: 'fullAccess' },
    opencode: { opencodePermissionMode: 'fullAccess' },
  };
  const TURN_LIMIT_MS = Number(process.env.AEGIS_ACTIVE_LIST_E2E_MINUTES || 5) * 60_000;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...args) => console.log('[active-list-e2e]', ...args);
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
    win.setSize(1280, 760);
    win.show();
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const shot = async (name) => {
      await delay(300);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, `${name}.png`), image.toPNG());
    };
    const until = async (code, label, ms = 30_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await js(code).catch(() => false)) return;
        await delay(200);
      }
      await shot(`failed-${label.replace(/\W+/g, '-')}`);
      throw new Error(`Timed out waiting for ${label}`);
    };
    await until('!!(window.electron && window.electron.sendClientEvent)', 'the preload API');

    const Database = require('better-sqlite3');
    const query = (sql, ...args) => {
      const db = new Database(path.join(profile, 'sessions.db'), { readonly: true, fileMustExist: true });
      try {
        return db.prepare(sql).all(...args);
      } finally {
        db.close();
      }
    };
    const cwd = path.join(work, 'repo');
    fs.mkdirSync(cwd, { recursive: true });

    const row = (id) => `document.querySelector('[data-active-tasks] [data-session-id="${id}"]')`;
    const activeRows = () => js('[...document.querySelectorAll("[data-active-tasks] [data-session-id]")].map(e=>({id:e.dataset.sessionId,state:e.dataset.taskState,title:e.title}))');
    const step = async (name, extra = {}) => {
      const rows = await activeRows();
      report.steps.push({ name, rows, ...extra });
      log(name, JSON.stringify(rows));
      await shot(name);
      return rows;
    };
    const start = async (title, prompt) => {
      const payload = { draftSessionId: `draft-active-e2e-${Date.now().toString(36)}`, title, skipTitleGeneration: true, prompt, cwd, projectCwd: cwd, scope: 'project', provider, ...(FULL[provider] ?? {}) };
      await js(`window.electron.sendClientEvent(${JSON.stringify({ type: 'session.start', payload })})`);
      let id;
      for (let i = 0; i < 150 && !id; i++) {
        try { id = query('SELECT id FROM sessions WHERE title=? ORDER BY created_at DESC LIMIT 1', title)[0]?.id; } catch {}
        if (!id) await delay(200);
      }
      if (!id) throw new Error(`${title} never started.`);
      return id;
    };
    const settle = async (id) => {
      const since = Date.now();
      let quiet = 0;
      while (Date.now() - since < TURN_LIMIT_MS) {
        await delay(1500);
        const status = query('SELECT status FROM sessions WHERE id=?', id)[0]?.status;
        if (status === 'running' || status === 'stopping' || !status) { quiet = 0; continue; }
        quiet ||= Date.now();
        if (Date.now() - quiet > 4000) return status;
      }
      throw new Error('The turn did not finish in time.');
    };
    // Open the task from the sidebar and stay on it well past the moment the app marks its result seen.
    const read = async (id) => {
      await js(`${row(id)}.click()`);
      await until(`${row(id)}?.getAttribute('aria-current')==='page'`, 'the task open');
      await delay(5000);
    };

    // First task: on the list while it runs, and still there after you read its answer.
    const a = await start('Say hello', 'Reply with just the word hello. Do not use any tools.');
    await until(`${row(a)}?.dataset.taskState==='running'`, 'the first task running in Active');
    await step('1-first-task-running');
    await settle(a);
    await read(a);
    let rows = await step('2-first-task-read-stays');
    assert.equal(rows.find((r) => r.id === a)?.state, 'review', 'a task you have read stays in Active, ready for review');

    // Second task: on top as soon as it starts, not under the older one.
    const b = await start('Say goodbye', 'Reply with just the word goodbye. Do not use any tools.');
    await until(`${row(b)}?.dataset.taskState==='running'`, 'the second task running in Active');
    rows = await step('3-new-task-on-top');
    assert.deepEqual(rows.map((r) => r.id), [b, a], 'the task just started is on top');
    await settle(b);
    await read(b);
    rows = await step('4-both-read-both-stay');
    assert.deepEqual(rows.map((r) => [r.id, r.state]), [[b, 'review'], [a, 'review']], 'both stay, newest first');

    // Closing by hand is what takes a task off the list.
    await js(`${row(a)}.querySelector('[data-task-status-trigger]').click()`);
    await until('!!document.querySelector("[data-task-status-menu]")', 'the status menu');
    await step('5-change-status-menu');
    await js('document.querySelector("[data-task-status-menu] [data-task-status-option=completed]").click()');
    await until(`!${row(a)}`, 'the closed task leaving Active');
    rows = await step('6-closed-task-leaves');
    assert.deepEqual(rows.map((r) => r.id), [b], 'only the task still open is left');

    report.organization = query('SELECT session_id, manual_status, kept_open FROM session_organization WHERE session_id IN (?, ?)', a, b);
    const org = Object.fromEntries(report.organization.map((r) => [r.session_id, r]));
    assert.equal(org[a].manual_status, 'completed');
    assert.equal(org[b].kept_open, 1);
    report.ok = true;
  }).catch(async (error) => {
    report.ok = false;
    report.error = error instanceof Error ? error.message : String(error);
    console.error('[active-list-e2e]', error);
  }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    log(report.ok ? 'PASS' : 'FAIL', report.error ?? '');
    app.exit(report.ok ? 0 : 1);
  });
}
