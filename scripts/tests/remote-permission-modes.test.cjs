// The permission mode of a session that another device drives: kept on the
// session (real SQLite, with a database from before the columns existed),
// reported to that device, and never lowered by a message that names no mode.
// Run: npm run transpile:electron && node scripts/tests/remote-permission-modes.test.cjs
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-remote-modes-'));
const electron = { app: { getPath: () => tmp, isPackaged: false, getAppPath: () => path.resolve(__dirname, '../..') } };
const originalLoad = Module._load;
Module._load = function (name, ...args) { return name === 'electron' ? electron : originalLoad.call(this, name, ...args); };

const root = path.resolve(__dirname, '../../dist-electron');
const sessions = require(path.join(root, 'electron/libs/session-store.js'));
const { keptSettings, remoteTaskPayload, sessionTaskSettings } = require(path.join(root, 'electron/remote/task-payload.js'));
const { chooseSettings, effectiveSettings, forgetCleared, markSent, pruneChosen, settingsToSend, waitingSettings } = require(path.join(root, 'shared/remote/chosen-settings.js'));
const Database = require('better-sqlite3');

const NEW_COLUMNS = ['bubble_permission_mode', 'bubble_plan_exit_mode', 'devin_permission_mode', 'mimo_permission_mode', 'minimax_permission_mode'];
const settingsOf = (id) => sessionTaskSettings(sessions.getSession(id));
/** A message from another device to a session that exists, as the host maps it. */
const followUp = (id, settings) => remoteTaskPayload(sessions.getSession(id).provider, { settings }, settingsOf(id));

// ── A database from before the columns: they are added, and its sessions say no mode. ──
sessions.initialize();
const old = sessions.createSession({ title: 'Before the columns', cwd: tmp, provider: 'bubble' });
sessions.close();
{
  const db = new Database(path.join(tmp, 'sessions.db'));
  for (const column of NEW_COLUMNS) db.exec(`ALTER TABLE sessions DROP COLUMN ${column}`);
  const columns = db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name);
  assert.ok(NEW_COLUMNS.every((column) => !columns.includes(column)), 'the fixture is an old database');
  db.close();
}
sessions.initialize();
{
  const row = sessions.getSession(old.id);
  assert.equal(row.title, 'Before the columns', 'the old session is still there');
  for (const column of NEW_COLUMNS) assert.equal(row[column], null, `${column} was added empty`);
  assert.deepEqual(settingsOf(old.id), { model: undefined, permissionMode: undefined, plan: undefined });
  // Nothing known and nothing said: the message names no mode, so the session keeps whatever it runs with.
  const payload = followUp(old.id, {});
  assert.equal(payload.bubblePermissionMode, undefined);
  assert.equal(payload.bubblePlanExitMode, undefined);
}

// ── Bubble: Full Access is kept on the session and reported. ──
const bubble = sessions.createSession({ title: 'Bubble', cwd: tmp, provider: 'bubble' });
assert.equal(sessions.getSession(bubble.id).bubble_permission_mode, null, 'no mode before one is said');
sessions.rememberSessionPermissionMode(bubble.id, 'bubble', { bubble: 'bypassPermissions', bubblePlanExit: 'bypassPermissions' });
assert.equal(sessions.getSession(bubble.id).bubble_permission_mode, 'bypassPermissions');
assert.equal(sessions.getSession(bubble.id).bubble_plan_exit_mode, 'bypassPermissions');
assert.equal(settingsOf(bubble.id).permissionMode, 'bypassPermissions');
assert.equal(settingsOf(bubble.id).plan, undefined);
// Across a restart too: the runner that held it is long gone by then.
sessions.close(); sessions.initialize();
assert.equal(settingsOf(bubble.id).permissionMode, 'bypassPermissions');

