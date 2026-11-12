// Qoder credits in the usage report, against real SQLite: the CLI reports
// running totals per Qoder session, and the report turns them into what each
// turn, day and model used. Electron is stubbed.
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-qoder-credits-'));
const electron = { app: { getPath: () => tmp, isPackaged: false, getAppPath: () => path.resolve(__dirname, '../..') } };
const originalLoad = Module._load;
Module._load = function (name, ...args) { return name === 'electron' ? electron : originalLoad.call(this, name, ...args); };
const sessions = require(path.resolve(__dirname, '../../dist-electron/electron/libs/session-store.js'));

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const dayKey = (at) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} is not ${expected}`);

sessions.initialize();
const task = sessions.createSession({ title: 'Qoder task', cwd: tmp, provider: 'qoder', model: 'Auto' });
const result = (at, qoderCredits, extra = {}) => sessions.addMessage(task.id, {
  type: 'result', subtype: 'success', duration_ms: 1, total_cost_usd: 0, costSource: 'unavailable',
  usage: { input_tokens: 0, output_tokens: 0 }, model: 'Auto', createdAt: at, ...(qoderCredits ? { qoderCredits } : {}), ...extra,
});

// Three turns of one Qoder session: 2, then 3 more, then 1.5 more on another model.
result(now - 3 * DAY, { sessionId: 'q1', total: 2, byModel: { Auto: 2 } });
result(now - 3 * DAY + 1000, { sessionId: 'q1', total: 5, byModel: { Auto: 5 } });
result(now - 2 * DAY, { sessionId: 'q1', total: 6.5, byModel: { Auto: 5, Fast: 1.5 } });
// A turn that reports nothing (an older CLI, a stopped turn) changes nothing.
result(now - 2 * DAY + 1000, null);
// A fork is another Qoder session and counts from zero; so does a total that went down.
result(now - DAY, { sessionId: 'q2', total: 0.5, byModel: { Auto: 0.5 } });
result(now - DAY + 1000, { sessionId: 'q2', total: 0.25, byModel: {} });
// Unreadable totals are skipped.
result(now - DAY + 2000, { sessionId: '', total: 99, byModel: {} });
result(now - DAY + 3000, { sessionId: 'q2', total: -1, byModel: {} });

let report = sessions.getAgentUsageReport('qoder', 30);
near(report.billing.credits, 2 + 3 + 1.5 + 0.5 + 0.25, 'credits in the range');
assert.equal(report.billing.agentMessages, 0);
assert.equal(report.totals.totalTokens, 0);
const models = Object.fromEntries(report.models.map((model) => [model.model, model]));
near(models.Auto.credits, 2 + 3 + 0.5 + 0.25, 'Auto: a turn whose totals name no model goes to its own');
near(models.Fast.credits, 1.5, 'Fast');
assert.equal(models.Auto.sessionCount, 1);
assert.equal(models.Fast.sessionCount, 1);
const days = Object.fromEntries(report.daily.map((point) => [point.date, point.byModelCredits ?? {}]));
near(days[dayKey(now - 3 * DAY)].Auto, 5, 'first day');
near(days[dayKey(now - 2 * DAY)].Fast, 1.5, 'second day, new model');
assert.equal(days[dayKey(now - 2 * DAY)].Auto, undefined, 'a model whose total did not move used nothing that day');
near(days[dayKey(now - DAY)].Auto, 0.75, 'third day');

// A range that starts mid-session counts from the totals just before it,
// not from zero.
const old = sessions.createSession({ title: 'Long task', cwd: tmp, provider: 'qoder', model: 'Auto' });
const oldResult = (at, total) => sessions.addMessage(old.id, {
  type: 'result', subtype: 'success', duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 },
  model: 'Auto', createdAt: at, qoderCredits: { sessionId: 'long', total, byModel: { Auto: total } },
});
oldResult(now - 40 * DAY, 100);
oldResult(now - 20 * DAY, 130);
oldResult(now - 2 * DAY, 131);
const before = report.billing.credits;
near(sessions.getAgentUsageReport('qoder', 30).billing.credits, before + 30 + 1, '30 days: the 100 from before the range is the base');
near(sessions.getAgentUsageReport('qoder', 7).billing.credits, before + 1, '7 days: only the last turn of the long task');
near(sessions.getAgentUsageReport('qoder', 365).billing.credits, before + 131, 'a year: all of it');

// When the models' totals moved by more than the session's did, the result
// before lacked them: the turn goes to its own model, whatever order they come in.
for (const byModel of [{ Auto: 2, Fast: 1 }, { Fast: 1, Auto: 2 }]) {
  const mixed = sessions.createSession({ title: 'Totals without models', cwd: tmp, provider: 'qoder', model: 'Fast' });
  const add = (at, qoderCredits) => sessions.addMessage(mixed.id, {
    type: 'result', subtype: 'success', duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, model: 'Fast', createdAt: at, qoderCredits,
  });
  const fastBefore = sessions.getAgentUsageReport('qoder', 30).models.find((model) => model.model === 'Fast').credits;
  const autoBefore = sessions.getAgentUsageReport('qoder', 30).models.find((model) => model.model === 'Auto').credits;
  add(now - 5000, { sessionId: mixed.id, total: 2, byModel: {} });
  add(now - 4000, { sessionId: mixed.id, total: 3, byModel });
  const after = Object.fromEntries(sessions.getAgentUsageReport('qoder', 30).models.map((model) => [model.model, model.credits]));
  near(after.Fast - fastBefore, 3, `Fast gets both turns (${Object.keys(byModel)})`);
  near(after.Auto - autoBefore, 0, `Auto gets none of it (${Object.keys(byModel)})`);
}

// The turn's model can be stored by its id while the totals name models as
// the picker does: the share no model accounts for still lands on one row.
{
  const named = sessions.createSession({ title: 'Id and name', cwd: tmp, provider: 'qoder', model: 'cmodel' });
  const add = (at, qoderCredits) => sessions.addMessage(named.id, {
    type: 'result', subtype: 'success', duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, model: 'cmodel', createdAt: at, qoderCredits,
  });
  add(now - 3000, { sessionId: named.id, total: 2, byModel: { Cantus: 2 }, model: 'Cantus' });
  add(now - 2000, { sessionId: named.id, total: 3, byModel: { Cantus: 2 }, model: 'Cantus' });
  const rows = Object.fromEntries(sessions.getAgentUsageReport('qoder', 30).models.map((model) => [model.model, model.credits ?? 0]));
  near(rows.Cantus, 3, 'both turns on the named row');
  assert.ok(!(rows.cmodel > 0), 'no second row under the id');
}

// A copied transcript shows the conversation and bills nothing: a task handed
// to Claude and back, or forked, adds no credits until it runs a turn of its own.
{
  const total = () => sessions.getAgentUsageReport('qoder', 30).billing.credits;
  const spent = total();
  const claude = sessions.createSession({ title: 'Qoder task', cwd: tmp, provider: 'claude' });
  sessions.copySessionHistory(task.id, claude.id);
  const back = sessions.createSession({ title: 'Qoder task', cwd: tmp, provider: 'qoder', model: 'Auto' });
  sessions.copySessionHistory(claude.id, back.id);
  const fork = sessions.createSession({ title: 'Qoder task (fork)', cwd: tmp, provider: 'qoder', model: 'Auto' });
  sessions.copySessionHistory(task.id, fork.id);
  near(total(), spent, 'copies add nothing');
  assert.ok(sessions.getSessionHistory(back.id).length > 0, 'the transcript was copied');
  assert.ok(sessions.getSessionHistory(back.id).every((message) => message.qoderCredits === undefined), 'without the credit totals');
  assert.ok(sessions.getSessionHistory(task.id).some((message) => message.qoderCredits), 'which stay on the task that spent them');
  // The returned task's own first turn, in a new Qoder session, counts from zero.
  sessions.addMessage(back.id, {
    type: 'result', subtype: 'success', duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, model: 'Auto', createdAt: now - 100,
    qoderCredits: { sessionId: 'q-back', total: 0.4, byModel: { Auto: 0.4 } },
  });
  near(total(), spent + 0.4, 'its own turn counts');
}

// Other agents are untouched: no billing block for one that reports none.
sessions.createSession({ title: 'Kimi task', cwd: tmp, provider: 'kimi' });
assert.equal(sessions.getAgentUsageReport('kimi', 30).billing, undefined);

sessions.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('qoder-credits.test.cjs passed');
