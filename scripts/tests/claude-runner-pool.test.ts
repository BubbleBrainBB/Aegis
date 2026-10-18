import assert from 'node:assert/strict';
import {
  CLAUDE_RUNNER_IDLE_TTL_MS,
  CLAUDE_RUNNER_MAX_IDLE,
  CLAUDE_RUNNER_MIN_IDLE_GRACE_MS,
  CLAUDE_RUNNER_PREWARM_IDLE_TTL_MS,
  noteClaudeBackgroundTasks,
  selectClaudeRunnersToReap,
  type ClaudeRunnerSnapshot,
} from '../../src/electron/libs/claude-runner-pool';

function snapshot(
  sessionId: string,
  overrides: Partial<ClaudeRunnerSnapshot> = {}
): ClaudeRunnerSnapshot {
  return {
    sessionId,
    inFlightTurns: 0,
    lastTurnEndedAt: 0,
    hasPendingPermissions: false,
    ...overrides,
  };
}

const NOW = 100 * 60 * 1000; // 100 minutes

// Busy runners are untouchable, no matter how old their last result is.
{
  const victims = selectClaudeRunnersToReap(
    [snapshot('busy', { inFlightTurns: 1, lastTurnEndedAt: 0 })],
    NOW
  );
  assert.deepEqual(victims, [], 'in-flight turns block reaping past any TTL');
}

// A session waiting on a permission dialog is never reaped.
{
  const victims = selectClaudeRunnersToReap(
    [snapshot('waiting', { hasPendingPermissions: true, lastTurnEndedAt: 0 })],
    NOW
  );
  assert.deepEqual(victims, [], 'pending permissions block reaping');
}

// Background work (a running background command, or a turn the CLI started
// when one finished) survives the TTL and the cap: retiring would kill it.
{
  const victims = selectClaudeRunnersToReap(
    [
      snapshot('watching-ci', { hasBackgroundWork: true, lastTurnEndedAt: 0 }),
      ...Array.from({ length: CLAUDE_RUNNER_MAX_IDLE }, (_, i) =>
        snapshot(`idle-${i}`, { lastTurnEndedAt: NOW - CLAUDE_RUNNER_MIN_IDLE_GRACE_MS - 1 - i })
      ),
    ],
    NOW
  );
  assert.deepEqual(victims, [], 'background work blocks reaping and does not count toward the cap');
}

// A background task finishing long after the last result: in the moment
// before the woken turn's first frame the runner has no tasks and no turn in
// flight, but the restarted idle clock keeps the reaper away.
{
  const watching = { inFlightTurns: 0, runningBackgroundTasks: 1, lastTurnEndedAt: 0 };
  const finished = noteClaudeBackgroundTasks(watching, 0, NOW);
  assert.equal(finished.lastTurnEndedAt, NOW, 'a finished task restarts the idle clock');
  assert.deepEqual(
    selectClaudeRunnersToReap(
      [snapshot('waking', { lastTurnEndedAt: finished.lastTurnEndedAt, hasBackgroundWork: false })],
      NOW + 60_000
    ),
    [],
    'the reaper spares the runner between the task finishing and the woken turn'
  );
  assert.equal(
    noteClaudeBackgroundTasks({ ...watching, inFlightTurns: 1 }, 0, NOW).lastTurnEndedAt,
    0,
    'during a turn the clock is the turn result\'s to restart'
  );
  assert.equal(
    noteClaudeBackgroundTasks({ ...watching, runningBackgroundTasks: 0 }, 1, NOW).lastTurnEndedAt,
    0,
    'a task starting does not restart it'
  );
}

// A first turn that has not produced a result yet has no idle anchor.
{
  const victims = selectClaudeRunnersToReap(
    [snapshot('first-turn', { lastTurnEndedAt: undefined })],
    NOW
  );
  assert.deepEqual(victims, [], 'no lastTurnEndedAt means never idle');
}

// TTL expiry reaps; fresher runners survive.
{
  const victims = selectClaudeRunnersToReap(
    [
      snapshot('old', { lastTurnEndedAt: NOW - CLAUDE_RUNNER_IDLE_TTL_MS - 1 }),
      snapshot('fresh', { lastTurnEndedAt: NOW - 1_000 }),
    ],
    NOW
  );
  assert.deepEqual(victims, ['old']);
}

// LRU cap: with more idle runners than maxIdle, the oldest beyond the grace
// window are evicted until the cap holds.
{
  const count = CLAUDE_RUNNER_MAX_IDLE + 2;
  const snapshots = Array.from({ length: count }, (_, index) =>
    snapshot(`s${index}`, {
      // s0 is oldest; all within TTL, all older than the grace window.
      lastTurnEndedAt: NOW - CLAUDE_RUNNER_MIN_IDLE_GRACE_MS - (count - index) * 1_000,
    })
  );
  const victims = selectClaudeRunnersToReap(snapshots, NOW).sort();
  assert.deepEqual(victims, ['s0', 's1'], 'the two oldest idle runners are cap-evicted');
}

