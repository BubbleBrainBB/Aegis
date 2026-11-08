import type { ManualTaskStatus } from '../../shared/session-organization';
import type { GitPullRequestSummary } from '../../shared/types';
import { turnReportNeedsUser, turnReportTitle } from '../../shared/turn-report';
import type { SessionView } from '../types';

export type SidebarStatusFilter = 'active' | 'archived' | 'all';
export type SidebarActivityWindow = '1d' | '7d' | '30d' | 'all';
export type SidebarGroupBy = 'none' | 'state' | 'project' | 'agent' | 'pull-request' | 'date';
export type TaskLayout = 'list' | 'board';
export type TaskProperty = 'summary' | 'pull-requests' | 'project' | 'agent' | 'date';
export type SidebarSortBy = 'state' | 'updated' | 'created';

export interface SidebarViewOptions {
  layout: TaskLayout;
  status: SidebarStatusFilter;
  /** Project root to show alone, or null for every project. */
  project: string | null;
  /** How far back completed tasks are listed; tasks still open always are. */
  activity: SidebarActivityWindow;
  /** On a board, No grouping falls back to columns by state (see boardGroupBy). */
  groupBy: SidebarGroupBy;
  subGroupBy: SidebarGroupBy;
  sortBy: SidebarSortBy;
  showSubSessions: boolean;
  showEmptyGroups: boolean;
  properties: readonly TaskProperty[];
}

export const TASK_PROPERTY_LABELS: Record<TaskProperty, string> = {
  summary: 'Summary',
  'pull-requests': 'Pull requests',
  project: 'Project',
  agent: 'Agent',
  date: 'Date',
};

export const DEFAULT_SIDEBAR_VIEW: SidebarViewOptions = {
  layout: 'list',
  status: 'active',
  project: null,
  activity: 'all',
  groupBy: 'none',
  subGroupBy: 'none',
  sortBy: 'state',
  showSubSessions: true,
  showEmptyGroups: false,
  properties: Object.keys(TASK_PROPERTY_LABELS) as TaskProperty[],
};

/** A board always has columns. */
export function boardGroupBy(groupBy: SidebarGroupBy): SidebarGroupBy {
  return groupBy === 'none' ? 'state' : groupBy;
}

export const SIDEBAR_STATUS_LABELS: Record<SidebarStatusFilter, string> = {
  active: 'Active',
  archived: 'Archived',
  all: 'All',
};

export const SIDEBAR_ACTIVITY_LABELS: Record<SidebarActivityWindow, string> = {
  all: 'All',
  '30d': 'Past month',
  '7d': 'Past week',
  '1d': 'Past day',
};

export const SIDEBAR_GROUP_LABELS: Record<SidebarGroupBy, string> = {
  none: 'No grouping',
  state: 'State',
  project: 'Project',
  agent: 'Agent',
  'pull-request': 'Pull request',
  date: 'Date',
};

export const SIDEBAR_SORT_LABELS: Record<SidebarSortBy, string> = {
  state: 'State',
  updated: 'Last activity',
  created: 'Created',
};

