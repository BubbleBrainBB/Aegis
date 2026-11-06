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
 * Where a session stands, most urgent first. Derived on every render and
 * never stored: reading a result or merging its PR is what moves it on.
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
  context: { unread?: boolean; pullRequest?: GitPullRequestSummary | null; worktreeSettled?: boolean }
): SidebarSessionState | null {
  if (session.isDraft) return null;
  const running = session.status === 'running' || session.status === 'stopping';
  if (session.permissionRequests.length > 0) return 'needs-input';
  if (running) return 'running';
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

/** A stable colour for a project's dot, the same wherever it appears. */
export function getProjectHue(path: string): number {
  let hash = 0;
  for (const char of path) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
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
 * The sidebar's Workspace list, most recently active first. Projects are not
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