// Grace window: runners idle for less than the grace period are not
// cap-evicted even when the pool is over the cap.
{
  const count = CLAUDE_RUNNER_MAX_IDLE + 2;
  const snapshots = Array.from({ length: count }, (_, index) =>
    snapshot(`s${index}`, { lastTurnEndedAt: NOW - 1_000 - index })
  );
  const victims = selectClaudeRunnersToReap(snapshots, NOW);
  assert.deepEqual(victims, [], 'freshly idle runners are protected by the grace window');
}

// Options are injectable for tuning without code changes elsewhere.
{
  const victims = selectClaudeRunnersToReap(
    [snapshot('a', { lastTurnEndedAt: NOW - 5_000 })],
    NOW,
    { idleTtlMs: 4_000 }
  );
  assert.deepEqual(victims, ['a']);
}

// TTL reaping and cap eviction combine without double-counting.
{
  const snapshots = [
    snapshot('expired', { lastTurnEndedAt: NOW - CLAUDE_RUNNER_IDLE_TTL_MS - 1 }),
    ...Array.from({ length: CLAUDE_RUNNER_MAX_IDLE + 1 }, (_, index) =>
      snapshot(`live${index}`, {
        lastTurnEndedAt: NOW - CLAUDE_RUNNER_MIN_IDLE_GRACE_MS - (index + 1) * 1_000,
      })
    ),
  ];
  const victims = selectClaudeRunnersToReap(snapshots, NOW).sort();
  // 'expired' goes by TTL; the surviving pool is maxIdle+1 so the oldest
  // survivor ('live5', furthest past grace) is cap-evicted too.
  assert.equal(victims.includes('expired'), true);
  assert.equal(victims.length, 2, 'one TTL reap + one cap eviction');
}

// ── Prewarm semantics (P3) ───────────────────────────────────────────────────

// Prewarmed entries expire on the shorter prewarm TTL; a real runner of the
// same age survives.
{
  const idleFor = CLAUDE_RUNNER_PREWARM_IDLE_TTL_MS + 1_000;
  const victims = selectClaudeRunnersToReap(
    [
      snapshot('prewarmed', { prewarmed: true, lastTurnEndedAt: NOW - idleFor }),
      snapshot('real', { lastTurnEndedAt: NOW - idleFor }),
    ],
    NOW
  );
  assert.deepEqual(victims, ['prewarmed'], 'prewarm TTL is shorter than the normal idle TTL');
}

// Cap pressure evicts the prewarmed entry FIRST — even when it is the newest
// thing in the pool — so speculation never displaces a real warm runner.
{
  const snapshots = [
    snapshot('prewarmed-new', { prewarmed: true, lastTurnEndedAt: NOW - 1_000 }),
    ...Array.from({ length: CLAUDE_RUNNER_MAX_IDLE }, (_, index) =>
      snapshot(`real${index}`, {
        lastTurnEndedAt: NOW - CLAUDE_RUNNER_MIN_IDLE_GRACE_MS - (index + 1) * 1_000,
      })
    ),
  ];
  const victims = selectClaudeRunnersToReap(snapshots, NOW);
  assert.deepEqual(
    victims,
    ['prewarmed-new'],
    'prewarmed entries are cap-evicted before any real warm runner'
  );
}

// Prewarmed entries get no grace protection, but real runners inside the
// grace window still cannot be cap-evicted.
{
  const snapshots = [
    snapshot('prewarmed', { prewarmed: true, lastTurnEndedAt: NOW - 500 }),
    ...Array.from({ length: CLAUDE_RUNNER_MAX_IDLE + 1 }, (_, index) =>
      snapshot(`fresh${index}`, { lastTurnEndedAt: NOW - (index + 1) * 1_000 })
    ),
  ];
  const victims = selectClaudeRunnersToReap(snapshots, NOW);
  assert.deepEqual(
    victims,
    ['prewarmed'],
    'only the prewarmed entry is evictable while real runners sit inside grace'
  );
}

// A prewarmed runner that just received its first turn is untouchable, flag
// or no flag (defense in depth — the dispatch path clears the flag anyway).
{
  const victims = selectClaudeRunnersToReap(
    [snapshot('busy-prewarm', { prewarmed: true, inFlightTurns: 1, lastTurnEndedAt: 0 })],
    NOW
  );
  assert.deepEqual(victims, [], 'in-flight prewarmed runners are never reaped');
}

console.log('claude-runner-pool.test.ts passed');
