// End-to-end check of the design row and board links with a real agent in the
// real app (not part of npm test: it uses your provider account and takes a few
// minutes). The agent draws one board, then two more. Each time it checks the
// row leads the answer and says Published, the answer highlights a board, and
// clicking the highlight shows that board on the canvas beside the chat.
//
// Build first (npx tsc -p src/electron/tsconfig.json && node scripts/build-design-assets.mjs && npx vite build), then:
//   AEGIS_DESIGN_ROW_E2E=claude NODE_OPTIONS="--require ./scripts/smoke-design-chat-row.cjs" \
//     node node_modules/electron/cli.js .
// Results: output/design-chat-row-e2e/ (report.json and a screenshot per step).
// AEGIS_DESIGN_ROW_E2E_WORK=<the temp folder of an earlier run> rechecks its first turn without redrawing it.
const provider = (process.env.AEGIS_DESIGN_ROW_E2E || '').trim();
// NODE_OPTIONS reaches the plain Node launcher too; only Electron's main process runs this.
if (provider && process.versions.electron && process.type === 'browser') setup();

function setup() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'output', 'design-chat-row-e2e');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const reuse = process.env.AEGIS_DESIGN_ROW_E2E_WORK;
  const work = reuse || fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-design-row-e2e-'));
  const profile = path.join(work, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  // The app's own settings, so the provider keeps its configuration; sessions and designs start empty.
  const real = path.join(os.homedir(), 'Library', 'Application Support', 'aegis');
  for (const file of ['app-preferences.json', 'user-profile.json', 'font-settings.json']) {
    try {
      fs.copyFileSync(path.join(real, file), path.join(profile, file));
    } catch {}
  }
  fs.writeFileSync(path.join(profile, 'renderer-state.json'), JSON.stringify({ 'aegis-onboarding-complete': '1' }));
  // Agents' CLIs are child processes: they must not load this file too.
  process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '').replace(/--require\s+\S*smoke-design-chat-row\.cjs/, '').trim();
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
  setImmediate(() => drive({ fs, path, out, work, profile, reuse }));
}

