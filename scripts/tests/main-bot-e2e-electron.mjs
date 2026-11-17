// End-to-end: the main bot's conversation hands two pieces of work to tasks in
// two projects, hears back from both, then sends one of them a follow-up.
// Real main process, real Bubble and a real worker agent, throwaway
// repositories. Uses agent usage, so it is not part of `npm test`.
//
//   npm run probe:main-bot-e2e
//
// MAIN_BOT_MODEL picks the bot's Bubble model (default: Bubble's own default).
// MAIN_BOT_WORKER (default claude) and MAIN_BOT_WORKER_MODEL (default haiku
// for Claude) pick the agent the tasks go to.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const botModel = process.env.MAIN_BOT_MODEL || null;
const worker = process.env.MAIN_BOT_WORKER || 'claude';
const workerModel = process.env.MAIN_BOT_WORKER_MODEL || (worker === 'claude' ? 'haiku' : null);
// The composer's remembered choices for the worker: full access, so a task
// that stops for approval shows the bot did not start it the way the composer would.
const cap = worker.charAt(0).toUpperCase() + worker.slice(1);
const fullAccess = {
  claude: 'fullAccess', codex: 'fullAccess', opencode: 'fullAccess', kimi: 'yolo', grok: 'yolo', deepseek: 'danger-full-access',
  devin: 'bypass', mimo: 'build', minimax: 'bypassPermissions', qoder: 'bypassPermissions', bubble: 'bypassPermissions',
}[worker];
const desktop = {
  'cowork.preferredProvider': worker,
  ...(workerModel ? { [`cowork.preferred${cap}Model`]: workerModel } : {}),
  ...(fullAccess ? { [`cowork.preferred${worker === 'grok' ? 'Kimi' : cap}PermissionMode`]: fullAccess } : {}),
};

