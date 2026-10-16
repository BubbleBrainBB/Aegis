// A follow-up task an agent proposed (propose_follow_up), drawn at the end of
// the turn that proposed it: the user decides here whether it runs in its own
// session and worktree, in this conversation, or not at all. Agent-written
// text renders as Markdown (no raw HTML).

import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { FollowUpActionKind, FollowUpProposalView } from '../../../shared/follow-up';
import { useAppStore } from '../../store/useAppStore';
import { findProposalForToolUse, useFollowUpStore } from '../../store/useFollowUpStore';
import { cn } from '../../utils/cn';
import { AlertTriangle, Check, ChevronRight, GitBranch, Lightbulb, List, LoaderCircle, MessageSquare, Search } from '../icons';
import { StructuredResponse } from '../StructuredResponse';

/** The proposal id the tool returned, when its result is in. */
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

export function FollowUpCard({
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

  if (failed) {
    return (
      <div className="my-1 flex items-start gap-1.5 text-[12px] text-[var(--text-muted)]">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <span className="min-w-0">Follow-up proposal not made{resultText ? `: ${resultText}` : '.'}</span>
      </div>
    );
  }
  if (!proposal) {
    return (
      <div className="my-1 flex items-center gap-1.5 text-[12px] text-[var(--text-muted)]">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        <span className="min-w-0 truncate">Proposing a follow-up task{inputTitle(input) ? `: ${inputTitle(input)}` : '…'}</span>
      </div>
    );
  }
  return <ProposalCard proposal={proposal} />;
}

type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'muted';

const TONE_DOT: Record<Tone, string> = {
  accent: 'bg-[var(--accent)]',
  success: 'bg-[#2f7d4f]',
  warning: 'bg-[#b26a00]',
  danger: 'bg-[#b42318]',
  muted: 'bg-[var(--text-muted)]',
};
const TONE_TEXT: Record<Tone, string> = {
  accent: 'text-[var(--accent)]',
  success: 'text-[#2f7d4f]',
  warning: 'text-[#b26a00]',
  danger: 'text-[#b42318]',
  muted: 'text-[var(--text-muted)]',
};

type Action = { label: string; title?: string; strong?: boolean; disabled?: boolean; onClick: () => void };

const groupButtonClass =
  'h-7 border-0 border-l border-[var(--border)] bg-[var(--bg-primary)] px-2.5 text-[12px] text-[var(--text-secondary)] transition-colors first:border-l-0 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-50';

/**
 * Collapsed: a two-line header (title over a quiet status line) and the
 * actions this step needs as one joined button group. Expanded: the task in
 * labelled sections, the result set apart in its own panel, all as Markdown.
 */
function ProposalCard({ proposal }: { proposal: FollowUpProposalView }) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const parentBusy = useAppStore((state) => state.sessions[proposal.parentSessionId]?.status === 'running');
  const child = useAppStore((state) => (proposal.childSessionId ? state.sessions[proposal.childSessionId] : undefined));
  const latestReport = proposal.reports.at(-1);

  const run = async (work: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    try {
      const result = await work();
      if (!result.ok && result.error) toast.error(result.error);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const perform = (kind: FollowUpActionKind) =>
    run(() => useFollowUpStore.getState().act({ proposalId: proposal.id, revision: proposal.revision, kind }));
  const sendToChat = () => run(() => useFollowUpStore.getState().continueWithReport(proposal.id));
  const openTask = () => {
    if (proposal.childSessionId) useAppStore.getState().setActiveSession(proposal.childSessionId);
  };

  const working = proposal.status === 'starting' || (proposal.status === 'started' && child?.status === 'running');
  let tone: Tone = 'muted';
  let status = '';
  let detail = '';
  let actions: Action[] = [];
  switch (proposal.status) {
    case 'proposed':
      tone = 'accent';
      status = 'Suggested';
      detail = 'runs in a new session on its own branch';
      actions = [
        { label: 'Start', strong: true, disabled: busy, onClick: () => void perform('start') },
        ...(parentBusy ? [] : [{ label: 'Do it here', title: 'Do it in this conversation', disabled: busy, onClick: () => void perform('here') }]),
        { label: 'Dismiss', disabled: busy, onClick: () => void perform('dismiss') },
      ];
      break;
    case 'starting':
      tone = 'muted';
      status = 'Starting';
      detail = 'preparing a worktree';
      break;
    case 'started':
      if (child?.status === 'running') {
        tone = 'warning';
        status = 'Working';
        detail = 'in its own session';
      } else if (latestReport) {
        tone = latestReport.turnStatus === 'completed' ? 'success' : 'danger';
        status = latestReport.turnStatus === 'completed' ? 'Result ready' : latestReport.turnStatus === 'error' ? 'Stopped with an error' : 'Stopped';
        detail = latestReport.deliveredAt !== null
          ? 'sent to this conversation'
          : latestReport.turnStatus !== 'stopped' && parentBusy
            ? 'goes to this conversation when it finishes'
            : '';
      } else {
        tone = 'muted';
        status = 'Started';
      }
      actions = [
        // Results go to this conversation on their own; the button is for one
        // that did not (a stopped turn, or a send that failed).
        ...(latestReport &&
        latestReport.deliveredAt === null &&
        child?.status !== 'running' &&
        (latestReport.turnStatus === 'stopped' || !parentBusy)
          ? [{
              label: 'Send to chat',
              title: parentBusy ? 'Available when this conversation is idle' : 'Send the result to this conversation',
              strong: true,
              disabled: busy || parentBusy,
              onClick: () => void sendToChat(),
            }]
          : []),
        { label: 'Open task', title: 'Open the follow-up session', onClick: openTask },
      ];
      break;
    case 'start_failed':
      tone = 'danger';
      status = 'Could not start';
      detail = proposal.lastError ?? '';
      actions = [
        { label: 'Retry', strong: true, disabled: busy, onClick: () => void perform('retry') },
        { label: 'Dismiss', disabled: busy, onClick: () => void perform('dismiss') },
      ];
      break;
    case 'sent_here':
      status = 'Sent to this conversation';
      break;
    case 'dismissed':
      status = 'Dismissed';
      break;
    case 'withdrawn':
      status = 'Withdrawn';
      detail = 'the agent took it back';
      break;
  }
  const settled = proposal.status === 'dismissed' || proposal.status === 'withdrawn';

  return (
    <div className="my-3 overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-primary)]" data-follow-up={proposal.id}>
      <div className="flex items-center gap-2.5 px-2.5 py-2">
        <button
          type="button"
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide details' : 'Show details'}
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')} />
        </button>
        <div
          className={cn(
            'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[7px]',
            settled ? 'bg-[var(--bg-tertiary)]/60 text-[var(--text-muted)]' : 'bg-[var(--accent-light)] text-[var(--accent)]',
          )}
        >
          <Lightbulb className="h-3.5 w-3.5" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn('truncate text-[13px] font-medium', settled ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-primary)]')}
            title={proposal.title}
          >
            {proposal.title}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-[var(--text-muted)]">
            {working ? <LoaderCircle className="h-3 w-3 flex-shrink-0 animate-spin" /> : <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', TONE_DOT[tone])} />}
            <span className={cn('flex-shrink-0', TONE_TEXT[tone])}>{status}</span>
            {detail ? <span className="min-w-0 truncate">· {detail}</span> : null}
          </span>
        </div>
        {actions.length > 0 ? (
          <div className="inline-flex flex-shrink-0 overflow-hidden rounded-[7px] border border-[var(--border)]">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className={cn(groupButtonClass, action.strong && 'font-medium text-[var(--text-primary)]')}
                disabled={action.disabled}
                title={action.title}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {expanded ? (
        <div className="flex flex-col gap-3.5 border-t border-[var(--border)] px-4 pb-3 pt-3.5">
          <Section icon={<Search className="h-3 w-3" />} label="Found" text={proposal.reason} />
          <Section icon={<List className="h-3 w-3" />} label="Plan" text={proposal.plan} />
          <Section icon={<Check className="h-3 w-3" />} label="Done when" text={proposal.acceptanceCriteria} />
          {latestReport ? (
            <div className="flex flex-col gap-1.5 rounded-lg border border-[color-mix(in_srgb,#2f7d4f_22%,transparent)] bg-[color-mix(in_srgb,#2f7d4f_6%,transparent)] px-3.5 py-3">
              <SectionLabel icon={<MessageSquare className="h-3 w-3" />} label="Result" className="text-[#2f7d4f]">
                <span className="font-normal normal-case tracking-normal text-[var(--text-muted)]">· reported by the follow-up session, not yet checked</span>
              </SectionLabel>
              <Markdown text={latestReport.summary} />
            </div>
          ) : null}
          {proposal.worktreeBranch ? (
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
              <GitBranch className="h-3 w-3 flex-shrink-0" />
              <span className="truncate font-mono">{proposal.worktreeBranch}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SectionLabel({ icon, label, className, children }: { icon: ReactNode; label: string; className?: string; children?: ReactNode }) {
  return (
    <div className={cn('flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]', className)}>
      {icon}
      {label}
      {children}
    </div>
  );
}

function Section({ icon, label, text }: { icon: ReactNode; label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <SectionLabel icon={icon} label={label} />
      <Markdown text={text} />
    </div>
  );
}

/** Agent-written Markdown, rendered by the chat's own renderer (sanitized, no raw HTML). */
function Markdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 overflow-x-auto text-[12.5px] text-[var(--text-secondary)]">
      <StructuredResponse content={text} />
    </div>
  );
}
