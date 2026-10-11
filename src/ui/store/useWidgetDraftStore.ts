import { create } from 'zustand';

export interface WidgetDraft {
  toolUseId: string;
  html: string;
  title?: string;
  /** Arrival order, so drafts that haven't become tool calls yet keep theirs. */
  order: number;
}

/**
 * show_widget calls still being written, per session: the markup so far,
 * drawn in the running turn until the call itself arrives (under the same
 * id). Live-only — never persisted, cleared when the run stops.
 */
interface WidgetDraftMemory {
  drafts: Record<string, Record<string, WidgetDraft>>;
  put: (sessionId: string, draft: { toolUseId: string; html: string; title?: string }) => void;
  clear: (sessionId: string) => void;
}

let nextOrder = 0;

export const useWidgetDraftStore = create<WidgetDraftMemory>()((set) => ({
  drafts: {},
  put: (sessionId, { toolUseId, html, title }) =>
    set((current) => {
      const session = current.drafts[sessionId] ?? {};
      const previous = session[toolUseId];
      if (previous && previous.html === html && previous.title === title) return current;
      return {
        drafts: {
          ...current.drafts,
          [sessionId]: { ...session, [toolUseId]: { toolUseId, html, title, order: previous?.order ?? nextOrder++ } },
        },
      };
    }),
  clear: (sessionId) =>
    set((current) => {
      if (!current.drafts[sessionId]) return current;
      const drafts = { ...current.drafts };
      delete drafts[sessionId];
      return { drafts };
    }),
}));
