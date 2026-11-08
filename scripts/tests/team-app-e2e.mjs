// End-to-end in the real app: the real main process and renderer, driven
// like a user (click Team, type in the composer, press Enter) through the
// DevTools protocol, with a screenshot after each step. Throwaway profile and
// repositories; real Claude and Codex logins. Uses agent usage, so it is not
// part of `npm test`.
//
//   npm run probe:team-app-e2e            (screenshots in $TEAM_SHOTS or a temp dir)
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aegis-team-app-')));
const shots = process.env.TEAM_SHOTS || path.join(tmp, 'shots');
mkdirSync(shots, { recursive: true });
const profile = path.join(tmp, 'profile');
mkdirSync(profile, { recursive: true });
const projects = { alpha: path.join(tmp, 'alpha'), notes: path.join(tmp, 'notes') };
for (const [name, folder] of Object.entries(projects)) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'README.md'), `# ${name}\n`);
  const git = (...args) => execFileSync('git', args, { cwd: folder, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  git('add', '-A');
  git('commit', '-qm', 'init');
}
// A returning user: onboarding done, Team set up, two projects from earlier work.
writeFileSync(path.join(profile, 'renderer-state.json'), JSON.stringify({ 'aegis-onboarding-complete': String(Date.now()) }));
writeFileSync(path.join(profile, 'app-preferences.json'), JSON.stringify({
  chatsFolder: path.join(tmp, 'chats'),
  team: {
    coordinator: { provider: 'claude', model: 'haiku' },
    fallback: { provider: null, model: '' },
    askWhenUnsure: true,
    agents: {
      claude: { enabled: true, description: 'Writing prose: documents, notes and replies. Not files in code repositories.' },
      codex: { enabled: true, description: 'Any file created or changed inside a git repository.' },
    },
  },
}));

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log('[team-app]', ...args);
const failures = [];
const check = (ok, what) => { log(ok ? 'ok  ' : 'FAIL', what); if (!ok) failures.push(what); };

const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(tmp, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const devUrl = server.resolvedUrls.local[0].replace(/\/$/, '');
const port = 9300 + Math.floor(Math.random() * 500);

function launch() {
  const env = { ...process.env, AEGIS_USER_DATA_DIR: profile, DEV_SERVER_URL: devUrl, NODE_ENV: 'development' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(root, 'node_modules/.bin/electron'), [`--remote-debugging-port=${port}`, path.join(root, 'dist-electron/electron/main.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', (c) => out.push(String(c)));
  child.stderr.on('data', (c) => out.push(String(c)));
  return { child, out };
}

async function connect() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith(devUrl));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        let id = 0;
        const pending = new Map();
        ws.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
        };
        const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
        return { ws, send };
      }
    } catch { /* not up yet */ }
    await delay(500);
  }
  throw new Error('the app window never appeared');
}

async function stop(app) {
  app.child.kill('SIGTERM');
  await new Promise((resolve) => { app.child.once('exit', resolve); setTimeout(resolve, 8000); });
}

// First launch makes the database; then the earlier projects go in.
{
  const first = launch();
  const cdp = await connect();
  await delay(3000);
  cdp.ws.close();
  await stop(first);
  const db = path.join(profile, 'sessions.db');
  if (!existsSync(db)) throw new Error('no sessions.db after the first launch');
  const now = Date.now();
  for (const [name, folder] of Object.entries(projects)) {
    execFileSync('sqlite3', [db, `INSERT INTO sessions (id, title, provider, cwd, project_cwd, status, created_at, updated_at) VALUES ('earlier-${name}', 'Set up ${name}', 'claude', '${folder}', '${folder}', 'completed', ${now - 3600_000}, ${now - 3600_000});`]);
  }
}