// A message that names no mode (the main bot's message_task on an older build
// of the other Mac, the settings a host never reported) keeps Full Access.
assert.deepEqual(
  [followUp(bubble.id, {}).bubblePermissionMode, followUp(bubble.id, {}).bubblePlanExitMode],
  ['bypassPermissions', 'bypassPermissions'],
);
assert.equal(followUp(bubble.id, undefined).bubblePermissionMode, 'bypassPermissions');
assert.equal(followUp(bubble.id, { model: 'kimi-k2' }).bubblePermissionMode, 'bypassPermissions');
// A mode that isn't one of the agent's is no mode.
assert.equal(followUp(bubble.id, { permissionMode: 'fullAccess' }).bubblePermissionMode, 'bypassPermissions');
// One that is said is taken, down as well as up.
assert.equal(followUp(bubble.id, { permissionMode: 'default' }).bubblePermissionMode, 'default');
assert.equal(followUp(bubble.id, { permissionMode: 'default' }).bubblePlanExitMode, 'default');

// A mode left unsaid changes nothing on the session.
sessions.rememberSessionPermissionMode(bubble.id, 'bubble', {});
assert.equal(sessions.getSession(bubble.id).bubble_permission_mode, 'bypassPermissions');

// Plan is a Bubble mode: the session says plan, and the mode it returns to stays Full Access.
assert.deepEqual(
  [followUp(bubble.id, { plan: true }).bubblePermissionMode, followUp(bubble.id, { plan: true }).bubblePlanExitMode],
  ['plan', 'bypassPermissions'],
);
sessions.rememberSessionPermissionMode(bubble.id, 'bubble', { bubble: 'plan', bubblePlanExit: 'bypassPermissions' });
assert.deepEqual(settingsOf(bubble.id), { model: undefined, permissionMode: 'bypassPermissions', plan: true });
// Still planning when the next message says nothing; out of it when the message says so.
assert.deepEqual(
  [followUp(bubble.id, {}).bubblePermissionMode, followUp(bubble.id, {}).bubblePlanExitMode],
  ['plan', 'bypassPermissions'],
);
assert.equal(followUp(bubble.id, { plan: false }).bubblePermissionMode, 'bypassPermissions');
assert.equal(followUp(bubble.id, { permissionMode: 'bypassPermissions' }).bubblePermissionMode, 'bypassPermissions');
// Told to leave plan when no mode to return to is known (REMOTE-MODE-04): Bubble's default, not plan again.
{
  const unknownExit = sessions.createSession({ title: 'Plan, exit unknown', cwd: tmp, provider: 'bubble' });
  sessions.rememberSessionPermissionMode(unknownExit.id, 'bubble', { bubble: 'plan' });
  assert.deepEqual(settingsOf(unknownExit.id), { model: undefined, permissionMode: undefined, plan: true });
  assert.deepEqual(
    [followUp(unknownExit.id, { plan: false }).bubblePermissionMode, followUp(unknownExit.id, { plan: false }).bubblePlanExitMode],
    ['default', 'default'],
  );
  assert.equal(followUp(unknownExit.id, {}).bubblePermissionMode, 'plan', 'nothing said: still planning');
}
// Plan said with no mode to return to keeps the one the session has.
sessions.rememberSessionPermissionMode(bubble.id, 'bubble', { bubble: 'plan' });
assert.equal(sessions.getSession(bubble.id).bubble_plan_exit_mode, 'bypassPermissions');
// The agent leaves plan when its plan is approved (onBubblePermissionModeChange): the session follows.
sessions.rememberSessionPermissionMode(bubble.id, 'bubble', { bubble: 'bypassPermissions' });
assert.deepEqual(settingsOf(bubble.id), { model: undefined, permissionMode: 'bypassPermissions', plan: undefined });
sessions.rememberSessionPermissionMode(bubble.id, 'bubble', { bubble: 'default' });
assert.equal(sessions.getSession(bubble.id).bubble_plan_exit_mode, 'default', 'a mode other than plan is where it stays');
assert.equal(settingsOf(bubble.id).permissionMode, 'default');

