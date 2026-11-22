import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { rendererStateStorage } from '../utils/renderer-state-storage';

/**
 * Sections that are not fixed on the icon rail. They live in the rail's
 * "More" menu, and the ones the user pins show under the rail's divider.
 * A section added here needs an entry in the rail's own list (Sidebar.tsx).
 */
export const PINNABLE_RAIL_SECTIONS = ['prs'] as const;
export type PinnableRailSection = (typeof PINNABLE_RAIL_SECTIONS)[number];

/** Pinned until the user says otherwise, so the rail starts as it always looked. */
const DEFAULT_PINNED: readonly PinnableRailSection[] = ['prs'];

export function isPinnableRailSection(value: unknown): value is PinnableRailSection {
  return (PINNABLE_RAIL_SECTIONS as readonly unknown[]).includes(value);
}

/** Saved pins in menu order, without unknown or repeated sections. */
export function sanitizeRailPins(value: unknown): PinnableRailSection[] {
  if (!Array.isArray(value)) return [...DEFAULT_PINNED];
  return PINNABLE_RAIL_SECTIONS.filter((section) => value.includes(section));
}

interface RailPinsStore {
  pinned: PinnableRailSection[];
  togglePinned: (section: PinnableRailSection) => void;
}

export const useRailPinsStore = create<RailPinsStore>()(
  persist(
    (set) => ({
      pinned: [...DEFAULT_PINNED],
      togglePinned: (section) =>
        set((state) => ({
          pinned: sanitizeRailPins(
            state.pinned.includes(section)
              ? state.pinned.filter((entry) => entry !== section)
              : [...state.pinned, section]
          ),
        })),
    }),
    {
      name: 'aegis-rail-pins',
      storage: createJSONStorage(() => rendererStateStorage),
      version: 1,
      partialize: ({ pinned }) => ({ pinned }),
      merge: (persisted, current) => ({
        ...current,
        pinned: sanitizeRailPins((persisted as { pinned?: unknown } | undefined)?.pinned ?? current.pinned),
      }),
    }
  )
);
