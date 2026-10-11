import { create } from "zustand";
import { useAppStore } from "./useAppStore";
import type { DesignSummary } from "../../shared/design-types";

/** A request from outside the canvas (e.g. chat "View thread") to focus a target. */
export interface DesignFocusRequest {
  sessionId: string;
  documentId: string;
  boardId?: string;
  commentId?: string;
  nonce: number;
}

/** A design to show in the Design section: the canvas and its conversation. */
export interface DesignSectionTarget {
  sessionId: string;
  documentId?: string;
}

/** What is selected on a chat's open canvas, shown as a chip in its composer. */
export interface DesignCanvasSelection {
  documentId: string;
  boardId: string;
  nodeId?: string;
  /** "Plus card · Pricing" */
  label: string;
}

export const useDesignStore = create<{
  titles: Record<string, string>;
  selections: Record<string, DesignCanvasSelection | undefined>;
  setSelection: (sessionId: string, selection: DesignCanvasSelection | undefined) => void;
  /** The composer dropped the selection chip: the canvas clears its selection. */
  clearRequest: { sessionId: string; nonce: number } | null;
  requestClearSelection: (sessionId: string) => void;
  /** What the Design section shows; null shows the library's newest design. */
  section: DesignSectionTarget | null;
  setSection: (target: DesignSectionTarget | null) => void;
  remember: (doc: Pick<DesignSummary, "id" | "title">) => void;
  focusRequest: DesignFocusRequest | null;
  requestFocus: (request: Omit<DesignFocusRequest, "nonce">) => void;
  consumeFocus: (nonce: number) => void;
}>((set) => ({
  titles: {},
  section: null,
  setSection: (section) => set({ section }),
  selections: {},
  setSelection: (sessionId, selection) =>
    set((s) => {
      const current = s.selections[sessionId];
      if (
        current?.documentId === selection?.documentId &&
        current?.boardId === selection?.boardId &&
        current?.nodeId === selection?.nodeId &&
        current?.label === selection?.label
      )
        return s;
      return { selections: { ...s.selections, [sessionId]: selection } };
    }),
  clearRequest: null,
  requestClearSelection: (sessionId) =>
    set((s) => ({
      clearRequest: { sessionId, nonce: Date.now() + Math.random() },
      selections: { ...s.selections, [sessionId]: undefined },
    })),
  remember: (doc) =>
    set((s) =>
      s.titles[doc.id] === doc.title
        ? s
        : { titles: { ...s.titles, [doc.id]: doc.title } },
    ),
  focusRequest: null,
  requestFocus: (request) => {
    set({ focusRequest: { ...request, nonce: Date.now() + Math.random() } });
    useAppStore
      .getState()
      .setActiveRightUtilityTab(`design:${request.documentId}`);
  },
  consumeFocus: (nonce) =>
    set((s) =>
      s.focusRequest?.nonce === nonce ? { focusRequest: null } : s,
    ),
}));

/**
 * Show a design: beside its chat in the right pane, or full size in the
 * Design section with the conversation floating over the canvas.
 */
export function openDesign(target: { sessionId: string; documentId: string; where: "pane" | "section" }) {
  const app = useAppStore.getState();
  if (target.where === "section") {
    useDesignStore.getState().setSection({ sessionId: target.sessionId, documentId: target.documentId });
    app.setActiveWorkspace("design");
    return;
  }
  if (app.activeWorkspace !== "chat") app.setActiveWorkspace("chat");
  if (app.activeSessionId !== target.sessionId) app.setActiveSession(target.sessionId);
  // After the session switch restores that chat's own right pane.
  queueMicrotask(() => useAppStore.getState().setActiveRightUtilityTab(`design:${target.documentId}`));
}

export function subscribeDesignChanges() {
  return window.electron.design?.onChanged((event) => {
    useDesignStore
      .getState()
      .remember({ id: event.documentId, title: event.title });
    const store = useAppStore.getState();
    // Background generation never steals the foreground conversation's panel.
    // A design started from a chat opens beside it, never in full view; one
    // started in the Design section is already on screen there.
    if (event.created && store.activeWorkspace === "chat" && store.activeSessionId === event.sessionId) {
      store.setActiveRightUtilityTab(`design:${event.documentId}`);
      if (store.rightPanelFullscreen) store.setRightPanelFullscreen(null);
    }
  });
}
