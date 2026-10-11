import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { rendererStateStorage } from '../utils/renderer-state-storage';

/** Oldest widget states are dropped past this many widgets. */
const MAX_WIDGETS = 300;

/**
 * State a widget keeps with `aegis.setState` (the selected tab, a slider's
 * value), keyed by its show_widget tool call, so it survives scrolling away,
 * switching sessions and restarting the app.
 */
interface WidgetStateMemory {
  states: Record<string, { value: unknown; savedAt: number }>;
  save: (toolUseId: string, value: unknown) => void;
}

export const useWidgetStateStore = create<WidgetStateMemory>()(
  persist(
    (set) => ({
      states: {},
      save: (toolUseId, value) =>
        set((current) => {
          const states = { ...current.states, [toolUseId]: { value, savedAt: Date.now() } };
          const ids = Object.keys(states);
          if (ids.length > MAX_WIDGETS) {
            ids.sort((a, b) => states[a].savedAt - states[b].savedAt);
            for (const id of ids.slice(0, ids.length - MAX_WIDGETS)) delete states[id];
          }
          return { states };
        }),
    }),
    { name: 'aegis:widget-states:v1', storage: createJSONStorage(() => rendererStateStorage) }
  )
);
