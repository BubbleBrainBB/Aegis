// A session the agent started because the user asked (start_session): one
// row in the turn that started it, with its project and where it stands; the
// row opens it, and rows of one batch read as one card (.sub-session-row). Its
// result comes back to this conversation on its own.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { FollowUpProposalView } from '../../../shared/follow-up';
import type { GitPullRequestSummary } from '../../../shared/types';
import type { SessionView } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { findProposalForToolUse, useFollowUpStore } from '../../store/useFollowUpStore';
import { useSessionOrganization } from '../../store/useSessionOrganizationStore';
import { primaryPullRequest, useSidebarPullRequestStore } from '../../store/useSidebarPullRequests';
import { cn } from '../../utils/cn';
import { deriveSidebarSessionState } from '../../utils/sidebar-view';
import { AlertTriangle, ChevronRight, LoaderCircle } from '../icons';
import { PULL_REQUEST_STATUS, pullRequestStatus } from '../pull-request-status';

function proposalIdFromResult(resultText: string | null): string | null {
  if (!resultText) return null;
  try {
    const parsed = JSON.parse(resultText) as { proposalId?: unknown };
    return typeof parsed.proposalId === 'string' ? parsed.proposalId : null;
  } catch {
    return null;
  }
}

function inputTitle(input: unknown): string | null {
  const title = (input as { title?: unknown } | null)?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}

export function SubSessionCard({
  toolUseId,
  input,
  resultText,
  failed,
}: {
  toolUseId: string;
  input: unknown;
  resultText: string | null;
  failed: boolean;
}) {
  const proposal = useFollowUpStore((state) => findProposalForToolUse(state.proposals, toolUseId, proposalIdFromResult(resultText)));
  const loaded = useFollowUpStore((state) => state.loaded);
  useEffect(() => {
    if (!loaded) void useFollowUpStore.getState().load();
  }, [loaded]);

  if (failed && proposal?.status !== 'start_failed') {
    return (
      <div className="my-1 flex items-start gap-1.5 text-[12px] text-[var(--text-muted)]">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <span className="min-w-0">Session not started{resultText ? `: ${resultText}` : '.'}</span>
      </div>
    );
  }
  if (!proposal) {
    return (
      <div className="my-1 flex items-center gap-1.5 text-[12px] text-[var(--text-muted)]">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        <span className="min-w-0 truncate">Starting a session{inputTitle(input) ? `: ${inputTitle(input)}` : '…'}</span>
      </div>
    );
  }
  return <SessionRow proposal={proposal} />;
}

/** Finished work with nothing left to look at has no mark. */
type Tone = 'none' | 'working' | 'warning' | 'danger' | 'review';

const DOT: Record<'warning' | 'danger' | 'review', string> = {
  warning: 'bg-[var(--warning)]',
  danger: 'bg-[var(--error)]',
  review: 'bg-[var(--accent)]',
};

function folderName(path: string | null | undefined): string {
  return path?.split('/').filter(Boolean).pop() ?? '';
}

/** How the task is doing, from its own status, what it last reported and its PR. */
function sessionState(
  proposal: FollowUpProposalView,
  child: SessionView | undefined,
  context: { unread?: boolean; pullRequest: GitPullRequestSummary | null },
): { tone: Tone; label: string } {
  if (proposal.status === 'starting') return { tone: 'working', label: 'Starting' };
  if (proposal.status === 'start_failed') return { tone: 'danger', label: 'Could not start' };
  if (proposal.detachedAt !== null) return { tone: 'none', label: 'Detached' };
  const latest = proposal.reports.at(-1);
  if (child && child.status !== 'running' && child.permissionRequests.length === 0) {
    if (latest?.turnStatus === 'error' || child.status === 'error') return { tone: 'danger', label: 'Failed' };
    if (latest?.turnStatus === 'stopped') return { tone: 'none', label: 'Stopped' };
  }
  const state = child ? deriveSidebarSessionState(child, context) : 'completed';
  if (state === 'needs-input') return { tone: 'warning', label: 'Needs input' };
  if (state === 'running') return { tone: 'working', label: 'Running' };
  const { pullRequest } = context;
  const label = pullRequest ? `#${pullRequest.number} ${PULL_REQUEST_STATUS[pullRequestStatus(pullRequest)].label}` : state === 'review' ? 'Ready for review' : 'Done';
  return { tone: state === 'review' ? 'review' : 'none', label };
}