// ── What a turn on this Mac runs with (handleSessionContinue): the message's word, else the session's. ──
{
  const turn = (said) => sessions.bubbleModesForTurn(said, sessions.getSession(bubble.id));
  sessions.rememberSessionPermissionMode(bubble.id, 'bubble', { bubble: 'bypassPermissions' });
  // The main bot's message_task names no mode. The runner may be long gone: the session's mode it is.
  assert.deepEqual(turn({}), { permissionMode: 'bypassPermissions', planExitMode: undefined });
  assert.deepEqual(turn({ permissionMode: null, planExitMode: null }), { permissionMode: 'bypassPermissions', planExitMode: undefined });
  assert.deepEqual(turn({ permissionMode: 'nonsense' }), { permissionMode: 'bypassPermissions', planExitMode: undefined });
  // What the message says wins, and the stored plan exit does not override the mode it names.
  assert.deepEqual(turn({ permissionMode: 'default' }), { permissionMode: 'default', planExitMode: undefined });
  assert.deepEqual(turn({ permissionMode: 'plan', planExitMode: 'default' }), { permissionMode: 'plan', planExitMode: 'default' });
  // Planning, and the message says nothing: still planning, and Full Access once the plan is approved.
  sessions.rememberSessionPermissionMode(bubble.id, 'bubble', { bubble: 'plan' });
  assert.deepEqual(turn({}), { permissionMode: 'plan', planExitMode: 'bypassPermissions' });
  assert.deepEqual(turn({ permissionMode: 'plan' }), { permissionMode: 'plan', planExitMode: 'bypassPermissions' });
  // A session that never said a mode leaves it to the agent, as before.
  assert.deepEqual(sessions.bubbleModesForTurn({}, sessions.getSession(old.id)), { permissionMode: undefined, planExitMode: undefined });
  sessions.rememberSessionPermissionMode(bubble.id, 'bubble', { bubble: 'default' });
}

// ── The agent changes mode itself in the turn it runs (REMOTE-MODE-02). ──
{
  const state = () => { const row = sessions.getSession(bubble.id); return [row.bubble_permission_mode, row.bubble_plan_exit_mode]; };
  // An approved plan, nothing chosen since: the session follows the turn out of plan.
  sessions.rememberSessionPermissionMode(bubble.id, 'bubble', { bubble: 'plan', bubblePlanExit: 'bypassPermissions' });
  sessions.rememberBubbleModeSwitch(bubble.id, 'bypassPermissions', false);
  assert.deepEqual(state(), ['bypassPermissions', 'bypassPermissions']);
  // Default chosen for the next turn while the plan was being worked on: approving the plan does not undo it.
  sessions.rememberSessionPermissionMode(bubble.id, 'bubble', { bubble: 'plan', bubblePlanExit: 'bypassPermissions' });
  const planning = sessions.getSession(bubble.id);
  assert.equal(sessions.namesAnotherBubbleMode({ permissionMode: 'default', planExitMode: 'default' }, planning), true);
  sessions.rememberSessionPermissionMode(bubble.id, 'bubble', { bubble: 'default', bubblePlanExit: 'default' });
  sessions.rememberBubbleModeSwitch(bubble.id, 'bypassPermissions', true);
  assert.deepEqual(state(), ['default', 'default']);
  assert.equal(sessions.bubbleModesForTurn({}, sessions.getSession(bubble.id)).permissionMode, 'default', 'the next turn runs in the mode chosen for it');
  // Still plan, with another mode to follow it: the plan is approved, so the session goes to that mode, not the turn's.
  sessions.rememberSessionPermissionMode(bubble.id, 'bubble', { bubble: 'plan', bubblePlanExit: 'default' });
  sessions.rememberBubbleModeSwitch(bubble.id, 'bypassPermissions', true);
  assert.deepEqual(state(), ['default', 'default']);
  // A composer saying again what the turn runs with is no new choice.
  assert.equal(sessions.namesAnotherBubbleMode({ permissionMode: 'plan', planExitMode: 'bypassPermissions' }, planning), false);
  assert.equal(sessions.namesAnotherBubbleMode({ permissionMode: 'plan' }, planning), false);
  assert.equal(sessions.namesAnotherBubbleMode({}, planning), false, 'a message that names no mode chooses none');
  assert.equal(sessions.namesAnotherBubbleMode({ permissionMode: 'plan', planExitMode: 'default' }, planning), true, 'another mode to follow the plan is a choice');
  assert.equal(sessions.namesAnotherBubbleMode({ permissionMode: 'bypassPermissions' }, planning), true);
  assert.equal(sessions.namesAnotherBubbleMode({ permissionMode: 'default', planExitMode: 'bypassPermissions' }, sessions.getSession(bubble.id)), false);
}

