import { useAppStore } from './useAppStore';
import { useDesignStore } from './useDesignStore';

type AppView = Pick<ReturnType<typeof useAppStore.getState>, 'sidebarCollapsed' | 'showSettings' | 'activeWorkspace'>;
type DesignView = Pick<ReturnType<typeof useDesignStore.getState>, 'sectionSidebarOpen'>;

/** The Design section is its own space: the task sidebar steps aside for it. */
function inDesignSection(app: AppView): boolean {
  return app.activeWorkspace === 'design';
}

/**
 * Whether the sidebar shows collapsed. Settings keeps it open, as Codex does:
 * its nav lives there, so the toggle goes away and the saved state waits for
 * Settings to close. The Design section starts with it collapsed whatever the
 * saved state is, and opening it there lasts for that visit only.
 */
export function sidebarShowsCollapsed(app: AppView, design: DesignView): boolean {
  if (app.showSettings) return false;
  return inDesignSection(app) ? !design.sectionSidebarOpen : app.sidebarCollapsed;
}

export function useSidebarCollapsed(): boolean {
  const sectionSidebarOpen = useDesignStore((s) => s.sectionSidebarOpen);
  return useAppStore((app) => sidebarShowsCollapsed(app, { sectionSidebarOpen }));
}

/** The title-bar button and the shortcut: in the Design section this leaves the saved state alone. */
export function toggleSidebar(): void {
  const app = useAppStore.getState();
  const design = useDesignStore.getState();
  if (inDesignSection(app)) design.setSectionSidebarOpen(!design.sectionSidebarOpen);
  else app.setSidebarCollapsed(!app.sidebarCollapsed);
}
