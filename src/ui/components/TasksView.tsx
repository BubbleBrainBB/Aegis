import { toast } from 'sonner';
import { useSessionOrganization, useSessionOrganizationStore, changeSessionOrganization } from '../store/useSessionOrganizationStore';
import { textInputDialog } from './ui/text-input-dialog';
import { useSessionActionsMenu } from '../hooks/useSessionActionsMenu';
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ChevronRight,
  Loader2,
  Monitor,
  MoreHorizontal,
  Pin,
} from './icons';
import { confirmDialog } from './ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { MainSheet } from './MainSheet';
import { TaskDisplayMenu } from './TaskDisplayMenu';
import { PROVIDERS } from '../utils/provider';
import { groupTasks, type TaskGroup } from '../utils/task-groups';
import { useAppStore } from '../store/useAppStore';
import { rootSessionOf, subSessionParents, useFollowUpStore } from '../store/useFollowUpStore';
import { sendEvent } from '../hooks/useIPC';
import type { GitPullRequestSummary } from '../../shared/types';
import { useSidebarViewOptions, useSidebarViewStore } from '../store/useSidebarViewStore';
import { primaryPullRequest, useSidebarPullRequests, useSidebarPullRequestStore } from '../store/useSidebarPullRequests';
import { PULL_REQUEST_STATUS, pullRequestStatus } from './pull-request-status';
import { getSessionProjectPath, SessionHoverCard, SessionWorktreeMarks } from './SessionHoverCard';
import {
  boardGroupBy,
  formatTaskDate,
  getProjectLabel,
  isWithinActivityWindow,
  mostUrgentSidebarState,
  sessionSortTime,
  SIDEBAR_STATE_LABELS,
  SIDEBAR_STATE_ORDER,
  TASK_FILTERS,
  taskAttention,
  type SidebarSessionState,
  type SidebarSortBy,
  type TaskProperty,
} from '../utils/sidebar-view';
import type { AgentProvider, SessionView } from '../types';
import { AgentIcon } from './ComposerAgentControls';
import { TaskStateIcon, TaskStatusMenu } from './TaskStatusMenu';
import { ProjectChip, TaskProjectFilter } from './TaskProjectFilter';
import { naturalTaskStateOf, openTask, taskStateOf, type TaskStateSources } from '../utils/task-state';
import { SessionHandoffProviderRoute } from './SessionHandoffIndicator';
import { TaskTitleLoading, useTaskTitleReveal } from './TaskTitleLoading';

/**
 * Session title that stays truncated until hovered, then scrolls left/right
 * (marquee) so long titles can be read in full. Overflow is measured at
 * runtime; short titles render exactly as before with no animation.
 */
