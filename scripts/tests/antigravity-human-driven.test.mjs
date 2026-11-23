// Antigravity only takes what a person typed, checked on the real session
// handlers (startSession / handleSessionContinue, the runner, the adapter)
// against scripts/fake-agy.mjs:
// - a message from the composer reaches agy exactly as typed: no title
//   one-shot, no note of Aegis's appended, no Aegis tools attached;
// - agy's own title for the session becomes the task's title;
// - everything that is not the composer is refused before agy hears of it:
//   a background start, a prompt marked as written by the app, a move of
//   another agent's session onto Antigravity, a handoff, the main bot.
//
// No Electron: the main process modules run under Node with `electron` stubbed.
// Run: npm run transpile:electron && node scripts/tests/antigravity-human-driven.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'aegis-antigravity-')));
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
const callsLog = path.join(tmp, 'agy-calls.jsonl');
writeFileSync(callsLog, '');
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
  // The agy this app finds: the scripted one, which logs every call it gets.
  ANTIGRAVITY_CLI_PATH: path.join(root, 'scripts/fake-agy.mjs'),
  FAKE_AGY_LOG: callsLog,
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

const calls = () => readFileSync(callsLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
/** Every prompt agy was sent, as text. */
const prompts = () => calls().filter((call) => call.method === 'session/prompt').map((call) => call.params.prompt.map((block) => block.text ?? `[${block.type}]`).join('\n'));

/** A window of the app, as far as the handlers need one: what it is sent, and what it sends. */
function appWindow() {
  const events = [];
  /** Called with each event as it is sent to the window, in the handlers' own tick. */
  const tap = { onEvent: null };
  const frame = { url: 'http://127.0.0.1:10087' };
  const webContents = { id: 1, mainFrame: frame, isDestroyed: () => false, send: (_channel, json) => { try { const event = JSON.parse(json); events.push(event); tap.onEvent?.(event); } catch { /* not an event */ } }, on() {}, once() {} };
  const window = loose({ isDestroyed: () => false, webContents: loose(webContents), on() {}, once() {} });
  const invoke = (channel, ...args) => handlers.get(channel)({ sender: webContents, senderFrame: frame }, ...args);
  /** An event from the app's own window, as its composer sends one. */
  const send = (event) => listeners.get('client-event')({ sender: webContents, senderFrame: frame }, JSON.stringify(event));
  return { window, events, invoke, send, tap };
}

let ipc;
let passed = false;
try {
  ipc = require(path.join(root, 'dist-electron/electron/ipc-handlers.js'));
  const store = require(path.join(root, 'dist-electron/electron/libs/session-store.js'));
  const { window, events, invoke, send, tap } = appWindow();
  store.initialize();
  ipc.setupIPCHandlers(window);
  const errors = () => events.filter((event) => event.type === 'runner.error').map((event) => event.payload.message);
  const idle = (id) => until(() => ['completed', 'idle', 'error'].includes(store.getSession(id)?.status), `task ${id} finished its turn`);
  const antigravityTasks = () => store.listSessions().filter((row) => row.provider === 'antigravity');

  // ── 1. The composer: a typed message reaches agy as typed. ──
  await send({
    type: 'session.start',
    payload: { title: 'New task', prompt: 'Please TITLE this. Then say hello', cwd: project, provider: 'antigravity', startId: 'start-1', antigravityPermissionMode: 'accept-edits', antigravityThoughtLevel: 'low' },
  });
  const task = await until(() => antigravityTasks()[0], 'the composer\'s task exists');
  await until(() => prompts().length === 1, 'agy got the message');
  await idle(task.id);
  assert.deepEqual(prompts(), ['Please TITLE this. Then say hello'], 'exactly what was typed, and nothing else was ever prompted');
  assert.deepEqual(errors(), []);
  // One session process (the catalog probe is another, and is never prompted).
  const promptedPids = new Set(calls().filter((call) => call.method === 'session/prompt').map((call) => call.pid));
  assert.equal(promptedPids.size, 1, 'no second agy was prompted (a title one-shot would be one)');
  for (const call of calls().filter((entry) => entry.spawn)) assert.deepEqual(call.spawn.args, ['acp']);
  assert.equal(calls().some((call) => call.badArgs), false, 'agy is only ever started as `agy acp`');
  for (const call of calls().filter((entry) => /^session\/(new|resume|load)$/.test(entry.method ?? ''))) {
    assert.deepEqual(call.params.mcpServers, [], 'no Aegis tools are attached');
  }
  const sessionPid = [...promptedPids][0];
  const sessionCalls = () => calls().filter((call) => call.pid === sessionPid && call.method);
  assert.equal(sessionCalls().find((call) => call.method === 'session/new').params.cwd, project, 'agy works in the project folder');
  assert.ok(sessionCalls().some((call) => call.method === 'session/set_mode' && call.params.modeId === 'accept-edits'), 'the composer\'s mode');
  assert.ok(sessionCalls().some((call) => call.method === 'session/set_config_option' && call.params.configId === 'thought_level' && call.params.value === 'low'), 'the composer\'s thinking level');
  // The task is named by agy's own title for its session, not by a prompt of Aegis's.
  await until(() => store.getSession(task.id).title === 'Fake Title From Agy', 'agy\'s own title is adopted');
  const stored = store.getSession(task.id);
  assert.ok(stored.antigravity_session_id, 'the ACP session id is kept for reopening');
  assert.equal(stored.antigravity_permission_mode, 'accept-edits');
  assert.match(store.getSessionHistory(task.id).map((message) => JSON.stringify(message)).join('\n'), /echo: Please TITLE this/);

  // A follow-up from the composer, the same way.
  await send({ type: 'session.continue', payload: { sessionId: task.id, prompt: 'A second message', provider: 'antigravity' } });
  await until(() => prompts().length === 2, 'agy got the follow-up');
  await idle(task.id);
  assert.equal(prompts()[1], 'A second message');
  // A rename by the person stays: agy's later titles do not replace it.
  store.updateSessionTitle(task.id, 'My own name');
  await send({ type: 'session.continue', payload: { sessionId: task.id, prompt: 'TITLE again' } });
  await until(() => prompts().length === 3, 'agy got the third message');
  await idle(task.id);
  assert.equal(store.getSession(task.id).title, 'My own name');

  // A chat without a project: other agents get a note about the chat's folder
  // appended to the first message. Antigravity gets the message alone.
  await send({ type: 'session.start', payload: { title: 'New chat', prompt: 'Just chatting', chat: true, provider: 'antigravity', startId: 'start-2' } });
  await until(() => prompts().length === 4, 'agy got the chat message');
  const chat = antigravityTasks().find((row) => row.id !== task.id);
  await idle(chat.id);
  assert.equal(prompts()[3], 'Just chatting', 'no chat-folder note');
  assert.equal(chat.is_chat, 1);

  // ── 2. Anything that is not the composer is refused, and agy never hears of it. ──
  const before = { prompts: prompts().length, tasks: antigravityTasks().length, spawns: calls().filter((call) => call.spawn).length };
  const refused = async (label, act) => {
    const seen = errors().length;
    const result = await act();
    assert.match(errors().at(-1) ?? '', /Antigravity only takes messages you type in Aegis on this computer/, `${label}: the reason is given`);
    assert.equal(errors().length, seen + 1, `${label}: said once`);
    return result;
  };
  // A start that does not come from the composer's event.
  const background = await refused('a background start', () =>
    invoke('session-start-background', { title: 'Scheduled', prompt: 'Run the nightly job', cwd: project, provider: 'antigravity' }));
  assert.deepEqual(background, { ok: false, sessionId: null });
  // A prompt the app wrote, whoever relays it: a workflow's report, a sub-task's reply.
  for (const workflowPrompt of ['event', 'task', 'follow-up', 'sub-session']) {
    assert.equal(await refused(`a "${workflowPrompt}" turn`, () =>
      send({ type: 'session.continue', payload: { sessionId: task.id, prompt: 'The workflow finished; continue.', workflowPrompt } })), undefined);
    await refused(`a "${workflowPrompt}" start`, () =>
      send({ type: 'session.start', payload: { title: 'Member', prompt: 'Review the diff', cwd: project, provider: 'antigravity', workflowPrompt } }));
  }
  // Moving another agent's task onto Antigravity with such a prompt.
  const other = store.createSession({ title: 'A Bubble task', cwd: project, provider: 'bubble' });
  await refused('a move onto Antigravity', () =>
    send({ type: 'session.continue', payload: { sessionId: other.id, prompt: 'Carry on', provider: 'antigravity', workflowPrompt: 'follow-up' } }));
  assert.equal(store.getSession(other.id).provider, 'bubble', 'the task stays with its agent');
  // A handoff opens the new agent with a brief Aegis wrote from the transcript.
  store.addMessage(other.id, { type: 'user_prompt', prompt: 'Start here' });
  const handoff = await invoke('session-handoff', { sessionId: other.id, targetProvider: 'antigravity' });
  assert.equal(handoff.ok, false);
  assert.match(handoff.message, /Antigravity only takes messages you type/);
  // The other way is the person's own transcript in Aegis, and stays possible.
  const away = await invoke('session-handoff', { sessionId: task.id, targetProvider: 'bubble' });
  assert.equal(away.ok, true, away.message);

  // The main bot: Antigravity is not an agent it may give a task to.
  const tools = require(path.join(root, 'dist-electron/electron/libs/main-bot/tools.js')).createMainBotTools();
  const startTask = tools.find((tool) => tool.name === 'start_task');
  const answer = await startTask.execute({ title: 'Fix the tests', goal: 'Green tests', prompt: 'Run the tests and fix what fails.', project: 'project', agent: 'Antigravity' });
  assert.equal(answer.isError, true, 'start_task with Antigravity fails');
  assert.match(String(answer.content), /only takes messages the person types/, String(answer.content));

  // A title or any other one-shot is not run through it either.
  const { getProviderService } = require(path.join(root, 'dist-electron/electron/libs/provider/service.js'));
  await assert.rejects(
    getProviderService().runOneShot({ provider: 'antigravity', threadId: 'title-x', cwd: project, prompt: 'Name this task in five words' }),
    /only takes messages a person types/
  );

  assert.equal(prompts().length, before.prompts, 'not one of these reached agy');
  assert.equal(antigravityTasks().length, before.tasks, 'and none left a task behind');
  assert.equal(
    calls().filter((call) => call.spawn).length,
    before.spawns,
    'agy was not even started for them'
  );

  // ── 3. The composer still works afterwards. ──
  await send({ type: 'session.continue', payload: { sessionId: task.id, prompt: 'Still here?' } });
  await until(() => prompts().length === before.prompts + 1, 'agy got the next typed message');
  await idle(task.id);
  assert.equal(prompts().at(-1), 'Still here?');

  // ── 4. agy goes on by itself after a turn: the task runs again, then ends. ──
  // The typed message starts a command that outlives the turn. When it is
  // done agy takes the work up with no prompt from anyone; the handlers set
  // the task running for that turn, store it marked as agy's own, and finish it.
  const statuses = () => events.filter((event) => event.type === 'session.status' && event.payload.sessionId === task.id).map((event) => event.payload.status);
  const seenStatuses = statuses().length;
  const seenErrors = errors().length;
  const storedBefore = store.getSessionHistory(task.id).length;
  await send({ type: 'session.continue', payload: { sessionId: task.id, prompt: 'Start the build in the BACKGROUND' } });
  const turnRows = () => store.getSessionHistory(task.id).slice(storedBefore);
  const resultRows = () => turnRows().filter((message) => message.type === 'result');
  await until(() => resultRows().length === 1, 'the typed turn ended');
  await until(() => turnRows().some((message) => message.type === 'system' && message.subtype === 'init' && message.selfStarted), 'agy took the work up by itself');
  assert.equal(store.getSession(task.id).status, 'running', 'the task runs while agy works by itself');
  assert.equal(resultRows().length, 1, 'and that turn is still open');
  await until(() => resultRows().length === 2, 'the turn agy started ended');
  await idle(task.id);
  assert.equal(store.getSession(task.id).status, 'completed');
  assert.deepEqual(statuses().slice(seenStatuses).filter((status, index, all) => status !== all[index - 1]), ['running', 'completed', 'running', 'completed']);
  assert.equal(prompts().at(-1), 'Start the build in the BACKGROUND', 'nothing but the typed message was sent to agy');
  // What is stored reads as two turns: the typed one, then agy's own, each with its words and its result.
  const rowKinds = turnRows()
    .filter((message) => !(message.type === 'system' && message.subtype === 'token_usage'))
    .map((message) => {
      if (message.type === 'user_prompt' || message.type === 'result') return message.type;
      if (message.type === 'system') return message.selfStarted ? 'init by itself' : message.subtype;
      const block = message.message.content[0];
      return block.type === 'tool_use' ? `call ${block.id.replace(/_\d+$/, '')}` : block.type === 'tool_result' ? `result of ${block.tool_use_id.replace(/_\d+$/, '')}` : block.type;
    });
  assert.deepEqual(rowKinds, [
    'user_prompt',
    'thinking',
    'call call_bg',
    'text',
    'result of call_bg',
    'result',
    'init by itself',
    'thinking',
    'call call_check',
    'result of call_check',
    'text',
    'result',
  ]);
  const buildResult = turnRows().find((message) => message.type === 'assistant' && message.message.content[0].type === 'tool_result' && message.message.content[0].tool_use_id.startsWith('call_bg'));
  assert.equal(buildResult.message.content[0].content, 'built in 63s', 'the command\'s card holds its real output');
  assert.equal(errors().length, seenErrors, 'none of this is an error');

  // ── 5. A message typed while agy works by itself takes that work over. ──
  // agy's words so far are stored and shown above the new message, and from
  // the moment the message is shown the task runs until that message's own
  // result: nothing of the work agy had started marks it finished.
  {
    const from = events.length;
    const rowsBefore = store.getSessionHistory(task.id).length;
    await send({ type: 'session.continue', payload: { sessionId: task.id, prompt: 'Another BACKGROUND build, WAKE_HOLD' } });
    const streamed = (text) => events.slice(from).some((event) =>
      event.type === 'stream.message' && event.payload.message.type === 'stream_event' && String(event.payload.message.event?.delta?.text ?? '').includes(text));
    await until(() => streamed('Checking the artefact'), 'agy is writing by itself');
    assert.equal(store.getSession(task.id).status, 'running');
    await send({ type: 'session.continue', payload: { sessionId: task.id, prompt: 'And then?' } });
    await until(() => prompts().at(-1) === 'And then?', 'agy got the message');
    await idle(task.id);
    const seen = events.slice(from);
    const shownAt = seen.findIndex((event) => event.type === 'stream.user_prompt' && event.payload.prompt === 'And then?');
    const committedAt = seen.findIndex((event) =>
      event.type === 'stream.message' && event.payload.message.type === 'assistant' && event.payload.message.message.content[0].text === 'Checking the artefact. ');
    assert.ok(shownAt > 0 && committedAt > 0, 'both were sent to the window');
    assert.ok(committedAt < shownAt, 'agy\'s words are committed before the new message is shown');
    const after = seen.slice(shownAt).filter((event) => event.type === 'session.status' && event.payload.sessionId === task.id).map((event) => event.payload.status);
    // The task was running already; once the message is shown the only change is its own end.
    assert.deepEqual(after.filter((status, index, all) => status !== all[index - 1]), ['completed'], 'running from the message to its result');
    const stored = store.getSessionHistory(task.id).slice(rowsBefore);
    const lastPrompt = stored.findLastIndex((message) => message.type === 'user_prompt');
    assert.equal(stored.slice(lastPrompt).filter((message) => message.type === 'result').length, 1, 'one result ends it');
    assert.equal(stored.slice(0, lastPrompt).filter((message) => message.type === 'result').length, 1, 'the work agy started reported none of its own');
  }

  // ── 6. A result that replaces an earlier one keeps its place, also after a rewrite. ──
  // A fork or an edited message rewrites a task's stored history; rows added
  // later go below it. A message stored again under its own id is not new.
  {
    const row = store.createSession({ title: 'Order', cwd: project, provider: 'antigravity' });
    const at = Date.now() - 60_000;
    const callResult = (content) => ({ type: 'assistant', uuid: 'result-of-build', createdAt: at + 2, message: { content: [{ type: 'tool_result', tool_use_id: 'build', content, is_error: false }] } });
    store.addMessage(row.id, { type: 'user_prompt', prompt: 'one', createdAt: at });
    store.addMessage(row.id, { type: 'assistant', uuid: 'call-build', createdAt: at + 1, message: { content: [{ type: 'tool_use', id: 'build', name: 'Bash', input: { command: 'npm run build' } }] } });
    store.addMessage(row.id, callResult('npm run build'));
    store.replaceSessionHistory(row.id, store.getSessionHistory(row.id));
    store.addMessage(row.id, { type: 'user_prompt', prompt: 'two', createdAt: at + 10 });
    store.addMessage(row.id, { type: 'assistant', uuid: 'answer-two', createdAt: at + 11, message: { content: [{ type: 'text', text: 'later' }] } });
    // The command reports back: the same id, the same time.
    store.addMessage(row.id, callResult('built in 63s'));
    const order = store.getSessionHistory(row.id).map((message) => message.uuid ?? message.prompt);
    assert.deepEqual(order, ['one', 'call-build', 'result-of-build', 'two', 'answer-two']);
    assert.equal(store.getSessionHistory(row.id)[2].message.content[0].content, 'built in 63s');
    // A new message still goes below everything.
    store.addMessage(row.id, { type: 'assistant', uuid: 'answer-three', createdAt: at + 3, message: { content: [{ type: 'text', text: 'new' }] } });
    assert.equal(store.getSessionHistory(row.id).at(-1).uuid, 'answer-three');
    store.deleteSession(row.id);
  }

  // ── 7. Stop pressed after a message is shown and before it is sent. ──
  // Between showing a message and sending it the handlers await a check of
  // the agent's CLI. A Stop in that moment ends the task's run; the message
  // stays shown and must not be sent after all, on this runner or a new one.
  const cli = require(path.join(root, 'dist-electron/electron/libs/antigravity-cli.js'));
  {
    const sent = prompts().length;
    // Forget the cached check, so this one takes a real moment (it starts the CLI).
    cli.noteAntigravityAuthState('login_required');
    cli.noteAntigravityAuthState('ready');
    tap.onEvent = (event) => {
      if (event.type !== 'stream.user_prompt' || event.payload.prompt !== 'Do not run this') return;
      tap.onEvent = null;
      // On the loop's next turn: the message is shown, its check still awaited.
      setImmediate(() => send({ type: 'session.stop', payload: { sessionId: task.id } }));
    };
    const from = events.length;
    await send({ type: 'session.continue', payload: { sessionId: task.id, prompt: 'Do not run this' } });
    await until(() => store.getSession(task.id).status === 'idle', 'the task is stopped');
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(prompts().length, sent, 'the stopped message never reached agy');
    assert.equal(store.getSession(task.id).status, 'idle');
    const afterStop = events.slice(from).filter((event) => event.type === 'session.status' && event.payload.sessionId === task.id).map((event) => event.payload.status);
    assert.equal(afterStop.at(-1), 'idle', 'and the task does not start running again');
    assert.ok(store.getSessionHistory(task.id).some((message) => message.type === 'user_prompt' && message.prompt === 'Do not run this'), 'the message stays in the conversation');
    // The next message is sent as usual.
    await send({ type: 'session.continue', payload: { sessionId: task.id, prompt: 'This one, please' } });
    await until(() => prompts().length === sent + 1, 'agy got the next message');
    await idle(task.id);
    assert.equal(prompts().at(-1), 'This one, please');
    assert.equal(store.getSession(task.id).status, 'completed');
  }

  // ── 8. The check fails after the message is shown. ──
  // The window is told the task failed (the error alone left it showing the
  // task as running), agy is not prompted, and the next message works.
  {
    const sent = prompts().length;
    const seenErrors = errors().length;
    cli.noteAntigravityAuthState('login_required', 'Authentication required');
    const from = events.length;
    assert.equal(await send({ type: 'session.continue', payload: { sessionId: task.id, prompt: 'While signed out' } }), undefined);
    await until(() => errors().length === seenErrors + 1, 'the reason is given');
    assert.match(errors().at(-1), /sign[- ]?in/i);
    const told = events.slice(from).filter((event) => event.type === 'session.status' && event.payload.sessionId === task.id).map((event) => event.payload.status);
    assert.equal(told.at(-1), 'error', 'the window is told the task failed');
    assert.equal(store.getSession(task.id).status, 'error');
    assert.equal(prompts().length, sent);
    cli.noteAntigravityAuthState('ready');
    await send({ type: 'session.continue', payload: { sessionId: task.id, prompt: 'Signed in again' } });
    await until(() => prompts().length === sent + 1, 'agy got the message after sign-in');
    await idle(task.id);
    assert.equal(store.getSession(task.id).status, 'completed');
  }

  passed = true;
  console.log('antigravity-human-driven: ok');
} catch (failure) {
  console.error(failure);
} finally {
  try { ipc?.cleanup(); } catch { /* closing */ }
  rmSync(tmp, { recursive: true, force: true });
  // At once: runners and servers keep the process alive.
  process.exit(passed ? 0 : 1);
}
