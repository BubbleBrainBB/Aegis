import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { rendererStateStorage } from '../utils/renderer-state-storage';
import {
  DEFAULT_SIDEBAR_VIEW,
  SIDEBAR_ACTIVITY_LABELS,
  SIDEBAR_GROUP_LABELS,
  SIDEBAR_SORT_LABELS,
  SIDEBAR_STATUS_LABELS,
  type SidebarGroupBy,
  type SidebarViewOptions,
} from '../utils/sidebar-view';

interface SidebarViewStore extends SidebarViewOptions {
  /** Grouping to return to when the state-view shortcut is pressed again. */
  previousGroupBy: SidebarGroupBy;
  /**
   * Which groups are folded, and which show every session instead of the first
   * few. Kept here because the Sidebar unmounts while Settings is open. Not persisted.
   */
  collapsedGroups: ReadonlySet<string>;
  expandedSessionGroups: ReadonlySet<string>;
  toggleGroupCollapsed: (key: string) => void;
  /**
   * Waits the user folded a conversation over (see subSessionWaitMark): only a
   * new one unfolds it again. Not persisted.
   */
  dismissedWaits: ReadonlySet<string>;
  foldSubSessions: (key: string, waits: readonly string[]) => void;
  /** The draft whose project was last unfolded for it, so a remount does not undo a later fold. */
  revealedDraft: { sessionId: string; project: string } | null;
  /** Unfold the project when going to a draft; pass null while no draft is active. */
  revealDraftProject: (draft: { sessionId: string; project: string } | null) => void;
  toggleSessionListExpanded: (key: string) => void;
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
      previousGroupBy: 'project',
      collapsedGroups: new Set<string>(),
      expandedSessionGroups: new Set<string>(),
      toggleGroupCollapsed: (key) =>
        set((state) => ({ collapsedGroups: withToggled(state.collapsedGroups, key) })),
      dismissedWaits: new Set<string>(),
      foldSubSessions: (key, waits) =>
        set((state) => ({
          collapsedGroups: new Set(state.collapsedGroups).add(key),
          dismissedWaits: new Set([...state.dismissedWaits, ...waits]),
        })),
      revealedDraft: null,
      revealDraftProject: (draft) =>
        set((state) => {
          const revealed = state.revealedDraft;
          if (revealed?.sessionId === draft?.sessionId && revealed?.project === draft?.project) return state;
          return {
            revealedDraft: draft,
            collapsedGroups:
              draft && state.collapsedGroups.has(draft.project)
                ? withToggled(state.collapsedGroups, draft.project)
                : state.collapsedGroups,
          };
        }),
      toggleSessionListExpanded: (key) =>
        set((state) => ({ expandedSessionGroups: withToggled(state.expandedSessionGroups, key) })),
      setOption: (key, value) => set({ [key]: value } as Partial<SidebarViewStore>),
      toggleStateView: () =>
        set((state) =>
          state.groupBy === 'state'
            ? { groupBy: state.previousGroupBy === 'state' ? 'project' : state.previousGroupBy }
            : { groupBy: 'state', previousGroupBy: state.groupBy }
        ),
      reset: () => set({ ...DEFAULT_SIDEBAR_VIEW }),
    }),
    {
      name: 'cowork-sidebar-view',
      storage: createJSONStorage(() => rendererStateStorage),
      version: 2,
      // Version 2 made Group by State the default, and it replaces the old default once.
      migrate: (persisted, version) => {
        const saved = (persisted ?? {}) as Partial<SidebarViewStore>;
        return version < 2 && saved.groupBy === 'project'
          ? { ...saved, groupBy: 'state' as const, previousGroupBy: 'project' as const }
          : saved;
      },
      partialize: ({ status, project, activity, groupBy, sortBy, showPullRequests, previousGroupBy }) => ({
        status, project, activity, groupBy, sortBy, showPullRequests, previousGroupBy,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SidebarViewStore>;
        return {
          ...current,
          status: pickValid(saved.status, SIDEBAR_STATUS_LABELS, current.status),
          project: typeof saved.project === 'string' && saved.project ? saved.project : null,
          activity: pickValid(saved.activity, SIDEBAR_ACTIVITY_LABELS, current.activity),
          groupBy: pickValid(saved.groupBy, SIDEBAR_GROUP_LABELS, current.groupBy),
          previousGroupBy: pickValid(saved.previousGroupBy, SIDEBAR_GROUP_LABELS, current.previousGroupBy),
          sortBy: pickValid(saved.sortBy, SIDEBAR_SORT_LABELS, current.sortBy),
          showPullRequests: typeof saved.showPullRequests === 'boolean' ? saved.showPullRequests : current.showPullRequests,
        };
      },
    }
  )
);

export function useSidebarViewOptions(): SidebarViewOptions {
  const status = useSidebarViewStore((s) => s.status);
  const project = useSidebarViewStore((s) => s.project);
  const activity = useSidebarViewStore((s) => s.activity);
  const groupBy = useSidebarViewStore((s) => s.groupBy);
  const sortBy = useSidebarViewStore((s) => s.sortBy);
  const showPullRequests = useSidebarViewStore((s) => s.showPullRequests);
  return { status, project, activity, groupBy, sortBy, showPullRequests };
}
