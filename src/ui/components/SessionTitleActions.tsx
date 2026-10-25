import { useAppStore } from '../store/useAppStore';
import { findProposalForChild, useFollowUpStore } from '../store/useFollowUpStore';
import type { SessionView } from '../types';
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
      {session && showMenu ? <SessionActionsMenu session={session} /> : null}
    </div>
  );
}
