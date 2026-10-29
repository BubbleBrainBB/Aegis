// Manual smoke test of design projects with real agents in the real app (not
// part of npm test: it uses your provider accounts and takes a while). For
// each provider it starts a Design view chat with the same request, answers
// "decide for me" if the agent asks first, waits until the chat is idle (the
// background review may send it back to work), then checks the project it made
// and saves a screenshot of its main page.
//
// Build first (npx tsc -p src/electron/tsconfig.json && node scripts/build-design-assets.mjs && npx vite build), then:
//   AEGIS_DESIGN_SMOKE=claude,codex,kimi NODE_OPTIONS="--require ./scripts/smoke-design-projects.cjs" \
//     node node_modules/electron/cli.js .
// Results: output/design-smoke/<provider>/ (report.json, page.png) and output/design-smoke/summary.json.
const wanted = (process.env.AEGIS_DESIGN_SMOKE || '').split(',').map((s) => s.trim()).filter(Boolean);
// NODE_OPTIONS reaches the plain Node launcher too; only Electron's main process runs this.
if (wanted.length && process.versions.electron && process.type === 'browser') setup();

function setup() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'output', 'design-smoke');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-design-smoke-'));
  const profile = path.join(work, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  // The app's own settings, so providers keep their configuration; sessions and designs start empty.
  const real = path.join(os.homedir(), 'Library', 'Application Support', 'aegis');
  for (const file of ['app-preferences.json', 'aegis-built-in-agent.json', 'claude-compatible-provider.json', 'codex-model-visibility.json', 'opencode-model-visibility.json', 'user-profile.json', 'font-settings.json']) {
    try {
      fs.copyFileSync(path.join(real, file), path.join(profile, file));
    } catch {}
  }
  // Agents' CLIs are child processes: they must not load this file too.
  process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '').replace(/--require\s+\S*smoke-design-projects\.cjs/, '').trim();
  if (!process.env.NODE_OPTIONS) delete process.env.NODE_OPTIONS;
  // Set now, before the app's main script reads them; never touch the real or dev profile.
  process.env.AEGIS_USER_DATA_DIR = profile;
  // No dev server: the app loads the built renderer.
  process.env.DEV_SERVER_URL = 'http://127.0.0.1:9';
  // The electron module isn't ready while --require modules load: drive the app once its main script runs.
  setImmediate(() => drive({ fs, os, path, root, out, work, profile }));
}

