import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { rendererStateStorage } from '../utils/renderer-state-storage';
import {
  DEFAULT_SIDEBAR_VIEW,
  SIDEBAR_ACTIVITY_LABELS,
  SIDEBAR_GROUP_LABELS,
  SIDEBAR_SORT_LABELS,
  SIDEBAR_STATUS_LABELS,
  TASK_PROPERTY_LABELS,
  type SidebarGroupBy,
  type SidebarViewOptions,
  type TaskFilter,
  type TaskProperty,
} from '../utils/sidebar-view';

interface SidebarViewStore extends SidebarViewOptions {
  /** Grouping to return to when the state-view shortcut is pressed again. */
  previousGroupBy: SidebarGroupBy;
  /**
   * Which groups are folded. Kept here so a fold outlives leaving the page. Not persisted.
   */
  collapsedGroups: ReadonlySet<string>;
  toggleGroupCollapsed: (key: string) => void;
  /**
   * Waits the user folded a conversation over (see subSessionWaitMark): only a
   * new one unfolds it again. Not persisted.
   */
  dismissedWaits: ReadonlySet<string>;
  foldSubSessions: (key: string, waits: readonly string[]) => void;
  /** Which state the page lists. Not persisted: a restart starts from everything. */
  taskFilter: TaskFilter;
  setTaskFilter: (filter: TaskFilter) => void;
  setOption: <K extends keyof SidebarViewOptions>(key: K, value: SidebarViewOptions[K]) => void;
  toggleStateView: () => void;
  reset: () => void;
}

function withToggled(keys: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(keys);
  if (!next.delete(key)) next.add(key);
  return next;
}

function pickValid<T extends string>(value: unknown, labels: Record<T, string>, fallback: T): T {
  return typeof value === 'string' && value in labels ? (value as T) : fallback;
}

export const useSidebarViewStore = create<SidebarViewStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SIDEBAR_VIEW,
      previousGroupBy: 'none',
      collapsedGroups: new Set<string>(),
      toggleGroupCollapsed: (key) =>
        set((state) => ({ collapsedGroups: withToggled(state.collapsedGroups, key) })),
      dismissedWaits: new Set<string>(),
      foldSubSessions: (key, waits) =>
        set((state) => ({
          collapsedGroups: new Set(state.collapsedGroups).add(key),
          dismissedWaits: new Set([...state.dismissedWaits, ...waits]),
        })),
      taskFilter: 'all',
      setTaskFilter: (taskFilter) => set({ taskFilter }),
      setOption: (key, value) => set({ [key]: value } as Partial<SidebarViewStore>),
      toggleStateView: () =>
        set((state) =>
          state.groupBy === 'state'
            ? { groupBy: state.previousGroupBy === 'state' ? 'none' : state.previousGroupBy }
            : { groupBy: 'state', previousGroupBy: state.groupBy }
        ),
      reset: () => set((state) => ({ ...DEFAULT_SIDEBAR_VIEW, project: state.project })),
    }),
    {
      name: 'cowork-sidebar-view',
      storage: createJSONStorage(() => rendererStateStorage),
      version: 3,
      // Version 2 made Group by State the default. Version 3 moved the list to a
      // page with its own state filter, so the old defaults make way for the flat list once.
      migrate: (persisted, version) => {
        const saved = (persisted ?? {}) as Partial<SidebarViewStore>;
        if (version >= 3) return saved;
        return {
          ...saved,
          groupBy: !saved.groupBy || saved.groupBy === 'state' || (version < 2 && saved.groupBy === 'project') ? 'none' as const : saved.groupBy,
          sortBy: !saved.sortBy || saved.sortBy === 'updated' ? 'state' as const : saved.sortBy,
        };
      },
      partialize: ({ layout, status, project, activity, groupBy, subGroupBy, sortBy, showSubSessions, showEmptyGroups, properties, previousGroupBy }) => ({
        layout, status, project, activity, groupBy, subGroupBy, sortBy, showSubSessions, showEmptyGroups, properties, previousGroupBy,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SidebarViewStore> & { showPullRequests?: unknown };
        const properties = Array.isArray(saved.properties)
          ? saved.properties.filter((property): property is TaskProperty => typeof property === 'string' && property in TASK_PROPERTY_LABELS)
          : saved.showPullRequests === false
            ? current.properties.filter((property) => property !== 'pull-requests')
            : current.properties;
        return {
          ...current,
          layout: saved.layout === 'board' ? 'board' : 'list',
          status: pickValid(saved.status, SIDEBAR_STATUS_LABELS, current.status),
          project: typeof saved.project === 'string' && saved.project ? saved.project : null,
          activity: pickValid(saved.activity, SIDEBAR_ACTIVITY_LABELS, current.activity),
          groupBy: pickValid(saved.groupBy, SIDEBAR_GROUP_LABELS, current.groupBy),
          subGroupBy: pickValid(saved.subGroupBy, SIDEBAR_GROUP_LABELS, current.subGroupBy),
          previousGroupBy: pickValid(saved.previousGroupBy, SIDEBAR_GROUP_LABELS, current.previousGroupBy),
          sortBy: pickValid(saved.sortBy, SIDEBAR_SORT_LABELS, current.sortBy),
          showSubSessions: typeof saved.showSubSessions === 'boolean' ? saved.showSubSessions : current.showSubSessions,
          showEmptyGroups: typeof saved.showEmptyGroups === 'boolean' ? saved.showEmptyGroups : current.showEmptyGroups,
          properties,
        };
      },
    }
  )
);

export function useSidebarViewOptions(): SidebarViewOptions {
  const layout = useSidebarViewStore((s) => s.layout);
  const status = useSidebarViewStore((s) => s.status);
  const project = useSidebarViewStore((s) => s.project);
  const activity = useSidebarViewStore((s) => s.activity);
  const groupBy = useSidebarViewStore((s) => s.groupBy);
  const subGroupBy = useSidebarViewStore((s) => s.subGroupBy);
  const sortBy = useSidebarViewStore((s) => s.sortBy);
  const showSubSessions = useSidebarViewStore((s) => s.showSubSessions);
  const showEmptyGroups = useSidebarViewStore((s) => s.showEmptyGroups);
  const properties = useSidebarViewStore((s) => s.properties);
  return { layout, status, project, activity, groupBy, subGroupBy, sortBy, showSubSessions, showEmptyGroups, properties };
}
