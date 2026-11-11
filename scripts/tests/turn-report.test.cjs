// Turn reports (shared/turn-report.ts) end to end on the compiled main
// process: the report_status tool, its storage on the session row, clearing
// when a new run starts, the MCP registration, and the desktop notification.
// Real SQLite; the Electron shell is stubbed.
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-turn-report-'));
const shown = [];
class Notification {
  constructor(options) { this.options = options; }
  static isSupported() { return true; }
  on() {}
  show() { shown.push(this.options); }
}
const electron = {
  app: { getPath: () => tmp, isPackaged: false, getAppPath: () => path.resolve(__dirname, '../..') },
  Notification,
};
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === 'electron' ? electron : originalLoad.call(this, name, ...args);
};

const root = path.resolve(__dirname, '../../dist-electron');
const sessions = require(path.join(root, 'electron/libs/session-store.js'));
const tool = require(path.join(root, 'electron/libs/turn-report-tool.js'));
const notifications = require(path.join(root, 'electron/libs/notifications.js'));
const { buildSessionMcpServer } = require(path.join(root, 'electron/libs/session-mcp.js'));
const { parseTurnReport, turnReportNeedsUser, isReportStatusToolName } = require(path.join(root, 'shared/turn-report.js'));

const textOf = (result) => result.content.map((item) => item.text).join('\n');
const flush = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  sessions.initialize();
  const a = sessions.createSession({ title: 'Import job', cwd: tmp, provider: 'codex' });
  const hidden = sessions.createSession({ title: 'Workflow member', cwd: tmp, provider: 'claude', hiddenFromThreads: true });

  // --- tool name and parsing ------------------------------------------------
  assert.equal(isReportStatusToolName('report_status'), true);
  assert.equal(isReportStatusToolName('mcp__aegis-sessions__report_status'), true);
  assert.equal(isReportStatusToolName('aegis-sessions.report_status'), true);
  assert.equal(isReportStatusToolName('report_statuses'), false);
  assert.equal(parseTurnReport(null), null);
  assert.equal(parseTurnReport('{not json'), null);
  assert.equal(parseTurnReport({ outcome: 'done', summary: 'x', reportedAt: 1 }), null, 'unknown outcomes are dropped');

  // --- the tool without a host ----------------------------------------------
  tool.setTurnReportEntry(null);
  assert.equal(tool.reportStatus(a.id, { outcome: 'blocked', summary: 'x' }).isError, true);

  // --- the host the main process installs (mirrors ipc-handlers.ts) -----------
  const broadcasts = [];
  tool.setTurnReportEntry({
    history: (sessionId) => sessions.getSessionHistory(sessionId),
    record: (sessionId, report) => {
      const row = sessions.getSession(sessionId);
      if (!row) return 'This conversation no longer exists.';
      if (row.hidden_from_threads === 1) return null;
      sessions.setSessionTurnReport(sessionId, report);
      broadcasts.push({ sessionId, report });
      return null;
    },
  });

  // Validation happens before anything is stored.
  assert.equal(tool.reportStatus(a.id, { outcome: 'finished', summary: 'x' }).isError, true, 'outcome is checked');
  assert.equal(tool.reportStatus(a.id, { outcome: 'blocked', summary: '   ' }).isError, true, 'summary is required');
  assert.equal(tool.reportStatus(a.id, { outcome: 'question', summary: 'Pick one' }).isError, true,
    'a question report carries the question');
  assert.equal(tool.reportStatus('missing', { outcome: 'blocked', summary: 'x' }).isError, true);
  assert.equal(tool.reportStatus(a.id, { outcome: 'in_progress', summary: 'x' }).isError, true,
    'work still running is only for runtimes that wake the agent (Claude)');
  assert.ok(!tool.reportStatusDescription(false).includes('in_progress'));
  assert.ok(tool.reportStatusDescription(true).includes('"in_progress"'));
  assert.ok(!tool.REPORT_STATUS_JSON_SCHEMA.properties.outcome.enum.includes('in_progress'));
  assert.equal(broadcasts.length, 0);
  assert.equal(sessions.getSession(a.id).turn_report ?? null, null);

  // A run starts; the agent asks a question.
  sessions.updateSessionStatus(a.id, 'running');
  const asked = tool.reportStatus(a.id, {
    outcome: 'question', summary: '  Which database should the import target?  ', question: 'Staging or production?',
  }, { now: 1000 });
  assert.equal(asked.isError, undefined);
  assert.match(textOf(asked), /Recorded/);
  assert.match(textOf(asked), /end your turn without adding anything/, 'no closing line after a reply already written');
  let stored = parseTurnReport(sessions.getSession(a.id).turn_report);
  assert.deepEqual(stored, {
    outcome: 'question', summary: 'Which database should the import target?', question: 'Staging or production?', reportedAt: 1000,
  });
  assert.equal(turnReportNeedsUser(stored), true);
  assert.equal(broadcasts.length, 1);

  // The last report of a turn wins; a question field on another outcome is dropped.
  tool.reportStatus(a.id, { outcome: 'blocked', summary: 'Needs the staging API key', question: 'ignored' }, { background: true, now: 2000 });
  stored = parseTurnReport(sessions.getSession(a.id).turn_report);
  assert.deepEqual(stored, { outcome: 'blocked', summary: 'Needs the staging API key', reportedAt: 2000 });

  // Hidden runs (workflow members) are accepted but never stored.
  assert.equal(tool.reportStatus(hidden.id, { outcome: 'blocked', summary: 'x' }).isError, undefined);
  assert.equal(sessions.getSession(hidden.id).turn_report ?? null, null);

  // --- the notification when the run ends -------------------------------------
  notifications.configureNotifications({ isWindowFocused: () => false, onActivate: () => {} });
  let finished;
  let backgroundWork = false;
  sessions.setSessionStatusListener((row, previous) => {
    if (previous === 'running' && row.status !== 'running') {
      finished = row;
      notifications.notifySessionDone(row, { backgroundWork });
    }
  });
  sessions.updateSessionStatus(a.id, 'completed');
  await flush();
  assert.ok(finished, 'the status listener saw the run end');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Agent is blocked');
  assert.equal(shown[0].body, 'Import job: Needs the staging API key');

  // Still running repeats keep the report; only a new run clears it.
  sessions.updateSessionStatus(a.id, 'completed');
  assert.ok(sessions.getSession(a.id).turn_report, 'a status write that is not a new run keeps the report');
  sessions.updateSessionStatus(a.id, 'running');
  assert.equal(sessions.getSession(a.id).turn_report, null, 'a new run starts with no report');
  tool.reportStatus(a.id, { outcome: 'in_progress', summary: 'Waiting for the import job' }, { background: true, now: 3000 });
  sessions.updateSessionStatus(a.id, 'running');
  assert.ok(sessions.getSession(a.id).turn_report, 'running → running is the same run');

  // Quiet outcomes notify nobody.
  shown.length = 0;
  backgroundWork = true;
  sessions.updateSessionStatus(a.id, 'completed');
  await flush();
  assert.equal(shown.length, 0, 'work still running in the background is not a finished run');
  backgroundWork = false;
  sessions.updateSessionStatus(a.id, 'running');
  tool.reportStatus(a.id, { outcome: 'in_progress', summary: 'No task behind this' }, { background: true, now: 3500 });
  sessions.updateSessionStatus(a.id, 'completed');
  await flush();
  assert.deepEqual(shown.map((n) => n.title), ['Agent run finished'],
    'with no task alive nothing would wake the agent, so the finish is still announced');
  shown.length = 0;
  sessions.updateSessionStatus(a.id, 'running');
  tool.reportStatus(a.id, { outcome: 'nothing_to_do', summary: 'Already fixed on main' }, { background: true, now: 4000 });
  sessions.updateSessionStatus(a.id, 'completed');
  await flush();
  assert.equal(shown.length, 0, 'a turn with nothing to change is not announced');

  // A question uses the input notification with the question itself.
  sessions.updateSessionStatus(a.id, 'running');
  tool.reportStatus(a.id, { outcome: 'question', summary: 'Pick a target', question: 'Staging or production?' }, { background: true, now: 5000 });
  sessions.updateSessionStatus(a.id, 'completed');
  await flush();
  assert.deepEqual(shown.map((n) => [n.title, n.body]), [['Agent needs your input', 'Import job: Staging or production?']]);

  // A failed run is a failure whatever the agent reported.
  shown.length = 0;
  sessions.updateSessionStatus(a.id, 'running');
  tool.reportStatus(a.id, { outcome: 'nothing_to_do', summary: 'x' }, { background: true, now: 6000 });
  sessions.updateSessionStatus(a.id, 'error');
  await flush();
  assert.deepEqual(shown.map((n) => n.title), ['Agent run failed']);

  // No report: the plain finished notification, as before.
  shown.length = 0;
  sessions.updateSessionStatus(a.id, 'running');
  sessions.updateSessionStatus(a.id, 'completed');
  await flush();
  assert.deepEqual(shown.map((n) => n.title), ['Agent run finished']);

  // --- a subagent never speaks for the conversation ----------------------------
  const tool_use = (id) => ({ type: 'tool_use', id, name: 'mcp__aegis-sessions__report_status', input: {} });
  const b = sessions.createSession({ title: 'Claude run', cwd: tmp, provider: 'claude' });
  sessions.addMessage(b.id, { type: 'assistant', uuid: 'main', parentToolUseId: null, message: { content: [tool_use('main-call')] } });
  sessions.addMessage(b.id, { type: 'assistant', uuid: 'sub', parentToolUseId: 'task-1', message: { content: [tool_use('sub-call')] } });
  const meta = (id) => ({ _meta: { 'claudecode/toolUseId': id } });
  const fromSub = await tool.reportClaudeStatus(b.id, { outcome: 'nothing_to_do', summary: 'mine' }, meta('sub-call'));
  assert.equal(fromSub.isError, true);
  assert.equal(sessions.getSession(b.id).turn_report ?? null, null, "a subagent's report is not stored");
  assert.equal((await tool.reportClaudeStatus(b.id, { outcome: 'in_progress', summary: 'main' }, meta('main-call'))).isError, undefined);
  assert.equal(parseTurnReport(sessions.getSession(b.id).turn_report).outcome, 'in_progress');
  const before = sessions.getSession(b.id).turn_report;
  assert.equal((await tool.reportClaudeStatus(b.id, { outcome: 'blocked', summary: 'no id' })).isError, true,
    'a call that names no tool_use is not trusted');
  assert.equal((await tool.reportClaudeStatus(b.id, { outcome: 'blocked', summary: 'late' }, meta('not-landed'), { waitMs: 150 })).isError, true,
    'a call history does not show yet is not trusted either: it might be a subagent, or ahead of a queued prompt starting');
  assert.equal(sessions.getSession(b.id).turn_report, before, 'neither is stored');
  sessions.addMessage(b.id, { type: 'assistant', uuid: 'late', parentToolUseId: null, message: { content: [tool_use('landing')] } });
  assert.equal((await tool.reportClaudeStatus(b.id, { outcome: 'blocked', summary: 'landed' }, meta('landing'), { waitMs: 150 })).isError, undefined);

  // --- MCP registration ------------------------------------------------------
  const toolNames = (server) => Object.keys(server._registeredTools);
  assert.ok(toolNames(buildSessionMcpServer({ callerSessionId: a.id })).includes('report_status'),
    'a signed caller gets the tool');
  const directOnly = [];
  const metaServer = buildSessionMcpServer({ resolveFromMeta: async (_meta, options) => { directOnly.push(options); return null; } });
  const refused = await metaServer._registeredTools.report_status.handler({ outcome: 'blocked', summary: 'x' }, { _meta: {} });
  assert.deepEqual(directOnly, [{ direct: true }], 'a request-meta caller must be the session itself, not a parent found through it');
  assert.equal(refused.isError, true);
  // OpenCode's real resolver: a subagent's child session walks up to its parent, unless the call must be direct.
  let resolve;
  const { OpenCodeSdkAdapter } = require(path.join(root, 'electron/libs/provider/opencode-sdk-adapter.js'));
  const adapter = new OpenCodeSdkAdapter({
    setBrowserUseHooks: (fn) => { resolve = fn; },
    getClient: async () => ({ getSession: async (id) => (id === 'child' ? { parentID: 'parent' } : null) }),
  });
  adapter.sessions.set('thread-1', { providerSessionId: 'parent', threadId: 'thread-1' });
  const named = (id) => ({ 'ai.opencode/sessionID': id });
  assert.equal(await resolve(named('child')), 'thread-1', 'browser and design calls still follow the parent');
  assert.equal(await resolve(named('child'), { direct: true }), null, 'a report from a child session is refused');
  assert.equal(await resolve(named('parent'), { direct: true }), 'thread-1');
  assert.ok(!toolNames(buildSessionMcpServer()).includes('report_status'),
    'without a named caller the tool is not offered: a report never lands on a guessed session');
  assert.ok(!toolNames(buildSessionMcpServer({ only: new Set(['show_widget']), callerSessionId: a.id })).includes('report_status'),
    'narrowed servers (Kimi) leave it out');

  // That reply can then be narration alone (prose Claude returned as a
  // thinking block): another task reading this one still gets it.
  const { readReferencedSession } = require(path.join(root, 'electron/libs/session-reference.js'));
  const replied = sessions.createSession({ title: 'Code word', cwd: tmp, provider: 'claude' });
  sessions.addMessage(replied.id, { type: 'user_prompt', prompt: 'What was the code word?', createdAt: 10 });
  sessions.addMessage(replied.id, { type: 'assistant', uuid: 'why', message: { content: [{ type: 'thinking', thinking: 'Look it up.' }] }, createdAt: 20 });
  sessions.addMessage(replied.id, { type: 'assistant', uuid: 'said', message: { content: [{ type: 'thinking', thinking: 'It was pineapple-42.\n\n', narration: true }] }, createdAt: 30 });
  assert.deepEqual(readReferencedSession(replied.id).messages.map((message) => message.text), ['It was pineapple-42.', '[thinking]', 'What was the code word?']);

  sessions.setSessionStatusListener(null);
  console.log('turn-report: ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
