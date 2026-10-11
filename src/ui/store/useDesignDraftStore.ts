import { create } from "zustand";
import type { DesignDraftMessage } from "../components/design/design-drafts";

/**
 * design_update calls still being written, per session and call. Transient:
 * a draft goes when its design saves the real version, the turn ends, or the
 * session is deleted.
 */
export const useDesignDraftStore = create<{
  drafts: Record<string, Record<string, DesignDraftMessage> | undefined>;
  put: (sessionId: string, draft: DesignDraftMessage) => void;
  /** The design saved: its finished drafts are now real boards. */
  settle: (documentId: string) => void;
  clear: (sessionId: string) => void;
}>((set) => ({
  drafts: {},
  put: (sessionId, draft) =>
    set((s) => ({ drafts: { ...s.drafts, [sessionId]: { ...s.drafts[sessionId], [draft.toolUseId]: draft } } })),
  settle: (documentId) =>
    set((s) => {
      let changed = false;
      const drafts: typeof s.drafts = {};
      for (const [sessionId, calls] of Object.entries(s.drafts)) {
        const kept = Object.fromEntries(
          Object.entries(calls ?? {}).filter(([, d]) => {
            const done = d.documentId === documentId && d.boards.every((b) => b.complete);
            if (done) changed = true;
            return !done;
          }),
        );
        drafts[sessionId] = kept;
      }
      return changed ? { drafts } : s;
    }),
  clear: (sessionId) =>
    set((s) => (s.drafts[sessionId] ? { drafts: { ...s.drafts, [sessionId]: undefined } } : s)),
}));

const NONE: DesignDraftMessage[] = [];
/** Drafts of one design (or of any design in the session when documentId is omitted). */
export function selectDesignDrafts(
  state: ReturnType<typeof useDesignDraftStore.getState>,
  sessionId: string | null | undefined,
  documentId?: string,
): DesignDraftMessage[] {
  const calls = sessionId ? state.drafts[sessionId] : undefined;
  if (!calls) return NONE;
  const list = Object.values(calls).filter((d) => documentId === undefined || d.documentId === documentId);
  return list.length ? list : NONE;
}
