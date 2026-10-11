import type { ReactNode } from 'react';
import { useAppStore } from '../store/useAppStore';
import { TitlebarControls } from './Sidebar';

/**
 * A main-column view, Codex-style: two tones only. The view's title and
 * actions sit in the title-bar row on the window chrome; the view itself is
 * on the light sheet below, which continues the sidebar panel's surface.
 */
export function MainSheet({
  header,
  joinedRight = false,
  sheetClassName = '',
  children,
}: {
  header?: ReactNode;
  /** A docked right pane continues the sheet on this side. */
  joinedRight?: boolean;
  sheetClassName?: string;
  children: ReactNode;
}) {
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);

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
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);

  return (
    <div
      className={`drag-region relative flex h-10 flex-shrink-0 items-center gap-2 pr-2 ${
        sidebarCollapsed ? 'pl-10' : 'pl-3'
      }`}
      data-main-titlebar
    >
      {sidebarCollapsed ? <TitlebarControls /> : null}
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </div>
  );
}
