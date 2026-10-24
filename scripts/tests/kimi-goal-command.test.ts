import assert from 'node:assert/strict';
import { kimiGoalControlWord, kimiGoalStartPrompt, parseGoalInput, supportsGoalUI, type SessionGoalSnapshot, type ThreadGoal } from '../../src/shared/session-goal';
import { changeKimiGoal, type KimiGoalDeps } from '../../src/electron/libs/kimi-goal';
import { KimiServerApiError } from '../../src/electron/libs/provider/kimi-server-manager';
import { buildProviderSlashCommands } from '../../src/ui/utils/claude-slash';

assert.equal(supportsGoalUI('kimi'), true);
// The slash menu offers /goal for Kimi: before a session, and merged into the session's commands.
assert.ok(buildProviderSlashCommands('kimi').some((c) => c.name === 'goal'));
assert.deepEqual(
  buildProviderSlashCommands('kimi', [{ name: 'compact', title: '/compact', description: 'Compact', source: 'acp' }, { name: 'skill:review', title: '/skill:review', description: 'Review', source: 'acp' }])
    .map((c) => c.name),
  ['compact', 'goal', 'skill:review'],
);
assert.equal(kimiGoalStartPrompt(' pause the release '), '/goal -- pause the release', 'a subcommand word stays an objective');
assert.equal(kimiGoalStartPrompt('-- Ship it'), '/goal -- Ship it', 'an explicit -- is not doubled');
assert.equal(kimiGoalStartPrompt(parseGoalInput('/goal Ship the login page', false).objective), '/goal -- Ship the login page');
assert.equal(parseGoalInput(kimiGoalStartPrompt('x'), false).isGoal, true, 'the continue path keeps it verbatim');
assert.equal(kimiGoalControlWord(' Pause '), 'pause');
assert.equal(kimiGoalControlWord('pause the release'), null);

const goal = (status: ThreadGoal['status'], objective = 'Ship it'): ThreadGoal => ({
  threadId: 's1', objective, status, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
});

