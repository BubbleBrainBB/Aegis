// A session the agent started because the user asked (start_session): one
// row in the turn that started it, the task and a status mark; the row opens
// it. Its result comes back to this conversation on its own.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { FollowUpProposalView } from '../../../shared/follow-up';
import { useAppStore } from '../../store/useAppStore';
import { findProposalForToolUse, useFollowUpStore } from '../../store/useFollowUpStore';
import { cn } from '../../utils/cn';
import { AlertTriangle, ChevronRight, LoaderCircle } from '../icons';

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

/** Only unfinished work gets a mark: a pulsing accent dot while it runs, amber when it needs you, red when it failed. */
type Tone = 'none' | 'working' | 'warning' | 'danger';

const DOT: Record<Exclude<Tone, 'none'>, string> = {
  working: 'animate-pulse bg-[var(--accent)]',
  warning: 'bg-[var(--warning)]',
  danger: 'bg-[var(--error)]',
};

/** How the session is doing, from its own status and what it last reported. */
function sessionState(
  proposal: FollowUpProposalView,
  child: { status: string; permissionRequests?: unknown[] } | undefined,
): { tone: Tone; label: string } {
  if (proposal.status === 'starting') return { tone: 'working', label: 'Starting' };
  if (proposal.status === 'start_failed') return { tone: 'danger', label: 'Could not start' };
  if (proposal.detachedAt !== null) return { tone: 'none', label: 'Detached' };
  if (child?.permissionRequests?.length) return { tone: 'warning', label: 'Needs you' };
  if (child?.status === 'running') return { tone: 'working', label: 'Running' };
  const latest = proposal.reports.at(-1);
  if (latest?.turnStatus === 'error' || child?.status === 'error') return { tone: 'danger', label: 'Failed' };
  if (latest?.turnStatus === 'stopped') return { tone: 'none', label: 'Stopped' };
  return { tone: 'none', label: 'Done' };
}

/** One quiet row: the task, a status mark, and the whole row opens the session. */
function SessionRow({ proposal }: { proposal: FollowUpProposalView }) {
  const [busy, setBusy] = useState(false);
  const child = useAppStore((state) => (proposal.childSessionId ? state.sessions[proposal.childSessionId] : undefined));
  const state = sessionState(proposal, child);
  const where = proposal.place === 'shared' ? 'Shares this folder' : proposal.worktreeBranch ?? 'Own worktree';

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

  const mark = state.tone === 'none' ? null : (
    <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', DOT[state.tone])} data-sub-session-mark={state.tone} />
  );

  if (proposal.status === 'start_failed' || !proposal.childSessionId) {
    return (
      <div
        className="my-2 flex w-full max-w-[560px] items-center gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--bg-primary)] py-2.5 pl-4 pr-3"
        data-sub-session={proposal.id}
        title={`${state.label} · ${where}`}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14px] text-[var(--text-primary)]">{proposal.title}</span>
          {proposal.lastError ? <span className="text-[12px] leading-4 text-[var(--error)]">{proposal.lastError}</span> : null}
        </span>
        {mark}
        {proposal.status === 'start_failed' ? (
          <button
            type="button"
            className="flex-shrink-0 text-[12.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
            disabled={busy}
            onClick={() => void retry()}
          >
            Retry
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="group my-2 flex w-full max-w-[560px] items-center gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--bg-primary)] py-2.5 pl-4 pr-3 text-left transition-colors hover:bg-[var(--sidebar-item-hover)]"
      onClick={open}
      title={`${state.label} · ${where}`}
      aria-label={`${proposal.title} · ${state.label}`}
      data-sub-session={proposal.id}
    >
      <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--text-primary)]">{proposal.title}</span>
      {mark}
      <ChevronRight className="h-4 w-4 flex-shrink-0 text-[var(--text-muted)] transition-colors group-hover:text-[var(--text-secondary)]" />
    </button>
  );
}
