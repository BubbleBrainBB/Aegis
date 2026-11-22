import type { ReactNode } from 'react';
import { TitlebarControls } from './Sidebar';
import { useSidebarCollapsed } from '../store/sidebar-collapse';

/**
 * A main-column view, Codex-style: the view's title and actions sit in the
 * column's title-bar row, a hairline under it, and the view itself below on
 * the same surface. (Glass and dot-matrix themes still draw the view as a
 * rounded sheet under the row: see `.aegis-sheet` in index.css.)
 */
export function MainSheet({
  header,
  joinedRight = false,
  sheetClassName = '',
  children,
}: {
  header?: ReactNode;
  /** A docked right pane continues the view on this side. */
  joinedRight?: boolean;
  sheetClassName?: string;
  children: ReactNode;
}) {
  const sidebarCollapsed = useSidebarCollapsed();

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <MainTitlebarRow>{header}</MainTitlebarRow>
      <div
        className={`aegis-sheet relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
          sidebarCollapsed ? '' : 'aegis-sheet--join-left'
        } ${joinedRight ? 'aegis-sheet--join-right' : ''} ${sheetClassName}`}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The title-bar row above a main-column sheet. With the sidebar collapsed it
 * also clears the traffic lights and hosts the sidebar toggle and history.
 */
export function MainTitlebarRow({ children }: { children?: ReactNode }) {
  const sidebarCollapsed = useSidebarCollapsed();

  return (
    <div
      // Collapsed, the 52px rail plus this padding clears the traffic lights.
      className={`aegis-titlebar-row drag-region relative flex h-10 flex-shrink-0 items-center gap-2 pr-2 ${
        sidebarCollapsed ? 'pl-8' : 'pl-3'
      }`}
      data-main-titlebar
    >
      {sidebarCollapsed ? <TitlebarControls /> : null}
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </div>
  );
}