function drive({ fs, path, out, work, profile, reuse }) {
  const assert = require('node:assert/strict');
  const { app, BrowserWindow } = require('electron');

  const FIRST = '给一个咖啡订阅产品画一张定价页的设计稿，画板就叫“定价页”，只要一块画板，桌面尺寸。不用问我问题，直接画，简单一点就好。画完告诉我结果。';
  const SECOND = '再加两块画板，分别叫“结账页”和“订阅成功页”，风格和定价页一致，同样简单一点。不用问我问题。画完告诉我结果。';
  const FULL = {
    claude: { claudeAccessMode: 'fullAccess' },
    codex: { codexPermissionMode: 'fullAccess' },
    grok: { grokPermissionMode: 'yolo' },
    opencode: { opencodePermissionMode: 'fullAccess' },
  };
  const TURN_LIMIT_MS = Number(process.env.AEGIS_DESIGN_ROW_E2E_MINUTES || 15) * 60_000;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...args) => console.log('[design-row-e2e]', ...args);
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
    win.setSize(1500, 950);
    win.show();
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const until = async (code, label, ms = 20_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await js(code).catch(() => false)) return;
        await delay(200);
      }
      await shot(`failed-${label.replace(/\W+/g, '-')}`);
      throw new Error(`Timed out waiting for ${label}`);
    };
    const shot = async (name) => {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, `${name}.png`), image.toPNG());
    };
    await until('!!(window.electron && window.electron.design && window.electron.sendClientEvent)', 'the preload API', 30_000);

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
    const sessionRow = () => query('SELECT id, status FROM sessions WHERE cwd=? ORDER BY created_at DESC LIMIT 1', cwd)[0];
    const settle = async (since) => {
      let quiet = 0;
      while (Date.now() - since < TURN_LIMIT_MS) {
        await delay(2000);
        let row;
        try {
          row = sessionRow();
        } catch {}
        if (!row) continue;
        if (row.status === 'running' || row.status === 'stopping') {
          quiet = 0;
          continue;
        }
        quiet ||= Date.now();
        if (Date.now() - quiet > 6000) return row;
      }
      throw new Error('The turn did not finish in time.');
    };

    const LAST_ROW = '[...document.querySelectorAll("[data-design-card]")].pop()';
    const checkTurn = async (step, expected) => {
      await until(`!!${LAST_ROW}`, `${step}: the design row`);
      const row = await js(`(()=>{
        const card=${LAST_ROW},r=card.getBoundingClientRect();
        const turn=card.closest('[data-message-index]');
        const after=(turn||card).querySelector('.markdown-content');
        const links=[...(after?after.querySelectorAll('.md-design-link'):[])].map(a=>({text:a.textContent,href:a.getAttribute('href')}));
        return {text:card.textContent,above:!!after&&r.bottom<=after.getBoundingClientRect().top,links,answer:after?after.textContent.slice(0,200):''};
      })()`);
      report.steps.push({ step, ...row });
      log(step, JSON.stringify(row));
      await js(`${LAST_ROW}.scrollIntoView({block:'center'})`);
      await delay(400);
      await shot(step);
      assert.ok(row.text.endsWith('Published'), `${step}: the row says Published, got ${row.text}`);
      assert.ok(row.text.includes(expected), `${step}: the row names ${expected}, got ${row.text}`);
      assert.ok(row.above, `${step}: the row leads the answer`);
      assert.ok(row.links.length > 0, `${step}: the answer highlights a board`);
      return row;
    };
    const clickLink = async (step, link) => {
      const boardId = link.href.split('/').pop();
      await js(`[...document.querySelectorAll('.md-design-link')].filter(a=>a.getAttribute('href')===${JSON.stringify(link.href)}).pop().click()`);
      await until('!!document.querySelector("[aria-label=\'Design canvas viewport\']")', `${step}: the canvas beside the chat`);
      await until(`!!document.querySelector('[data-board-id="${boardId}"].is-selected')`, `${step}: the linked board selected on the canvas`);
      await delay(1500);
      await shot(`${step}-canvas`);
    };

    // One board: the row names it.
    let started = Date.now();
    let session;
    if (reuse) {
      session = sessionRow();
    } else {
      const payload = { draftSessionId: `draft-design-row-e2e-${Date.now().toString(36)}`, title: 'Design row e2e', skipTitleGeneration: true, prompt: FIRST, cwd, projectCwd: cwd, scope: 'project', provider, ...(FULL[provider] ?? {}) };
      await js(`window.electron.sendClientEvent(${JSON.stringify({ type: 'session.start', payload })})`);
      log('started', provider);
      session = await settle(started);
      log('first turn done', ((Date.now() - started) / 60000).toFixed(1), 'min');
    }
    report.sessionId = session.id;
    await js(`window.electron.openExternalUrl(${JSON.stringify(`aegis://sessions/${session.id}`)})`);
    const one = await checkTurn('1-one-board', '定价页');
    await clickLink('1-one-board', one.links[0]);

    // Several boards: the row names the design.
    await js(`window.electron.sendClientEvent(${JSON.stringify({ type: 'session.continue', payload: { sessionId: session.id, prompt: SECOND, provider } })})`);
    log('asked for two more boards');
    started = Date.now();
    await delay(3000);
    session = await settle(started);
    log('second turn done', ((Date.now() - started) / 60000).toFixed(1), 'min');
    await until(`document.querySelectorAll("[data-design-card]").length>=2`, 'a second design row');
    const title = (await js('window.electron.design.listAll()')).map((d) => d.title)[0];
    const many = await checkTurn('2-several-boards', title);
    await clickLink('2-several-boards', many.links[many.links.length - 1]);

    // Did the agent write the links, or did the app make them?
    const raw = query("SELECT data FROM messages WHERE session_id=? AND data LIKE '%aegis://designs/%'", session.id);
    report.agentWroteLinks = raw.length;
    report.ok = true;
  }).catch(async (error) => {
    report.ok = false;
    report.error = error instanceof Error ? error.message : String(error);
    console.error('[design-row-e2e]', error);
  }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    log(report.ok ? 'PASS' : 'FAIL', report.error ?? '');
    app.exit(report.ok ? 0 : 1);
  });
}