const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aegis-main-bot-')));
const projects = { alpha: path.join(tmp, 'alpha'), notes: path.join(tmp, 'notes') };
for (const [name, folder] of Object.entries(projects)) {
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'README.md'), `# ${name}\n`);
  if (name === 'notes') continue;
  const git = (...args) => execFileSync('git', args, { cwd: folder, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  git('add', '-A');
  git('commit', '-qm', 'init');
}
await mkdir(path.join(tmp, 'profile'), { recursive: true });
await writeFile(path.join(tmp, 'profile', 'renderer-state.json'), JSON.stringify(desktop));

const first = [
  'Two things, please:',
  '1. In project alpha: create DONE.txt containing the word alpha. No commit.',
  '2. In project notes: create DONE.txt containing the word notes.',
].join('\n');
const second = 'Tell the alpha task to also create NOTE.txt containing the word ok, in the same place as DONE.txt.';

const appDir = path.join(tmp, 'app');
await mkdir(path.join(appDir, 'dist-react'), { recursive: true });
await writeFile(path.join(appDir, 'dist-react', 'index.html'), '<!doctype html><html><body>main bot e2e</body></html>');
await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'main-bot-e2e', main: 'main.cjs' }));
await writeFile(
  path.join(appDir, 'main.cjs'),
  `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = ${JSON.stringify(root)};
const PROJECTS = ${JSON.stringify(projects)};
app.setPath('userData', path.join(${JSON.stringify(tmp)}, 'profile'));
require(path.join(ROOT, 'dist-electron/electron/libs/shell-environment.js')).ensureShellEnvironment();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(ROOT, 'dist-electron/electron/preload.cjs') } });
  await win.loadFile(path.join(__dirname, 'dist-react', 'index.html'));
  require(path.join(ROOT, 'dist-electron/electron/ipc-handlers.js')).setupIPCHandlers(win);
  const sessions = require(path.join(ROOT, 'dist-electron/electron/libs/session-store.js'));
  require(path.join(ROOT, 'dist-electron/electron/libs/app-preferences.js')).setAppPreferences({ chatsFolder: path.join(${JSON.stringify(tmp)}, 'chats') });
  // The user already has these projects: they come from earlier sessions.
  for (const folder of Object.values(PROJECTS)) sessions.createSession({ title: 'Earlier', cwd: folder, projectCwd: folder, provider: ${JSON.stringify(worker)} });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await js('window.__asks = []; window.__errors = []; window.electron.onServerEvent((e) => { if (e.type === "permission.request") window.__asks.push({ sessionId: e.payload.sessionId, tool: e.payload.toolName }); if (e.type === "runner.error") window.__errors.push(e.payload.message); }); 0');
  const main = await js('window.electron.openMainBot()');
  console.log('[main-bot] conversation:', JSON.stringify({ id: main.id, provider: main.provider, isChat: main.isChat, cwd: main.cwd }));
  const BOT_MODEL = ${JSON.stringify(botModel)};
  const say = (prompt) => js('window.electron.sendClientEvent(' + JSON.stringify({ type: 'session.continue', payload: {
    sessionId: main.id, prompt, provider: 'bubble', ...(BOT_MODEL ? { model: BOT_MODEL } : {}), bubblePermissionMode: 'default',
  } }) + '); 0');
  const history = () => sessions.getSessionHistory(main.id);
  const calls = (name) => history().flatMap((m) => m.type === 'assistant' ? ((m.message && m.message.content) || []).filter((b) => b.type === 'tool_use' && b.name === name) : []);
  const reports = () => history().filter((m) => m.type === 'user_prompt' && m.workflowPrompt === 'follow-up');
  const watches = () => sessions.getDatabase().prepare('SELECT task_id, title, report_status FROM main_bot_watches').all();
  const idle = () => { const row = sessions.getSession(main.id); return row && row.status !== 'running'; };
  // Until the bot has heard back about everything it handed out and has answered.
  const settle = async (label, wantReports, minutes) => {
    const deadline = Date.now() + minutes * 60_000;
    let last = '';
    let quiet = 0;
    while (Date.now() < deadline) {
      await delay(3000);
      const line = 'starts ' + calls('start_task').length + ' · messages ' + calls('message_task').length + ' · reports ' + reports().length + ' · waiting on ' + watches().length + ' · ' + (idle() ? 'idle' : 'working');
      if (line !== last) { console.log('[main-bot] ' + label + ': ' + line); last = line; }
      if (reports().length >= wantReports && watches().length === 0 && idle()) { if (++quiet > 1) return true; } else quiet = 0;
    }
    return false;
  };
  const taskRows = () => sessions.listSessions().filter((row) => row.id !== main.id && row.title !== 'Earlier');
  const fileIn = (row, name) => row && row.cwd && fs.existsSync(path.join(row.cwd, name)) ? fs.readFileSync(path.join(row.cwd, name), 'utf8').trim() : null;

  await say(${JSON.stringify(first)});
  const firstDone = await settle('first', 1, 6);
  const tasks = taskRows();
  const alpha = tasks.find((row) => row.project_cwd === PROJECTS.alpha);
  const notes = tasks.find((row) => row.project_cwd === PROJECTS.notes);
  const describe = (row) => row && { title: row.title, provider: row.provider, model: row.model, cwd: row.cwd, envMode: row.env_mode, access: row.claude_access_mode, status: row.status, done: fileIn(row, 'DONE.txt') };
  console.log('[main-bot] start_task calls:', JSON.stringify(calls('start_task').map((b) => b.input)));
  console.log('[main-bot] alpha:', JSON.stringify(describe(alpha)));
  console.log('[main-bot] notes:', JSON.stringify(describe(notes)));
  console.log('[main-bot] reports:', JSON.stringify(reports().map((m) => m.prompt)));

  let secondDone = false;
  if (firstDone && alpha) {
    const before = reports().length;
    await say(${JSON.stringify(second)});
    secondDone = await settle('second', before + 1, 5);
    console.log('[main-bot] message_task calls:', JSON.stringify(calls('message_task').map((b) => b.input)));
    console.log('[main-bot] alpha NOTE.txt:', JSON.stringify(fileIn(alpha, 'NOTE.txt')));
  }
  const asks = await js('window.__asks');
  const errors = await js('window.__errors');
  console.log('[main-bot] approvals asked:', JSON.stringify(asks));
  console.log('[main-bot] errors:', JSON.stringify(errors));
  console.log('[main-bot] projects offered:', JSON.stringify(sessions.listProjects()));
  const checks = {
    'the bot heard back about the first two tasks': firstDone,
    'two tasks were started': calls('start_task').length === 2 && tasks.length === 2,
    'alpha ran in its own worktree and did the work': Boolean(alpha && alpha.env_mode === 'worktree' && alpha.cwd.startsWith(PROJECTS.alpha + '/') && fileIn(alpha, 'DONE.txt') === 'alpha'),
    'notes ran in its folder and did the work': Boolean(notes && notes.cwd === PROJECTS.notes && fileIn(notes, 'DONE.txt') === 'notes'),
    'tasks went to the agent used in those projects': tasks.every((row) => row.provider === ${JSON.stringify(worker)}),
    'no task stopped for approval': !asks.some((ask) => tasks.some((row) => row.id === ask.sessionId)),
    'the bot was not asked to approve its own tools': !asks.some((ask) => ask.sessionId === main.id),
    'the follow-up reached the alpha task and came back': secondDone && calls('message_task').length >= 1 && fileIn(alpha, 'NOTE.txt') === 'ok',
    "the bot's folder is not offered as a project": !sessions.listProjects().some((folder) => folder === main.cwd),
  };
  for (const [name, passed] of Object.entries(checks)) console.log('[main-bot] ' + (passed ? 'ok  ' : 'FAIL') + ' ' + name);
  const ok = Object.values(checks).every(Boolean);
  console.log('[main-bot]', ok ? 'PASS' : 'FAIL');
  app.exit(ok ? 0 : 1);
});
`,
);
const child = spawn(path.join(root, 'node_modules', '.bin', 'electron'), [appDir], { stdio: 'inherit', env: { ...process.env, AEGIS_E2E: '1' } });
child.on('exit', (code) => {
  console.log(`[main-bot] artifacts in ${tmp}`);
  process.exit(code ?? 1);
});
