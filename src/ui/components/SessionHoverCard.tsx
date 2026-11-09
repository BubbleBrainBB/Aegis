import { toast } from 'sonner';
import { useState, type ReactElement } from 'react';
import { Tooltip as TooltipPrimitive } from '@base-ui-components/react/tooltip';
import { PreviewCard } from '@base-ui-components/react/preview-card';
import { FolderClosed, GitBranch, GitFork, Loader2, Monitor } from './icons';
import { useAppStore } from '../store/useAppStore';
import { findProposalForChild, useFollowUpStore } from '../store/useFollowUpStore';
import { primaryPullRequest } from '../store/useSidebarPullRequests';
import { PULL_REQUEST_STATUS, pullRequestRepo, pullRequestStatus, type PullRequestStatus } from './pull-request-status';
import { formatAge, getProjectLabel } from '../utils/sidebar-view';
import type { GitPullRequestSummary } from '../../shared/types';
import type { SessionView } from '../types';

const SESSION_BRANCH_CACHE_TTL_MS = 30_000;

type SessionBranchCacheEntry = {
  branch: string | null;
  expiresAt: number;
};

const sessionBranchCache = new Map<string, SessionBranchCacheEntry>();
const pendingSessionBranchRequests = new Map<string, Promise<string | null>>();

export const WORKTREE_ACTION_LABELS = {
  move: 'Moving into a new worktree…',
  apply: 'Squash-merging changes back…',
  discard: 'Removing worktree…',
} as const;

export function getSessionProjectPath(session: SessionView): string | null {
  return session.projectCwd?.trim() || session.cwd?.trim() || null;
}

function getSessionBranchCwd(session: SessionView): string | null {
  return session.worktreePath?.trim() || session.cwd?.trim() || session.projectCwd?.trim() || null;
}

async function readSessionBranch(cwd: string): Promise<string | null> {
  const cached = sessionBranchCache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.branch;
  }

  const pending = pendingSessionBranchRequests.get(cwd);
  if (pending) return pending;

  const request = window.electron
    .getGitBranch(cwd)
    .then((result) => (result.ok ? result.branch?.trim() || null : null))
    .catch(() => null)
    .then((branch) => {
      sessionBranchCache.set(cwd, {
        branch,
        expiresAt: Date.now() + SESSION_BRANCH_CACHE_TTL_MS,
      });
      return branch;
    })
    .finally(() => {
      pendingSessionBranchRequests.delete(cwd);
    });

  pendingSessionBranchRequests.set(cwd, request);
  return request;
}

function pullRequestsLabel(pullRequests: GitPullRequestSummary[]): string {
  if (pullRequests.length === 1) {
    return `Pull request #${pullRequests[0].number} · ${PULL_REQUEST_STATUS[pullRequestStatus(pullRequests[0])].label}`;
  }
  const counts = new Map<PullRequestStatus, number>();
  for (const pr of pullRequests) counts.set(pullRequestStatus(pr), (counts.get(pullRequestStatus(pr)) ?? 0) + 1);
  const parts = (['open', 'draft', 'merged', 'closed'] as const)
    .filter((status) => counts.has(status))
    .map((status) => `${counts.get(status)} ${PULL_REQUEST_STATUS[status].label.toLowerCase()}`);
  return `${pullRequests.length} pull requests · ${parts.join(', ')}`;
}

/**
 * The row's PR glyph: the status of the PR that speaks for the session, a
 * count when there are several, and on hover every PR the session opened.
 */
