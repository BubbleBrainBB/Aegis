import { toast } from 'sonner';
import { Check, Loader2 } from './icons';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { changeSessionOrganization, useSessionOrganizationStore } from '../store/useSessionOrganizationStore';
import { SIDEBAR_STATE_LABELS, SIDEBAR_STATE_ORDER, type SidebarSessionState } from '../utils/sidebar-view';
import type { ManualTaskStatus } from '../../shared/session-organization';
import type { SessionView } from '../types';

/** Where a task stands: red or amber while it wants something, half green until reviewed, then a green check. */
export function TaskStateIcon({ state, failed }: { state: SidebarSessionState | null; failed: boolean }) {
  if (state === 'running') {
    return <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-[var(--text-muted)]" role="img" aria-label="Running" />;
  }
  if (state === 'review') {
    return (
      <svg viewBox="0 0 16 16" className="h-4 w-4 flex-shrink-0" role="img" aria-label={SIDEBAR_STATE_LABELS.review} data-task-icon="half">
        <circle cx="8" cy="8" r="5.75" fill="none" stroke="var(--success)" strokeWidth="1.5" />
        <path d="M8 2.25a5.75 5.75 0 0 1 0 11.5z" fill="var(--success)" />
      </svg>
    );
  }
  const fill = failed
    ? 'var(--error)'
    : state === 'needs-input'
      ? 'var(--warning)'
      : 'var(--success)';
  const label = failed ? 'Failed' : state ? SIDEBAR_STATE_LABELS[state] : 'Draft';
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 flex-shrink-0" role="img" aria-label={label}>
      <circle cx="8" cy="8" r="6.5" fill={fill} />
      {failed ? (
        <path d="M5.75 5.75l4.5 4.5m0-4.5l-4.5 4.5" fill="none" stroke="var(--bg-primary)" strokeWidth="1.5" strokeLinecap="round" />
      ) : state === 'needs-input' ? (
        <path d="M8 4.75v3.75m0 2.75v.01" fill="none" stroke="var(--bg-primary)" strokeWidth="1.5" strokeLinecap="round" />
      ) : (
        <path d="M5 8.25l2.1 2.1L11 6.1" fill="none" stroke="var(--bg-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

/**
 * A task's state icon that opens Change status: the agent sets Needs input and
 * Running, you can move a task to Ready for review or Completed. Picking the
 * state the task would have anyway clears the hand-set one.
 */
export function TaskStatusMenu({
  session,
  state,
  naturalState,
  failed,
}: {
  session: SessionView;
  state: SidebarSessionState | null;
  /** The state without a hand-set one. */
  naturalState: SidebarSessionState | null;
  failed: boolean;
}) {
  // A running task, one asking for an approval mid-turn, a draft and a task
  // on another Mac keep the state they report.
  const enabled =
    Boolean(state) && state !== 'running' && session.permissionRequests.length === 0 && !session.device && !session.isDraft;
  const manualStatus = useSessionOrganizationStore((s) => s.sessions[session.id]?.manualStatus ?? null);
  const icon = <TaskStateIcon state={state} failed={failed} />;
  if (!enabled) return icon;

  const pick = (status: ManualTaskStatus) => {
    // The task's own state needs no hand-set one, even when they agree now
    // (an open PR put it back in review): clearing it lets the next change through.
    const next = status === naturalState ? null : status;
    if (next === manualStatus) return;
    void changeSessionOrganization({ kind: 'status', sessionId: session.id, status: next })
      .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="no-drag -m-1 flex flex-shrink-0 items-center justify-center rounded-md p-1 transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)]"
            aria-label={`Change status: ${failed ? 'Failed' : SIDEBAR_STATE_LABELS[state!]}`}
            title="Change status"
            data-task-status-trigger
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        {icon}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="w-[240px] p-1.5"
        onClick={(event) => event.stopPropagation()}
        data-task-status-menu
      >
        <div className="-mx-1.5 -mt-1.5 mb-1 flex h-8 items-center border-b border-[var(--border)] px-3.5 text-[13px] text-[var(--text-muted)]">
          Change status…
        </div>
        {SIDEBAR_STATE_ORDER.map((option) => {
          const selectable = option === 'review' || option === 'completed';
          return (
            <DropdownMenuItem
              key={option}
              disabled={!selectable}
              onSelect={selectable ? () => pick(option) : undefined}
              className="gap-2 rounded-md px-2 py-1.5 text-[13px]"
              data-task-status-option={option}
            >
              <TaskStateIcon state={option} failed={false} />
              <span className="min-w-0 flex-1 truncate">{SIDEBAR_STATE_LABELS[option]}</span>
              {option === state && <Check className="h-3.5 w-3.5" aria-label="Current" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
