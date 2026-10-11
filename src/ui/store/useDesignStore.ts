import { useEffect } from "react";
import { create } from "zustand";
import { useAppStore } from "./useAppStore";
import { useDesignDraftStore } from "./useDesignDraftStore";
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
  /** Every design, newest first (the Design section's library); null until loaded. */
  library: DesignSummary[] | null;
  refreshLibrary: () => Promise<void>;
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
  library: null,
  refreshLibrary: async () => {
    const rows = await window.electron.design?.listAll().catch(() => null);
    if (rows) set({ library: rows });
  },
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

const EMPTY_LIBRARY: DesignSummary[] = [];
/** The design library, loaded on first use and kept current by subscribeDesignChanges. */
export function useDesignLibrary(): DesignSummary[] {
  const library = useDesignStore((s) => s.library);
  useEffect(() => {
    if (library === null) void useDesignStore.getState().refreshLibrary();
  }, [library]);
  return library ?? EMPTY_LIBRARY;
}

/** A new design in the Design section: an empty canvas whose chat starts with the first message. */
export function startNewDesign(cwd?: string | null) {
  const app = useAppStore.getState();
  const sessionId = app.createDetachedDraftSession(cwd ?? app.projectCwd, "New design");
  useDesignStore.getState().setSection({ sessionId });
  if (app.activeWorkspace !== "design") app.setActiveWorkspace("design");
  return sessionId;
}

export function subscribeDesignChanges() {
  // A draft the Design section shows became a real chat: follow it.
  const offPromotion = useAppStore.subscribe((state, previous) => {
    const promotion = state.draftPromotion;
    if (!promotion || promotion === previous.draftPromotion) return;
    const design = useDesignStore.getState();
    if (design.section?.sessionId === promotion.from) design.setSection({ ...design.section, sessionId: promotion.to });
  });
  const offChanges = window.electron.design?.onChanged((event) => {
    const design = useDesignStore.getState();
    design.remember({ id: event.documentId, title: event.title });
    if (event.scope !== "comments") {
      void design.refreshLibrary();
      // The saved version replaces the boards drawn while it was written.
      useDesignDraftStore.getState().settle(event.documentId);
    }
    const store = useAppStore.getState();
    // The Design section's new design shows the canvas its first message made.
    if (event.created && store.activeWorkspace === "design" && design.section?.sessionId === event.sessionId && !design.section.documentId) {
      design.setSection({ sessionId: event.sessionId, documentId: event.documentId });
    }
    // Background generation never steals the foreground conversation's panel.
    // A design started from a chat opens beside it, never in full view; one
    // started in the Design section is already on screen there.
    if (event.created && store.activeWorkspace === "chat" && store.activeSessionId === event.sessionId) {
      store.setActiveRightUtilityTab(`design:${event.documentId}`);
      if (store.rightPanelFullscreen) store.setRightPanelFullscreen(null);
    }
  });
  return () => {
    offPromotion();
    offChanges?.();
  };
}
