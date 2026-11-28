import type { SessionOrganizationSnapshot } from '../../shared/session-organization';
import type { GitPullRequestSummary } from '../../shared/types';
import { useAppStore } from '../store/useAppStore';
import { useSessionOrganizationStore } from '../store/useSessionOrganizationStore';
import { isWorktreeSettled, primaryPullRequest } from '../store/useSidebarPullRequests';
import type { SessionView } from '../types';
import { deriveSidebarSessionState, type SidebarSessionState } from './sidebar-view';

export type SettledWorktrees = Parameters<typeof isWorktreeSettled>[1];

/** Everything a task's state is worked out from, besides the task itself. */
export interface TaskStateSources {
  organization: Pick<SessionOrganizationSnapshot, 'sessions'>;
  prsBySession: Record<string, GitPullRequestSummary[] | null | undefined>;
  worktrees: SettledWorktrees;
  /** Tasks with a workflow of theirs still going (useWorkflowRunningSessions). */
  workflowSessions: ReadonlySet<string>;
  /** Tasks with a workflow of theirs that waits to be started (useWorkflowWaitingSessions). */
  workflowWaiting: ReadonlySet<string>;
}

/** Where a task stands, as the sidebar and My Tasks show it. */
export function taskStateOf(session: SessionView, sources: TaskStateSources): SidebarSessionState | null {
  return deriveSidebarSessionState(session, {
    unread: sources.organization.sessions[session.id]?.unread,
    pullRequest: primaryPullRequest(sources.prsBySession[session.id]),
    worktreeSettled: isWorktreeSettled(session, sources.worktrees),
    keptOpen: sources.organization.sessions[session.id]?.keptOpen,
    workflowRunning: sources.workflowSessions.has(session.id),
    workflowWaiting: sources.workflowWaiting.has(session.id),
    manualStatus: sources.organization.sessions[session.id]?.manualStatus,
  });
}

/** Where it would stand without a status set by hand: picking that one clears the hand-set status. */
export function naturalTaskStateOf(session: SessionView, sources: TaskStateSources): SidebarSessionState | null {
  return deriveSidebarSessionState(session, {
    unread: sources.organization.sessions[session.id]?.unread,
    pullRequest: primaryPullRequest(sources.prsBySession[session.id]),
    worktreeSettled: isWorktreeSettled(session, sources.worktrees),
    keptOpen: sources.organization.sessions[session.id]?.keptOpen,
    workflowRunning: sources.workflowSessions.has(session.id),
    workflowWaiting: sources.workflowWaiting.has(session.id),
  });
}

/**
 * Opens a task next to the conversation that names it, as a tab of the right
 * panel; with ⌘ or Ctrl held, as the full task instead.
 */
export function openTaskBeside(sessionId: string, event?: { metaKey: boolean; ctrlKey: boolean }) {
  if (event?.metaKey || event?.ctrlKey) {
    openTask(sessionId);
    return;
  }
  useAppStore.getState().openTaskPanel(sessionId);
}

/** Opens a task's chat from a list. */
export function openTask(sessionId: string) {
  const app = useAppStore.getState();
  if (app.showSettings) app.setShowSettings(false);
  const needsSessionActivation =
    app.activeSessionId !== sessionId ||
    app.activeWorkspace !== 'chat' ||
    app.showNewSession ||
    Boolean(useSessionOrganizationStore.getState().sessions[sessionId]?.unread) ||
    Boolean(app.sessions[sessionId]?.runtimeNotice);
  if (needsSessionActivation) {
    app.setActiveSession(sessionId);
  }
  const next = useAppStore.getState();
  if (next.showNewSession) next.setShowNewSession(false);
  if (next.activeWorkspace !== 'chat') next.setActiveWorkspace('chat');
  if (next.chatSidebarView !== 'threads') next.setChatSidebarView('threads');
}
