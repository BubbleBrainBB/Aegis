// End-to-end: Team's coordinator hands a task to the agent whose description
// fits, adds a follow-up to it, then moves it to another agent. Real main
// process, real Claude and Codex logins, throwaway repositories. Uses agent
// usage, so it is not part of `npm test`.
//
//   npm run probe:team-e2e
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aegis-team-')));
const projects = { alpha: path.join(tmp, 'alpha'), notes: path.join(tmp, 'notes') };
for (const [name, folder] of Object.entries(projects)) {
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'README.md'), `# ${name}\n`);
  const git = (...args) => execFileSync('git', args, { cwd: folder, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  git('add', '-A');
  git('commit', '-qm', 'init');
}

const appDir = path.join(tmp, 'app');
await mkdir(path.join(appDir, 'dist-react'), { recursive: true });
await writeFile(path.join(appDir, 'dist-react', 'index.html'), '<!doctype html><html><body>team e2e</body></html>');
await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'team-e2e', main: 'main.cjs' }));
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
const failures = [];
const check = (ok, what) => { console.log('[team]', ok ? 'ok  ' : 'FAIL', what); if (!ok) failures.push(what); };
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(ROOT, 'dist-electron/electron/preload.cjs') } });
  await win.loadFile(path.join(__dirname, 'dist-react', 'index.html'));
  require(path.join(ROOT, 'dist-electron/electron/ipc-handlers.js')).setupIPCHandlers(win);
  const sessions = require(path.join(ROOT, 'dist-electron/electron/libs/session-store.js'));
  const prefs = require(path.join(ROOT, 'dist-electron/electron/libs/app-preferences.js'));
  prefs.setAppPreferences({
    chatsFolder: path.join(${JSON.stringify(tmp)}, 'chats'),
    team: {
      coordinator: { provider: 'claude', model: 'haiku' },
      fallback: { provider: null, model: '' },
      askWhenUnsure: false,
      agents: {
        claude: { enabled: true, description: 'Writing and editing documents and notes.' },
        codex: { enabled: true, description: 'Creating or changing files in a code repository.' },
      },
    },
  });
  for (const folder of Object.values(PROJECTS)) sessions.createSession({ title: 'Earlier', cwd: folder, projectCwd: folder, provider: 'claude' });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await js('window.__asks = []; window.electron.onServerEvent((e) => { if (e.type === "permission.request") window.__asks.push({ sessionId: e.payload.sessionId, tool: e.payload.toolName }); }); 0');
  const team = await js('window.electron.openTeamSession()');
  const again = await js('window.electron.openTeamSession()');
  check(team.id === again.id, 'Team is one conversation');
  const send = (prompt) => js('window.electron.sendClientEvent(' + JSON.stringify({ type: 'session.continue', payload: { sessionId: team.id, prompt } }) + '); 0');
  const idle = (id) => { const row = sessions.getSession(id); return row && row.status !== 'running'; };
  // Team stays idle for two checks in a row: a result on its way in would wake it.
  let quiet = 0;
  const settled = () => { quiet = idle(team.id) ? quiet + 1 : 0; return quiet >= 2; };
  async function waitFor(what, test, ms = 5 * 60_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await delay(3000);
      const value = await test();
      if (value) return value;
    }
    check(false, 'timed out: ' + what);
    return null;
  }
  const rows = () => js('window.electron.followUps.list()');
  const teamText = () => sessions.getSessionHistory(team.id).filter((m) => m.type === 'assistant').flatMap((m) => (m.message.content || []).filter((b) => b.type === 'text').map((b) => b.text)).join('\\n');
  const toolCalls = (name) => sessions.getSessionHistory(team.id).flatMap((m) => m.type === 'assistant' ? (m.message.content || []).filter((b) => b.type === 'tool_use' && b.name.endsWith(name)) : []);

  // 1. New work goes to the agent whose description fits, in the named project.
  await send('In project alpha, create a file DONE.txt containing the word alpha. Nothing else, no commit.');
  const started = await waitFor('the task to finish and report', async () => {
    const list = await rows();
    const row = list[0];
    return row && row.childSessionId && idle(row.childSessionId) && row.reports.some((r) => r.deliveredAt !== null) && settled() ? row : null;
  });
  if (started) {
    const child = sessions.getSession(started.childSessionId);
    check(started.provider === 'codex' && child.provider === 'codex', 'task given to Codex (got ' + started.provider + '/' + child.provider + ')');
    check(child.project_cwd === PROJECTS.alpha && child.env_mode === 'worktree', 'task runs in its own worktree of alpha');
    const file = path.join(child.cwd, 'DONE.txt');
    check(fs.existsSync(file) && /alpha/.test(fs.readFileSync(file, 'utf8')), 'Codex wrote DONE.txt');
    console.log('[team] coordinator said:\\n' + teamText());

    // 2. More about that task is added to it, not started anew.
    const before = sessions.getSessionHistory(child.id).filter((m) => m.type === 'user_prompt').length;
    await send('Also add the word beta on a second line of that DONE.txt.');
    await waitFor('the follow-up to reach the task and its result to reach Team', async () => {
      const prompts = sessions.getSessionHistory(child.id).filter((m) => m.type === 'user_prompt').length;
      const reports = (await rows())[0].reports;
      return prompts > before && idle(child.id) && reports.length >= 2 && reports.every((r) => r.deliveredAt !== null) && settled();
    });
    check((await rows()).length === 1, 'no second task was started');
    check(toolCalls('add_to_task').length >= 1, 'coordinator used add_to_task');
    check(/beta/.test(fs.readFileSync(file, 'utf8')), 'the task added beta');

    // 3. Moving the task replaces its owner and remembers the kind of work.
    await send('Let Claude take over that DONE.txt task from now on.');
    await waitFor('the move', async () => sessions.getSession(child.id).provider === 'claude' && idle(team.id) && idle(child.id));
    check(toolCalls('move_task').length >= 1, 'coordinator used move_task');
    check((await rows())[0].provider === 'claude', 'the task row shows Claude');
  }
  const asks = await js('window.__asks');
  check(asks.length === 0, 'no approvals were asked (' + JSON.stringify(asks) + ')');
  console.log('[team]', failures.length ? 'FAIL' : 'PASS');
  app.exit(failures.length ? 1 : 0);
});
`,
);
const child = spawn(path.join(root, 'node_modules', '.bin', 'electron'), [appDir], { stdio: 'inherit', env: { ...process.env, AEGIS_E2E: '1' } });
child.on('exit', (code) => process.exit(code ?? 1));