const ACTIVITY_WINDOW_MS: Record<Exclude<SidebarActivityWindow, 'all'>, number> = {
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** The project is where the page is (the sidebar picks it), not how it is drawn. */
export function isDefaultSidebarView(options: SidebarViewOptions): boolean {
  return (Object.keys(DEFAULT_SIDEBAR_VIEW) as (keyof SidebarViewOptions)[]).every((key) => {
    if (key === 'project') return true;
    if (key === 'properties') {
      return options.properties.length === DEFAULT_SIDEBAR_VIEW.properties.length;
    }
    return options[key] === DEFAULT_SIDEBAR_VIEW[key];
  });
}

export function isWithinActivityWindow(
  session: Pick<SessionView, 'updatedAt'>,
  activity: SidebarActivityWindow,
  now: number
): boolean {
  if (activity === 'all') return true;
  return now - session.updatedAt <= ACTIVITY_WINDOW_MS[activity];
}

export function sessionSortTime(session: Pick<SessionView, 'updatedAt' | 'createdAt'>, sortBy: SidebarSortBy): number {
  return sortBy === 'created' ? session.createdAt ?? session.updatedAt : session.updatedAt;
}

/**
 * Where a session stands, most urgent first. Derived on every render: reading
 * a result or merging its PR is what moves it on, unless you set it by hand.
 */
export type SidebarSessionState = 'needs-input' | 'running' | 'review' | 'completed';

export const SIDEBAR_STATE_ORDER: SidebarSessionState[] = ['needs-input', 'running', 'review', 'completed'];

export const SIDEBAR_STATE_LABELS: Record<SidebarSessionState, string> = {
  'needs-input': 'Needs input',
  running: 'Running',
  review: 'Ready for review',
  completed: 'Completed',
};

export type TaskFilter = 'all' | SidebarSessionState;

export const TASK_FILTERS: ReadonlyArray<{ id: TaskFilter; label: string }> = [
  { id: 'all', label: 'All' },
  ...SIDEBAR_STATE_ORDER.map((state) => ({ id: state, label: SIDEBAR_STATE_LABELS[state] })),
];

/** The sidebar's Active list: what needs you first, then what waits for review, then what still runs. */
export const ACTIVE_STATE_ORDER: SidebarSessionState[] = ['needs-input', 'review', 'running'];

/** A task with the sub-tasks it started, listed together. */
export interface TaskFamily<T> {
  root: T;
  children: T[];
}

/**
 * The sidebar's Active list: every task that is not finished, with its family.
 * Sub-tasks belong to the task that started them, so while any of them is
 * unfinished the whole family shows, finished members too. A family stands
 * where its most urgent member does, the latest activity first after that.
 */
export function listActiveTaskFamilies<T extends Pick<SessionView, 'id' | 'updatedAt' | 'createdAt'>>(
  tasks: readonly T[],
  rootOf: (id: string) => string | null,
  stateOf: (task: T) => SidebarSessionState | null
): TaskFamily<T>[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const families = new Map<string, TaskFamily<T>>();
  for (const task of tasks) {
    const root = rootOf(task.id);
    if (root && byId.has(root)) continue;
    families.set(task.id, { root: task, children: [] });
  }
  for (const task of tasks) {
    const root = rootOf(task.id);
    if (root && byId.has(root)) families.get(root)!.children.push(task);
  }
  const ranked = [...families.values()].flatMap((family) => {
    const members = [family.root, ...family.children];
    const ranks = members.map((task) => ACTIVE_STATE_ORDER.indexOf(stateOf(task) as SidebarSessionState)).filter((rank) => rank >= 0);
    if (!ranks.length) return [];
    family.children.sort((left, right) => (left.createdAt ?? left.updatedAt) - (right.createdAt ?? right.updatedAt));
    return [{ family, rank: Math.min(...ranks), latest: Math.max(...members.map((task) => task.updatedAt)) }];
  });
  return ranked
    .sort((left, right) => left.rank - right.rank || right.latest - left.latest)
    .map((entry) => entry.family);
}

/** Where a conversation stands with the tasks it started: the most urgent of them all. */
export function mostUrgentSidebarState(
  own: SidebarSessionState,
  tasks: readonly (SidebarSessionState | null)[]
): SidebarSessionState {
  return SIDEBAR_STATE_ORDER.find((state) => state === own || tasks.includes(state)) ?? own;
}

/** Null while the session is still a draft: nothing has been sent, so there is no state yet. */
export function deriveSidebarSessionState(
  session: Pick<
    SessionView,
    'status' | 'permissionRequests' | 'runtimeNotice' | 'envMode' | 'worktreePath' | 'isDraft'
  > & Partial<Pick<SessionView, 'turnReport' | 'backgroundTasks'>>,
  context: {
    unread?: boolean;
    pullRequest?: GitPullRequestSummary | null;
    worktreeSettled?: boolean;
    /** Set by hand from the Change status menu; it outranks everything the last run left behind. */
    manualStatus?: ManualTaskStatus | null;
  }
): SidebarSessionState | null {
  if (session.isDraft) return null;
  const running = session.status === 'running' || session.status === 'stopping';
  if (session.permissionRequests.length > 0) return 'needs-input';
  if (running) return 'running';
  if (context.manualStatus) return context.manualStatus;
  // Only a failure you have not looked at yet; an old one you already saw
  // would otherwise sit in Needs input forever.
  if (session.runtimeNotice === 'error') return 'needs-input';
  // The agent's own report of how the turn ended (shared/turn-report.ts):
  // a question or blocker waits on you until your next message; work still
  // going in the background needs nothing, for as long as a task is alive to
  // wake the agent (a restart ends them, and the stored report outlives them);
  // "nothing to change" has no result to review.
  const outcome = session.turnReport?.outcome;
  if (outcome === 'question' || outcome === 'blocked') return 'needs-input';
  if (outcome === 'in_progress' && session.backgroundTasks?.length) return 'running';
  const finished = session.runtimeNotice === 'completed' && outcome !== 'nothing_to_do';
  if (finished || context.unread) return 'review';
  const pr = context.pullRequest;
  if (pr?.state === 'open') return 'review';
  // A live worktree holds work that has not been applied back yet, unless its
  // PR already landed (or was closed) upstream, or git shows nothing is left.
  if (session.envMode === 'worktree' && session.worktreePath && !pr && !context.worktreeSettled) return 'review';
  return 'completed';
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? '';
}

/** One short line on what a task waiting on the user wants. */
export function taskAttention(
  session: Pick<SessionView, 'permissionRequests' | 'runtimeNotice' | 'lastTurnError' | 'turnReport'>
): { text: string; tone: 'error' | 'warning' } | null {
  const request = session.permissionRequests[0];
  if (request) {
    const input = request.input as { command?: unknown; question?: unknown; questions?: Array<{ question?: unknown }> } | undefined;
    const question = input?.questions?.[0]?.question ?? input?.question;
    if (typeof question === 'string' && question.trim()) return { text: firstLine(question), tone: 'warning' };
    if (typeof input?.command === 'string' && input.command.trim()) {
      return { text: `Run ${firstLine(input.command)}`, tone: 'warning' };
    }
    return { text: `Allow ${request.toolName}`, tone: 'warning' };
  }
  if (session.runtimeNotice === 'error') {
    return { text: firstLine(session.lastTurnError ?? '') || 'Stopped with an error', tone: 'error' };
  }
  if (turnReportNeedsUser(session.turnReport)) {
    return { text: turnReportTitle(session.turnReport!), tone: 'warning' };
  }
  return null;
}

export function getProjectLabel(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}

/** How long ago, in one short word: now, 5m, 3h, 2d, 3w, 4mo, 1y. */
export function formatAge(timestamp: number, now = Date.now()): string {
  const seconds = Math.floor((now - timestamp) / 1000);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A list date: an age within the last day, then a calendar date. */
export function formatTaskDate(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  const date = new Date(timestamp);
  return date.getFullYear() === new Date(now).getFullYear()
    ? `${MONTHS[date.getMonth()]} ${date.getDate()}`
    : `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/**
 * My Tasks' Project filter, most recently active first. Projects are not
 * stored: they come from their tasks, plus the one the user just picked.
 */
export function listWorkspaceProjects(
  sessions: Iterable<Pick<SessionView, 'hiddenFromThreads' | 'scope' | 'isChat' | 'isDraft' | 'projectCwd' | 'cwd' | 'updatedAt'>>,
  selected: string | null
): string[] {
  const latest = new Map<string, number>();
  for (const session of sessions) {
    // A chat's own folder is not a project.
    if (session.hiddenFromThreads || session.scope === 'dm' || session.isChat || session.isDraft) continue;
    const path = (session.projectCwd || session.cwd)?.trim();
    if (!path) continue;
    latest.set(path, Math.max(latest.get(path) ?? 0, session.updatedAt));
  }
  const path = selected?.trim();
  if (path && !latest.has(path)) latest.set(path, 0);
  return Array.from(latest.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([project]) => project);
}