// ── A new task still starts on the agent's default unless told otherwise. ──
assert.deepEqual(
  [remoteTaskPayload('bubble', {}).bubblePermissionMode, remoteTaskPayload('bubble', {}).bubblePlanExitMode],
  ['default', 'default'],
);
assert.equal(remoteTaskPayload('bubble', { settings: { permissionMode: 'bypassPermissions' } }).bubblePermissionMode, 'bypassPermissions');
assert.equal(remoteTaskPayload('bubble', { settings: { permissionMode: 'bypassPermissions' } }).bubblePlanExitMode, 'bypassPermissions');
assert.deepEqual(
  [remoteTaskPayload('bubble', { settings: { permissionMode: 'bypassPermissions', plan: true } }).bubblePermissionMode,
    remoteTaskPayload('bubble', { settings: { permissionMode: 'bypassPermissions', plan: true } }).bubblePlanExitMode],
  ['plan', 'bypassPermissions'],
);
assert.equal(remoteTaskPayload('claude', {}).claudeAccessMode, 'default');
assert.equal(remoteTaskPayload('codex', {}).codexPermissionMode, 'defaultPermissions');
assert.equal(remoteTaskPayload('devin', {}).devinPermissionMode, 'accept-edits');
assert.equal(remoteTaskPayload('mimo', {}).mimoPermissionMode, 'ask');
assert.equal(remoteTaskPayload('minimax', {}).minimaxPermissionMode, 'default');

// ── The other agents on the same path. ──
// Claude and Codex keep their mode in columns of their own: reported as before,
// and a message that names none leaves it to the session.
const claude = sessions.createSession({ title: 'Claude', cwd: tmp, provider: 'claude', claudeAccessMode: 'bypassPermissions', claudeExecutionMode: 'plan' });
assert.deepEqual(settingsOf(claude.id), { model: undefined, effort: 'high', permissionMode: 'bypassPermissions', plan: true });
assert.equal(followUp(claude.id, {}).claudeAccessMode, undefined);
// Plan or not is the session's too when the message leaves it out (REMOTE-MODE-03: a sender says only what it changes).
assert.equal(followUp(claude.id, {}).claudeExecutionMode, undefined);
assert.equal(followUp(claude.id, { plan: false }).claudeExecutionMode, 'execute');
assert.equal(followUp(claude.id, { plan: true }).claudeExecutionMode, 'plan');
assert.equal(remoteTaskPayload('claude', {}).claudeExecutionMode, 'execute', 'a new task executes');
assert.equal(followUp(claude.id, { permissionMode: 'acceptEdits' }).claudeAccessMode, 'acceptEdits');
const codex = sessions.createSession({ title: 'Codex', cwd: tmp, provider: 'codex', codexPermissionMode: 'fullAccess', codexFastMode: true });
assert.deepEqual(settingsOf(codex.id), { model: undefined, effort: undefined, fast: true, permissionMode: 'fullAccess', plan: undefined });
assert.equal(followUp(codex.id, {}).codexPermissionMode, undefined);
assert.equal(followUp(codex.id, {}).codexExecutionMode, undefined);
assert.equal(remoteTaskPayload('codex', {}).codexExecutionMode, 'execute');
sessions.rememberSessionPermissionMode(claude.id, 'claude', { bubble: 'bypassPermissions' });
assert.equal(sessions.getSession(claude.id).bubble_permission_mode, null, 'only the session\'s own agent is written');

