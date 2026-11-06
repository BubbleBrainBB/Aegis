import assert from 'node:assert/strict';
import {
  DEFAULT_SIDEBAR_VIEW,
  mostUrgentSidebarState,
  deriveSidebarSessionState,
  boardGroupBy,
  formatTaskDate,
  getProjectLabel,
  isDefaultSidebarView,
  listWorkspaceProjects,
  taskAttention,
  TASK_FILTERS,
  isWithinActivityWindow,
  sessionSortTime,
} from '../../src/ui/utils/sidebar-view';
import { groupTasks } from '../../src/ui/utils/task-groups';
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
assert.equal(deriveSidebarSessionState(worktree, { worktreeSettled: true }), 'completed', 'a worktree with nothing left to apply is done');
assert.equal(deriveSidebarSessionState({ ...worktree, runtimeNotice: 'completed' }, { worktreeSettled: true }), 'review', 'a result you have not seen still waits on you');
assert.equal(deriveSidebarSessionState(worktree, { worktreeSettled: true, pullRequest: pr('open') }), 'review', 'an open PR still waits on you');
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
assert.equal(DEFAULT_SIDEBAR_VIEW.groupBy, 'none');
assert.equal(DEFAULT_SIDEBAR_VIEW.sortBy, 'state');
assert.equal(isDefaultSidebarView({ ...DEFAULT_SIDEBAR_VIEW, groupBy: 'project' }), false);
assert.equal(isDefaultSidebarView({ ...DEFAULT_SIDEBAR_VIEW, layout: 'board' }), false);
assert.equal(isDefaultSidebarView({ ...DEFAULT_SIDEBAR_VIEW, properties: ['date'] }), false);
assert.equal(isDefaultSidebarView({ ...DEFAULT_SIDEBAR_VIEW, properties: [...DEFAULT_SIDEBAR_VIEW.properties] }), true);
assert.equal(isDefaultSidebarView({ ...DEFAULT_SIDEBAR_VIEW, project: '/p' }), true, 'the project is where the page is, not how it is drawn');

// A conversation stands where the most urgent of its tasks does.
assert.equal(mostUrgentSidebarState('completed', ['review', 'running', 'completed']), 'running');
assert.equal(mostUrgentSidebarState('running', ['needs-input']), 'needs-input');
assert.equal(mostUrgentSidebarState('needs-input', ['completed']), 'needs-input', 'its own wait counts too');
assert.equal(mostUrgentSidebarState('review', [null, 'completed']), 'review', 'a task still a draft does not count');
assert.equal(mostUrgentSidebarState('completed', ['completed']), 'completed', 'done only when all of it is');

// What a waiting task wants, in one line.
const attentionOf = (session: Partial<Parameters<typeof taskAttention>[0]>) =>
  taskAttention({ permissionRequests: [], ...session } as Parameters<typeof taskAttention>[0]);
const ask = (input: unknown) => [{ sessionId: 's', toolUseId: 't', toolName: 'Bash', input }] as never;
assert.deepEqual(attentionOf({ permissionRequests: ask({ command: 'ls\nrm' }) }), { text: 'Run ls', tone: 'warning' });
assert.deepEqual(attentionOf({ permissionRequests: ask({ questions: [{ question: 'Which one?' }] }) }), { text: 'Which one?', tone: 'warning' });
assert.deepEqual(attentionOf({ permissionRequests: ask({}) }), { text: 'Allow Bash', tone: 'warning' });
assert.deepEqual(attentionOf({ runtimeNotice: 'error' }), { text: 'Stopped with an error', tone: 'error' });
assert.deepEqual(attentionOf({ runtimeNotice: 'error', lastTurnError: '\nOut of credits\nmore' }), { text: 'Out of credits', tone: 'error' });
assert.equal(attentionOf({ runtimeNotice: 'completed' }), null);

// List dates: an age within a day, then a calendar date.
const dateNow = new Date(2026, 10, 4, 12).getTime();
assert.equal(formatTaskDate(dateNow - 10_000, dateNow), 'now');
assert.equal(formatTaskDate(dateNow - 5 * 60_000, dateNow), '5m');
assert.equal(formatTaskDate(dateNow - 3 * 3_600_000, dateNow), '3h');
assert.equal(formatTaskDate(new Date(2026, 9, 31, 12).getTime(), dateNow), 'Oct 31');
assert.equal(formatTaskDate(new Date(2025, 9, 31, 12).getTime(), dateNow), 'Oct 2025');

// The Workspace list: projects with tasks, newest first, plus the one just picked.
const workspaceTask = (extra: Record<string, unknown>) => ({ updatedAt: 1, ...extra }) as never;
assert.deepEqual(
  listWorkspaceProjects(
    [
      workspaceTask({ cwd: '/old', updatedAt: 1 }),
      workspaceTask({ cwd: '/new', updatedAt: 3 }),
      workspaceTask({ cwd: '/new/.worktrees/x', projectCwd: '/old', updatedAt: 2 }),
      workspaceTask({ cwd: '/hidden', hiddenFromThreads: true }),
      workspaceTask({ cwd: '/dm', scope: 'dm' }),
      workspaceTask({ cwd: '/chat', isChat: true }),
      workspaceTask({ cwd: '/draft', isDraft: true }),
    ],
    '/picked'
  ),
  ['/new', '/old', '/picked'],
);
assert.equal(getProjectLabel('/projects/coworker/'), 'coworker');
assert.deepEqual(TASK_FILTERS.map((filter) => filter.id), ['all', 'needs-input', 'running', 'review', 'completed']);

