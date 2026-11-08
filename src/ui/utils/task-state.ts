import type { SessionOrganizationSnapshot } from '../../shared/session-organization';
import type { GitPullRequestSummary } from '../../shared/types';
import { useAppStore } from '../store/useAppStore';
import { isWorktreeSettled, primaryPullRequest } from '../store/useSidebarPullRequests';
import type { SessionView } from '../types';
import { deriveSidebarSessionState, type SidebarSessionState } from './sidebar-view';

export type SettledWorktrees = Parameters<typeof isWorktreeSettled>[1];

/** Everything a task's state is worked out from, besides the task itself. */
export interface TaskStateSources {
  organization: Pick<SessionOrganizationSnapshot, 'sessions'>;
  prsBySession: Record<string, GitPullRequestSummary[] | null | undefined>;
  worktrees: SettledWorktrees;
}

/** Where a task stands, as the sidebar and My Tasks show it. */
export function taskStateOf(session: SessionView, sources: TaskStateSources): SidebarSessionState | null {
  return deriveSidebarSessionState(session, {
    unread: sources.organization.sessions[session.id]?.unread,
    pullRequest: primaryPullRequest(sources.prsBySession[session.id]),
    worktreeSettled: isWorktreeSettled(session, sources.worktrees),
    manualStatus: sources.organization.sessions[session.id]?.manualStatus,
  });
}

/** Where it would stand without a status set by hand: picking that one clears the hand-set status. */
export function naturalTaskStateOf(session: SessionView, sources: TaskStateSources): SidebarSessionState | null {
  return deriveSidebarSessionState(session, {
    unread: sources.organization.sessions[session.id]?.unread,
    pullRequest: primaryPullRequest(sources.prsBySession[session.id]),
    worktreeSettled: isWorktreeSettled(session, sources.worktrees),
  });
}

/** Opens a task's chat from a list. */
export function openTask(sessionId: string) {
  const app = useAppStore.getState();
  app.setShowSettings(false);
  app.setActiveSession(sessionId);
  app.setShowNewSession(false);
  app.setActiveWorkspace('chat');
  app.setChatSidebarView('threads');
}
