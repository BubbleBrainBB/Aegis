// Copied history in the usage reports, against real SQLite: a fork or a
// handoff copies the transcript, results included, into the new task. Those
// turns were paid for in the task they ran in, so the copy adds nothing to any
// agent's report, while the new task's own turns count once. Electron is
// stubbed; Codex and OpenCode read from a scratch home.
// Requires transpile:electron.
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-copied-history-usage-'));
// Never read personal Codex or OpenCode history.
const home = path.join(tmp, 'home');
os.homedir = () => home;
process.env.CODEX_HOME = path.join(home, '.codex');
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
const electron = { app: { getPath: () => tmp, isPackaged: false, getAppPath: () => root } };
const originalLoad = Module._load;
Module._load = function (name, ...args) { return name === 'electron' ? electron : originalLoad.call(this, name, ...args); };
const sessions = require(path.join(root, 'dist-electron/electron/libs/session-store.js'));
const Database = require(path.join(root, 'node_modules/better-sqlite3'));

// A clock the test moves: tasks are created, and their turns run, in order.
const realNow = Date.now;
let clock = realNow() - 10 * 60 * 1000;
Date.now = () => clock;
const tick = () => (clock += 1000);

const PROVIDERS = ['claude', 'codex', 'opencode', 'kimi', 'qoder', 'devin', 'deepseek'];
const reports = () => JSON.parse(JSON.stringify(
  Object.fromEntries(PROVIDERS.map((provider) => [provider, sessions.getAgentUsageReport(provider, 30)]))
));
const unchangedBy = (label, act) => {
  const before = reports();
  const value = act();
  assert.deepEqual(reports(), before, `${label} must leave every agent's report as it was`);
  return value;
};
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} is not ${expected}`);
const task = (provider, model) => { tick(); return sessions.createSession({ title: `${provider} task`, cwd: tmp, provider, model }); };
const turn = (sessionId, extra = {}) => sessions.addMessage(sessionId, {
  type: 'result', subtype: 'success', duration_ms: 1, total_cost_usd: 0,
  usage: { input_tokens: 1000, output_tokens: 100 }, createdAt: tick(), ...extra,
});
const copyInto = (sourceId, provider, model) => {
  const copy = task(provider, model);
  sessions.copySessionHistory(sourceId, copy.id);
  return copy;
};
const results = (sessionId) => sessions.getSessionHistory(sessionId).filter((message) => message.type === 'result');

try {
  sessions.initialize();

  // A Claude task: one finished turn, and one stopped turn kept as a usage record.
  const claude = task('claude', 'claude-sonnet-4-6');
  sessions.addMessage(claude.id, { type: 'user_prompt', prompt: 'Add a retry helper', createdAt: tick() });
  turn(claude.id, {
    total_cost_usd: 1,
    modelUsage: { 'claude-sonnet-4-6': {
      inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 1, contextWindow: 200000,
    } },
  });
  assert.ok(sessions.addUsageRecord(claude.id, {
    type: 'usage_record', uuid: 'stopped-turn', duration_ms: 1, total_cost_usd: 0.5,
    usage: { input_tokens: 200, output_tokens: 20 }, createdAt: tick(),
  }));
  let report = sessions.getAgentUsageReport('claude', 30);
  assert.equal(report.totals.totalTokens, 1320);
  near(report.totals.totalCostUsd, 1.5, 'Claude cost before any copy');
  assert.equal(report.totals.sessionCount, 1);

  // Fork: the same agent. Nothing is added, and the copy still reads as the conversation.
  const fork = unchangedBy('A fork', () => copyInto(claude.id, 'claude', 'claude-sonnet-4-6'));
  const [sourceResult] = results(claude.id);
  const [forkResult] = results(fork.id);
  assert.equal(results(fork.id).length, 1, 'the fork shows the copied turn');
  assert.ok(sessions.getSessionHistory(fork.id).some((message) => message.type === 'user_prompt' && message.prompt === 'Add a retry helper'));
  assert.deepEqual(forkResult.usage, sourceResult.usage, 'the copied result keeps its numbers');
  assert.equal(forkResult.total_cost_usd, 1);
  assert.equal(forkResult.copiedFromSessionId, claude.id);
  assert.equal(sessions.isCopiedUsage(forkResult), true);
  assert.equal(sourceResult.copiedFromSessionId, undefined, 'the source is not marked');
  assert.equal(sessions.isCopiedUsage(sourceResult), false);
  // The context ring reads the last result, copied or not.
  const ring = sessions.getLatestClaudeModelUsageBySession();
  assert.ok(ring[fork.id], 'the fork has a context reading');
  assert.deepEqual(ring[fork.id], ring[claude.id]);

  // A turn run in the fork is the fork's own: counted once.
  turn(fork.id, { total_cost_usd: 0.25, usage: { input_tokens: 200, output_tokens: 20 } });
  report = sessions.getAgentUsageReport('claude', 30);
  assert.equal(report.totals.totalTokens, 1320 + 220);
  near(report.totals.totalCostUsd, 1.75, 'Claude cost after the fork ran a turn');
  assert.equal(report.totals.sessionCount, 2);

  // A fork of the fork copies a copy and an own turn: each names the task that ran it.
  const second = unchangedBy('A fork of a fork', () => copyInto(fork.id, 'claude', 'claude-sonnet-4-6'));
  assert.deepEqual(results(second.id).map((message) => message.copiedFromSessionId), [claude.id, fork.id]);
  // A history rewrite (rewind, compaction, edit) keeps the mark.
  unchangedBy('Rewriting copied history', () => sessions.replaceSessionHistory(second.id, sessions.getSessionHistory(second.id)));
  assert.deepEqual(results(second.id).map((message) => message.copiedFromSessionId), [claude.id, fork.id]);

  // Devin bills in messages and credits, Qoder in credits.
  const devin = task('devin', 'claude-opus-5-5');
  turn(devin.id, { costSource: 'unavailable', model: 'claude-opus-5-5', devinBilling: { agentMessages: 3, credits: 1.5 } });
  assert.deepEqual(sessions.getAgentUsageReport('devin', 30).billing, { agentMessages: 3, credits: 1.5 });
  const qoder = task('qoder', 'Auto');
  turn(qoder.id, { costSource: 'unavailable', model: 'Auto', qoderCredits: { sessionId: 'q1', total: 2, byModel: { Auto: 2 } } });

  // Handoff: another agent. The copied turns do not move into its report
  // (tokens, cost, Devin billing, Qoder credits), in either direction.
  const handoffs = {};
  for (const [provider, model] of [['kimi', 'kimi-k2'], ['qoder', 'Auto'], ['devin', 'claude-opus-5-5'], ['deepseek', 'deepseek-chat']]) {
    handoffs[provider] = unchangedBy(`A handoff from Claude to ${provider}`, () => copyInto(claude.id, provider, model));
  }
  unchangedBy('A handoff from Devin to Claude', () => copyInto(devin.id, 'claude', 'claude-sonnet-4-6'));
  unchangedBy('A copy from Devin to Devin', () => copyInto(devin.id, 'devin', 'claude-opus-5-5'));
  unchangedBy('A handoff from Qoder to Claude', () => copyInto(qoder.id, 'claude', 'claude-sonnet-4-6'));
  unchangedBy('A copy from Qoder to Qoder', () => copyInto(qoder.id, 'qoder', 'Auto'));
  for (const provider of ['kimi', 'deepseek']) {
    assert.equal(sessions.getAgentUsageReport(provider, 30).totals.totalTokens, 0, `${provider} has run nothing yet`);
    assert.equal(sessions.getAgentUsageReport(provider, 30).totals.sessionCount, 0);
  }

  // The new agent's own turn counts once, in its own report.
  turn(handoffs.kimi.id, { total_cost_usd: 3, costSource: 'reported', model: 'kimi-k2' });
  report = sessions.getAgentUsageReport('kimi', 30);
  assert.equal(report.totals.totalTokens, 1100);
  near(report.totals.totalCostUsd, 3, 'Kimi cost after its own turn');
  assert.equal(report.totals.sessionCount, 1);
  turn(handoffs.devin.id, { costSource: 'unavailable', model: 'claude-opus-5-5', devinBilling: { agentMessages: 1, credits: 0.5 } });
  assert.deepEqual(sessions.getAgentUsageReport('devin', 30).billing, { agentMessages: 4, credits: 2 });

  // DeepSeek's per-task cost prices the task's own turns only.
  assert.deepEqual(sessions.getDeepseekSessionCost(handoffs.deepseek.id), { usd: 0 });
  turn(handoffs.deepseek.id, { total_cost_usd: 0.5, costSource: 'reported', model: 'deepseek-chat' });
  assert.deepEqual(sessions.getDeepseekSessionCost(handoffs.deepseek.id), { usd: 0.5 });

  // Copies made before results were marked are found at startup and marked:
  // a result older than its task, identical to one in an earlier task.
  const cost = (provider) => sessions.getAgentUsageReport(provider, 30).totals.totalCostUsd;
  const claudeBefore = cost('claude');
  const kimiBefore = cost('kimi');
  const older = task('claude', 'claude-sonnet-4-6');
  tick();
  sessions.addMessage(older.id, { type: 'result', uuid: 'older-turn', subtype: 'success', duration_ms: 1, total_cost_usd: 2, usage: { input_tokens: 500, output_tokens: 50 } });
  const [olderTurn] = results(older.id);
  // What the copy used to store: the same result under a new id, unmarked.
  const oldCopy = (provider, model, uuid) => {
    const copy = task(provider, model);
    sessions.addMessage(copy.id, { ...olderTurn, uuid });
    return copy;
  };
  const oldFork = oldCopy('claude', 'claude-sonnet-4-6', 'old-fork-copy');
  const oldSecondFork = oldCopy('claude', 'claude-sonnet-4-6', 'old-second-fork-copy');
  const oldHandoff = oldCopy('kimi', 'kimi-k2', 'old-handoff-copy');
  turn(oldFork.id, { total_cost_usd: 0.1 });
  // Not copies: a result older than its task whose original is gone, and two
  // tasks whose own results happen to be identical.
  const orphan = task('claude', 'claude-sonnet-4-6');
  sessions.addMessage(orphan.id, { type: 'result', uuid: 'orphan-turn', subtype: 'success', duration_ms: 1, total_cost_usd: 4, usage: { input_tokens: 500, output_tokens: 50 }, createdAt: clock - 500 });
  const twins = [task('claude', 'claude-sonnet-4-6'), task('claude', 'claude-sonnet-4-6')];
  const sameMoment = tick();
  for (const twin of twins) turn(twin.id, { total_cost_usd: 0.5, createdAt: sameMoment });
  near(cost('claude'), claudeBefore + 2 + 2 + 2 + 0.1 + 4 + 1, 'old copies are counted again until they are marked');
  near(cost('kimi'), kimiBefore + 2, 'an old handoff copy is counted under the new agent until it is marked');
  assert.equal(sessions.markResultsCopiedBeforeMarking(), 3);
  near(cost('claude'), claudeBefore + 2 + 0.1 + 4 + 1, 'the copied turn is counted once, own turns stay');
  near(cost('kimi'), kimiBefore, 'the handoff copy no longer counts for the new agent');
  for (const copy of [oldFork, oldSecondFork, oldHandoff]) {
    assert.equal(results(copy.id)[0].copiedFromSessionId, older.id);
    assert.equal(results(copy.id)[0].total_cost_usd, 2, 'a marked copy keeps its numbers');
  }
  assert.equal(results(oldFork.id)[1].copiedFromSessionId, undefined, 'the old fork keeps its own turn');
  assert.equal(results(older.id)[0].copiedFromSessionId, undefined);
  assert.equal(results(orphan.id)[0].copiedFromSessionId, undefined);
  for (const twin of twins) assert.equal(results(twin.id)[0].copiedFromSessionId, undefined);
  assert.equal(sessions.markResultsCopiedBeforeMarking(), 0, 'nothing is left to mark');

  // Codex counts tokens from its rollout files and takes a turn's price from
  // the result after it. A copied result's price is not a price for the new
  // task's rollout.
  const state = new Database(path.join(process.env.CODEX_HOME, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,model TEXT,tokens_used INTEGER)');
  const rollout = (threadId, at) => {
    const usage = { input_tokens: 100000, cached_input_tokens: 50000, output_tokens: 1000, cache_write_input_tokens: 0, total_tokens: 101000 };
    const file = path.join(tmp, `${threadId}.jsonl`);
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      JSON.stringify({ type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } } }),
    ].join('\n'));
    state.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(threadId, file, 'gpt-5.5', 0);
  };
  const codex = task('codex', 'gpt-5.5');
  sessions.updateCodexSessionId(codex.id, 'source-thread');
  const ranAt = tick();
  rollout('source-thread', ranAt);
  turn(codex.id, { total_cost_usd: 42, costSource: 'reported', usage: { input_tokens: 100000, output_tokens: 1000 } });
  report = sessions.getAgentUsageReport('codex', 30);
  assert.equal(report.totals.totalTokens, 101000);
  near(report.totals.totalCostUsd, 42, 'Codex cost as reported');
  const codexFork = task('codex', 'gpt-5.5');
  sessions.updateCodexSessionId(codexFork.id, 'fork-thread');
  rollout('fork-thread', ranAt);
  sessions.updateSessionModel(codexFork.id, 'gpt-5.5'); // The store's own invalidation: the rollout is new.
  near(sessions.getAgentUsageReport('codex', 30).totals.totalCostUsd, 42.305, 'the other thread is priced by the API estimate');
  unchangedBy('A copy into a Codex task', () => sessions.copySessionHistory(codex.id, codexFork.id));
  state.close();

  console.log('copied history usage: ok');
} finally {
  Date.now = realNow;
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true });
}
