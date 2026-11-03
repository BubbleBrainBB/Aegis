// End-to-end: a conversation with no project starts tasks in other projects
// through start_session. Real main process, real Claude login, throwaway
// repositories. Uses agent usage, so it is not part of `npm test`.
//
//   npm run probe:task-first-e2e
//
// TASK_FIRST_PROVIDER (default claude) picks the agent and TASK_FIRST_MODEL the
// model (default haiku for Claude, the agent's own default otherwise).
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const provider = process.env.TASK_FIRST_PROVIDER || 'claude';
const model = process.env.TASK_FIRST_MODEL || (provider === 'claude' ? 'haiku' : undefined);
// Full access, so that a task stopping for approval means it lost the conversation's mode.
const access = {
  claude: { claudeAccessMode: 'fullAccess' }, codex: { codexPermissionMode: 'fullAccess' }, opencode: { opencodePermissionMode: 'fullAccess' },
  kimi: { kimiPermissionMode: 'yolo' }, grok: { grokPermissionMode: 'yolo' }, deepseek: { deepseekPermissionMode: 'danger-full-access' },
  devin: { devinPermissionMode: 'bypass' }, mimo: { mimoPermissionMode: 'build' }, minimax: { minimaxPermissionMode: 'bypassPermissions' },
  qoder: { qoderPermissionMode: 'bypassPermissions' }, bubble: { bubblePermissionMode: 'bypassPermissions' }, pi: {},
}[provider];
const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aegis-task-first-')));
const projects = { alpha: path.join(tmp, 'alpha'), beta: path.join(tmp, 'beta'), notes: path.join(tmp, 'notes') };
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
const prompt = [
  'Start two separate sessions, one per project:',
  '1. In project alpha: create DONE.txt containing the word alpha.',
  '2. In project notes: create DONE.txt containing the word notes.',
  'Each session should only do that, without committing. When their results come back, list them in one line each.',
].join('\n');

const appDir = path.join(tmp, 'app');
await mkdir(path.join(appDir, 'dist-react'), { recursive: true });
await writeFile(path.join(appDir, 'dist-react', 'index.html'), '<!doctype html><html><body>task first e2e</body></html>');
await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'task-first-e2e', main: 'main.cjs' }));
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
  for (const folder of Object.values(PROJECTS)) sessions.createSession({ title: 'Earlier', cwd: folder, projectCwd: folder, provider: 'claude' });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await js('window.electron.sendClientEvent(' + JSON.stringify({ type: 'session.start', payload: {
    chat: true, title: 'This week', skipTitleGeneration: true, provider: ${JSON.stringify(provider)}, ...(${JSON.stringify(model ?? null)} ? { model: ${JSON.stringify(model ?? null)} } : {}),
    prompt: ${JSON.stringify(prompt)}, ...${JSON.stringify(access)},
  } }) + '); 0');
  await js('window.__asks = []; window.electron.onServerEvent((e) => { if (e.type === "permission.request") window.__asks.push({ sessionId: e.payload.sessionId, tool: e.payload.toolName }); }); 0');
  const deadline = Date.now() + 5 * 60_000;
  let views = [];
  let last = '';
  let settled = 0;
  while (Date.now() < deadline) {
    await delay(4000);
    views = await js('window.electron.followUps.list()');
    const line = views.map((v) => v.title.slice(0, 24) + ':' + v.status + '/' + v.place + '/' + v.reports.length + '/' + (v.reports.at(-1) ? v.reports.at(-1).deliveredAt !== null : '-')).join(' | ');
    if (line !== last) { console.log('[task-first]', line); last = line; }
    const parentId = views[0] && views[0].parentSessionId;
    const parent = parentId && sessions.getSession(parentId);
    const delivered = views.length >= 2 && views.every((v) => v.reports.some((r) => r.deliveredAt !== null));
    if (delivered && parent && parent.status !== 'running') { if (++settled > 1) break; }
  }
  const rows = views.map((v) => {
    const child = v.childSessionId && sessions.getSession(v.childSessionId);
    return {
      childId: v.childSessionId, title: v.title, status: v.status, place: v.place, branch: v.worktreeBranch, reports: v.reports.length,
      child: child && { provider: child.provider, cwd: child.cwd, projectCwd: child.project_cwd, envMode: child.env_mode, access: child.claude_access_mode, isChat: child.is_chat },
      file: child && child.cwd && fs.existsSync(path.join(child.cwd, 'DONE.txt')) ? fs.readFileSync(path.join(child.cwd, 'DONE.txt'), 'utf8').trim() : null,
    };
  });
  const parent = views[0] && sessions.getSession(views[0].parentSessionId);
  const history = parent ? sessions.getSessionHistory(parent.id) : [];
  const started = history.flatMap((m) => m.type === 'assistant' ? (m.message.content || []).filter((b) => b.type === 'tool_use' && /start_session/.test(b.name)) : []);
  const calls = started.map((b) => b.name + ':' + (b.input.project || '-'));
  const asks = await js('window.__asks');
  console.log('[task-first] approvals asked:', JSON.stringify(asks));
  console.log('[task-first] tool_use linked:', JSON.stringify(views.map((v) => Boolean(v.toolUseId))));
  const reply = history.filter((m) => m.type === 'assistant').flatMap((m) => (m.message.content || []).filter((b) => b.type === 'text').map((b) => b.text)).at(-1);
  console.log('[task-first] parent:', JSON.stringify({ cwd: parent && parent.cwd, isChat: parent && parent.is_chat, access: parent && parent.claude_access_mode }));
  console.log('[task-first] project args:', JSON.stringify(calls));
  console.log('[task-first] rows:', JSON.stringify(rows, null, 1));
  console.log('[task-first] last reply:\\n' + (reply || '(none)'));
  const inProject = (row, name) => row.child && row.child.projectCwd === PROJECTS[name];
  const ok = rows.length === 2
    && rows.every((row) => !asks.some((ask) => row.childId === ask.sessionId))
    && ['alpha'].every((name) => rows.some((row) => inProject(row, name) && row.place === 'worktree' && row.child.envMode === 'worktree' && row.child.cwd.startsWith(PROJECTS[name] + '/') && row.file === name))
    && rows.some((row) => inProject(row, 'notes') && row.place === 'project' && row.child.cwd === PROJECTS.notes && row.file === 'notes')
    && rows.every((row) => row.child.provider === ${JSON.stringify(provider)});
  console.log('[task-first]', ok ? 'PASS' : 'FAIL');
  app.exit(ok ? 0 : 1);
});
`,
);
const child = spawn(path.join(root, 'node_modules', '.bin', 'electron'), [appDir], { stdio: 'inherit', env: { ...process.env, AEGIS_E2E: '1' } });
child.on('exit', (code) => {
  console.log(`[task-first] artifacts in ${tmp}`);
  process.exit(code ?? 1);
});