/** One row per task: mark, title, project, where it stands. The whole row opens the session. */
function SessionRow({ proposal }: { proposal: FollowUpProposalView }) {
  const [busy, setBusy] = useState(false);
  const child = useAppStore((state) => (proposal.childSessionId ? state.sessions[proposal.childSessionId] : undefined));
  const unread = useSessionOrganization().sessions[proposal.childSessionId ?? '']?.unread;
  const pullRequest = useSidebarPullRequestStore((state) => primaryPullRequest(state.bySession[proposal.childSessionId ?? '']));
  const state = sessionState(proposal, child, { unread, pullRequest });
  const where = proposal.place === 'shared' ? 'Shares this folder' : proposal.place === 'project' ? 'Works in the project folder' : proposal.worktreeBranch ?? 'Own worktree';
  // A conversation with no project has no project to name.
  const project = child
    ? child.isChat ? '' : folderName(child.projectCwd || child.cwd)
    : proposal.place === 'shared' ? '' : folderName(proposal.projectCwd);

  const open = () => {
    if (proposal.childSessionId) useAppStore.getState().setActiveSession(proposal.childSessionId);
  };
  const retry = async () => {
    setBusy(true);
    try {
      const result = await useFollowUpStore.getState().act({ proposalId: proposal.id, revision: proposal.revision, kind: 'retry' });
      if (!result.ok && result.error) toast.error(result.error);
    } finally {
      setBusy(false);
    }
  };

  const StatusIcon = pullRequest && state.label.startsWith('#') ? PULL_REQUEST_STATUS[pullRequestStatus(pullRequest)] : null;
  const mark = (
    <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center" data-sub-session-mark={state.tone}>
      {state.tone === 'working' ? (
        <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />
      ) : state.tone !== 'none' ? (
        <span className={cn('h-2 w-2 rounded-full', DOT[state.tone])} />
      ) : null}
    </span>
  );
  const details = (
    <>
      <span className="w-[116px] flex-shrink-0 truncate text-[12.5px] text-[var(--text-muted)]" data-sub-session-project>{project}</span>
      <span
        className={cn(
          'flex w-[104px] flex-shrink-0 items-center gap-1 truncate text-[12.5px]',
          state.tone === 'warning' ? 'font-medium text-[var(--warning)]' : state.tone === 'danger' ? 'text-[var(--error)]' : 'text-[var(--text-secondary)]',
        )}
        data-sub-session-state
      >
        {StatusIcon ? <StatusIcon.Icon className={cn('h-3.5 w-3.5 flex-shrink-0', StatusIcon.className)} aria-hidden="true" /> : null}
        <span className="min-w-0 truncate">{state.label}</span>
      </span>
    </>
  );

  if (proposal.status === 'start_failed' || !proposal.childSessionId) {
    return (
      <div className="sub-session-row" data-sub-session={proposal.id} title={`${state.label} · ${where}`}>
        {mark}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14px] text-[var(--text-primary)]">{proposal.title}</span>
          {proposal.lastError ? <span className="text-[12px] leading-4 text-[var(--error)]">{proposal.lastError}</span> : null}
        </span>
        {proposal.status === 'start_failed' ? (
          <button
            type="button"
            className="flex-shrink-0 text-[12.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
            disabled={busy}
            onClick={() => void retry()}
          >
            Retry
          </button>
        ) : details}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="sub-session-row group text-left transition-colors hover:bg-[var(--sidebar-item-hover)]"
      onClick={open}
      title={`${state.label} · ${where}`}
      aria-label={`${proposal.title} · ${project ? `${project} · ` : ''}${state.label}`}
      data-sub-session={proposal.id}
    >
      {mark}
      <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--text-primary)]">{proposal.title}</span>
      {details}
      <ChevronRight className="h-4 w-4 flex-shrink-0 text-[var(--text-muted)] transition-colors group-hover:text-[var(--text-secondary)]" />
    </button>
  );
}