function drive({ fs, os, path, root, out, work, profile }) {
  const { app, BrowserWindow } = require('electron');

  const REQUEST = [
    '帮我开发一款Reader Mac App，帮助我更好的阅读和收藏文章。数据都在本地。做成可点击的交互原型（HTML）。',
    '## 信息采集\n1. 主动添加：URL（自动抓取内容和图片）、附件（PDF、视频、图片）、Markdown 编辑（标题、内容、图片）\n2. 自动订阅：RSS、社交媒体账号（X、微博、YouTube）',
    '## 信息编辑和分类\n1. 标签：每条内容都可以打标签\n2. 分类、目录：树形目录\n3. 收藏\n4. 编辑：内置 Markdown 编辑',
    '## AI 辅助\n1. 自动翻译\n2. 总结和摘要\n3. 二次创作：基于一条或多条内容\n4. 集成 AI Chat：调用 AI Agent 辅助处理内容',
  ].join('\n\n');
  const DECIDE = 'Decide for me: take sensible defaults for every open question (one direction, light theme, realistic sample content in Chinese and English) and build it now as an interactive prototype. Do not ask more questions.';
  const FULL = {
    claude: { claudeAccessMode: 'fullAccess' },
    codex: { codexPermissionMode: 'fullAccess' },
    opencode: { opencodePermissionMode: 'fullAccess' },
    kimi: { kimiPermissionMode: 'yolo' },
    grok: { grokPermissionMode: 'yolo' },
    pi: {},
    qoder: { qoderPermissionMode: 'yolo' },
    bubble: { bubblePermissionMode: 'bypassPermissions' },
    deepseek: { deepseekPermissionMode: 'danger-full-access' },
    devin: { devinPermissionMode: 'bypass' },
    mimo: { mimoPermissionMode: 'build' },
    minimax: { minimaxPermissionMode: 'bypassPermissions' },
  };
  const PARALLEL = Math.max(1, Number(process.env.AEGIS_DESIGN_SMOKE_PARALLEL || 3));
  const TURN_LIMIT_MS = Number(process.env.AEGIS_DESIGN_SMOKE_MINUTES || 30) * 60_000;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...args) => console.log('[design-smoke]', ...args);

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
    const js = (code) => win.webContents.executeJavaScript(code, true);
    for (let i = 0; i < 300; i++) {
      if (await js('!!(window.electron && window.electron.design && window.electron.sendClientEvent)').catch(() => false)) break;
      await delay(100);
    }
    const dist = path.join(root, 'dist-electron');
    const { getDesignRepository } = require(path.join(dist, 'electron/design/service.js'));
    const { captureProjectPage } = require(path.join(dist, 'electron/design/project/capture.js'));
    const { pageUrl } = require(path.join(dist, 'electron/design/project/service.js'));
    const Database = require('better-sqlite3');
    const sessionRow = (cwd) => {
      const db = new Database(path.join(profile, 'sessions.db'), { readonly: true, fileMustExist: true });
      try {
        return db.prepare('SELECT id, status FROM sessions WHERE cwd=? ORDER BY created_at DESC LIMIT 1').get(cwd);
      } finally {
        db.close();
      }
    };
    const projectIn = (cwd) => getDesignRepository().listAll().find((d) => d.kind === 'project' && d.folder && d.folder.startsWith(cwd));
    // Idle for a while: the turn ended and no review sent it back to work.
    const settle = async (cwd, since) => {
      let quietSince = 0;
      while (Date.now() - since < TURN_LIMIT_MS) {
        await delay(2000);
        let row;
        try {
          row = sessionRow(cwd);
        } catch {}
        if (!row) continue;
        if (row.status === 'running' || row.status === 'stopping') {
          quietSince = 0;
          continue;
        }
        quietSince ||= Date.now();
        if (Date.now() - quietSince > 75_000) return row;
      }
      return sessionRow(cwd) ?? null;
    };

    const runOne = async (provider) => {
      const started = Date.now();
      const cwd = path.join(work, 'repos', provider);
      fs.mkdirSync(cwd, { recursive: true });
      const draft = `draft-design-smoke-${provider}-${Date.now().toString(36)}`;
      const report = { provider, steps: [] };
      try {
        const payload = { draftSessionId: draft, title: `Design smoke · ${provider}`, skipTitleGeneration: true, prompt: REQUEST, cwd, projectCwd: cwd, scope: 'project', provider, ...(FULL[provider] ?? {}) };
        await js(`window.electron.sendClientEvent(${JSON.stringify({ type: 'session.start', payload })})`);
        log(provider, 'started');
        let row = await settle(cwd, started);
        report.steps.push({ step: 'first turn', status: row?.status, minutes: +((Date.now() - started) / 60000).toFixed(1) });
        let project = projectIn(cwd);
        if (row && (!project || !(project.pages || []).length)) {
          // The agent asked first (the design instructions tell it to): decide for it.
          report.asked = true;
          await js(`window.electron.sendClientEvent(${JSON.stringify({ type: 'session.continue', payload: { sessionId: row.id, prompt: DECIDE, provider } })})`);
          log(provider, 'answered "decide for me"');
          const again = Date.now();
          row = await settle(cwd, again);
          report.steps.push({ step: 'after decide', status: row?.status, minutes: +((Date.now() - again) / 60000).toFixed(1) });
          project = projectIn(cwd);
        }
        report.sessionId = row?.id;
        if (!project) throw new Error('No design project was created.');
        const doc = getDesignRepository().read(project.sessionId, project.id);
        const history = getDesignRepository().history(project.sessionId, project.id);
        report.project = { title: doc.title, folder: doc.folder, pages: project.pages, files: (doc.files || []).map((f) => f.path), versions: history.length };
        const page = (project.pages || [])[0];
        if (!page) throw new Error('The project has no pages.');
        const url = await pageUrl(doc, page);
        const shot = await captureProjectPage(url, { width: 1440, height: 900, maxDimension: 1440 });
        fs.mkdirSync(path.join(out, provider), { recursive: true });
        fs.writeFileSync(path.join(out, provider, 'page.png'), Buffer.from(shot.dataUrl.split(',')[1], 'base64'));
        report.page = { path: page, errors: shot.errors, warnings: shot.warnings, title: shot.title };
        report.ok = shot.errors.length === 0;
      } catch (error) {
        report.ok = false;
        report.error = error instanceof Error ? error.message : String(error);
      }
      report.minutes = +((Date.now() - started) / 60000).toFixed(1);
      fs.mkdirSync(path.join(out, provider), { recursive: true });
      fs.writeFileSync(path.join(out, provider, 'report.json'), JSON.stringify(report, null, 2));
      log(provider, report.ok ? 'ok' : 'FAILED', report.error ?? '', `${report.minutes} min`);
      return report;
    };

    const queue = [...wanted];
    const results = [];
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
        while (queue.length) results.push(await runOne(queue.shift()));
      }),
    );
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(results.map(({ steps, ...r }) => r), null, 2));
    log('done', JSON.stringify(results.map((r) => [r.provider, r.ok, r.error ?? ''])));
    app.exit(results.every((r) => r.ok) ? 0 : 1);
  }).catch((error) => {
    console.error('[design-smoke]', error);
    app.exit(1);
  });
}
