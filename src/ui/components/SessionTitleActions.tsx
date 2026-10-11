import type { SessionView } from '../types';
import { SessionActionsMenu } from './SessionActionsMenu';
import { SessionTitleEditor } from './SessionTitleEditor';

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
      <SessionTitleEditor session={session} className={className} />
      {session && showMenu ? <SessionActionsMenu session={session} /> : null}
    </div>
  );
}