function harness(options: { loaded?: boolean; loadsOnSend?: boolean; remote?: ThreadGoal | null; fail?: Error; reboundId?: string } = {}) {
  const log: string[] = [];
  let loaded = options.loaded ?? false;
  const store = new Map<string, SessionGoalSnapshot>();
  let revision = 0;
  const deps: KimiGoalDeps = {
    adapter: {
      hasSession: () => loaded,
      changeGoal: async (id, change) => {
        log.push(('control' in change ? `control:${change.control}` : `objective:${change.objective}`) + (id === 'server:session_1' ? '' : `@${id}`));
        if (options.fail) throw options.fail;
      },
      readGoal: async () => {
        log.push('read');
        return options.remote;
      },
    },
    cached: (id) => store.get(id),
    publish: (id, value) => {
      const snapshot = { sessionId: id, supported: true, goal: value, revision: ++revision };
      store.set(id, snapshot);
      log.push(`publish:${value ? value.status : 'null'}`);
      return snapshot;
    },
    forget: (id) => void store.delete(id),
    sendPrompt: async (prompt) => {
      log.push(`send:${prompt}`);
      if (options.loadsOnSend) setTimeout(() => (loaded = true), 20);
      return true;
    },
    describeFailure: (error) => (error instanceof Error ? error.message : String(error)),
    isNoCurrentGoal: (error) => error instanceof KimiServerApiError && error.code === 40914,
    kimiSessionId: () => (loaded && options.reboundId) || 'server:session_1',
    reconnectTimeoutMs: 500,
  };
  return { log, deps, store };
}
async function main() {
  const kimi = { id: 's1', kimi_session_id: 'server:session_1' };

  // Unloaded resume (after Stop / restart): the runner comes up first, then Kimi resumes.
  {
    const h = harness({ loadsOnSend: true });
    await changeKimiGoal(kimi, { type: 'set', status: 'active' }, h.deps);
    assert.deepEqual(h.log.filter((l) => !l.startsWith('publish')), ['send:Continue working on the goal.', 'control:resume']);
  }
  // A resume that rebinds the task to a new Kimi session controls the new one.
  {
    const h = harness({ loadsOnSend: true, reboundId: 'server:session_2' });
    await changeKimiGoal(kimi, { type: 'set', status: 'active' }, h.deps);
    assert.ok(h.log.includes('control:resume@server:session_2'));
  }
  // Pausing a goal that already ended (40914): it reads as ended, no error.
  {
    const h = harness({ loaded: true, fail: new KimiServerApiError(40914, 'x', '/p') });
    const snapshot = await changeKimiGoal(kimi, { type: 'set', status: 'paused' }, h.deps);
    assert.equal(snapshot.goal, null);
  }
  // Unloaded resume whose runner never subscribes: refused, Kimi is not resumed unseen.
  {
    const h = harness();
    await assert.rejects(changeKimiGoal(kimi, { type: 'set', status: 'active' }, h.deps), /did not reconnect/);
    assert.ok(!h.log.includes('control:resume'));
  }
  // Unloaded pause: the goal is read back from Kimi (no goal.updated will come).
  {
    const h = harness({ remote: goal('paused') });
    const snapshot = await changeKimiGoal(kimi, { type: 'set', status: 'paused' }, h.deps);
    assert.deepEqual(h.log, ['control:pause', 'read', 'publish:paused']);
    assert.equal(snapshot.goal?.status, 'paused');
  }
  // Loaded pause and typed `/goal Pause`: a control, no read (goal.updated arrives).
  {
    const h = harness({ loaded: true });
    await changeKimiGoal(kimi, { type: 'set', status: 'active', objective: 'Pause' }, h.deps);
    assert.equal(h.log[0], 'control:pause');
    assert.ok(!h.log.includes('read'));
  }
  // Clear: cancel, then null; an already-ended goal (40914) counts as cleared.
  {
    // Matched by code: the server's wording does not matter.
    const h = harness({ loaded: true, fail: new KimiServerApiError(40914, 'goal.not_found', '/sessions/s/profile') });
    const snapshot = await changeKimiGoal(kimi, { type: 'clear' }, h.deps);
    assert.equal(snapshot.goal, null);
    assert.deepEqual(h.log, ['control:cancel', 'publish:null']);
  }
  // Other failures surface (described), and nothing is published.
  {
    const h = harness({ loaded: true, fail: new Error('open in another Kimi client') });
    await assert.rejects(changeKimiGoal(kimi, { type: 'set', status: 'paused' }, h.deps), /another Kimi client/);
    assert.ok(!h.log.some((l) => l.startsWith('publish')));
  }
  // New objective: replace via the API, then the objective starts the work.
  {
    const h = harness({ loaded: true });
    await changeKimiGoal(kimi, { type: 'set', status: 'active', objective: 'Ship it' }, h.deps);
    assert.deepEqual(h.log.filter((l) => !l.startsWith('publish')), ['objective:Ship it', 'send:Ship it']);
  }
  // A task Kimi has not started: the `/goal --` prompt; controls are refused.
  {
    const h = harness();
    await changeKimiGoal({ id: 's1', kimi_session_id: null }, { type: 'set', objective: 'pause the release' }, h.deps);
    assert.deepEqual(h.log.filter((l) => !l.startsWith('publish')), ['send:/goal -- pause the release']);
    await assert.rejects(changeKimiGoal({ id: 's1' }, { type: 'set', status: 'paused' }, h.deps), /no goal yet/);
  }
  // Budget-only changes are not something Kimi supports.
  await assert.rejects(changeKimiGoal(kimi, { type: 'set', tokenBudget: 5 }, harness({ loaded: true }).deps), /only the budget/);
}

main().then(
  () => console.log('kimi-goal-command: passed'),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
