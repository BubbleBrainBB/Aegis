// A message is shown and the task set running before the agent's runtime is
// checked. When that check fails, the window must be told the task failed:
// the `runner.error` it gets carries the reason and does not change the status
// the window shows, so without a `session.status` of `error` the task stayed
// shown as running while it was stored as failed.
//
// Checked on the real session handlers (startSession / handleSessionContinue)
// for every agent with such a check, for a first message and for a follow-up.
// Only the check's answer is replaced ("not ready"), so what is installed on
// the machine running this does not matter and no message reaches an agent.
//
// No Electron: the main process modules run under Node with `electron` stubbed.
// Run: npm run transpile:electron && node scripts/tests/send-runtime-check-failed.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'aegis-send-check-')));
const project = path.join(tmp, 'project');
mkdirSync(project, { recursive: true });
writeFileSync(path.join(project, 'README.md'), '# project\n');

// The handlers set up the whole app, which registers its local MCP servers in
// the agents' own configuration and looks for the agents' CLIs. None of that
// may reach the real home of whoever runs this: nothing Aegis-specific is
// inherited, and every path the main process resolves is sent into a
// temporary home. (See remote-bubble-modes.test.mjs, where this is asserted.)
for (const name of Object.keys(process.env)) if (name.startsWith('AEGIS_')) delete process.env[name];
const home = path.join(tmp, 'home');
mkdirSync(home, { recursive: true });
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  BUBBLE_HOME: path.join(tmp, 'bubble-home'),
  KIMI_CODE_HOME: path.join(home, '.kimi-code'),
  CODEX_HOME: path.join(home, '.codex'),
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local/share'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  AEGIS_KIMI_LEGACY_MCP_PATH: path.join(home, '.kimi/mcp.json'),
  AEGIS_CODEX_USER_CONFIG_PATH: path.join(home, '.codex/config.toml'),
  AEGIS_CODEX_MCP_CONFIG_PATH: path.join(home, 'aegis-codex-mcp.toml'),
  AEGIS_BROWSER_USE_TEST_MODE: '1',
  AEGIS_REMOTE_LAN: '0',
  // Whatever looks for agy while the app sets up finds the scripted one.
  ANTIGRAVITY_CLI_PATH: path.join(root, 'scripts/fake-agy.mjs'),
  FAKE_AGY_LOG: path.join(tmp, 'agy-calls.jsonl'),
});
process.setMaxListeners(64);

// ── Electron, as far as the main process modules touch it here. ──
const handlers = new Map();
const listeners = new Map();
const anything = new Proxy(function () {}, { get: (_t, key) => (key === 'then' ? undefined : anything), apply: () => anything, construct: () => anything });
const loose = (known) => new Proxy(known, { get: (target, key) => (key in target ? target[key] : anything) });
const electron = loose({
  app: loose({ getPath: () => path.join(tmp, 'profile'), isPackaged: false, getAppPath: () => root, getName: () => 'Aegis', getVersion: () => '0.0.0', on() {}, once() {}, whenReady: () => Promise.resolve() }),
  ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn), removeHandler: (name) => handlers.delete(name), removeAllListeners() {} },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => Buffer.from(value).toString() },
  dialog: loose({ showMessageBox: async () => ({ response: 1 }) }),
});
mkdirSync(path.join(tmp, 'profile'), { recursive: true });
const load = Module._load;
Module._load = function (name, ...rest) { return name === 'electron' ? electron : load.call(this, name, ...rest); };