function SessionPullRequestsGlyph({
  pullRequests,
  onOpenChange,
}: {
  pullRequests: GitPullRequestSummary[];
  onOpenChange: (open: boolean) => void;
}) {
  const primary = primaryPullRequest(pullRequests)!;
  const meta = PULL_REQUEST_STATUS[pullRequestStatus(primary)];
  const label = pullRequestsLabel(pullRequests);
  return (
    <PreviewCard.Root onOpenChange={(open) => onOpenChange(open)}>
      <PreviewCard.Trigger
        delay={200}
        closeDelay={150}
        render={
          <span
            className={`flex flex-shrink-0 items-center gap-0.5 ${meta.className}`}
            aria-label={label}
            data-pull-request-count={pullRequests.length}
          >
            <meta.Icon className="h-3.5 w-3.5" aria-hidden="true" />
            {pullRequests.length > 1 ? (
              <span className="text-[11px] tabular-nums leading-none">{pullRequests.length}</span>
            ) : null}
          </span>
        }
      />
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="right" align="start" sideOffset={8} collisionPadding={12} className="z-[95]">
          <PreviewCard.Popup
            className="w-[320px] max-h-[360px] overflow-y-auto rounded-[var(--popover-radius)] border border-[var(--popover-border)] bg-[var(--popover-bg)] p-1 text-left shadow-[var(--popover-shadow-lg)] outline-none transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
            aria-label={label}
          >
            {pullRequests.map((pr) => {
              const status = PULL_REQUEST_STATUS[pullRequestStatus(pr)];
              return (
                <button
                  key={pr.url}
                  type="button"
                  className="block w-full rounded-md px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)]"
                  title={pr.url}
                  onClick={(event) => {
                    event.stopPropagation();
                    void window.electron.openExternalUrl(pr.url).then((result) => {
                      if (!result.ok) toast.error(result.message || 'Failed to open pull request.');
                    });
                  }}
                >
                  <div className="truncate text-[13px] leading-5 text-[var(--text-primary)]">{pr.title}</div>
                  <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-[var(--text-muted)]">
                    <span className={`flex flex-shrink-0 items-center gap-1 ${status.className}`}>
                      <status.Icon className="h-3 w-3" aria-hidden="true" />
                      {status.label}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="min-w-0 truncate">{pullRequestRepo(pr.url)}</span>
                    <span className="flex-shrink-0 tabular-nums">#{pr.number}</span>
                    {pr.additions !== undefined && pr.deletions !== undefined ? (
                      <span className="flex-shrink-0 tabular-nums">
                        <span className="text-[var(--success)]">+{pr.additions}</span>{' '}
                        <span className="text-[var(--error)]">−{pr.deletions}</span>
                      </span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

/**
 * A task row's git marks: a spinner while its worktree moves, then its PRs,
 * or the branch glyph while it runs on an isolated branch with none.
 */
export function SessionWorktreeMarks({
  session,
  worktreeAction,
  pullRequests,
  onPullRequestsOpenChange,
}: {
  session: SessionView;
  worktreeAction: keyof typeof WORKTREE_ACTION_LABELS | null;
  pullRequests?: GitPullRequestSummary[] | null;
  onPullRequestsOpenChange: (open: boolean) => void;
}) {
  return (
    <>
      {worktreeAction ? (
        <span className="flex-shrink-0" title={WORKTREE_ACTION_LABELS[worktreeAction]}>
          <Loader2
            className="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]"
            aria-label={WORKTREE_ACTION_LABELS[worktreeAction]}
          />
        </span>
      ) : null}
      {pullRequests?.length ? (
        <SessionPullRequestsGlyph pullRequests={pullRequests} onOpenChange={onPullRequestsOpenChange} />
      ) : session.envMode === 'worktree' && session.worktreePath ? (
        <span
          className="flex-shrink-0"
          title={`Runs on an isolated branch${session.associatedWorktreeBranch ? ` · ${session.associatedWorktreeBranch}` : ''}`}
        >
          <GitBranch className="h-3.5 w-3.5 text-[var(--accent)]" aria-label="Runs on an isolated branch" />
        </span>
      ) : null}
    </>
  );
}

/**
 * The card that shows when the pointer rests on a task row: its full title,
 * age, device, project, branch and where it came from. `trigger` is the row.
 */
export function SessionHoverCard({
  session,
  disabled,
  side,
  sideOffset,
  trigger,
}: {
  session: SessionView;
  disabled: boolean;
  side: 'bottom' | 'right';
  sideOffset: number;
  trigger: ReactElement<Record<string, unknown>>;
}) {
  // A follow-up or sub-session names the conversation it came from (also when it is listed apart from it).
  const followUpParentId = useFollowUpStore(s => findProposalForChild(s.proposals, session.id)?.parentSessionId ?? null);
  const startedBySession = useFollowUpStore(s => findProposalForChild(s.proposals, session.id)?.kind === 'session');
  const followUpParentTitle = useAppStore(s => (followUpParentId ? s.sessions[followUpParentId]?.title : undefined));
  const [branchLookup, setBranchLookup] = useState<{
    cwd: string;
    branch: string | null;
    loading: boolean;
    expiresAt: number;
  } | null>(null);
  const inWorktree = session.envMode === 'worktree' && Boolean(session.worktreePath);
  const projectPath = getSessionProjectPath(session);
  const projectLabel = session.isChat ? 'No project' : projectPath ? getProjectLabel(projectPath) : 'No Project';
  // A chat's folder has no branch to look up.
  const branchCwd = session.isChat ? null : getSessionBranchCwd(session);
  const storedWorktreeBranch = session.associatedWorktreeBranch?.trim() || null;
  const lookedUpBranch = branchLookup?.cwd === branchCwd ? branchLookup.branch : null;
  const branch = storedWorktreeBranch || lookedUpBranch;
  const branchLoading = Boolean(
    !storedWorktreeBranch &&
      branchCwd &&
      branchLookup?.cwd === branchCwd &&
      branchLookup.loading
  );
  const handleOpenChange = (open: boolean) => {
    if (!open || storedWorktreeBranch || !branchCwd) return;
    if (
      branchLookup?.cwd === branchCwd &&
      (branchLookup.loading || branchLookup.expiresAt > Date.now())
    ) {
      return;
    }

    const cached = sessionBranchCache.get(branchCwd);
    if (cached && cached.expiresAt > Date.now()) {
      setBranchLookup({
        cwd: branchCwd,
        branch: cached.branch,
        loading: false,
        expiresAt: cached.expiresAt,
      });
      return;
    }

    setBranchLookup({ cwd: branchCwd, branch: null, loading: true, expiresAt: 0 });
    void readSessionBranch(branchCwd).then((nextBranch) => {
      setBranchLookup({
        cwd: branchCwd,
        branch: nextBranch,
        loading: false,
        expiresAt: sessionBranchCache.get(branchCwd)?.expiresAt ?? Date.now(),
      });
    });
  };

  return (
    <TooltipPrimitive.Root disableHoverablePopup disabled={disabled} onOpenChange={handleOpenChange}>
      <TooltipPrimitive.Trigger delay={420} closeDelay={80} render={trigger} />

      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          side={side}
          align="start"
          sideOffset={sideOffset}
          collisionPadding={12}
          className="z-[90]"
        >
          <TooltipPrimitive.Popup data-session-hover-card className="w-max min-w-[224px] max-w-[min(400px,calc(100vw-24px))] rounded-[var(--popover-radius)] border border-[var(--popover-border)] bg-[var(--popover-bg)] px-3 py-2.5 text-left text-[12px] text-[var(--text-secondary)] shadow-[var(--popover-shadow-lg)] outline-none transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
            <div className="flex min-w-0 items-baseline gap-3">
              <div className="line-clamp-3 min-w-0 flex-1 break-words text-[13px] font-medium leading-5 text-[var(--text-primary)]">
                {session.title}
              </div>
              <div className="flex-shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">
                {formatAge(session.updatedAt)}
              </div>
            </div>

            <div className="mt-2 space-y-1.5 leading-[18px]">
              {session.device ? (
                <div className="flex min-w-0 items-start gap-2 text-[var(--text-primary)]">
                  <Monitor className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
                  <span className="min-w-0 flex-1 break-words">{session.device.name}</span>
                </div>
              ) : null}
              <div className="flex min-w-0 items-start gap-2" title={session.device ? undefined : projectPath || undefined}>
                <FolderClosed className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
                <span className="min-w-0 flex-1 break-words">{projectLabel}</span>
              </div>
              {branch || branchLoading ? (
                <div className="flex min-w-0 items-start gap-2">
                  <GitBranch
                    className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${inWorktree ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}
                  />
                  <span className={`min-w-0 flex-1 break-all ${branchLoading ? 'text-[var(--text-muted)]' : ''}`}>
                    {branchLoading ? 'Checking branch…' : branch}
                  </span>
                </div>
              ) : null}
              {followUpParentId ? (
                <div className="flex min-w-0 items-start gap-2">
                  <GitFork className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" />
                  <span className="min-w-0 flex-1 break-words">
                    {startedBySession ? 'Started from' : 'Follow-up from'} {followUpParentTitle ? `“${followUpParentTitle}”` : 'another conversation'}
                  </span>
                </div>
              ) : null}
            </div>
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
