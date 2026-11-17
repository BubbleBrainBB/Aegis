import { useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useSessionOrganization } from '../store/useSessionOrganizationStore';
import { useSidebarPullRequests, useSidebarPullRequestStore } from '../store/useSidebarPullRequests';
import { useWorkflowRunningSessions } from '../store/useWorkflowStore';
import { SIDEBAR_STATE_LABELS, taskAttention, type SidebarSessionState } from '../utils/sidebar-view';
import { taskStateOf, type TaskStateSources } from '../utils/task-state';
import type { SessionView } from '../types';

/** What a task's state is worked out from, kept current: the facts the sidebar and My Tasks read. */
export function useTaskStateSources(): TaskStateSources {
  const organization = useSessionOrganization();
  const prsBySession = useSidebarPullRequests(true);
  const settledWorktrees = useSidebarPullRequestStore((s) => s.settledWorktrees);
  const settledCheckedAt = useSidebarPullRequestStore((s) => s.settledCheckedAt);
  const workflowSessions = useWorkflowRunningSessions();
  return useMemo<TaskStateSources>(
    () => ({ organization, prsBySession, worktrees: { settledWorktrees, settledCheckedAt }, workflowSessions }),
    [organization, prsBySession, settledWorktrees, settledCheckedAt, workflowSessions]
  );
}

export interface TaskStanding {
  /** Undefined when the task is not known here (deleted, or not loaded yet). */
  session: SessionView | undefined;
  state: SidebarSessionState | null;
  failed: boolean;
  /** The state in words, as My Tasks names it. */
  label: string;
}

/** How one task stands now, with the icon state and words the sidebar and My Tasks use for it. */
export function useTaskStanding(sessionId: string | null | undefined): TaskStanding {
  const session = useAppStore((s) => (sessionId ? s.sessions[sessionId] : undefined));
  const sources = useTaskStateSources();
  return useMemo(() => {
    const state = session ? taskStateOf(session, sources) : null;
    const failed = Boolean(session) && state === 'needs-input' && taskAttention(session!)?.tone === 'error';
    const label = failed ? 'Failed' : state ? SIDEBAR_STATE_LABELS[state] : 'Started';
    return { session, state, failed, label };
  }, [session, sources]);
}
