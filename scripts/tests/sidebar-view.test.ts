import assert from 'node:assert/strict';
import {
  DEFAULT_SIDEBAR_VIEW,
  mostUrgentSidebarState,
  deriveSidebarSessionState,
  isDefaultSidebarView,
  isWithinActivityWindow,
  sessionSortTime,
} from '../../src/ui/utils/sidebar-view';
import type { GitPullRequestSummary } from '../../src/shared/types';

// Isolated persistence: exercise the real store without the renderer bridge.
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
  configurable: true,
});

type StateInput = Parameters<typeof deriveSidebarSessionState>[0];
const idle: StateInput = { status: 'completed', permissionRequests: [], runtimeNotice: undefined, envMode: 'local', worktreePath: null, isDraft: false };
const pr = (state: GitPullRequestSummary['state']): GitPullRequestSummary => ({
  number: 7,
  title: 'Sidebar view options',
  state,
  url: 'https://github.com/o/r/pull/7',
});
const permission = { toolUseId: 't', toolName: 'Bash', input: {} } as unknown as StateInput['permissionRequests'][number];

// --- state derivation -------------------------------------------------------

assert.equal(deriveSidebarSessionState({ ...idle, status: 'idle', isDraft: true }, {}), null,
  'a new task nothing was sent from has no state yet');
assert.equal(deriveSidebarSessionState({ ...idle, status: 'running', permissionRequests: [permission] }, {}), 'needs-input',
  'a pending approval outranks running');
assert.equal(deriveSidebarSessionState({ ...idle, status: 'running' }, {}), 'running');
assert.equal(deriveSidebarSessionState({ ...idle, status: 'stopping' }, {}), 'running');
assert.equal(deriveSidebarSessionState({ ...idle, status: 'error', runtimeNotice: 'error' }, {}), 'needs-input', 'an unseen failure needs you');
assert.equal(deriveSidebarSessionState({ ...idle, status: 'error' }, {}), 'completed', 'a failure already looked at does not linger');
assert.equal(deriveSidebarSessionState({ ...idle, runtimeNotice: 'completed' }, {}), 'review', 'an unseen result is ready for review');
assert.equal(deriveSidebarSessionState(idle, { unread: true }), 'review', 'marked unread stays in review');
assert.equal(deriveSidebarSessionState(idle, { pullRequest: pr('open') }), 'review', 'an open PR waits on review');
assert.equal(deriveSidebarSessionState(idle, {}), 'completed');
assert.equal(deriveSidebarSessionState(idle, { pullRequest: pr('merged') }), 'completed');

const worktree: StateInput = { ...idle, envMode: 'worktree', worktreePath: '/p/.worktrees/a' };
assert.equal(deriveSidebarSessionState(worktree, {}), 'review', 'a live worktree holds work not applied back yet');
assert.equal(deriveSidebarSessionState(worktree, { pullRequest: pr('merged') }), 'completed', 'a merged PR closes the loop');
assert.equal(deriveSidebarSessionState(worktree, { pullRequest: pr('closed') }), 'completed');
assert.equal(deriveSidebarSessionState({ ...worktree, worktreePath: null }, {}), 'completed',
  'applying or discarding the worktree clears it');

// --- the agent's own report of how its turn ended ---------------------------
const report = (outcome: NonNullable<StateInput['turnReport']>['outcome']): StateInput['turnReport'] =>
  ({ outcome, summary: 'x', reportedAt: 1 });
assert.equal(deriveSidebarSessionState({ ...idle, turnReport: report('question') }, {}), 'needs-input',
  'a question waits on you, seen or not');
assert.equal(deriveSidebarSessionState({ ...idle, runtimeNotice: 'completed', turnReport: report('blocked') }, {}), 'needs-input',
  'a blocker outranks an unseen result');
assert.equal(deriveSidebarSessionState({ ...idle, status: 'running', turnReport: report('question') }, {}), 'running',
  'a run in progress outranks the last report');
assert.equal(deriveSidebarSessionState({ ...idle, runtimeNotice: 'error', turnReport: report('nothing_to_do') }, {}), 'needs-input',
  'an unseen failure is a failure whatever was reported');
const task = { taskId: 't', description: 'tests', taskType: 'local_bash' };
assert.equal(deriveSidebarSessionState({ ...idle, turnReport: report('in_progress'), backgroundTasks: [task] }, {}), 'running',
  'work still going in the background needs nothing from you');
assert.equal(deriveSidebarSessionState({ ...idle, turnReport: report('in_progress'), backgroundTasks: [] }, {}), 'completed',
  'a stored report outlives its tasks (restart, runner gone): nothing is running any more');
assert.equal(deriveSidebarSessionState({ ...idle, runtimeNotice: 'completed', turnReport: report('in_progress') }, {}), 'review',
  'with no task left, the run status decides');
assert.equal(deriveSidebarSessionState({ ...idle, runtimeNotice: 'completed', turnReport: report('nothing_to_do') }, {}), 'completed',
  'a turn with nothing to change has no result to review');