function ScrollingTitle({ title, className = '' }: { title: string; className?: string }) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [marqueeStyle, setMarqueeStyle] = useState<CSSProperties | undefined>();

  useLayoutEffect(() => {
    const measure = () => {
      const outer = outerRef.current;
      const inner = innerRef.current;
      if (!outer || !inner) return;
      const distance = inner.scrollWidth - outer.clientWidth;
      const next = distance > 2;
      setOverflowing(next);
      setMarqueeStyle(
        next
          ? ({
              '--marquee-distance': `${-(distance + 6)}px`,
              '--marquee-duration': `${Math.max(2.5, distance / 35)}s`,
            } as CSSProperties)
          : undefined
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (outerRef.current) observer.observe(outerRef.current);
    // Content width changes without the outer resizing (font swap-in, late
    // glyph layout) — watch the inner too so overflow detection never goes
    // stale.
    if (innerRef.current) observer.observe(innerRef.current);
    return () => observer.disconnect();
  }, [title]);

  return (
    <span
      ref={outerRef}
      className={`marquee-title-outer ${className}`}
      data-overflowing={overflowing ? 'true' : undefined}
      style={marqueeStyle}
    >
      <span ref={innerRef} className="marquee-title-inner">
        {title}
      </span>
    </span>
  );
}

/** One wait of a task on the user; a later wait of the same task comes after new activity. */
function subSessionWaitMark(session: SessionView): string {
  return `${session.id}:${session.updatedAt}`;
}


function toggleTaskPin(sessionId: string) {
  sendEvent({ type: 'session.togglePin', payload: { sessionId } });
}

function ProviderGlyph({ provider }: { provider?: AgentProvider }) {
  return <AgentIcon provider={provider ?? 'claude'} />;
}

/**
 * My Tasks: every task in the main column, as a list or a board, filtered by
 * state and by project.
 */
export function TasksView() {
  const followUpsLoaded = useFollowUpStore(s => s.loaded);
  useEffect(() => {
    if (!followUpsLoaded) void useFollowUpStore.getState().load();
  }, [followUpsLoaded]);
  const followUpProposals = useFollowUpStore(s => s.proposals);
  const subSessionParentMap = useMemo(() => subSessionParents(followUpProposals), [followUpProposals]);
  const sessions = useAppStore((s) => s.sessions);
  const organization = useSessionOrganization();
  const view = useSidebarViewOptions();
  const setViewOption = useSidebarViewStore((state) => state.setOption);
  const taskFilter = useSidebarViewStore((state) => state.taskFilter);
  const setTaskFilter = useSidebarViewStore((state) => state.setTaskFilter);
  const prsBySession = useSidebarPullRequests(true);
  const settledWorktrees = useSidebarPullRequestStore((state) => state.settledWorktrees);
  const settledCheckedAt = useSidebarPullRequestStore((state) => state.settledCheckedAt);
  const sources = useMemo<TaskStateSources>(
    () => ({ organization, prsBySession, worktrees: { settledWorktrees, settledCheckedAt } }),
    [organization, prsBySession, settledWorktrees, settledCheckedAt]
  );
  const collapsedGroups = useSidebarViewStore((state) => state.collapsedGroups);
  const toggleGroupExpanded = useSidebarViewStore((state) => state.toggleGroupCollapsed);
  const dismissedWaits = useSidebarViewStore((state) => state.dismissedWaits);
  const foldSubSessions = useSidebarViewStore((state) => state.foldSubSessions);
  const isBoard = view.layout === 'board';
  const groupBy = isBoard ? boardGroupBy(view.groupBy) : view.groupBy;

  const {
    pinnedSessions,
    sectionGroups,
    groups,
    listed,
    archivedCount,
    subSessionsByRoot,
  } = useMemo(() => {
    const now = Date.now();
    const byTime = (left: SessionView, right: SessionView) =>
      sessionSortTime(right, view.sortBy) - sessionSortTime(left, view.sortBy);
    // A chat nothing has been sent from is not a task yet: it shows on screen,
    // not in any list. New Task goes back to it (openDraftSession).
    const allSessions = Object.values(sessions).filter(
      (session) => !session.hiddenFromThreads && session.scope !== 'dm' && !session.isDraft
    );
    let sessionList = allSessions.filter((session) => {
      const archived = Boolean(organization.sessions[session.id]?.archived);
      if (view.status === 'active' && archived) return false;
      if (view.status === 'archived' && !archived) return false;
      return !view.project || getSessionProjectPath(session) === view.project;
    });
    const archivedCount = allSessions.filter((session) => organization.sessions[session.id]?.archived).length;

    // Sub-sessions sit one level under the top session that started them, when
    // it is listed too, in the order they started so rows don't jump. By
    // project, one that runs in another project is listed under that project
    // instead. A board and the date view are flat: each task stands on its own.
    const subSessionsByRoot = new Map<string, SessionView[]>();
    if (!isBoard && groupBy !== 'date') {
      const listedIds = new Set(sessionList.map((session) => session.id));
      const nested = new Set<string>();
      for (const session of sessionList) {
        const root = rootSessionOf(subSessionParentMap, session.id);
        if (!root || !listedIds.has(root)) continue;
        if (groupBy === 'project' && getSessionProjectPath(session) !== getSessionProjectPath(sessions[root])) continue;
        nested.add(session.id);
        subSessionsByRoot.set(root, [...(subSessionsByRoot.get(root) ?? []), session]);
      }
      for (const children of subSessionsByRoot.values()) {
        children.sort((left, right) => (left.createdAt ?? left.updatedAt) - (right.createdAt ?? right.updatedAt));
      }
      sessionList = sessionList.filter((session) => !nested.has(session.id));
    }
    if (!view.showSubSessions) {
      sessionList = sessionList.filter((session) => !rootSessionOf(subSessionParentMap, session.id));
    }

    // A row stands where the most urgent of its tasks does.
    const rowStates = new Map<string, SidebarSessionState | null>();
    for (const session of sessionList) {
      const own = taskStateOf(session, sources);
      rowStates.set(session.id, own && mostUrgentSidebarState(
        own,
        (subSessionsByRoot.get(session.id) ?? []).map((task) => taskStateOf(task, sources))
      ));
    }
    if (taskFilter !== 'all') sessionList = sessionList.filter((session) => rowStates.get(session.id) === taskFilter);
    // The window only thins out finished work: what is still open always shows.
    sessionList = sessionList.filter(
      (session) => rowStates.get(session.id) !== 'completed' || isWithinActivityWindow(session, view.activity, now)
    );
    const stateRank = (session: SessionView) => SIDEBAR_STATE_ORDER.indexOf(rowStates.get(session.id) as SidebarSessionState);
    const byListOrder = view.sortBy === 'state'
      ? (left: SessionView, right: SessionView) => stateRank(left) - stateRank(right) || byTime(left, right)
      : byTime;

    // Pinned 和自定义 section 只属于按项目/不分组的列表；其他视图是分诊视图，
    // 每个会话都按自身分类归位
    const usesSections = !isBoard && (groupBy === 'project' || groupBy === 'none');
    const sectionGroups = usesSections
      ? organization.sections.map((section) => ({
          ...section,
          sessions: sessionList
            .filter((session) => organization.sessions[session.id]?.sectionId === section.id)
            .sort(byListOrder),
        }))
      : [];
    const unsectioned = usesSections
      ? sessionList.filter((session) => !organization.sessions[session.id]?.sectionId)
      : sessionList;
    const pinnedSessions = usesSections
      ? unsectioned.filter((session) => session.pinned).sort(byListOrder)
      : [];
    const regularSessions = usesSections
      ? unsectioned.filter((session) => !session.pinned)
      : unsectioned;

    const groups = groupTasks([...regularSessions].sort(byListOrder), groupBy, view.subGroupBy, {
      sortBy: view.sortBy,
      now,
      stateOf: (task) => rowStates.get(task.id),
      pullRequestOf: (task) => {
        const pr = primaryPullRequest(prsBySession[task.id]);
        return pr ? pullRequestStatus(pr) : null;
      },
      providerLabel: (provider) => PROVIDERS.find((entry) => entry.id === provider)?.label ?? provider,
      showEmptyGroups: view.showEmptyGroups,
    });

    return {
      pinnedSessions,
      sectionGroups,
      groups,
      listed: sessionList.length,
      archivedCount,
      subSessionsByRoot,
    };
  }, [
    subSessionParentMap,
    sessions,
    organization,
    prsBySession,
    sources,
    taskFilter,
    isBoard,
    groupBy,
    view.subGroupBy,
    view.status,
    view.project,
    view.activity,
    view.sortBy,
    view.showSubSessions,
    view.showEmptyGroups,
  ]);

  const isExpanded = (key: string) => !collapsedGroups.has(key);

  /**
   * A session row and, under it, the sub-sessions it started (one level),
   * folded with the chevron beside its title.
   */
  const withSubSessions = (
    session: SessionView,
    depth: number,
    key: string,
    renderRow: (row: SessionView, rowDepth: number, nest?: SubSessionNest, nested?: boolean) => ReactNode,
  ) => {
    const children = view.showSubSessions ? subSessionsByRoot.get(session.id) : undefined;
    if (!children?.length) return <Fragment key={key}>{renderRow(session, depth)}</Fragment>;
    const childStates = children.map((child) => taskStateOf(child, sources));
    const waits = children
      .filter((_, index) => childStates[index] === 'needs-input')
      .map(subSessionWaitMark);
    // A fold holds until another task needs the user.
    const foldKey = `sub-sessions:${session.id}`;
    const expanded = !collapsedGroups.has(foldKey) || waits.some((wait) => !dismissedWaits.has(wait));
    const nest: SubSessionNest = {
      count: children.length,
      running: children.filter((child) => child.status === 'running').length,
      waiting: waits.length > 0,
      expanded,
      onToggle: () => {
        if (expanded) foldSubSessions(foldKey, waits);
        else toggleGroupExpanded(foldKey);
      },
    };
    return (
      <Fragment key={key}>
        {renderRow(session, depth, nest)}
        {expanded ? (
          <div data-sub-sessions-of={session.id}>
            {children.map((child, index) => (
              <div key={child.id} className="relative">
                {renderRow(child, depth + 1)}
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute top-0 w-[10px] border-l border-[color-mix(in_srgb,var(--text-primary)_16%,transparent)] ${
                    index === children.length - 1 ? 'h-[calc(50%-0.5px)] rounded-bl-[6px] border-b' : 'bottom-0'
                  }`}
                  // Down from the parent's state icon, hooking into the last sub-session.
                  style={{ left: `${depth * ROW_INDENT + 19.5}px` }}
                />
              </div>
            ))}
          </div>
        ) : null}
      </Fragment>
    );
  };
  // Grouped by project, or inside one, its name would only repeat.
  const showProject = !view.project && groupBy !== 'project' && view.subGroupBy !== 'project' && view.properties.includes('project');
  const renderSession = (session: SessionView, key = session.id) =>
    withSubSessions(session, 0, key, (row, rowDepth, nest) => (
      <SessionItem
        session={row}
        state={taskStateOf(row, sources)}
        naturalState={naturalTaskStateOf(row, sources)}
        depth={rowDepth}
        nest={nest}
        pullRequests={view.properties.includes('pull-requests') ? prsBySession[row.id] : null}
        showProject={showProject}
        properties={view.properties}
        sortBy={view.sortBy}
        variant="row"
      />
    ));
  const renderCard = (session: SessionView) => (
    <SessionItem
      key={session.id}
      session={session}
      state={taskStateOf(session, sources)}
      naturalState={naturalTaskStateOf(session, sources)}
      depth={0}
      pullRequests={view.properties.includes('pull-requests') ? prsBySession[session.id] : null}
      showProject={showProject}
      properties={view.properties}
      sortBy={view.sortBy}
      variant="card"
    />
  );
  const plainHeaderClass = 'mb-1 flex h-7 w-full items-center gap-1.5 px-3 text-left text-[13px] font-normal text-[var(--text-muted)]';
  const editSection = async (id: string, name: string, remove = false) => {
    try {
      if (remove) {
        if (await confirmDialog({ title: `Remove ${name}?`, description: 'Conversations return to their project groups.', confirmLabel: 'Remove section' })) {
          await changeSessionOrganization({ kind: 'remove-section', sectionId: id });
        }
      } else {
        const next = await textInputDialog({ title: 'Rename section', label: 'Section name', value: name, maxLength: 80 });
        if (next) await changeSessionOrganization({ kind: 'rename-section', sectionId: id, name: next });
      }
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  };

  const projectLabel = view.project ? getProjectLabel(view.project) : null;
  const listEmpty = listed === 0 && !groups.some((group) => group.state);

  const renderListGroup = (group: TaskGroup) => {
    if (groupBy === 'none') return group.tasks.length ? <section key={group.key} className="mb-4">{group.tasks.map((task) => renderSession(task, `flat:${task.id}`))}</section> : null;
    const expanded = isExpanded(group.key);
    return (
      <section key={group.key} className="mb-3" data-sidebar-state={group.state} data-task-group={group.key}>
        <TaskGroupHeader group={group} expanded={expanded} onToggle={() => toggleGroupExpanded(group.key)} />
        {expanded
          ? group.subgroups
            ? group.subgroups.map((subgroup) => {
                const subKey = `${group.key}/${subgroup.key}`;
                const subExpanded = isExpanded(subKey);
                return (
                  <div key={subKey} data-task-subgroup={subKey}>
                    <TaskGroupHeader group={subgroup} expanded={subExpanded} onToggle={() => toggleGroupExpanded(subKey)} nested />
                    {subExpanded ? subgroup.tasks.map((task) => renderSession(task, `${subKey}:${task.id}`)) : null}
                  </div>
                );
              })
            : group.tasks.map((task) => renderSession(task, `${group.key}:${task.id}`))
          : null}
      </section>
    );
  };

  return (
    <MainSheet
      header={
        <h1 className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]" title={view.project ?? undefined}>
          {projectLabel ?? 'My Tasks'}
        </h1>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col" data-tasks-view>
        <div className="flex h-12 flex-shrink-0 items-center justify-between gap-2 px-2">
          <div className="flex min-w-0 items-center gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto" role="group" aria-label="Filter tasks">
            {TASK_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                aria-pressed={taskFilter === filter.id}
                onClick={() => setTaskFilter(filter.id)}
                className={`inline-flex h-7 flex-shrink-0 items-center rounded-full border px-3 text-[13px] transition-colors duration-150 ${
                  taskFilter === filter.id
                    ? 'border-transparent bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
                    : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
            <span aria-hidden="true" className="mx-1 h-4 w-px flex-shrink-0 bg-[var(--border)]" />
            <TaskProjectFilter />
          </div>
          <TaskDisplayMenu />
        </div>

        {isBoard && !listEmpty ? (
          <div className="sidebar-scrollbar flex min-h-0 flex-1 gap-2 overflow-x-auto px-2 pb-2" data-task-board>
            {groups.map((group) => (
              <section
                key={group.key}
                className="flex w-[300px] flex-shrink-0 flex-col"
                data-sidebar-state={group.state}
                data-task-column={group.key}
              >
                <h2 className="flex h-9 flex-shrink-0 items-center gap-2 px-2 text-[13px] font-normal text-[var(--text-primary)]" title={group.path}>
                  <TaskGroupMark group={group} />
                  <span className="min-w-0 truncate">{group.label}</span>
                  <span className="text-[12px] tabular-nums text-[var(--text-muted)]">{group.tasks.length}</span>
                </h2>
                <div className="sidebar-scrollbar flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
                  {group.subgroups
                    ? group.subgroups.map((subgroup) => (
                        <Fragment key={subgroup.key}>
                          <div className="flex h-7 flex-shrink-0 items-center gap-1.5 px-2 text-[12px] text-[var(--text-muted)]" data-task-subgroup={`${group.key}/${subgroup.key}`}>
                            <TaskGroupMark group={subgroup} />
                            <span className="min-w-0 truncate">{subgroup.label}</span>
                            <span className="tabular-nums">{subgroup.tasks.length}</span>
                          </div>
                          {subgroup.tasks.map(renderCard)}
                        </Fragment>
                      ))
                    : group.tasks.map(renderCard)}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="sidebar-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-6" data-task-list>
            {pinnedSessions.length > 0 && (
              <section className="mb-4">
                <div className={plainHeaderClass}>Pinned</div>
                {pinnedSessions.map((session) => renderSession(session, `pinned:${session.id}`))}
              </section>
            )}
            {sectionGroups.filter(group => taskFilter === 'all' || group.sessions.length > 0).map(group => (
              <section key={group.id} className="mb-4">
                <div className="group/section mb-1 flex items-center px-3 text-[13px] text-[var(--text-muted)]">
                  <button className="min-w-0 flex-1 truncate text-left" aria-expanded={isExpanded(group.id)} onClick={() => toggleGroupExpanded(group.id)}>{group.name}</button>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<button aria-label={`Manage ${group.name}`} className="flex h-6 w-6 items-center justify-center opacity-0 group-hover/section:opacity-100 focus:opacity-100"><MoreHorizontal className="h-3.5 w-3.5" /></button>} />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => void editSection(group.id, group.name)}>Rename…</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void editSection(group.id, group.name, true)}>Remove section…</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {isExpanded(group.id) && (group.sessions.length ? group.sessions.map((session) => renderSession(session, `section:${session.id}`)) : <div className="px-3 py-1 text-[12px] text-[var(--text-muted)]">No tasks yet</div>)}
              </section>
            ))}
            {groups.map(renderListGroup)}

            {listEmpty && (
              <p className="px-3 pt-3 text-[13px] text-[var(--text-secondary)]">
                {Object.values(sessions).some((session) => !session.isDraft && !session.hiddenFromThreads && session.scope !== 'dm') ? 'No tasks match this view.' : 'No tasks yet.'}
              </p>
            )}

            {/* 归档入口留在列表底部：点一下就是 Status → Archived，不必先找到视图菜单 */}
            {view.status === 'archived' || (view.status === 'active' && archivedCount > 0) ? (
              <button
                type="button"
                className="mt-2 px-3 text-[13px] text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text-primary)]"
                onClick={() => setViewOption('status', view.status === 'archived' ? 'active' : 'archived')}
              >
                {view.status === 'archived' ? 'Back to active tasks' : 'Archived'}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </MainSheet>
  );
}

function TaskGroupMark({ group }: { group: TaskGroup }) {
  if (group.state) return <TaskStateIcon state={group.state} failed={false} />;
  if (group.provider) return <span className="flex flex-shrink-0 items-center"><ProviderGlyph provider={group.provider} /></span>;
  if (group.pullRequest) {
    const meta = PULL_REQUEST_STATUS[group.pullRequest];
    return <meta.Icon className={`h-3.5 w-3.5 flex-shrink-0 ${meta.className}`} aria-hidden="true" />;
  }
  return null;
}

/** A group's bar, folding what is under it; a subgroup's is a quieter line. */
function TaskGroupHeader({ group, expanded, onToggle, nested = false }: {
  group: TaskGroup;
  expanded: boolean;
  onToggle: () => void;
  nested?: boolean;
}) {
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2 text-left text-[13px] ${
        nested
          ? 'mt-1 h-8 px-3 text-[var(--text-secondary)]'
          : 'mb-1 h-9 rounded-lg bg-[var(--sidebar-item-hover)] px-2.5 text-[var(--text-primary)]'
      }`}
      aria-expanded={expanded}
      onClick={onToggle}
      title={group.path}
    >
      <ChevronRight className={`h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)] transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`} />
      <TaskGroupMark group={group} />
      <span className="min-w-0 truncate">{group.label}</span>
      <span className="text-[12px] tabular-nums text-[var(--text-muted)]">{group.tasks.length}</span>
    </button>
  );
}

/** A row's sub-sessions: how many, how they are doing, and whether they show. */
type SubSessionNest = {
  count: number;
  running: number;
  waiting: boolean;
  expanded: boolean;
  onToggle: () => void;
};

/** Folded sub-sessions in one mark, only when there is news: amber when one needs you, a spinner while any runs. */
function SubSessionSummary({ nest }: { nest: SubSessionNest }) {
  if (nest.waiting) {
    return <span className="h-2 w-2 flex-shrink-0 rounded-full bg-[var(--warning)]" title="A sub-session needs you" aria-label="A sub-session needs you" />;
  }
  if (nest.running > 0) {
    return (
      <span className="flex-shrink-0 text-[var(--text-muted)]" title={`${nest.running} of ${nest.count} sub-sessions running`}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      </span>
    );
  }
  return null;
}

const ROW_INDENT = 24;

const SessionItem = memo(function SessionItem({
  session,
  state,
  naturalState,
  depth,
  nest,
  nested = false,
  pullRequests,
  showProject,
  properties,
  sortBy,
  variant,
}: {
  session: SessionView;
  state: SidebarSessionState | null;
  /** The state without one set by hand (see TaskStatusMenu). */
  naturalState: SidebarSessionState | null;
  depth: number;
  /** Set on a row with sub-sessions under it. */
  nest?: SubSessionNest;
  /** Hangs on its parent's tree line, which runs through the pin's gutter. */
  nested?: boolean;
  pullRequests?: GitPullRequestSummary[] | null;
  showProject: boolean;
  properties: readonly TaskProperty[];
  sortBy: SidebarSortBy;
  variant: 'row' | 'card';
}) {
  const unread = useSessionOrganizationStore(s => s.sessions[session.id]?.unread);
  const rowRef = useRef<HTMLDivElement>(null);
  const { openMenu, menuOpen, worktreeAction } = useSessionActionsMenu(session, nest);
  // The PR list replaces the session preview while it is open.
  const [pullRequestsOpen, setPullRequestsOpen] = useState(false);
  const projectPath = getSessionProjectPath(session);

  const attention = state === 'needs-input' ? taskAttention(session) : null;
  const summary = attention && properties.includes('summary') ? attention : null;
  const summaryClass = attention?.tone === 'error' ? 'text-[var(--error)]' : 'text-[var(--warning)]';
  const isCard = variant === 'card';

  const pin = (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        toggleTaskPin(session.id);
      }}
      className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md transition-all duration-150 hover:text-[var(--text-primary)] focus:opacity-100 group-hover/session:opacity-100 ${
        session.pinned ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)] opacity-0'
      }`}
      aria-label={session.pinned ? 'Unpin conversation' : 'Pin conversation'}
      aria-pressed={session.pinned}
      title={session.pinned ? 'Unpin conversation' : 'Pin conversation'}
    >
      <Pin className="h-3.5 w-3.5" fill={session.pinned ? 'currentColor' : 'none'} />
    </button>
  );
  const unreadDot = unread ? <span aria-label="Unread conversation" title="Unread conversation" className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" /> : null;
  const deviceMark = session.device ? (
    <Monitor
      data-session-device
      className={`h-[13px] w-[13px] flex-shrink-0 text-[var(--text-muted)] ${session.device.online ? '' : 'opacity-50'}`}
      aria-label={`On ${session.device.name}`}
    />
  ) : null;
  const worktreeMarks = (
    <SessionWorktreeMarks
      session={session}
      worktreeAction={worktreeAction}
      pullRequests={pullRequests}
      onPullRequestsOpenChange={setPullRequestsOpen}
    />
  );
  // Only cards name the project; a list row leaves it to the hover card.
  const projectPill = isCard && showProject && projectPath && !session.isChat ? <ProjectChip path={projectPath} /> : null;
  const providerMark = !properties.includes('agent') ? null : session.handoffSourceProvider ? (
    <SessionHandoffProviderRoute
      sourceProvider={session.handoffSourceProvider}
      targetProvider={session.provider ?? 'claude'}
    />
  ) : (
    <span className="flex flex-shrink-0 items-center" data-task-provider>
      <ProviderGlyph provider={session.provider} />
    </span>
  );
  const date = properties.includes('date') ? formatTaskDate(sessionSortTime(session, sortBy)) : null;
  const titleReveal = useTaskTitleReveal(session.titlePending);

  return (
    <SessionHoverCard
      session={session}
      disabled={menuOpen || pullRequestsOpen}
      side={isCard ? 'right' : 'bottom'}
      sideOffset={isCard ? 8 : 2}
      trigger={
        <div
          ref={rowRef}
          data-session-id={session.id}
          data-task-state={state ?? undefined}
          role="button"
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void openMenu({ x: event.clientX, y: event.clientY });
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter') {
              openTask(session.id);
            } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              void openMenu({ x: rect.left + 12, y: rect.bottom });
            }
          }}
          tabIndex={0}
          className={`group/session relative cursor-pointer rounded-lg text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)] focus-visible:bg-[var(--sidebar-item-hover)] focus-visible:outline-none ${
            isCard
              ? 'flex w-full flex-shrink-0 flex-col gap-2 border border-[var(--border)] p-3'
              : 'flex h-11 items-center gap-3 px-3'
          }`}
          style={isCard ? undefined : { marginLeft: `${depth * ROW_INDENT}px` }}
          onClick={() => openTask(session.id)}
        >
          {isCard ? (
            <>
              <span className="flex items-start gap-2">
                <span className="flex h-5 flex-shrink-0 items-center">
                  <TaskStatusMenu session={session} state={state} naturalState={naturalState} failed={attention?.tone === 'error'} rowRef={rowRef} />
                </span>
                {session.titlePending ? (
                  <span className="flex h-5 min-w-0 flex-1 items-center"><TaskTitleLoading /></span>
                ) : (
                  <span className={`line-clamp-2 min-w-0 flex-1 text-[13px] leading-5 ${titleReveal}`}>{session.title}</span>
                )}
                {deviceMark ? <span className="flex h-5 flex-shrink-0 items-center">{deviceMark}</span> : null}
                {unreadDot ? <span className="flex h-5 flex-shrink-0 items-center">{unreadDot}</span> : null}
                <span className="absolute right-1.5 top-1.5">{pin}</span>
              </span>
              {summary ? <span className={`line-clamp-2 text-[12px] ${summaryClass}`} data-task-attention>{summary.text}</span> : null}
              {projectPill || providerMark || date || pullRequests?.length || worktreeAction || session.worktreePath ? (
                <span className="flex min-w-0 items-center gap-2">
                  {projectPill}
                  {worktreeMarks}
                  {providerMark}
                  {date ? <span className="ml-auto flex-shrink-0 whitespace-nowrap text-[12px] tabular-nums text-[var(--text-muted)]" data-task-date>{date}</span> : null}
                </span>
              ) : null}
            </>
          ) : (
            <>
              <TaskStatusMenu session={session} state={state} naturalState={naturalState} failed={attention?.tone === 'error'} rowRef={rowRef} />
              <span className={`flex min-w-0 items-center gap-2 ${summary ? 'max-w-[60%] flex-shrink-0' : 'flex-1'}`}>
                {session.titlePending ? (
                  <TaskTitleLoading />
                ) : (
                  <ScrollingTitle title={session.title} className={`min-w-0 text-[13px] font-normal leading-[1.3] ${titleReveal}`} />
                )}
                {nest ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      nest.onToggle();
                    }}
                    className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text-primary)]"
                    aria-label={nest.expanded ? 'Hide sub-sessions' : 'Show sub-sessions'}
                    aria-expanded={nest.expanded}
                    title={nest.expanded ? 'Hide sub-sessions' : 'Show sub-sessions'}
                  >
                    <ChevronRight className={`h-3.5 w-3.5 transition-transform duration-150 ${nest.expanded ? 'rotate-90' : ''}`} />
                  </button>
                ) : null}
                {nest && !nest.expanded ? <SubSessionSummary nest={nest} /> : null}
                {deviceMark}
                {unreadDot}
              </span>
              {summary ? (
                <span className={`min-w-0 flex-1 truncate text-[13px] ${summaryClass}`} data-task-attention>
                  {summary.text}
                </span>
              ) : null}
              <span className="flex flex-shrink-0 items-center gap-3">
                {pin}
                {worktreeMarks}
                {providerMark}
                {date ? (
                  <span className="w-14 flex-shrink-0 whitespace-nowrap text-right text-[13px] tabular-nums text-[var(--text-secondary)]" data-task-date>
                    {date}
                  </span>
                ) : null}
              </span>
            </>
          )}
        </div>
      }
    />
  );
});
