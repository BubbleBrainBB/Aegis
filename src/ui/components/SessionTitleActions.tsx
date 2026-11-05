import { useAppStore } from '../store/useAppStore';
import { findProposalForChild, useFollowUpStore } from '../store/useFollowUpStore';
import type { SessionView } from '../types';
import { Loader2, Monitor } from './icons';
import { SessionActionsMenu } from './SessionActionsMenu';
import { SessionTitleEditor } from './SessionTitleEditor';

/** For a sub-session: the session that started it, one click back. */
function ParentCrumb({ sessionId }: { sessionId: string }) {
  const parentId = useFollowUpStore((state) => {
    const link = findProposalForChild(state.proposals, sessionId);
    return link && link.detachedAt === null ? link.parentSessionId : null;
  });
  const parentTitle = useAppStore((state) => (parentId ? state.sessions[parentId]?.title : undefined));
  if (!parentId || !parentTitle) return null;
  return (
    <>
      <button
        type="button"
        className="min-w-0 max-w-[40%] flex-shrink truncate text-[length:inherit] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        title={`Open ${parentTitle}`}
        onClick={() => useAppStore.getState().setActiveSession(parentId)}
        data-session-parent-crumb
      >
        {parentTitle}
      </button>
      <span className="flex-shrink-0 text-[var(--text-muted)]" aria-hidden="true">›</span>
    </>
  );
}

/**
 * Keep the conversation menu beside its title, including in split panes. The
 * main title bar sets `showMenu={false}` and puts the menu with its other
 * actions on the right instead.
 */
export function SessionTitleActions({ session, className = '', showMenu = true }: {
  session: SessionView | null | undefined;
  className?: string;
  showMenu?: boolean;
}) {
  return (
    // Without the menu beside it the title alone sets this group's width;
    // filling the row keeps its hover inset (negative margins) from clipping it.
    <div className={`flex min-w-0 items-center gap-2 ${showMenu ? '' : 'flex-1'}`} data-session-title-actions>
      {session ? <ParentCrumb sessionId={session.id} /> : null}
      <SessionTitleEditor session={session} className={className} />
      {session?.device ? (
        <span data-session-machine className="no-drag inline-flex h-6 flex-shrink-0 items-center gap-[5px] rounded-[7px] bg-[var(--sidebar-item-hover)] pl-1.5 pr-2 text-[12.5px] text-[var(--text-secondary)]">
          <Monitor className="h-3.5 w-3.5" />
          {session.device.name}
          {session.device.reconnecting
            ? <Loader2 className="ml-0.5 h-3 w-3 animate-spin text-[var(--text-muted)]" aria-label="Reconnecting" />
            : <span className={`ml-0.5 h-1.5 w-1.5 rounded-full ${session.device.online ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]'}`} aria-label={session.device.online ? 'Connected' : 'Offline'} />}
        </span>
      ) : null}
      {session && showMenu && !session.device ? <SessionActionsMenu session={session} /> : null}
    </div>
  );
}