const app = launch();
const { send } = await connect();
await send('Runtime.enable');
await send('Page.enable');
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return result.result?.result?.value;
};
const shot = async (name) => {
  const { result } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(shots, `${name}.png`), Buffer.from(result.data, 'base64'));
  log('screenshot', name);
};
const center = async (selector) => evaluate(`(() => { const e = ${selector}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const click = async (selector) => {
  const point = await center(selector);
  if (!point) throw new Error('nothing to click: ' + selector);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
  await delay(400);
};
const waitFor = async (what, expression, ms = 4 * 60_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await delay(1500);
  }
  check(false, 'timed out: ' + what);
  return false;
};
const composer = 'document.querySelector("[contenteditable=true]")';
const running = 'Boolean(document.querySelector("button[aria-label=Stop]"))';
const typeAndSend = async (text) => {
  await click(composer);
  await send('Input.insertText', { text });
  await delay(200);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await delay(1500);
};
// Team settles: not running, and nothing new for a while (results arrive as new turns).
const settle = async (what, ms = 6 * 60_000) => {
  const deadline = Date.now() + ms;
  let quiet = 0;
  let lastText = '';
  while (Date.now() < deadline) {
    const text = await evaluate('document.querySelector("main")?.innerText.length ?? 0');
    const busy = await evaluate(running);
    quiet = !busy && text === lastText ? quiet + 1 : 0;
    lastText = text;
    if (quiet >= 6) return true;
    await delay(2000);
  }
  check(false, 'timed out: ' + what);
  return false;
};

try {
  await waitFor('the app to load', 'Boolean(document.querySelector(".aegis-sidebar-panel [aria-label=Team]"))', 60_000);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await delay(1000);
  await shot('01-home');

  await click('document.querySelector(".aegis-sidebar-panel [aria-label=Team]")');
  await waitFor('Team to open', `Boolean(${composer})`, 30_000);
  await delay(800);
  check(await evaluate('document.body.innerText.includes("What should the team work on?")'), 'Team opens on its own empty state');
  check(await evaluate('!document.querySelector("[data-session-tasks-crumb]")'), 'Team has no My Tasks crumb');
  check(await evaluate('!document.body.innerText.includes("No project")'), 'Team offers no project picker');
  await shot('02-team-empty');

  await typeAndSend('In project alpha, create a file DONE.txt containing the word alpha. Nothing else, no commit.');
  await waitFor('the task row', 'Boolean(document.querySelector("[data-sub-session]"))');
  await shot('03-task-started');
  await settle('the first task to finish and report');
  await shot('04-task-reported');
  check(await evaluate('[...document.querySelectorAll("button")].some((b) => /Haiku/.test(b.textContent))'), 'the composer still shows the coordinator model after a turn');
  check(await evaluate('document.querySelectorAll("[data-sub-session]").length === 1'), 'one task row in Team');
  check(await evaluate('[...document.querySelectorAll("[data-active-tasks] [data-session-id]")].length >= 1'), 'the task is in the Active list');

  await typeAndSend('Also add the word beta on a second line of that DONE.txt.');
  await waitFor('the add line', 'Boolean(document.querySelector("[data-team-task-line=add]"))');
  await settle('the follow-up to finish');
  await shot('05-added-to-task');
  check(await evaluate('document.querySelectorAll("[data-sub-session]").length === 1'), 'still one task (added, not started anew)');

  await typeAndSend('Let Claude take over that DONE.txt task from now on.');
  await waitFor('the move line', 'Boolean(document.querySelector("[data-team-task-line=move]"))');
  await settle('the move to finish');
  await shot('06-moved-to-claude');

  await click('document.querySelector("[data-sub-session]")');
  await delay(1500);
  await shot('07-task-session');
  check(await evaluate('Boolean(document.querySelector("[data-session-parent-crumb]")) && document.querySelector("[data-session-parent-crumb]").textContent === "Team"'), 'the task breadcrumb names Team');
  const stopped = await evaluate('(document.body.innerText.match(/.{0,160}You stopped.{0,80}/s) || [""])[0].split("\\n").join(" | ")');
  if (stopped) log('stopped context:', stopped);
  check(!stopped, 'adding to the task did not stop it');
  check((await evaluate('window.electron.followUps.list()'))[0]?.provider === 'claude', 'the task belongs to Claude after the move');

  await click('document.querySelector(".aegis-sidebar-panel [aria-label=\\"My Tasks\\"]")');
  await delay(1500);
  await shot('08-my-tasks');
  check(await evaluate('![...document.querySelectorAll("[data-session-id]")].some((e) => e.textContent.trim().startsWith("Team"))'), 'Team itself is not in My Tasks');

  await evaluate('window.electron && 0');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ',', code: 'Comma', modifiers: 4, windowsVirtualKeyCode: 188 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ',', code: 'Comma', modifiers: 4, windowsVirtualKeyCode: 188 });
  await delay(1200);
  if (!(await evaluate('Boolean(document.querySelector(".aegis-settings"))'))) {
    await click('document.querySelector("[aria-label=Settings], [title=Settings]")').catch(() => undefined);
    await delay(800);
  }
  await click('[...document.querySelectorAll(".aegis-settings nav button, .aegis-settings nav li")].find((e) => e.textContent.trim() === "Team")');
  await waitFor('Settings › Team', 'Boolean(document.querySelector("[data-team-settings] [data-team-agent]"))', 30_000);
  await delay(800);
  await shot('09-settings-team');
} catch (error) {
  console.error(error);
  failures.push(String(error));
  await shot('failure').catch(() => undefined);
} finally {
  const prefs = JSON.parse(readFileSync(path.join(profile, 'app-preferences.json'), 'utf8'));
  log('team settings after:', JSON.stringify(prefs.team?.agents));
  log('screenshots in', shots);
  log(failures.length ? `FAIL (${failures.length})` : 'PASS');
  await stop(app);
  await server.close();
  if (failures.length) console.log(app.out.join('').split('\n').filter((line) => /error|Error|fail/i.test(line)).slice(-30).join('\n'));
  process.exit(failures.length ? 1 : 0);
}