// The handlers log every start and send in development.
const log = console.log;
console.log = (...args) => { if (!/^\[(Session|Runner|ProviderService|feishu)/.test(String(args[0]))) log(...args); };
const warn = console.warn;
console.warn = (...args) => { if (!/^\[(Antigravity|Devin|MiniMax|MiMo|Kimi|Codex)/.test(String(args[0]))) warn(...args); };

const until = async (check, label, ms = 20000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};

/** A window of the app, as far as the handlers need one: what it is sent, and what it sends. */
function appWindow() {
  const events = [];
  const frame = { url: 'http://127.0.0.1:10087' };
  const webContents = { id: 1, mainFrame: frame, isDestroyed: () => false, send: (_channel, json) => { try { events.push(JSON.parse(json)); } catch { /* not an event */ } }, on() {}, once() {} };
  const window = loose({ isDestroyed: () => false, webContents: loose(webContents), on() {}, once() {} });
  /** An event from the app's own window, as its composer sends one. */
  const send = (event) => listeners.get('client-event')({ sender: webContents, senderFrame: frame }, JSON.stringify(event));
  return { window, events, send };
}

// Each agent's check: the module the handlers call it from, the answer given
// here, and the reason the window is to show for that answer.
const noCli = { ready: false, cliAvailable: false, acpAvailable: false, authState: 'unknown', checkedAt: 0 };
const agents = [
  { provider: 'claude', module: 'claude-runtime-status', check: 'getClaudeRuntimeStatusCached', status: { ready: false, kind: 'login_required', summary: 'Claude Code is not signed in.', detail: 'Sign in first.' }, reason: /Claude Code is not signed in/ },
  { provider: 'opencode', module: 'opencode-runtime-status', check: 'getOpencodeRuntimeStatus', status: { ready: false, cliAvailable: false, configExists: false, hasModelConfig: false, checkedAt: 0 }, reason: /OpenCode SDK is not ready/ },
  { provider: 'kimi', module: 'kimi-runtime-status', check: 'getKimiRuntimeStatus', status: { ...noCli, serverAvailable: false }, reason: /Kimi Code CLI is not installed/ },
  { provider: 'grok', module: 'grok-runtime-status', check: 'getGrokRuntimeStatus', status: noCli, reason: /Grok Build CLI is not installed/ },
  // Not a promise: this one is answered at once.
  { provider: 'deepseek', module: 'deepseek-cli', check: 'getDeepseekRuntimeStatus', sync: true, status: { ready: false, profileInstalled: true, hasApiKey: false }, reason: /DeepSeek Harness has no API key/ },
  { provider: 'devin', module: 'devin-cli', check: 'getDevinRuntimeStatus', status: noCli, reason: /Devin CLI is not installed/ },
  { provider: 'mimo', module: 'mimo-cli', check: 'getMimoRuntimeStatus', status: noCli, reason: /MiMo Code CLI is not installed/ },
  { provider: 'minimax', module: 'minimax-cli', check: 'getMinimaxRuntimeStatus', status: noCli, reason: /MiniMax Code CLI is not installed/ },
  { provider: 'antigravity', module: 'antigravity-cli', check: 'getAntigravityRuntimeStatus', status: noCli, reason: /Antigravity CLI \(agy\) is not installed/ },
];

let ipc;
let passed = false;
try {
  ipc = require(path.join(root, 'dist-electron/electron/ipc-handlers.js'));
  const store = require(path.join(root, 'dist-electron/electron/libs/session-store.js'));
  // The handlers read each check from its module when they call it.
  const asked = new Map(agents.map((agent) => [agent.provider, 0]));
  for (const agent of agents) {
    const exports = require(path.join(root, 'dist-electron/electron/libs', `${agent.module}.js`));
    assert.equal(typeof exports[agent.check], 'function', `${agent.module} exports ${agent.check}`);
    exports[agent.check] = () => {
      asked.set(agent.provider, asked.get(agent.provider) + 1);
      return agent.sync ? agent.status : Promise.resolve(agent.status);
    };
  }
  const { window, events, send } = appWindow();
  store.initialize();
  ipc.setupIPCHandlers(window);

  /**
   * What the window was sent from `from` on, about one task. `shown` is the
   * status the window ends up showing: it only follows `session.status`.
   */
  const told = (from, sessionId) => {
    const seen = events.slice(from);
    const about = seen.filter((event) => event.payload?.sessionId === sessionId);
    const statuses = about.filter((event) => event.type === 'session.status').map((event) => event.payload.status);
    return {
      statuses,
      shown: statuses.at(-1),
      prompts: about.filter((event) => event.type === 'stream.user_prompt').map((event) => event.payload.prompt),
      errors: seen.filter((event) => event.type === 'runner.error'),
    };
  };

  /**
   * The send ended: its reason reached the window. The status that goes with
   * it is sent before the reason, so nothing more is on its way after this.
   */
  const refused = async (from, label) => {
    await until(() => events.slice(from).some((event) => event.type === 'runner.error'), `${label}: the reason is given`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  };

  // ── 1. A follow-up message. ──
  for (const agent of agents) {
    const label = `${agent.provider}, follow-up`;
    const task = store.createSession({ title: `A ${agent.provider} task`, cwd: project, provider: agent.provider });
    const checks = asked.get(agent.provider);
    const from = events.length;
    await send({ type: 'session.continue', payload: { sessionId: task.id, prompt: `Carry on, ${agent.provider}`, provider: agent.provider } });
    await refused(from, label);
    const seen = told(from, task.id);
    assert.ok(asked.get(agent.provider) > checks, `${label}: the check was made`);
    assert.deepEqual(seen.prompts, [`Carry on, ${agent.provider}`], `${label}: the message is shown`);
    assert.equal(seen.statuses[0], 'running', `${label}: the task is shown running first`);
    assert.equal(seen.shown, 'error', `${label}: the window is told the task failed`);
    assert.equal(seen.errors.length, 1, `${label}: the reason is given once`);
    assert.match(seen.errors[0].payload.message, agent.reason, label);
    assert.equal(seen.errors[0].payload.sessionId, task.id, `${label}: the reason names the task`);
    assert.equal(store.getSession(task.id).status, 'error', `${label}: and it is stored as failed`);
    assert.ok(store.getSessionHistory(task.id).some((message) => message.type === 'user_prompt' && message.prompt === `Carry on, ${agent.provider}`), `${label}: the message stays in the conversation`);
  }

  // ── 2. The first message of a new task. ──
  for (const agent of agents) {
    const label = `${agent.provider}, first message`;
    const startId = `start-${agent.provider}`;
    const checks = asked.get(agent.provider);
    const from = events.length;
    // No title is asked of the agent: that would start its CLI.
    await send({
      type: 'session.start',
      payload: { title: `New ${agent.provider} task`, prompt: `Begin, ${agent.provider}`, cwd: project, provider: agent.provider, startId, skipTitleGeneration: true },
    });
    await refused(from, label);
    const opened = events.slice(from).find((event) => event.type === 'session.status' && event.payload.startId === startId);
    assert.ok(opened, `${label}: the task is opened in the window`);
    assert.equal(opened.payload.status, 'running', `${label}: and shown running`);
    const seen = told(from, opened.payload.sessionId);
    assert.ok(asked.get(agent.provider) > checks, `${label}: the check was made`);
    assert.deepEqual(seen.prompts, [`Begin, ${agent.provider}`], `${label}: the message is shown`);
    assert.equal(seen.shown, 'error', `${label}: the window is told the task failed`);
    assert.equal(seen.errors.length, 1, `${label}: the reason is given once`);
    assert.match(seen.errors[0].payload.message, agent.reason, label);
    assert.equal(store.getSession(opened.payload.sessionId).status, 'error', `${label}: and it is stored as failed`);
  }

  passed = true;
  console.log('send-runtime-check-failed: ok');
} catch (failure) {
  console.error(failure);
} finally {
  try { ipc?.cleanup(); } catch { /* closing */ }
  rmSync(tmp, { recursive: true, force: true });
  // At once: runners and servers keep the process alive.
  process.exit(passed ? 0 : 1);
}
