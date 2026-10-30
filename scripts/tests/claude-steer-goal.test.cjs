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

  fs.rmSync(root, { recursive: true, force: true });
  console.log('claude-steer-goal.test.cjs passed');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