// Grouping: every way keeps the order it was given inside each group.
const groupingTask = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, provider: 'claude', projectCwd: '/p/a', cwd: '/p/a', updatedAt: 100, ...extra }) as never;
const groupingContext = {
  sortBy: 'updated' as const,
  now: new Date(2026, 10, 4, 12).getTime(),
  stateOf: (task: { id: string }) => (task.id === 'b' ? 'running' as const : 'completed' as const),
  pullRequestOf: (task: { id: string }) => (task.id === 'a' ? 'merged' as const : task.id === 'b' ? 'open' as const : null),
  providerLabel: (provider: string) => provider.toUpperCase(),
};
const taskA = groupingTask('a', { updatedAt: groupingContext.now - 1000 });
const taskB = groupingTask('b', { provider: 'codex', projectCwd: '/p/b', updatedAt: groupingContext.now });
const taskC = groupingTask('c', { isChat: true, cwd: '/chats/1', updatedAt: new Date(2026, 8, 1).getTime() });
const groupKeys = (by: Parameters<typeof groupTasks>[1], sub: Parameters<typeof groupTasks>[2] = 'none', extra = {}) =>
  groupTasks([taskA, taskB, taskC], by, sub, { ...groupingContext, ...extra } as never);
assert.deepEqual(groupKeys('none').map((group) => group.key), ['all']);
assert.deepEqual(groupKeys('state').map((group) => group.key), ['state:running', 'state:completed']);
assert.deepEqual(
  groupKeys('state', 'none', { showEmptyGroups: true }).map((group) => group.key),
  ['state:needs-input', 'state:running', 'state:review', 'state:completed']
);
assert.deepEqual(groupKeys('project').map((group) => group.key), ['/p/b', '/p/a', 'no-project'], 'newest project first, no project last');
assert.deepEqual(groupKeys('agent').map((group) => group.label), ['CLAUDE', 'CODEX']);
assert.deepEqual(groupKeys('pull-request').map((group) => group.key), ['pull-request:open', 'pull-request:merged', 'pull-request:none']);
assert.deepEqual(groupKeys('date').map((group) => group.label), ['Today', 'September'], 'newest first');
assert.deepEqual(groupKeys('state', 'state')[0].subgroups, undefined, 'a subgroup the same as its group is none');
assert.deepEqual(groupKeys('none', 'state')[0].subgroups, undefined);
assert.deepEqual(
  groupKeys('state', 'agent', { showEmptyGroups: true })[3].subgroups?.map((group) => [group.key, group.tasks.map((task) => task.id)]),
  [['agent:claude', ['a', 'c']]]
);
assert.equal(boardGroupBy('none'), 'state', 'a board always has columns');
assert.equal(boardGroupBy('agent'), 'agent');

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
  assert.equal(store.getState().groupBy, 'none', 'from a state view with nothing to return to, the shortcut still leaves it');

  store.getState().setOption('status', 'archived');
  store.getState().setOption('project', '/p');
  store.getState().reset();
  assert.equal(store.getState().status, 'active');
  assert.equal(store.getState().groupBy, 'none');
  assert.equal(store.getState().project, '/p', 'resetting how the page is drawn keeps the project it shows');
  store.getState().setOption('project', null);

  // The old defaults make way for the flat list once; other choices stay.
  const migrate = store.persist.getOptions().migrate!;
  const migrated = async (saved: unknown, version: number) => (await migrate(saved, version)) as Partial<ReturnType<typeof store.getState>>;
  const moved = await migrated({ groupBy: 'state', sortBy: 'updated', status: 'all' }, 2);
  assert.equal(moved.groupBy, 'none');
  assert.equal(moved.sortBy, 'state');
  assert.equal(moved.status, 'all');
  assert.equal((await migrated({ groupBy: 'project' }, 1)).groupBy, 'none', 'the default before that moves too');
  const chosen = await migrated({ groupBy: 'project', sortBy: 'created' }, 2);
  assert.equal(chosen.groupBy, 'project', 'a choice made since stays');
  assert.equal(chosen.sortBy, 'created');
  assert.equal((await migrated({ groupBy: 'date' }, 1)).groupBy, 'date');
  assert.equal((await migrated({ groupBy: 'state', sortBy: 'updated' }, 3)).groupBy, 'state', 'and it happens only once');
  assert.equal(store.persist.getOptions().version, 3);

  store.getState().setTaskFilter('running');
  assert.equal(store.getState().taskFilter, 'running');
  assert.equal('taskFilter' in (store.persist.getOptions().partialize!(store.getState()) as object), false, 'a restart starts from everything');
  store.getState().setTaskFilter('all');

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
  assert.equal(merged.properties.includes('pull-requests'), true);
  assert.equal(merged.layout, 'list');
  const oldPrChoice = merge({ showPullRequests: false }, store.getState()) as ReturnType<typeof store.getState>;
  assert.equal(oldPrChoice.properties.includes('pull-requests'), false, 'an earlier choice to hide PR status carries over');
  const savedLook = merge(
    { layout: 'board', subGroupBy: 'agent', properties: ['date', 'bogus'], showSubSessions: false },
    store.getState()
  ) as ReturnType<typeof store.getState>;
  assert.equal(savedLook.layout, 'board');
  assert.equal(savedLook.subGroupBy, 'agent');
  assert.deepEqual(savedLook.properties, ['date']);
  assert.equal(savedLook.showSubSessions, false);
  assert.equal(merged.project, null);

  console.log('sidebar-view tests passed');
}

void main();