// Devin, MiMo and MiniMax Code: the mode last said, each in its own column.
for (const [provider, mode, column, field] of [
  ['devin', 'bypass', 'devin_permission_mode', 'devinPermissionMode'],
  ['mimo', 'build', 'mimo_permission_mode', 'mimoPermissionMode'],
  ['minimax', 'bypassPermissions', 'minimax_permission_mode', 'minimaxPermissionMode'],
]) {
  const row = sessions.createSession({ title: provider, cwd: tmp, provider });
  assert.equal(settingsOf(row.id).permissionMode, undefined, `${provider}: no mode before one is said`);
  sessions.rememberSessionPermissionMode(row.id, provider, { [provider]: mode });
  assert.equal(sessions.getSession(row.id)[column], mode);
  assert.equal(settingsOf(row.id).permissionMode, mode, `${provider}: reported`);
  // Named by nobody: left to the agent, which may have changed mode itself since.
  assert.equal(followUp(row.id, {})[field], undefined, `${provider}: a message without a mode sets none`);
  assert.equal(followUp(row.id, { permissionMode: mode })[field], mode);
  // A stored value that is no mode of this agent is not reported.
  sessions.updateSessionAgentPermissionMode(row.id, provider, 'not-a-mode');
  assert.equal(settingsOf(row.id).permissionMode, undefined);
}
sessions.close();