assert.equal(deriveSidebarSessionState({ ...idle, turnReport: report('nothing_to_do') }, { unread: true }), 'review',
  'marked unread still means review');
assert.equal(deriveSidebarSessionState({ ...idle, turnReport: report('nothing_to_do') }, { pullRequest: pr('open') }), 'review',
  'an open PR from earlier work still waits on review');
assert.equal(deriveSidebarSessionState({ ...idle, runtimeNotice: 'completed', turnReport: null }, {}), 'review',
  'no report: the run status decides, as before');

// --- filters and sorting ----------------------------------------------------

const now = Date.UTC(2026, 8, 28, 12);
const day = 24 * 60 * 60 * 1000;
assert.equal(isWithinActivityWindow({ updatedAt: now - 3 * day }, 'all', now), true);
assert.equal(isWithinActivityWindow({ updatedAt: now - 3 * day }, '7d', now), true);
assert.equal(isWithinActivityWindow({ updatedAt: now - 3 * day }, '1d', now), false);
assert.equal(isWithinActivityWindow({ updatedAt: now - 31 * day }, '30d', now), false);

assert.equal(sessionSortTime({ updatedAt: 20, createdAt: 10 }, 'updated'), 20);
assert.equal(sessionSortTime({ updatedAt: 20, createdAt: 10 }, 'created'), 10);
assert.equal(sessionSortTime({ updatedAt: 20 }, 'created'), 20, 'sessions without a creation time fall back');

assert.equal(isDefaultSidebarView(DEFAULT_SIDEBAR_VIEW), true);
assert.equal(DEFAULT_SIDEBAR_VIEW.groupBy, 'state');
assert.equal(isDefaultSidebarView({ ...DEFAULT_SIDEBAR_VIEW, groupBy: 'project' }), false);
assert.equal(isDefaultSidebarView({ ...DEFAULT_SIDEBAR_VIEW, project: '/p' }), false);

// A conversation stands where the most urgent of its tasks does.
assert.equal(mostUrgentSidebarState('completed', ['review', 'running', 'completed']), 'running');
assert.equal(mostUrgentSidebarState('running', ['needs-input']), 'needs-input');
assert.equal(mostUrgentSidebarState('needs-input', ['completed']), 'needs-input', 'its own wait counts too');
assert.equal(mostUrgentSidebarState('review', [null, 'completed']), 'review', 'a task still a draft does not count');
assert.equal(mostUrgentSidebarState('completed', ['completed']), 'completed', 'done only when all of it is');

// --- store ------------------------------------------------------------------

async function main() {
  const { useSidebarViewStore } = await import('../../src/ui/store/useSidebarViewStore');
  const store = useSidebarViewStore;

  store.getState().setOption('groupBy', 'date');
  store.getState().toggleStateView();
  assert.equal(store.getState().groupBy, 'state', 'the shortcut switches to Group by State');
  store.getState().toggleStateView();
  assert.equal(store.getState().groupBy, 'date', 'pressing it again restores the previous grouping');
  store.getState().setOption('groupBy', 'state');
  useSidebarViewStore.setState({ previousGroupBy: 'state' });
  store.getState().toggleStateView();
  assert.equal(store.getState().groupBy, 'project', 'from a state view with nothing to return to, the shortcut still leaves it');

  store.getState().setOption('status', 'archived');
  store.getState().reset();
  assert.equal(store.getState().status, 'active');
  assert.equal(store.getState().groupBy, 'state');

  // Group by Project was the default before: move saved views off it once, then respect the choice.
  const migrate = store.persist.getOptions().migrate!;
  const moved = (await migrate({ groupBy: 'project', status: 'all' }, 1)) as Partial<ReturnType<typeof store.getState>>;
  assert.equal(moved.groupBy, 'state');
  assert.equal(moved.previousGroupBy, 'project', 'the shortcut still goes back to projects');
  assert.equal(moved.status, 'all', 'other choices stay');
  assert.equal(((await migrate({ groupBy: 'date' }, 1)) as { groupBy: string }).groupBy, 'date');
  assert.equal(store.persist.getOptions().version, 2);

  // A fold made over a wait holds until another wait.
  store.getState().foldSubSessions('sub-sessions:p', ['c1:10']);
  assert.equal(store.getState().collapsedGroups.has('sub-sessions:p'), true);
  assert.equal(store.getState().dismissedWaits.has('c1:10'), true);
  store.getState().foldSubSessions('sub-sessions:p', []);
  assert.equal(store.getState().collapsedGroups.has('sub-sessions:p'), true, 'folding again keeps it folded');

  // Unknown or stale persisted values fall back instead of breaking the list.
  const merge = store.persist.getOptions().merge!;
  const merged = merge(
    { status: 'bogus', groupBy: 'state', activity: '7d', showPullRequests: 'yes', project: '' },
    store.getState()
  ) as ReturnType<typeof store.getState>;
  assert.equal(merged.status, 'active');
  assert.equal(merged.groupBy, 'state');
  assert.equal(merged.activity, '7d');
  assert.equal(merged.showPullRequests, true);
  assert.equal(merged.project, null);

  console.log('sidebar-view tests passed');
}

void main();
