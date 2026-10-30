// Goal mode under steer: folded steers and Stop's withdrawal must settle the
// /goal controller's work and goal-start wait. Requires transpile:electron.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-claude-steer-goal-'));
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { getPath: () => root } };
  return load.call(this, id, ...args);
};
const manager = require('../../dist-electron/electron/libs/claude-goal-manager.js');
Module._load = load;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function transport(ctrl) {
  const calls = [];
  let interrupts = 0;
  return {
    calls,
    get interrupts() { return interrupts; },
    commands: async () => [{ name: 'goal' }],
    interrupt: async () => { interrupts++; },
    abort: () => calls.push('abort'),
    send: (text) => {
      calls.push(text);
      void (async () => {
        await ctrl.receive({ type: 'assistant', local_command_source: '<local-command-stdout>Goal cleared: x</local-command-stdout>' });
        await ctrl.receive({ type: 'result', result: 'Goal cleared: x' });
      })();
    },
  };
}

async function within(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  // A turn that folded a steer answers both prompts with one result: the
  // pause after it must find the controller idle, not wait for a second result.
  {
    const ctrl = manager.createClaudeGoalController('folded', false);
    const wire = transport(ctrl);
    await ctrl.initialize(wire);
    const text = await ctrl.prepare('/goal Ship it');
    ctrl.submitted(text);
    await ctrl.receive({ type: 'assistant', local_command_source: '<local-command-stdout>Goal set: Ship it</local-command-stdout>' });
    ctrl.submitted('steered into the goal turn');
    const paused = ctrl.change({ type: 'set', status: 'paused' });
    await tick();
    await ctrl.receive({ type: 'result' }, 2);
    await within(paused, 2000, 'pause after a folded steer');
    assert.equal(ctrl.snapshot.goal.status, 'paused');
    assert.equal(wire.calls.includes('abort'), false, 'no runtime abort');
    manager.releaseClaudeGoalController('folded', ctrl);
  }

  // A withdrawn prompt never gets a result: it stops counting as work.
  {
    const ctrl = manager.createClaudeGoalController('withdrawn-work', false);
    const wire = transport(ctrl);
    await ctrl.initialize(wire);
    const text = await ctrl.prepare('/goal Keep going');
    ctrl.submitted(text);
    await ctrl.receive({ type: 'assistant', local_command_source: '<local-command-stdout>Goal set: Keep going</local-command-stdout>' });
    ctrl.submitted('queued steer');
    const paused = ctrl.change({ type: 'set', status: 'paused' });
    await tick();
    ctrl.withdrawn(1);
    await ctrl.receive({ type: 'result' }, 1);
    await within(paused, 2000, 'pause after a withdrawal');
    assert.equal(wire.calls.includes('abort'), false);
    manager.releaseClaudeGoalController('withdrawn-work', ctrl);
  }

  // Stop withdrew the /goal prompt itself: its start wait ends at once with
  // the withdrawal error, never at the 30s timeout that aborts the runtime.
  {
    const ctrl = manager.createClaudeGoalController('withdrawn-goal', false);
    const wire = transport(ctrl);
    await ctrl.initialize(wire);
    // Watch the goal-start timer itself: it must be cleared, never left to
    // fire its runtime abort 30s later.
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    const goalTimers = new Set();
    const cleared = new Set();
    global.setTimeout = (fn, ms, ...rest) => {
      const handle = realSetTimeout(fn, ms, ...rest);
      if (ms === 30_000) goalTimers.add(handle);
      return handle;
    };
    global.clearTimeout = (handle) => { cleared.add(handle); return realClearTimeout(handle); };
    let activation;
    try {
      activation = manager.awaitClaudeGoalSet('withdrawn-goal', 'Never read', async () => {
        ctrl.submitted(await ctrl.prepare('/goal Never read'));
      });
    } finally {
      global.setTimeout = realSetTimeout;
    }
    await tick();
    assert.equal(goalTimers.size, 1, 'the goal start armed its 30s timeout');
    ctrl.withdrawn(1, true);
    manager.rejectClaudeGoalSet('withdrawn-goal', new manager.ClaudeGoalWithdrawnError());
    await assert.rejects(within(activation, 2000, 'withdrawn goal start'), (error) => error instanceof manager.ClaudeGoalWithdrawnError);
    global.clearTimeout = realClearTimeout;
    for (const handle of goalTimers) assert(cleared.has(handle), 'the withdrawal cleared the 30s goal-start timer');
    assert.equal(wire.calls.includes('abort'), false, 'no runtime abort');
    manager.releaseClaudeGoalController('withdrawn-goal', ctrl);
  }

  // Every hand-back exit settles a goal start: a /goal prompt Stop caught
  // while it was still being prepared (never submitted), and one still
  // queued when the runner went away (submitted). Neither may leave the 30s
  // timer to abort whatever runtime is live by then.
  {
    const { createPromptHandBack } = require('../../dist-electron/electron/libs/claude-prompt-handback.js');
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    for (const exit of [
      { label: 'Stop during preparation', submitted: false, promptId: 'goal-prompt' },
      { label: 'runner ended', submitted: true, promptId: 'goal-prompt' },
      // A goal started on an idle or fresh runner: the host has no id for it.
      { label: 'Stop while preparing a goal started on an idle runner', submitted: false, promptId: undefined },
      { label: 'runner ended before taking a goal started on an idle runner', submitted: true, promptId: undefined },
    ]) {
      const id = `handback-${exit.submitted}-${exit.promptId ?? 'none'}`;
      const ctrl = manager.createClaudeGoalController(id, false);
      const wire = transport(ctrl);
      await ctrl.initialize(wire);
      ctrl.submitted('ordinary work already running');
      const goalTimers = new Set();
      const cleared = new Set();
      global.setTimeout = (fn, ms, ...rest) => {
        const handle = realSetTimeout(fn, ms, ...rest);
        if (ms === 30_000) goalTimers.add(handle);
        return handle;
      };
      global.clearTimeout = (handle) => { cleared.add(handle); return realClearTimeout(handle); };
      let activation;
      try {
        activation = manager.awaitClaudeGoalSet(id, 'Ship it', async () => {
          if (exit.submitted) ctrl.submitted(await ctrl.prepare('/goal Ship it'));
        });
      } finally {
        global.setTimeout = realSetTimeout;
      }
      await tick();
      const workBefore = ctrl.work;
      const reported = [];
      const handBack = createPromptHandBack({
        goal: ctrl,
        rejectGoalStart: (error, goalSend) => manager.rejectClaudeGoalSet(id, error, goalSend),
        report: (ids) => reported.push(...ids),
      });
      // The /goal prompt this start dispatched took its send number after
      // the start began waiting (as the runner numbers it on send).
      handBack(exit.promptId, { submitted: exit.submitted, goalSend: manager.nextClaudeGoalSend() });
      await assert.rejects(within(activation, 2000, exit.label), (error) => error instanceof manager.ClaudeGoalWithdrawnError,
        `${exit.label}: the goal start ends as withdrawn`);
      global.clearTimeout = realClearTimeout;
      assert.equal(goalTimers.size, 1);
      for (const handle of goalTimers) assert(cleared.has(handle), `${exit.label}: the 30s goal-start timer is cleared`);
      assert.equal(ctrl.work, exit.submitted ? workBefore - 1 : workBefore,
        `${exit.label}: only a submitted prompt stops counting as work`);
      assert.deepEqual(reported, exit.promptId ? ['goal-prompt'] : [],
        `${exit.label}: the host hears once, and only about a prompt it knows by id`);
      assert.equal(wire.calls.includes('abort'), false, `${exit.label}: no runtime abort`);
      manager.releaseClaudeGoalController(id, ctrl);
    }
  }

  // B1: an earlier runner's /goal prompt — taken and finished on a CLI
  // without lifecycle frames, or simply never taken — is swept when that
  // runner ends (here: aborted because the next goal changed the model). Its
  // withdrawal must not fail the new goal start, which began waiting after
  // that prompt was sent; the new goal's own withdrawal still does.
  {
    const id = 'replacement-goal';
    const ctrl = manager.createClaudeGoalController(id, false);
    await ctrl.initialize(transport(ctrl));
    const oldGoalSend = manager.nextClaudeGoalSend();           // G1, sent by the old runner
    let outcome = 'pending';
    const replacement = manager.awaitClaudeGoalSet(id, 'Second goal', async () => {}).then(
      () => { outcome = 'activated'; },
      (error) => { outcome = error; }
    );
    await tick();
    manager.rejectClaudeGoalSet(id, new manager.ClaudeGoalWithdrawnError(), oldGoalSend);  // old runner's end sweep
    await tick();
    assert.equal(outcome, 'pending', "an earlier runner's goal prompt never fails a later goal start");
    manager.rejectClaudeGoalSet(id, new manager.ClaudeGoalWithdrawnError(), manager.nextClaudeGoalSend());
    await within(replacement, 2000, 'replacement goal');
    assert(outcome instanceof manager.ClaudeGoalWithdrawnError, "the new goal's own withdrawal still ends it");
    manager.releaseClaudeGoalController(id, ctrl);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('claude-steer-goal.test.cjs passed');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
