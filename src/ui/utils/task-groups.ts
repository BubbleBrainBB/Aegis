import type { AgentProvider, SessionView } from '../types';
import {
  getProjectLabel,
  sessionSortTime,
  SIDEBAR_STATE_LABELS,
  SIDEBAR_STATE_ORDER,
  type SidebarGroupBy,
  type SidebarSessionState,
  type SidebarSortBy,
} from './sidebar-view';

type PullRequestGroup = 'open' | 'draft' | 'merged' | 'closed' | 'none';

const PULL_REQUEST_GROUPS: ReadonlyArray<{ id: PullRequestGroup; label: string }> = [
  { id: 'open', label: 'Open' },
  { id: 'draft', label: 'Draft' },
  { id: 'merged', label: 'Merged' },
  { id: 'closed', label: 'Closed' },
  { id: 'none', label: 'No pull request' },
];

export interface TaskGroup {
  /** Unique among its siblings. A state group's key is `state:<state>`, and so on. */
  key: string;
  label: string;
  state?: SidebarSessionState;
  /** The project a project group stands for. */
  path?: string;
  provider?: AgentProvider;
  pullRequest?: Exclude<PullRequestGroup, 'none'>;
  tasks: SessionView[];
  subgroups?: TaskGroup[];
}

export interface TaskGroupContext {
  sortBy: SidebarSortBy;
  now: number;
  stateOf: (task: SessionView) => SidebarSessionState | null | undefined;
  pullRequestOf: (task: SessionView) => Exclude<PullRequestGroup, 'none'> | null;
  providerLabel: (provider: AgentProvider) => string;
  /** State groups stay listed with nothing in them. */
  showEmptyGroups?: boolean;
}

// Group by Date 的分组标签（对齐 Codex）：Today / Yesterday / 一周内用星期几，
// 更早的按月份（跨年再带年份），保证每个会话都有归属。
const TIME_GROUP_WEEKDAY_FORMAT = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
const TIME_GROUP_MONTH_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'long' });
const TIME_GROUP_MONTH_YEAR_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });

export function getTimeGroupLabel(timestamp: number, now: Date): string {
  const date = new Date(timestamp);
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (dayDiff <= 0) return 'Today';
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff < 7) return TIME_GROUP_WEEKDAY_FORMAT.format(date);
  return date.getFullYear() === now.getFullYear()
    ? TIME_GROUP_MONTH_FORMAT.format(date)
    : TIME_GROUP_MONTH_YEAR_FORMAT.format(date);
}

function taskProject(task: SessionView): string | null {
  return task.isChat ? null : task.projectCwd?.trim() || task.cwd?.trim() || null;
}

function bucket<T>(tasks: SessionView[], keyOf: (task: SessionView) => T): Map<T, SessionView[]> {
  const buckets = new Map<T, SessionView[]>();
  for (const task of tasks) {
    const key = keyOf(task);
    const members = buckets.get(key);
    if (members) members.push(task);
    else buckets.set(key, [task]);
  }
  return buckets;
}

function groupOnce(tasks: SessionView[], by: SidebarGroupBy, context: TaskGroupContext): TaskGroup[] {
  const latest = (members: SessionView[]) =>
    Math.max(...members.map((task) => sessionSortTime(task, context.sortBy)));

  switch (by) {
    case 'none':
      return [{ key: 'all', label: '', tasks }];
    case 'state': {
      const buckets = bucket(tasks, (task) => context.stateOf(task) ?? null);
      return SIDEBAR_STATE_ORDER.filter((state) => context.showEmptyGroups || buckets.has(state)).map((state) => ({
        key: `state:${state}`,
        label: SIDEBAR_STATE_LABELS[state],
        state,
        tasks: buckets.get(state) ?? [],
      }));
    }
    case 'project': {
      const buckets = bucket(tasks, taskProject);
      const projects = Array.from(buckets.entries())
        .filter(([path]) => path !== null)
        .sort((left, right) => latest(right[1]) - latest(left[1]))
        .map(([path, members]) => ({ key: path as string, label: getProjectLabel(path as string), path: path as string, tasks: members }));
      const noProject = buckets.get(null);
      return noProject ? [...projects, { key: 'no-project', label: 'No project', tasks: noProject }] : projects;
    }
    case 'agent':
      return Array.from(bucket(tasks, (task) => task.provider ?? 'claude').entries())
        .map(([provider, members]) => ({ key: `agent:${provider}`, label: context.providerLabel(provider), provider, tasks: members }))
        .sort((left, right) => left.label.localeCompare(right.label));
    case 'pull-request': {
      const buckets = bucket(tasks, (task) => context.pullRequestOf(task) ?? 'none');
      return PULL_REQUEST_GROUPS.filter((group) => buckets.has(group.id)).map((group) => ({
        key: `pull-request:${group.id}`,
        label: group.label,
        pullRequest: group.id === 'none' ? undefined : group.id,
        tasks: buckets.get(group.id)!,
      }));
    }
    case 'date': {
      const now = new Date(context.now);
      const buckets = bucket(tasks, (task) => getTimeGroupLabel(sessionSortTime(task, context.sortBy), now));
      return Array.from(buckets.entries())
        .sort((left, right) => latest(right[1]) - latest(left[1]))
        .map(([label, members]) => ({ key: `date:${label}`, label, tasks: members }));
    }
  }
}

/** Splits an ordered list into groups, and those into subgroups, keeping the order inside each. */
export function groupTasks(
  tasks: SessionView[],
  by: SidebarGroupBy,
  subBy: SidebarGroupBy,
  context: TaskGroupContext
): TaskGroup[] {
  const groups = groupOnce(tasks, by, context);
  if (by === 'none' || subBy === 'none' || subBy === by) return groups;
  return groups.map((group) => ({ ...group, subgroups: groupOnce(group.tasks, subBy, { ...context, showEmptyGroups: false }) }));
}
