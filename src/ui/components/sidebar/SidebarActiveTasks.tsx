import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useSessionOrganization } from '../../store/useSessionOrganizationStore';
import { useSidebarPullRequests, useSidebarPullRequestStore } from '../../store/useSidebarPullRequests';
import { rootSessionOf, subSessionParents, useFollowUpStore } from '../../store/useFollowUpStore';
import { useSessionActionsMenu } from '../../hooks/useSessionActionsMenu';
import { useMinuteClock } from '../../hooks/useMinuteClock';
import { formatAge, listActiveTaskFamilies, taskAttention, type SidebarSessionState } from '../../utils/sidebar-view';
import { naturalTaskStateOf, openTask, taskStateOf, type TaskStateSources } from '../../utils/task-state';
import { TaskStatusMenu } from '../TaskStatusMenu';
import { TaskTitleLoading, useTaskTitleReveal } from '../TaskTitleLoading';
import { SessionHoverCard, SessionWorktreeMarks } from '../SessionHoverCard';
import type { GitPullRequestSummary } from '../../../shared/types';
import type { SessionView } from '../../types';

const CHILD_INDENT = 24;
const TREE_LINE = 'border-[color-mix(in_srgb,var(--text-primary)_16%,transparent)]';

/**
 * The sidebar's Active list: the tasks you are working through, so you can
 * move between them from inside one. Finished tasks leave it; My Tasks has
 * the rest. Sub-tasks hang under the task that started them, all of them.
 */
export function SidebarActiveTasks() {
  const followUpsLoaded = useFollowUpStore((s) => s.loaded);
  useEffect(() => {
    if (!followUpsLoaded) void useFollowUpStore.getState().load();
  }, [followUpsLoaded]);
  const proposals = useFollowUpStore((s) => s.proposals);
  const parents = useMemo(() => subSessionParents(proposals), [proposals]);
  const sessions = useAppStore((s) => s.sessions);
  const organization = useSessionOrganization();
  const prsBySession = useSidebarPullRequests(true);
  const settledWorktrees = useSidebarPullRequestStore((s) => s.settledWorktrees);
  const settledCheckedAt = useSidebarPullRequestStore((s) => s.settledCheckedAt);
  const sources = useMemo<TaskStateSources>(
    () => ({ organization, prsBySession, worktrees: { settledWorktrees, settledCheckedAt } }),
    [organization, prsBySession, settledWorktrees, settledCheckedAt]
  );

  const families = useMemo(() => {
    const tasks = Object.values(sessions).filter(
      (session) =>
        !session.hiddenFromThreads &&
        session.scope !== 'dm' &&
        !session.isDraft &&
        !organization.sessions[session.id]?.archived
    );
    return listActiveTaskFamilies(tasks, (id) => rootSessionOf(parents, id), (task) => taskStateOf(task, sources));
  }, [sessions, organization, parents, sources]);

  if (families.length === 0) {
    return <div className="px-2 py-1 text-[13px] text-[var(--text-muted)]" data-active-tasks-empty>No active tasks</div>;
  }

  return (
    <div className="space-y-px" data-active-tasks>
      {families.map(({ root, children }) => (
        <div key={root.id} data-active-family={root.id}>
          <ActiveTaskRow
            session={root}
            state={taskStateOf(root, sources)}
            naturalState={naturalTaskStateOf(root, sources)}
            pullRequests={prsBySession[root.id]}
          />
          {children.map((child, index) => (
            <div key={child.id} className="relative">
              <ActiveTaskRow
                session={child}
                state={taskStateOf(child, sources)}
                naturalState={naturalTaskStateOf(child, sources)}
                pullRequests={prsBySession[child.id]}
                nested
              />
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute left-[15.5px] top-0 w-[10px] border-l ${TREE_LINE} ${
                  index === children.length - 1 ? 'h-[calc(50%-0.5px)] rounded-bl-[6px] border-b' : 'bottom-0'
                }`}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const ActiveTaskRow = memo(function ActiveTaskRow({
  session,
  state,
  naturalState,
  pullRequests,
  nested = false,
}: {
  session: SessionView;
  state: SidebarSessionState | null;
  naturalState: SidebarSessionState | null;
  pullRequests?: GitPullRequestSummary[];
  nested?: boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const selected = useAppStore(
    (s) => s.activeSessionId === session.id && s.activeWorkspace === 'chat' && !s.showSettings
  );
  const { openMenu, menuOpen, worktreeAction } = useSessionActionsMenu(session);
  // The PR list replaces the task preview while it is open.
  const [pullRequestsOpen, setPullRequestsOpen] = useState(false);
  const now = useMinuteClock();
  const failed = state === 'needs-input' && taskAttention(session)?.tone === 'error';
  const titleReveal = useTaskTitleReveal(session.titlePending);

  return (
    <SessionHoverCard
      session={session}
      disabled={menuOpen || pullRequestsOpen}
      side="right"
      sideOffset={8}
      trigger={
        <div
          ref={rowRef}
          role="button"
          tabIndex={0}
          data-session-id={session.id}
          data-task-state={state ?? undefined}
          aria-current={selected ? 'page' : undefined}
          onClick={() => openTask(session.id)}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter') openTask(session.id);
            else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              void openMenu({ x: rect.left + 12, y: rect.bottom });
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            void openMenu({ x: event.clientX, y: event.clientY });
          }}
          className={`no-drag flex h-7 cursor-pointer items-center gap-2 rounded-md pl-2 pr-1.5 text-[13px] transition-colors duration-150 focus-visible:outline-none ${
            selected
              ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--sidebar-item-hover)]'
          }`}
          style={nested ? { marginLeft: CHILD_INDENT } : undefined}
        >
          <TaskStatusMenu session={session} state={state} naturalState={naturalState} failed={failed} rowRef={rowRef} />
          {session.titlePending ? (
            <span className="flex min-w-0 flex-1 items-center"><TaskTitleLoading /></span>
          ) : (
            <span className={`min-w-0 flex-1 truncate ${titleReveal}`}>{session.title}</span>
          )}
          <SessionWorktreeMarks
            session={session}
            worktreeAction={worktreeAction}
            pullRequests={pullRequests}
            onPullRequestsOpenChange={setPullRequestsOpen}
          />
          <span className="flex-shrink-0 text-[12px] tabular-nums text-[var(--text-muted)]" data-task-age>
            {formatAge(session.updatedAt, Math.max(now, session.updatedAt))}
          </span>
        </div>
      }
    />
  );
});