// ── What this device chose for a session on another Mac. ──
{
  // An older Mac: it says what it has, with no numbered reports and nothing it promises to keep.
  const old = (settings) => ({ settings });
  // A newer one: numbered reports, and the fields it keeps and answers for.
  const KEEPS = ['model', 'permissionMode', 'plan'];
  const newer = (version, settings) => ({ settings, version, keeps: KEEPS });
  /** A message as it leaves: what it says, what that Mac had said by then, and the choices it carries. */
  const message = (chosen, reported, settings = effectiveSettings(reported, chosen)) => ({ settings, reported, picked: { ...chosen?.picked } });
  /** A message leaves with everything this device would say, and is answered at once. */
  const send = (chosen, reported) => markSent(chosen, message(chosen, reported));

  // ── An older Mac that reports no mode (Bubble): the choice stands, sent or not, and is said every time. ──
  let chosen = chooseSettings(undefined, old({ model: 'm' }), { permissionMode: 'bypassPermissions', plan: false });
  assert.deepEqual(effectiveSettings(old({ model: 'm' }), chosen), { model: 'm', permissionMode: 'bypassPermissions', plan: false });
  assert.deepEqual(waitingSettings(chosen), { permissionMode: 'bypassPermissions', plan: false }, 'not sent yet');
  assert.equal(pruneChosen(chosen, old({ model: 'm' })), chosen, 'nothing changed over there: the same choice');
  chosen = send(chosen, old({ model: 'm' }));
  assert.deepEqual(waitingSettings(chosen), {}, 'sent');
  assert.equal(pruneChosen(chosen, old({ model: 'm' })), chosen);
  assert.deepEqual(settingsToSend(old({ model: 'm' }), chosen), { model: 'm', permissionMode: 'bypassPermissions', plan: false }, 'said in full to a Mac that keeps nothing');
  // It reports the field after all, with another value: its word from then on.
  assert.deepEqual(pruneChosen(chosen, old({ model: 'm', permissionMode: 'bypassPermissions' })).settings, { plan: false });
  const moved = pruneChosen(send(chooseSettings(undefined, old({ permissionMode: 'default' }), { permissionMode: 'bypassPermissions' }), old({ permissionMode: 'default' })), old({ permissionMode: 'plan-first' }));
  assert.equal(moved, undefined);
  assert.equal(effectiveSettings(old({ permissionMode: 'default' }), moved).permissionMode, 'default', 'a choice that ended does not come back');

  // ── A newer Mac. ──
  // Nothing chosen here: a message says nothing of the fields that Mac keeps (REMOTE-MODE-03), and the rest in full.
  assert.deepEqual(settingsToSend(newer(1, { model: 'm', permissionMode: 'bypassPermissions', effort: 'high' }), undefined), { effort: 'high' });
  assert.deepEqual(settingsToSend({ settings: { permissionMode: 'build' }, version: 1, keeps: ['model', 'permissionMode'] }, undefined), {});
  // A choice goes out once, alone; the first report after the message left is that Mac's answer.
  chosen = chooseSettings(undefined, newer(1, { permissionMode: 'default' }), { permissionMode: 'bypassPermissions' });
  assert.deepEqual(settingsToSend(newer(1, { permissionMode: 'default' }), chosen), { permissionMode: 'bypassPermissions' });
  chosen = send(chosen, newer(1, { permissionMode: 'default' }));
  assert.deepEqual(settingsToSend(newer(1, { permissionMode: 'default' }), chosen), {}, 'said once');
  assert.equal(effectiveSettings(newer(1, { permissionMode: 'default' }), chosen).permissionMode, 'bypassPermissions', 'shown until that Mac answers');
  assert.equal(pruneChosen(chosen, newer(2, { permissionMode: 'bypassPermissions' })), undefined);
  // A field that Mac does not keep (effort, for Bubble) is said every time, as to an older Mac.
  chosen = send(chooseSettings(undefined, newer(1, { model: 'm' }), { effort: 'high' }), newer(1, { model: 'm' }));
  assert.equal(pruneChosen(chosen, newer(5, { model: 'm' })), chosen, 'that Mac never answers for it');
  assert.deepEqual(settingsToSend(newer(5, { model: 'm' }), chosen), { effort: 'high' });

  // REMOTE-MODE-01. Full Access goes out with a message; Default is chosen before that message's
  // report is back. The report is of the earlier message: it must not undo the later choice.
  for (const report of [old, (settings) => newer(1, settings)]) {
    const before = report({ permissionMode: 'default' });
    chosen = chooseSettings(undefined, before, { permissionMode: 'bypassPermissions' });
    const first = message(chosen, before);
    chosen = chooseSettings(chosen, before, { permissionMode: 'default' });
    chosen = markSent(chosen, first);
    assert.deepEqual(waitingSettings(chosen), { permissionMode: 'default' }, 'the first message did not carry the later choice');
    const after = report === old ? old({ permissionMode: 'bypassPermissions' }) : newer(2, { permissionMode: 'bypassPermissions' });
    chosen = pruneChosen(chosen, after);
    assert.equal(effectiveSettings(after, chosen).permissionMode, 'default', 'the later choice outlives the earlier message\'s report');
    assert.deepEqual(settingsToSend(after, chosen).permissionMode, 'default');
    // The same in the other order: the report arrives before the first message is known to have landed.
    chosen = chooseSettings(undefined, before, { permissionMode: 'bypassPermissions' });
    chosen = chooseSettings(chosen, before, { permissionMode: 'default' });
    chosen = markSent(pruneChosen(chosen, after), first);
    assert.deepEqual(waitingSettings(chosen), { permissionMode: 'default' });
  }
  // A choice not sent yet waits whatever that Mac reports meanwhile.
  chosen = chooseSettings(undefined, newer(1, { permissionMode: 'default' }), { permissionMode: 'bypassPermissions' });
  assert.equal(pruneChosen(chosen, newer(9, { permissionMode: 'plan-first' })), chosen);
  // A message that failed carried nothing: nothing is marked without a delivery.
  assert.deepEqual(waitingSettings(markSent(chosen, message(chosen, newer(1, { permissionMode: 'default' }), {}))), { permissionMode: 'bypassPermissions' });

  // REMOTE-MODE-ACK-SAME-VALUE-REPICK. Default goes out, and its answer is late. Full Access is
  // chosen and goes out, and that Mac says it has it. Default is chosen again, and has not gone
  // out when the first answer arrives. That answer is to the first Default: the one chosen since
  // is another choice, though the value is the same, and still waits. That Mac is on Full Access.
  for (const report of [old, (settings) => newer(1, settings)]) {
    const atFirst = report({ permissionMode: 'bypassPermissions' });
    chosen = chooseSettings(undefined, atFirst, { permissionMode: 'default' });
    const firstDefault = message(chosen, atFirst);
    chosen = chooseSettings(chosen, atFirst, { permissionMode: 'bypassPermissions' });
    chosen = markSent(chosen, message(chosen, atFirst));
    const hasFullAccess = report === old ? old({ permissionMode: 'bypassPermissions' }) : newer(3, { permissionMode: 'bypassPermissions' });
    chosen = pruneChosen(chosen, hasFullAccess);
    chosen = chooseSettings(chosen, hasFullAccess, { permissionMode: 'default' });
    assert.deepEqual(waitingSettings(chosen), { permissionMode: 'default' });
    chosen = pruneChosen(markSent(chosen, firstDefault), hasFullAccess);
    assert.deepEqual(waitingSettings(chosen), { permissionMode: 'default' }, 'the late answer to the first Default does not settle the one chosen since');
    assert.equal(effectiveSettings(hasFullAccess, chosen).permissionMode, 'default');
    assert.equal(settingsToSend(hasFullAccess, chosen).permissionMode, 'default', 'the next message still says Default');
    // The message that does carry it settles it.
    chosen = markSent(chosen, message(chosen, hasFullAccess));
    assert.deepEqual(waitingSettings(chosen), {});
  }
  // Every choice is one of its own, of any field and after any that ended.
  {
    const first = chooseSettings(undefined, undefined, { permissionMode: 'default', plan: false });
    const again = chooseSettings(undefined, undefined, { permissionMode: 'default' });
    assert.notEqual(first.picked.permissionMode, first.picked.plan);
    assert.notEqual(first.picked.permissionMode, again.picked.permissionMode, 'a choice made after another ended is not mistaken for it');
    // A field left alone keeps its choice when another is chosen.
    assert.equal(chooseSettings(first, undefined, { plan: true }).picked.permissionMode, first.picked.permissionMode);
  }

  // REMOTE-MODE-01-ACK-ORDER. Default goes out; the answer is late. Meanwhile that Mac took it and
  // was put back on Full Access, and that report is here first. The answer is measured from what
  // was known when the message left: the newer report is that Mac's word, though its value is the
  // one from before the message.
  {
    const atSend = newer(4, { permissionMode: 'bypassPermissions' });
    chosen = chooseSettings(undefined, atSend, { permissionMode: 'default' });
    const late = message(chosen, atSend, settingsToSend(atSend, chosen));
    assert.deepEqual(late.settings, { permissionMode: 'default' });
    const newerReport = newer(6, { permissionMode: 'bypassPermissions' });
    assert.equal(effectiveSettings(newerReport, pruneChosen(chosen, newerReport)).permissionMode, 'default', 'still waiting to hear of the message');
    chosen = pruneChosen(markSent(pruneChosen(chosen, newerReport), late), newerReport);
    assert.equal(chosen, undefined, 'the late answer does not keep an older choice over a newer report');
    assert.equal(effectiveSettings(newerReport, chosen).permissionMode, 'bypassPermissions');
    assert.deepEqual(settingsToSend(newerReport, chosen), {});
    // The usual order: the answer first, then the report.
    chosen = chooseSettings(undefined, atSend, { permissionMode: 'default' });
    chosen = markSent(chosen, message(chosen, atSend, settingsToSend(atSend, chosen)));
    assert.equal(effectiveSettings(atSend, chosen).permissionMode, 'default');
    assert.equal(pruneChosen(chosen, newer(5, { permissionMode: 'default' })), undefined);
  }

  // Plan chosen here and sent, then approved there: the toggle follows that Mac.
  chosen = send(chooseSettings(undefined, newer(1, { permissionMode: 'bypassPermissions' }), { plan: true }), newer(1, { permissionMode: 'bypassPermissions' }));
  assert.equal(effectiveSettings(newer(1, { permissionMode: 'bypassPermissions' }), chosen).plan, true);
  chosen = pruneChosen(chosen, newer(2, { permissionMode: 'bypassPermissions', plan: true }));
  assert.equal(chosen, undefined);
  assert.equal(effectiveSettings(newer(3, { permissionMode: 'bypassPermissions' }), chosen).plan, undefined);
  // A later choice replaces an earlier one; a field cleared on purpose hides what that Mac has, and counts as sent with the message.
  chosen = chooseSettings(undefined, old({ model: 'a', effort: 'high' }), { permissionMode: 'bypassPermissions' });
  chosen = chooseSettings(chosen, old({ model: 'a', effort: 'high' }), { model: 'b', effort: undefined, fast: undefined });
  assert.deepEqual(effectiveSettings(old({ model: 'a', effort: 'high' }), chosen), { model: 'b', effort: undefined, fast: undefined, permissionMode: 'bypassPermissions' });
  chosen = chooseSettings(chosen, old({ model: 'a', effort: 'high' }), { permissionMode: 'default' });
  assert.equal(effectiveSettings(old({ model: 'a', effort: 'high' }), chosen).permissionMode, 'default');
  assert.deepEqual(waitingSettings(markSent(chosen, message(chosen, old({ model: 'a', effort: 'high' }), { model: 'b', permissionMode: 'default' }))), {});
  // REMOTE-MODES-UNDEFINED-CLEAR. Another model is picked, which clears the effort in the composer.
  // No message can say "no effort": it leaves the field out and that Mac keeps the one it had.
  // Once a message has gone, the clear is forgotten and what that Mac reports is shown again,
  // on an older Mac (which would otherwise never end it) as on a newer one.
  for (const report of [old, (settings) => newer(1, settings)]) {
    const before = report({ model: 'a', effort: 'high', permissionMode: 'default' });
    let picked = chooseSettings(undefined, before, { model: 'b', effort: undefined, fast: undefined });
    assert.equal(effectiveSettings(before, picked).effort, undefined, 'cleared in the composer until a message goes');
    picked = forgetCleared(markSent(picked, message(picked, before, { model: 'b' })));
    assert.deepEqual(Object.keys(picked.settings), ['model'], 'the clear went unsaid and is forgotten');
    assert.equal(effectiveSettings(before, picked).effort, 'high', 'what that Mac still runs with is shown');
    assert.equal(effectiveSettings(before, picked).model, 'b');
  }
  // A clear not sent yet, and a value that was said, are kept.
  assert.equal(forgetCleared(chosen), chosen);
  assert.equal(forgetCleared(undefined), undefined);
  // Choosing nothing changes nothing.
  assert.equal(chooseSettings(chosen, old({ model: 'a', effort: 'high' }), {}), chosen);
  assert.deepEqual(effectiveSettings(old({ model: 'a' }), undefined), { model: 'a' });
  assert.deepEqual(effectiveSettings(undefined, undefined), {});
  assert.deepEqual(waitingSettings(undefined), {});
  assert.deepEqual(settingsToSend(undefined, undefined), {});
}

// ── What each agent's session keeps when a message leaves it out (REMOTE-MODE-03-COLD-SETTINGS). ──
{
  // Only what is stored on the session, so it holds for a fresh runner too, and is said in every report.
  assert.deepEqual(keptSettings('claude'), ['model', 'effort', 'permissionMode', 'plan']);
  assert.deepEqual(keptSettings('codex'), ['model', 'effort', 'fast', 'permissionMode', 'plan']);
  // Their effort lives with the runner: not promised, so a sender keeps saying it.
  assert.deepEqual(keptSettings('bubble'), ['model', 'permissionMode', 'plan']);
  for (const provider of ['devin', 'mimo', 'minimax']) assert.deepEqual(keptSettings(provider), ['model', 'permissionMode']);
  assert.deepEqual(keptSettings('kimi'), []);
  assert.deepEqual(keptSettings(null), keptSettings('claude'));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('remote-permission-modes: ok');
