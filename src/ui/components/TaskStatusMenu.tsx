import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { toast } from 'sonner';
import { Check, Loader2 } from './icons';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { changeSessionOrganization, useSessionOrganizationStore } from '../store/useSessionOrganizationStore';
import { shortcutBlocked } from '../hooks/useKeyboardShortcuts';
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

/** The states you can pick, by the number key that picks them; the agent sets the others. */
const PICKABLE: readonly ManualTaskStatus[] = ['review', 'completed'];

// S opens the menu of the row under the pointer, or of the focused row.
const openers = new Map<HTMLElement, () => void>();
let hoveredRow: HTMLElement | null = null;
let listening = false;

function listenForShortcut() {
  if (listening) return;
  listening = true;
  window.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() !== 's' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (shortcutBlocked(event)) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    const focused = (document.activeElement as HTMLElement | null)?.closest?.('[data-task-status-row]') as HTMLElement | null;
    const row = focused && openers.has(focused) ? focused : hoveredRow;
    const open = row ? openers.get(row) : undefined;
    if (!open) return;
    event.preventDefault();
    open();
  });
}

// One registration per row while the menu is available; the latest opener is
// read through a ref, so re-renders do not drop the row the pointer rests on.
function useStatusShortcut(rowRef: RefObject<HTMLElement | null>, enabled: boolean, open: () => void) {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const row = rowRef.current;
    if (!row || !enabled) return;
    listenForShortcut();
    openers.set(row, () => openRef.current());
    row.dataset.taskStatusRow = '';
    const enter = () => { hoveredRow = row; };
    const leave = () => { if (hoveredRow === row) hoveredRow = null; };
    if (row.matches(':hover')) enter();
    row.addEventListener('mouseenter', enter);
    row.addEventListener('mouseleave', leave);
    return () => {
      openers.delete(row);
      delete row.dataset.taskStatusRow;
      leave();
      row.removeEventListener('mouseenter', enter);
      row.removeEventListener('mouseleave', leave);
    };
  }, [rowRef, enabled]);
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
  rowRef,
}: {
  session: SessionView;
  state: SidebarSessionState | null;
  /** The state without a hand-set one. */
  naturalState: SidebarSessionState | null;
  failed: boolean;
  /** The row S works on while it is hovered or focused. */
  rowRef: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  // A running task, one asking for an approval mid-turn, a draft and a task
  // on another Mac keep the state they report.
  const enabled =
    Boolean(state) && state !== 'running' && session.permissionRequests.length === 0 && !session.device && !session.isDraft;
  const manualStatus = useSessionOrganizationStore((s) => s.sessions[session.id]?.manualStatus ?? null);
  useStatusShortcut(rowRef, enabled, () => setOpen(true));
  const icon = <TaskStateIcon state={state} failed={failed} />;
  if (!enabled) return icon;

  const pick = (status: ManualTaskStatus) => {
    setOpen(false);
    // The task's own state needs no hand-set one, even when they agree now
    // (an open PR put it back in review): clearing it lets the next change through.
    const next = status === naturalState ? null : status;
    if (next === manualStatus) return;
    void changeSessionOrganization({ kind: 'status', sessionId: session.id, status: next })
      .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const status = PICKABLE[Number(event.key) - 1];
    if (!status) return;
    event.preventDefault();
    pick(status);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
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
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
        data-task-status-menu
      >
        <div className="-mx-1.5 -mt-1.5 mb-1 flex h-8 items-center justify-between border-b border-[var(--border)] px-3.5 text-[13px] text-[var(--text-muted)]">
          <span>Change status…</span>
          <Kbd>S</Kbd>
        </div>
        {SIDEBAR_STATE_ORDER.map((option) => {
          const number = PICKABLE.indexOf(option as ManualTaskStatus) + 1;
          return (
            <DropdownMenuItem
              key={option}
              disabled={!number}
              onSelect={() => pick(option as ManualTaskStatus)}
              className="gap-2 rounded-md px-2 py-1.5 text-[13px]"
              data-task-status-option={option}
            >
              <TaskStateIcon state={option} failed={false} />
              <span className="min-w-0 flex-1 truncate">{SIDEBAR_STATE_LABELS[option]}</span>
              <span className="flex w-3.5 justify-center">{option === state ? <Check className="h-3.5 w-3.5" aria-label="Current" /> : null}</span>
              <span className="w-3 text-right text-[12px] tabular-nums text-[var(--text-muted)]">{number || ''}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="min-w-4 rounded border border-[var(--border-strong,var(--border))] px-1 text-center font-sans text-[11px] leading-4 text-[var(--text-secondary)]">
      {children}
    </kbd>
  );
}
