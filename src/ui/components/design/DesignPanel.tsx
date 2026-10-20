import type { DesignCanvasAwareness } from "../../../shared/design-types";
import { nextBoardName } from "../../../shared/design-names";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  editDesignLayer,
  moveDesignLayer,
  readDesignLayers,
  replaceDesignLayerStyle,
  findDesignLayer,
  designLayerPath,
  insertDesignLayer,
  inferAutoLayout,
  setAutoLayout,
  wrapInAutoLayout,
  type AutoLayoutKind,
  type DesignLayer,
} from "../../../shared/design-layers";
import { buildDesignCommentPrompt } from "../../../shared/design-comment";
import { DesignCanvas, type CanvasApi, type CanvasPin } from "./DesignCanvas";
import { LayersPopover } from "./LayersPopover";
import { ElementDesignTab } from "./ElementDesignTab";
import { BoardDesignTab } from "./BoardDesignTab";
import { DesignPages } from "./DesignPages";
import { designPages, designPageId } from "../../../shared/design-pages";
import type { DesignMark } from "../../../shared/design-marks";
import { rendererStateStorage } from "../../utils/renderer-state-storage";
import { DesignTweaksTab } from "./DesignTweaksTab";
import { CodeTab } from "./CodeTab";
import { InspectorResizer, useInspectorWidth } from "./InspectorResizer";
import { useCommentsHidden, useInspectorOpen } from "./design-prefs";
import { DesignCommentControls } from "./DesignCommentControls";
import { CommentsList } from "./CommentsList";
import { CommentComposer } from "./CommentComposer";
import { CommentThread } from "./CommentThread";
import { HistoryPanel } from "./HistoryPanel";
import { DesignCompare } from "./DesignCompare";
import { InlineTextEditor } from "./InlineTextEditor";
import { SelectionTools } from "./SelectionTools";
import { frameStyle } from "./design-insert";
import type { DropTarget } from "./BoardFrame";
import type { Rect } from "./canvas-geometry";
import {
  anchorLabel,
  authorName,
  cropBoardImage,
  errorText,
  initialOf,
  useDesignUser,
} from "./design-ui";
import { ArrowLeft, ChevronDown, History, Plus, Eye, EyeOff, Layers, MoreHorizontal, Sparkles, X } from "../icons";
import { useAppStore } from "../../store/useAppStore";
import { useDesignStore } from "../../store/useDesignStore";
import { selectDesignDrafts, useDesignDraftStore } from "../../store/useDesignDraftStore";
import { useShallow } from "zustand/react/shallow";
import { boardsWithDrafts, isDraftBoardId } from "./design-drafts";
import { useComposerQueueStore } from "../../store/useComposerQueueStore";
import {
  canSendDesignComment,
  sendDesignComment,
} from "../../lib/design-comment-send";
import type {
  DesignAnchor,
  DesignComment,
  DesignDocument,
  DesignOperation,
  DesignRevisionInfo,
  DesignSummary,
} from "../../../shared/design-types";
import type { Attachment } from "../../types";
import { DesignUndo, blockedBy, touchedBoards, undoKey } from "./design-undo";
import { summarizeOperations } from "../../../shared/design-history";
import { DesignAgentName, relativeTime, useDesignAgentName } from "./design-ui";
import { DesignCards } from "./DesignCards";
import { DesignStylesDialog } from "./DesignStylesDialog";
import { PROVIDERS } from "../../utils/provider";
import "./design.css";
import "./design-claude.css";
import { DesignActionMenu, DesignFloatingToolbar, DesignLayersSection } from "./DesignChrome";
import { isImeComposing } from "../../utils/ime";

/** A board made with the Frame tool starts empty and white. */
const BLANK_BOARD = '<html><head></head><body style="margin: 0; background: #ffffff"></body></html>';
// Undo history lives as long as the app does, per document, across tab switches.
const undoStacks = new Map<string, DesignUndo>();
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const uid = () => crypto.randomUUID();
/** Width of the history column (design.css .design-history). */
const HISTORY_WIDTH = 288;
type Selection = { boardId: string; revision: number; anchor: DesignAnchor };
type Tab = "design" | "tweaks" | "code" | "comments";
type CommentInput = { text: string; toAgent: boolean; attachments: Attachment[] };
const EMPTY_QUEUE: never[] = [];

type DesignPanelProps = {
  sessionId: string | null;
  documentId?: string;
  hidden: boolean;
  /** "section": the Design section's full canvas, its library in the sidebar. */
  chrome?: "pane" | "section";
  /** Where the toolbar goes instead of the panel's own top row (the title bar). */
  toolbarHost?: HTMLElement | null;
  /** Drawn over the canvas area only (left of the inspector), e.g. the agent dock. */
  canvasOverlay?: (stage: RefObject<HTMLDivElement | null>) => ReactNode;
};

/** A chat's designs: its library, or one design's canvas with the editing tools. */
export function DesignPanel(props: DesignPanelProps) {
  const provider = useAppStore((s) => (props.sessionId ? s.sessions[props.sessionId]?.provider : undefined));
  const agent = PROVIDERS.find((p) => p.id === provider)?.label ?? "Agent";
  return (
    <DesignAgentName.Provider value={agent}>
      <DesignPanelBody {...props} />
    </DesignAgentName.Provider>
  );
}

function DesignPanelBody({ sessionId, documentId, hidden, chrome = "pane", toolbarHost, canvasOverlay }: DesignPanelProps) {
  const overlayStage = useRef<HTMLDivElement>(null);
  const agentName = useDesignAgentName();
  const session = useAppStore((s) =>
    sessionId ? s.sessions[sessionId] : undefined,
  );
  const user = useDesignUser();
  const [list, setList] = useState<DesignSummary[]>([]);
  const [doc, setDoc] = useState<DesignDocument | null>(null);
  const pageKey = "aegis.design.page:" + documentId;
  const [pageChoice, setPageChoice] = useState<string>(() => rendererStateStorage.getItem(pageKey) ?? "");
  const pages = designPages(doc ?? {});
  const activePageId = pages.some(page => page.id === pageChoice) ? pageChoice : pages[0].id;
  const [selectedMarkIds, setSelectedMarkIds] = useState<string[]>([]);
  useEffect(() => { setPageChoice(rendererStateStorage.getItem(pageKey) ?? ""); }, [pageKey]);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [awareness, setAwareness] = useState<{ key: string; value: DesignCanvasAwareness }>();
  const awarenessKey = documentId + ":" + activePageId;
  const reportAwareness = useCallback((value: DesignCanvasAwareness) => setAwareness({ key: awarenessKey, value }), [awarenessKey]);
  const currentAwareness = awareness?.key === awarenessKey ? awareness.value : undefined;
  const selected = selectedIds.length === 1 ? selectedIds[0] : undefined;
  const [selection, setSelection] = useState<Selection>();
  const [layerTarget, setLayerTarget] = useState<{
    boardId: string;
    nodeId: string;
    request: number;
  }>();
  const [tweakPreview, setTweakPreview] = useState<{ boardId: string; revision: number; html: string }>();
  const [tab, setTab] = useState<Tab>("design");
  const [inspectorWidth, setInspectorWidth, saveInspectorWidth] = useInspectorWidth();
  const [inspectorOpen, setInspectorOpen] = useInspectorOpen();
  const [commentsHidden, setCommentsHidden] = useCommentsHidden();
  const [commentMode, setCommentMode] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [composer, setComposer] = useState<Selection>();
  const [textEdit, setTextEdit] = useState<Selection & { caret?: { x: number; y: number } }>();
  /** Text tool: a previewed new layer being typed, saved on commit. */
  const [textInsert, setTextInsert] = useState<{
    boardId: string;
    revision: number;
    target: DropTarget;
    tag: string;
    rect: Rect;
    styles: Record<string, string>;
  }>();
  const [liveRect, setLiveRect] = useState<{ x: number; y: number; width: number; height: number }>();
  const [activeCommentId, setActiveCommentId] = useState<string>();
  const [focusTarget, setFocusTarget] = useState<{
    boardId: string;
    rect?: { x: number; y: number; width: number; height: number };
    nonce: number;
  }>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<DesignRevisionInfo[]>([]);
  const [historical, setHistorical] = useState<number>();
  // Tell the next turn which design is open here and what is in view. The
  // selection goes with each message instead, as the composer chip below.
  useEffect(() => {
    if (!sessionId || hidden) return;
    const open = doc && !historical ? doc.id : undefined;
    void window.electron.design
      .focus?.({
        sessionId,
        documentId: open,
        pageId: open ? activePageId : undefined,
        visibleBoardIds: open ? currentAwareness?.visibleBoardIds : undefined,
        focusedBoardId: open ? currentAwareness?.focusedBoardId : undefined,
      })
      ?.catch(() => {});
  }, [sessionId, hidden, doc?.id, historical, activePageId, currentAwareness]);
  // Close only on lifecycle changes, not between every selection/viewport report.
  useEffect(() => {
    const open = !hidden && !historical ? doc?.id : undefined;
    return () => {
      if (sessionId && open) void window.electron.design.focus?.({ sessionId, documentId: open, open: false })?.catch(() => {});
    };
  }, [sessionId, hidden, doc?.id, historical]);
  // The chat composer shows what is selected here as a chip, and a message
  // sent with it carries it to the agent; dropping the chip clears the selection.
  useEffect(() => {
    if (!sessionId) return;
    const ids = selection ? [selection.boardId] : selectedIds;
    const boards = doc ? ids.flatMap((id) => doc.boards.filter((b) => b.id === id)) : [];
    const store = useDesignStore.getState();
    if (hidden || !doc || historical || !boards.length) {
      // Another tab of this chat may own the chip; clear only ours.
      if (store.selections[sessionId]?.documentId === (doc?.id ?? documentId)) store.setSelection(sessionId, undefined);
      return;
    }
    const [board] = boards;
    const layer = selection ? anchorLabel(board, selection.anchor) : undefined;
    store.setSelection(sessionId, boards.length > 1
      ? {
          documentId: doc.id,
          boardIds: boards.map((b) => b.id),
          label: boards.length === 2 ? `${boards[0].name}, ${boards[1].name}` : `${board.name} + ${boards.length - 1} more`,
        }
      : {
          documentId: doc.id,
          boardIds: [board.id],
          ...(selection?.anchor.nodeId ? { nodeId: selection.anchor.nodeId } : {}),
          label: layer ? `${layer} · ${board.name}` : board.name,
          contentRevision: board.contentRevision,
        });
  }, [sessionId, documentId, hidden, doc, historical, selectedIds, selection]);
  useEffect(() => () => {
    const store = useDesignStore.getState();
    if (sessionId && documentId && store.selections[sessionId]?.documentId === documentId) store.setSelection(sessionId, undefined);
  }, [sessionId, documentId]);
  const clearRequest = useDesignStore((s) => s.clearRequest);
  useEffect(() => {
    if (!clearRequest || clearRequest.sessionId !== sessionId) return;
    setSelection(undefined);
    setSelectedIds([]);
  }, [clearRequest, sessionId]);
  const [head, setHead] = useState(0);
  const [stylesOpen, setStylesOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportAllPages, setExportAllPages] = useState(false);
  const [exportScale, setExportScale] = useState<1 | 2>(2);
  /** A board's download menu, opened from the download icon on its heading. */
  const [boardDownload, setBoardDownload] = useState<{ boardId: string; trigger: { current: HTMLElement | null } }>();
  const [exportMenu, setExportMenu] = useState<true>();
  const exportTrigger = useRef<HTMLButtonElement>(null);
  /** Title: one click opens the design menu, a double click renames in place. */
  const [renaming, setRenaming] = useState(false);
  const titleClick = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(titleClick.current), []);
  const startRename = () => {
    clearTimeout(titleClick.current);
    setExportMenu(undefined);
    setRenaming(true);
  };
  // Layers and Properties share a panel; the existing shortcut still toggles it.
  const layersOpen = inspectorOpen && !historyOpen && tab !== "comments";
  const toggleLayers = () => {
    setInspectorOpen(!layersOpen);
    if (!layersOpen) { setHistoryOpen(false); setTab("design"); }
  };
  const loadLayerStyles = useCallback(
    async (boardId: string, nodeId: string) => (await canvas.current?.styles(boardId, nodeId)) ?? null,
    [],
  );
  const composerChoice = useDesignStore((s) => (sessionId ? s.composer[sessionId] : undefined));
  // The message behind each board's latest agent version (prompt cards).
  const [prompts, setPrompts] = useState<Record<string, { prompt: string; revision: number }>>({});
  useEffect(() => {
    if (chrome !== "section" || !sessionId || !doc?.id) return;
    let alive = true;
    void window.electron.design
      .prompts?.({ sessionId, documentId: doc.id })
      .then((rows) => alive && setPrompts(rows ?? {}))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [chrome, sessionId, doc?.id, doc?.revision]);
  const [compare, setCompare] = useState<{
    boardId: string;
    from: number;
    to: number;
    commentId?: string;
  }>();
  const [boardMenu, setBoardMenu] = useState(false);
  const boardMenuTrigger = useRef<HTMLButtonElement>(null);
  const canvas = useRef<CanvasApi | null>(null);
  const root = useRef<HTMLElement>(null);
  const stepRef = useRef<(direction: "undo" | "redo") => void>(() => {});
  const mounted = useRef(true);
  const readEpoch = useRef(0);
  // Boards the agent is writing right now, drawn until the real version lands.
  const drafts = useDesignDraftStore(useShallow((s) => selectDesignDrafts(s, sessionId, doc?.id ?? "")));
  const writing = !historical && drafts.length > 0;
  const canvasBoards = useMemo(
    () => (doc ? (historical ? doc.boards : boardsWithDrafts(doc.boards, drafts)).filter(board => designPageId(doc, board) === activePageId).map(board => tweakPreview?.boardId === board.id && tweakPreview.revision === board.contentRevision ? { ...board, html: tweakPreview.html } : board) : []),
    [doc, drafts, historical, activePageId, tweakPreview],
  );
  // A board the agent starts writing comes into view.
  const seenDraftBoards = useRef(new Set<string>());
  useEffect(() => {
    if (hidden) return;
    const added = canvasBoards.filter((b) => isDraftBoardId(b.id) && !seenDraftBoards.current.has(b.id));
    for (const b of added) seenDraftBoards.current.add(b.id);
    const latest = added.at(-1);
    if (latest) setFocusTarget({ boardId: latest.id, nonce: Date.now() });
  }, [canvasBoards, hidden]);
  // Hand edits wait while the agent writes, so neither overwrites the other.
  // A new chat on an existing design is still a draft; the design is already
  // there to edit by hand.
  const editable =
    !!session && !session.readOnly && !historical && !writing;
  const canMention = canSendDesignComment(sessionId);
  const activeBoard = doc?.boards.find((b) => b.id === selected);
  const queue = useComposerQueueStore((s) =>
    sessionId ? s.queues[sessionId] ?? EMPTY_QUEUE : EMPTY_QUEUE,
  );
  const queuedIds = useMemo(
    () =>
      new Set(
        queue.flatMap((item) => (item.design ? [item.design.commentId] : [])),
      ),
    [queue],
  );

  useEffect(() => {
    setPreviewing(false);
  }, [hidden, documentId, sessionId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readEpoch.current++;
    };
  }, []);
  const reload = useCallback(async () => {
    if (!sessionId || !window.electron.design) return;
    const epoch = ++readEpoch.current;
    try {
      if (!documentId) {
        const rows = await window.electron.design.list(sessionId);
        if (mounted.current && epoch === readEpoch.current) setList(rows);
      } else {
        const current = await window.electron.design.read({
          sessionId,
          documentId,
        });
        const d = historical
          ? await window.electron.design.read({
              sessionId,
              documentId,
              revision: historical,
            })
          : current;
        if (!mounted.current || epoch !== readEpoch.current) return;
        setHead(current.revision);
        // Threads are document-level: a historical view still shows current ones.
        setDoc({ ...d, comments: current.comments });
        setFailure("");
        useDesignStore.getState().remember(d);
        setSelectedIds((ids) =>
          ids.filter((id) => d.boards.some((b) => b.id === id)),
        );
      }
    } catch (e) {
      if (mounted.current && epoch === readEpoch.current)
        setFailure(errorText(e));
    }
  }, [sessionId, documentId, historical]);
  const loadHistory = useCallback(async () => {
    if (!sessionId || !documentId) return;
    try {
      const rows = await window.electron.design.history({
        sessionId,
        documentId,
      });
      if (mounted.current) setVersions(rows);
    } catch (e) {
      if (mounted.current) setFailure(errorText(e));
    }
  }, [sessionId, documentId]);
  useEffect(() => {
    void reload();
    return window.electron.design?.onChanged((e) => {
      if (
        e.sessionId !== sessionId ||
        (documentId && e.documentId !== documentId)
      )
        return;
      void reload();
      if (historyOpen && e.scope !== "comments") void loadHistory();
    });
  }, [reload, loadHistory, historyOpen, sessionId, documentId]);
  useEffect(() => {
    if (historyOpen) void loadHistory();
  }, [historyOpen, loadHistory]);

  // "View thread" from the chat: open this document's thread on the canvas.
  const focusRequest = useDesignStore((s) => s.focusRequest);
  useEffect(() => {
    if (
      hidden ||
      !doc ||
      !focusRequest ||
      focusRequest.documentId !== doc.id ||
      focusRequest.sessionId !== sessionId
    )
      return;
    useDesignStore.getState().consumeFocus(focusRequest.nonce);
    const comment = doc.comments.find((c) => c.id === focusRequest.commentId);
    if (focusRequest.commentId && !comment) {
      toast.error("That comment no longer exists.");
      return;
    }
    // Arriving from chat to a thread shows comments again; a sent selection only shows its board.
    if (comment) setCommentsHidden(false);
    openThread(comment, focusRequest.boardId);
  }, [focusRequest, doc, hidden, sessionId]);

  // ⌘Z / ⌘⇧Z (macOS) and Ctrl+Z / Ctrl+Y (elsewhere) while working in this canvas.
  // Text fields keep their own undo; the menu's undo is skipped by preventDefault.
  useEffect(() => {
    if (hidden || !documentId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const direction = undoKey(e, isMac);
      if (!direction) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest("input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=menu],[role=dialog]")) return;
      if (target && target !== document.body && !root.current?.contains(target) && !toolbarHost?.contains(target)) return;
      e.preventDefault();
      stepRef.current(direction);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden, documentId, toolbarHost]);

  function hideComments() {
    setCommentsHidden(true);
    setActiveCommentId(undefined);
    setComposer(undefined);
    canvas.current?.setMode("select");
    if (tab === "comments") setInspectorOpen(false);
    canvas.current?.focus();
  }

  function showComments() {
    setCommentsHidden(false);
    setHistoryOpen(false);
    setHistorical(undefined);
    setTab("comments");
    setInspectorOpen(true);
  }

  function openThread(comment?: DesignComment, boardId?: string) {
    if (!doc) return;
    setHistorical(undefined);
    setCompare(undefined);
    setComposer(undefined);
    const target = comment?.boardId ?? boardId;
    if (!target || !doc.boards.some((b) => b.id === target)) {
      if (comment) toast.error("That board was deleted.");
      return;
    }
    const targetBoard = doc.boards.find(board => board.id === target)!;
    if (designPageId(doc, targetBoard) !== activePageId) selectPage(designPageId(doc, targetBoard));
    setSelectedIds([target]);
    setSelection(undefined);
    // A stale layer request would reselect on the comment reload and switch
    // the inspector from Comments to Properties after resolving a thread.
    setLayerTarget(undefined);
    setActiveCommentId(comment?.id);
    if (comment) {
      setCommentsHidden(false);
      setHistoryOpen(false);
      setTab("comments");
      setInspectorOpen(true);
    }
    setFocusTarget({ boardId: target, rect: comment?.anchor.rect, nonce: Date.now() });
  }

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      await action();
    } catch (e) {
      if (mounted.current) setFailure(errorText(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  /** Every canvas edit goes through here, so ⌘Z can undo it. */
  const writeDesign = async (operations: DesignOperation[], summary?: string) => {
    if (!doc || !sessionId) throw new Error("Design is not editable right now.");
    const before = doc;
    const result = await window.electron.design.update({
      sessionId,
      documentId: before.id,
      operationId: uid(),
      operations,
      ...(summary ? { summary } : {}),
    });
    const stack = undoStacks.get(before.id) ?? new DesignUndo();
    undoStacks.set(before.id, stack);
    stack.record({
      from: result.revision - 1,
      to: result.revision,
      boardIds: touchedBoards(operations, before.boards, result.boards),
      title: operations.some((op) => op.type === "title"),
      canvas: operations.some((op) => op.type === "canvas"),
      summary: summary || summarizeOperations(operations, before),
    });
    return result;
  };
  /** Undo or redo the person's last canvas edit by restoring the boards it touched. */
  const step = (direction: "undo" | "redo") =>
    run(async () => {
      if (!doc || !sessionId || !editable) return;
      const stack = undoStacks.get(doc.id);
      const sourceStack = direction === "undo" ? stack?.undo : stack?.redo;
      const entry = sourceStack?.at(-1);
      if (!stack || !entry) return;
      const history = await window.electron.design.history({ sessionId, documentId: doc.id });
      const headNow = history[0]?.revision ?? head;
      if (blockedBy(entry, history, stack.ownedRevisions)) {
        // The agent edited the same boards since; restoring would discard that.
        stack.undo = [];
        stack.redo = [];
        toast(`${agentName} changed this since your edit. Use History to restore an earlier version.`);
        return;
      }
      const result = await window.electron.design.restore({
        sessionId,
        documentId: doc.id,
        revision: entry.from,
        expectedRevision: headNow,
        operationId: uid(),
        ...(entry.boardIds.length ? { boardIds: entry.boardIds } : {}),
        title: entry.title,
        canvas: entry.canvas,
        summary: `${direction === "undo" ? "Undo" : "Redo"} · ${entry.summary}`,
      });
      sourceStack?.pop();
      stack.ownedRevisions.add(result.revision);
      const back = { ...entry, from: entry.to, to: result.revision };
      if (direction === "undo") stack.redo.push(back);
      else stack.undo.push(back);
      await reload();
      if (historyOpen) await loadHistory();
    });
  stepRef.current = (direction) => void step(direction);
  const update = (operations: DesignOperation[], summary?: string) => {
    if (!editable || !doc || !sessionId) return Promise.resolve();
    return run(async () => {
      await writeDesign(operations, summary);
      await reload();
    });
  };
  const selectPage = (id: string) => {
    setTweakPreview(undefined);
    setPageChoice(id);
    rendererStateStorage.setItem(pageKey, id);
    setSelection(undefined); setSelectedIds([]); setSelectedMarkIds([]);
    setLayerTarget(undefined); setFocusTarget(undefined); setActiveCommentId(undefined);
    setTextEdit(undefined); setTextInsert(undefined); setComposer(undefined); setPreviewing(false);
  };
  const createPage = () => void run(async () => {
    if (!doc || !editable || pages.length >= 40) return;
    if (doc.boards.length >= 32) throw new Error("This design has 32 boards. Remove a board before adding a page.");
    const page = { id: "page-" + uid(), name: `Page ${pages.length + 1}` };
    await writeDesign([
      { type: "canvas", expectedRevision: doc.revision, pages: [...pages, page] },
      { type: "add", name: nextBoardName(doc.boards), html: BLANK_BOARD, x: 0, y: 0, pageId: page.id },
    ], `Added ${page.name}`);
    await reload(); selectPage(page.id);
  });
  const deletePage = (id: string) => void run(async () => {
    if (!doc || !editable || pages.length <= 1) return;
    const index = pages.findIndex(page => page.id === id);
    if (index < 0) return;
    const boards = doc.boards.filter(board => designPageId(doc, board) === id);
    const operations: DesignOperation[] = boards.map(board => ({ type: "remove", boardId: board.id, expectedRevision: board.contentRevision }));
    operations.push({ type: "canvas", expectedRevision: doc.revision, pages: pages.filter(page => page.id !== id), marks: (doc.marks ?? []).filter(mark => designPageId(doc, mark) !== id) });
    await writeDesign(operations, `Deleted ${pages[index].name}`);
    await reload(); if (activePageId === id) selectPage(pages[index - 1]?.id ?? pages[index + 1].id);
    requestAnimationFrame(() => canvas.current?.focus());
  });
  const changeMarks = (changed: DesignMark[], reason: string) => {
    if (!doc) return;
    const byId = new Map(changed.map(mark => [mark.id, mark]));
    const marks = (doc.marks ?? []).map(mark => byId.get(mark.id) ?? mark);
    return update([{ type: "canvas", expectedRevision: doc.revision, marks }], `Changed canvas ${reason}`);
  };
  const inject = (text: string) => {
    const store = useAppStore.getState();
    const target = sessionId || store.createDraftSession();
    if (!store.sessions[target] && !useAppStore.getState().sessions[target])
      throw new Error("Conversation no longer exists.");
    store.requestChatInjection({
      sessionId: target,
      text,
      attachments: [],
      mode: "append",
      source: "design-canvas",
    });
  };

  /** Hands one thread message to the agent: screenshot, context and a linked chat row. */
  async function deliver(
    comment: DesignComment,
    messageId: string,
    input: CommentInput,
    reply: boolean,
  ) {
    if (!doc || !sessionId) return;
    const board = doc.boards.find((b) => b.id === comment.boardId);
    if (!board) throw new Error("That board was deleted.");
    const preview = await window.electron.design.preview({
      sessionId,
      documentId: doc.id,
      boardId: board.id,
      revision: doc.revision,
    });
    const bytes = Uint8Array.from(atob(preview.dataUrl.split(",")[1]), (c) =>
      c.charCodeAt(0),
    );
    const screenshot = await window.electron.createInlineImageAttachment(
      "image/png",
      bytes,
    );
    // Area comments lead with a close-up of the region, then the whole board.
    const crop =
      comment.anchor.area && comment.anchor.rect
        ? await cropBoardImage(preview.dataUrl, board.width, comment.anchor.rect)
            .then((b) => (b ? window.electron.createInlineImageAttachment("image/png", b) : undefined))
            .catch(() => undefined)
        : undefined;
    const layer = anchorLabel(board, comment.anchor);
    const earlier = comment.messages.filter((m) => m.id !== messageId);
    const state = sendDesignComment({
      sessionId,
      prompt: input.text,
      effectivePrompt: buildDesignCommentPrompt({
        text: input.text,
        documentId: doc.id,
        boardId: board.id,
        boardName: board.name,
        commentId: comment.id,
        contentRevision: board.contentRevision,
        documentRevision: preview.revision,
        anchor: comment.anchor,
        layerName: layer,
        thread: reply ? earlier : undefined,
      }),
      attachments: [
        ...(crop ? [crop] : []),
        ...(screenshot ? [screenshot] : []),
        ...input.attachments,
      ],
      design: {
        kind: "design-comment",
        documentId: doc.id,
        documentTitle: doc.title,
        boardId: board.id,
        boardName: board.name,
        ...(layer ? { layerName: layer } : {}),
        commentId: comment.id,
        messageId,
        reply,
      },
    });
    if (state === "queued") toast(`Queued until ${agentName} finishes the current turn`);
  }
  const submitComment = (target: Selection, input: CommentInput) =>
    run(async () => {
      if (!doc || !sessionId) return;
      const board = doc.boards.find((b) => b.id === target.boardId);
      if (!board) throw new Error("That board was deleted.");
      if (board.contentRevision !== target.revision)
        throw new Error("This board changed. Select the element again.");
      const { computedStyles: _styles, ...anchor } = target.anchor;
      const toAgent = input.toAgent && canMention;
      const comment = await window.electron.design.comment({
        sessionId,
        documentId: doc.id,
        boardId: board.id,
        contentRevision: target.revision,
        anchor: {
          ...anchor,
          rect: anchor.rect ?? { x: 0, y: 0, width: board.width, height: 0 },
        },
        text: input.text,
        id: uid(),
        toAgent,
      });
      setComposer(undefined);
      setActiveCommentId(comment.id);
      await reload();
      if (toAgent)
        await deliver(comment, comment.id, input, false).catch((e) =>
          toast.error(`Saved as a note. ${errorText(e)}`),
        );
    });
  const replyTo = (comment: DesignComment, input: CommentInput) =>
    run(async () => {
      if (!doc || !sessionId) return;
      const toAgent = input.toAgent && canMention;
      const id = uid();
      const next = await window.electron.design.reply({
        sessionId,
        documentId: doc.id,
        commentId: comment.id,
        id,
        text: input.text,
        toAgent,
      });
      await reload();
      if (toAgent)
        await deliver(next, id, input, true).catch((e) =>
          toast.error(`Saved as a reply. ${errorText(e)}`),
        );
    });
  const resolve = (commentId: string, resolved = true) =>
    run(async () => {
      if (!doc || !sessionId) return;
      await window.electron.design.resolve({
        sessionId,
        documentId: doc.id,
        commentId,
        resolved,
      });
      if (activeCommentId === commentId) setActiveCommentId(undefined);
      await reload();
    });
  const restore = (revision: number, boardId?: string) =>
    run(async () => {
      if (!doc || !sessionId) return;
      await window.electron.design.restore({
        sessionId,
        documentId: doc.id,
        revision,
        expectedRevision: head,
        operationId: uid(),
        ...(boardId ? { boardId } : {}),
      });
      setHistorical(undefined);
      setCompare(undefined);
      await reload();
      await loadHistory();
    });
  const changeLayer = async (
    board: NonNullable<typeof activeBoard>,
    html: string,
    summary?: string,
  ) => {
    if (!editable || busy || !sessionId || !doc)
      throw new Error("Design is not editable right now.");
    setBusy(true);
    try {
      await writeDesign(
        [{ type: "content", boardId: board.id, expectedRevision: board.contentRevision, html }],
        summary,
      );
      if (selection?.boardId === board.id && selection.anchor.nodeId) {
        if (!findDesignLayer(readDesignLayers(html), selection.anchor.nodeId)) {
          setSelection(undefined);
          setLayerTarget(undefined);
        }
      }
      await reload();
    } finally {
      setBusy(false);
    }
  };
  const selectLayer = (boardId: string, node: DesignLayer, revision: number) => {
    setSelectedIds([boardId]);
    setSelection({ boardId, revision, anchor: { nodeId: node.id, text: node.text } });
    setLayerTarget({ boardId, nodeId: node.id, request: Date.now() });
  };
  /**
   * Keyboard moves through the layer tree: into the first child, up to the
   * parent (a top-level layer's parent is its board), or across siblings
   * (boards when no layer is selected). False when there is nowhere to go.
   */
  const navigateLayers = (direction: "child" | "parent" | "next" | "prev"): boolean => {
    if (!doc) return false;
    const nodeId = selection?.anchor.nodeId;
    const boardId = selection?.boardId ?? selected;
    const board = doc.boards.find((b) => b.id === boardId);
    if (!board) return false;
    const tree = readDesignLayers(board.html);
    const step = <T,>(list: T[], at: number) => list[(at + (direction === "next" ? 1 : -1) + list.length) % list.length];
    if (!nodeId) {
      if (direction === "child") {
        if (!tree[0]) return false;
        selectLayer(board.id, tree[0], board.contentRevision);
        return true;
      }
      if (direction === "next" || direction === "prev") {
        const pageBoards = doc.boards.filter(item => designPageId(doc, item) === activePageId);
        const next = step(pageBoards, pageBoards.indexOf(board));
        if (!next) return false;
        setSelectedIds([next.id]);
        setSelection(undefined);
        setLayerTarget(undefined);
        return true;
      }
      return false;
    }
    const node = findDesignLayer(tree, nodeId);
    const ancestors = designLayerPath(tree, nodeId);
    if (!node || !ancestors) return false;
    const parent = ancestors[ancestors.length - 1];
    if (direction === "parent") {
      if (parent) selectLayer(board.id, parent, board.contentRevision);
      else {
        setSelectedIds([board.id]);
        setSelection(undefined);
        setLayerTarget(undefined);
      }
      return true;
    }
    if (direction === "child") {
      if (!node.children[0]) return false;
      selectLayer(board.id, node.children[0], board.contentRevision);
      return true;
    }
    const siblings = parent ? parent.children : tree;
    if (siblings.length < 2) return false;
    selectLayer(board.id, step(siblings, siblings.findIndex((n) => n.id === nodeId)), board.contentRevision);
    return true;
  };
  /**
   * Auto layout for the selected layer: lay out its own children (direction
   * and grid columns read from where they are now), or wrap the layer in a
   * new auto layout container, which then becomes the selection.
   */
  const applyAutoLayout = async (kind: AutoLayoutKind | "infer", wrap?: boolean) => {
    const target = selection;
    const board = doc?.boards.find((b) => b.id === target?.boardId);
    const node = board && target?.anchor.nodeId ? findDesignLayer(readDesignLayers(board.html), target.anchor.nodeId) : undefined;
    if (!board || !node) return;
    const wrapIt = wrap ?? node.children.length === 0;
    let layout: { kind: AutoLayoutKind; columns?: number } = { kind: kind === "infer" ? "column" : kind };
    if (!wrapIt && node.children.length > 1) {
      const rects = await canvas.current?.measure(board.id, node.children.map((c) => c.id));
      const boxes = Object.values(rects ?? {}).filter((r): r is NonNullable<typeof r> => !!r);
      const inferred = inferAutoLayout(boxes);
      if (kind === "infer") layout = { kind: inferred.direction };
      if (layout.kind === "grid") layout.columns = inferred.columns > 1 ? inferred.columns : 2;
    }
    const name = node.name.split(" · ")[0];
    try {
      if (wrapIt) {
        const wrapped = wrapInAutoLayout(board.html, node.id, layout);
        await changeLayer(board, wrapped.html, `Wrapped ${name} in auto layout`);
        const fresh = findDesignLayer(readDesignLayers(wrapped.html), wrapped.nodeId);
        if (fresh) selectLayer(board.id, fresh, board.contentRevision + 1);
      } else {
        const label = layout.kind === "grid" ? `a ${layout.columns ?? 2}-column grid` : `a ${layout.kind}`;
        await changeLayer(board, setAutoLayout(board.html, node.id, layout), `Laid out ${name} as ${label}`);
      }
    } catch (e) {
      setFailure(errorText(e));
    }
  };
  /** Text and Frame tools: one write per new layer, which then becomes the selection. */
  const insertLayer = (
    boardId: string,
    revision: number,
    parentId: string | null,
    index: number,
    layer: Parameters<typeof insertDesignLayer>[3],
    summary: string,
  ) => {
    // Another save is in flight: keep the new layer and write it right after.
    if (busy) {
      pendingInsert.current = [boardId, revision, parentId, index, layer, summary];
      return;
    }
    return run(async () => {
      const board = doc?.boards.find((b) => b.id === boardId);
      if (!board) throw new Error("That board was deleted.");
      if (board.contentRevision !== revision)
        throw new Error("The board changed while you were adding to it. Try again.");
      const { html, nodeId } = insertDesignLayer(board.html, parentId ?? undefined, index, layer);
      const result = await writeDesign(
        [{ type: "content", boardId, expectedRevision: board.contentRevision, html }],
        summary,
      );
      await reload();
      const next = result.boards.find((b) => b.id === boardId);
      const node = next && findDesignLayer(readDesignLayers(next.html), nodeId);
      if (next && node) selectLayer(boardId, node, next.contentRevision);
    });
  };
  const pendingInsert = useRef<Parameters<typeof insertLayer> | null>(null);
  useEffect(() => {
    const args = pendingInsert.current;
    if (busy || !args) return;
    pendingInsert.current = null;
    void insertLayer(...args);
  }, [busy]);
  const createBoard = (rect: Rect) =>
    run(async () => {
      if (!doc) return;
      const name = nextBoardName(doc.boards);
      const result = await writeDesign(
        [{ type: "add", pageId: activePageId, name, html: BLANK_BOARD, x: Math.round(rect.x), y: Math.round(rect.y), width: rect.width, height: rect.height }],
        `Added ${name}`,
      );
      await reload();
      const created = result.boards.find((b) => !doc.boards.some((o) => o.id === b.id));
      if (created) {
        setSelection(undefined);
        setLayerTarget(undefined);
        setSelectedIds([created.id]);
      }
    });
  /** In-place text editing for an unlocked text layer on the current version. */
  const editableText = (target: Selection | undefined) => {
    if (!editable || !target?.anchor.nodeId || !doc) return undefined;
    const board = doc.boards.find((b) => b.id === target.boardId);
    if (!board || board.contentRevision !== target.revision) return undefined;
    const tree = readDesignLayers(board.html);
    const node = findDesignLayer(tree, target.anchor.nodeId);
    if (!node?.textEditable || node.locked) return undefined;
    if (designLayerPath(tree, node.id)?.some((n) => n.locked)) return undefined;
    return { board, node };
  };
  /** The selected layer can be dragged or resized: current version, unlocked. */
  const layerEditable = (target: Selection | undefined) => {
    if (!editable || busy || !target?.anchor.nodeId || !doc) return undefined;
    const board = doc.boards.find((b) => b.id === target.boardId);
    if (!board || board.contentRevision !== target.revision) return undefined;
    const tree = readDesignLayers(board.html);
    const node = findDesignLayer(tree, target.anchor.nodeId);
    if (!node || node.locked) return undefined;
    const path = designLayerPath(tree, node.id) ?? [];
    if (path.some((n) => n.locked)) return undefined;
    return { board, node, tree };
  };
  const shortName = (name: string) => name.split(" · ")[0];
  const moveLayer = async (
    board: NonNullable<typeof activeBoard>,
    nodeId: string,
    parentId: string,
    index: number,
  ) => {
    try {
      const tree = readDesignLayers(board.html);
      const node = findDesignLayer(tree, nodeId);
      const parent = findDesignLayer(tree, parentId);
      const sameParent = designLayerPath(tree, nodeId)?.at(-1)?.id === parentId;
      await changeLayer(
        board,
        moveDesignLayer(board.html, nodeId, parentId, index),
        node && parent
          ? sameParent
            ? `Reordered ${shortName(node.name)} in ${shortName(parent.name)}`
            : `Moved ${shortName(node.name)} into ${shortName(parent.name)}`
          : undefined,
      );
      return true;
    } catch (e) {
      setFailure(errorText(e));
      return false;
    }
  };
  const resizeLayer = async (
    board: NonNullable<typeof activeBoard>,
    nodeId: string,
    size: Record<string, string>,
  ) => {
    try {
      const node = findDesignLayer(readDesignLayers(board.html), nodeId);
      if (!node) throw new Error("Layer no longer exists.");
      const el = document.createElement("div");
      el.style.cssText = node.styles.cssText;
      // A width replaces Fill: drop the flex shorthand before setting longhands.
      if (size.width) el.style.removeProperty("flex");
      for (const [k, v] of Object.entries(size)) {
        if (v) el.style.setProperty(k, v, "important");
        else el.style.removeProperty(k);
      }
      const hug = size.width === "fit-content" || size.height === "";
      await changeLayer(
        board,
        replaceDesignLayerStyle(board.html, nodeId, el.style.cssText),
        hug ? `${shortName(node.name)} hugs its content` : `Resized ${shortName(node.name)}`,
      );
      return true;
    } catch (e) {
      setFailure(errorText(e));
      return false;
    }
  };
  const styleLayer = async (
    board: NonNullable<typeof activeBoard>,
    nodeId: string,
    styles: Record<string, string>,
    kind: "gap" | "padding" | "move" | "absolute",
  ) => {
    try {
      const node = findDesignLayer(readDesignLayers(board.html), nodeId);
      if (!node) throw new Error("Layer no longer exists.");
      const el = document.createElement("div");
      el.style.cssText = node.styles.cssText;
      for (const [k, v] of Object.entries(styles)) {
        if (v && v !== "auto") el.style.setProperty(k, v, "important");
        else el.style.removeProperty(k);
      }
      const name = shortName(node.name);
      await changeLayer(
        board,
        replaceDesignLayerStyle(board.html, nodeId, el.style.cssText),
        kind === "gap"
          ? `Changed gap in ${name}`
          : kind === "padding"
            ? `Changed padding of ${name}`
            : kind === "absolute"
              ? `Made ${name} absolute`
              : `Moved ${name}`,
      );
      return true;
    } catch (e) {
      setFailure(errorText(e));
      return false;
    }
  };
  const startTextEdit = (
    target: (Selection & { caret?: { x: number; y: number } }) | undefined = selection,
  ): boolean => {
    if (!editableText(target)) return false;
    setComposer(undefined);
    setActiveCommentId(undefined);
    setTextEdit(target);
    return true;
  };
  const startComment = (): boolean => {
    if (!editable || !doc) return false;
    setCommentsHidden(false);
    if (selection) {
      setComposer(selection);
      setActiveCommentId(undefined);
      return true;
    }
    if (activeBoard) {
      setComposer({ boardId: activeBoard.id, revision: activeBoard.contentRevision, anchor: {} });
      setActiveCommentId(undefined);
      return true;
    }
    return false;
  };
  /**
   * Hands the selected boards (or all of them) to the project: their HTML and
   * a README are written under .aegis/design/, then the request goes to the
   * agent pointing at those files. Without a project folder, the agent reads
   * the design itself.
   */
  const implement = () =>
    run(async () => {
      if (!doc || !sessionId) return;
      const boardIds = selectedIds.filter((id) => doc.boards.some((b) => b.id === id));
      const chosen = boardIds.length ? doc.boards.filter((b) => boardIds.includes(b.id)) : doc.boards;
      const what = chosen.length === 1 ? `the "${chosen[0].name}" board` : `${chosen.length} boards`;
      let handoff: Awaited<ReturnType<typeof window.electron.design.handoff>> | undefined;
      try {
        handoff = await window.electron.design.handoff({ sessionId, documentId: doc.id, boardIds });
      } catch (e) {
        toast(`Couldn't write the boards into the project (${errorText(e)}). The agent will read the design instead.`);
      }
      inject(
        handoff
          ? [
              `Implement ${what} from design "${doc.title}" in this project, using its existing components, styles and tokens.`,
              `The boards are in ${handoff.folder}/ (start with README.md): ${handoff.boards.map((b) => `${b.name} → ${b.file}`).join(", ")}.`,
              `They are static references for layout, type, spacing and copy, not code to paste in. Design ${doc.id} has the latest version (design_read).`,
            ].join(" ")
          : `Implement ${what} from design "${doc.title}" (document ${doc.id}) in this project using its existing components. Read the design with design_read first.`,
      );
      if (handoff) toast.success(`${chosen.length === 1 ? "Board" : `${chosen.length} boards`} written to ${handoff.folder}`);
    });
  /**
   * Export, then say where it went: a save dialog can be cancelled, and a
   * file ready is not a file saved until the user picked where.
   */
  const exportAs = (
    format: "pdf" | "html" | "png",
    boardId?: string,
    only?: { boardIds?: string[]; scale?: 1 | 2 },
  ) =>
    run(async () => {
      const what = format === "pdf" ? "PDF" : format === "html" ? "HTML bundle" : "PNG";
      setExporting(true);
      try {
      const r = await window.electron.design.export({
        sessionId: sessionId!,
        documentId: doc!.id,
        revision: doc!.revision,
        format,
        ...(boardId ? { boardId } : {}),
        ...(only?.boardIds ? { boardIds: only.boardIds } : {}),
        // A board's own download is about that board, wherever its page is.
        ...(!exportAllPages && !boardId && !only?.boardIds ? { pageId: activePageId } : {}),
        ...(format === "png" ? { scale: only?.scale ?? exportScale } : {}),
      });
      if (r.saved && r.path) {
        const saved = r.path;
        toast.success(`${what} saved as ${saved.split(/[\\/]/).pop()}`, {
          action: { label: "Show", onClick: () => void window.electron.revealPath(saved) },
        });
      } else if (!r.saved) toast(`${what} export canceled`);
      } finally { setExporting(false); }
    });
  const exportBoard = (boardId: string) => exportAs("png", boardId);

  if (hidden) return null;
  const projectPath = session?.projectCwd ?? session?.cwd ?? "";
  const projectName = projectPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  if (!documentId)
    return (
      <section
        className="design-panel design-library"
        aria-label="Design workspace"
      >
        <div className="design-library-heading">
          <div>
            <h2>Designs</h2>
            <p>{projectName ? `In ${projectName}` : "In this conversation"}</p>
          </div>
          <button
            className="design-library-new"
            disabled={!session || session.readOnly || busy || session.isDraft}
            onClick={() =>
              void run(async () => {
                const d = await window.electron.design.create({
                  sessionId: sessionId!,
                  title: "Untitled design",
                  operationId: uid(),
                });
                useAppStore
                  .getState()
                  .setActiveRightUtilityTab(`design:${d.id}`);
              })
            }
          >
            <Plus size={14} />
            New design
          </button>
        </div>
        {failure && (
          <p role="alert" className="design-error">
            {failure}
          </p>
        )}
        {list.length ? (
          <DesignCards
            designs={list}
            coverSession={sessionId ?? undefined}
            tagMembers
            onOpen={(d) => useAppStore.getState().setActiveRightUtilityTab(`design:${d.id}`)}
          />
        ) : (
          <div className="design-welcome">
            <div className="design-empty-boards">
              <i />
              <i />
            </div>
            <h3>A canvas for your next idea</h3>
            <p>
              Describe a website or app. {agentName} draws the boards here,
              ready for your feedback.
            </p>
            <button
              onClick={() =>
                inject(
                  "Design a homepage and a pricing page for this project with the design tools.",
                )
              }
              disabled={!!session?.readOnly}
            >
              Start designing in chat ↗
            </button>
          </div>
        )}
      </section>
    );

  const openCommentCount = doc?.comments.filter(comment => comment.status !== "resolved").length ?? 0;
  const pins: CanvasPin[] = (doc?.comments ?? [])
    .filter((c) => (c.status !== "resolved" || c.id === activeCommentId) && canvasBoards.some(board => board.id === c.boardId))
    .map((c) => ({
      id: c.id,
      boardId: c.boardId,
      nodeId: c.anchor.nodeId,
      nodeIds: c.anchor.area ? c.anchor.nodeIds : undefined,
      offset: c.anchor.offset,
      rect: c.anchor.rect,
      initial: initialOf(authorName(c.author, user)),
      status: c.status,
    }));
  const activeComment = doc?.comments.find((c) => c.id === activeCommentId);
  const compareComment = doc?.comments.find((c) => c.id === compare?.commentId);
  const status = historical
    ? "Viewing an earlier version"
    : exporting
      ? "Preparing export…"
      : busy
      ? "Saving…"
      : session?.readOnly
        ? "Read-only"
        : "saved";

  const pagePicker = (
    doc && <DesignPages pages={pages} activeId={activePageId} editable={editable && !busy}
          onSelect={selectPage} onCreate={createPage} onDelete={deletePage}
          onRename={(id, name) => void update([{ type: "canvas", expectedRevision: doc.revision, pages: pages.map(page => page.id === id ? { ...page, name } : page) }], `Renamed page to ${name}`)}
          counts={id => ({ boards: doc.boards.filter(board => designPageId(doc, board) === id).length, marks: (doc.marks ?? []).filter(mark => designPageId(doc, mark) === id).length })} />
  );

  const toolbar = (
      <header className="design-toolbar">
        {(chrome === "pane" || chrome === "section") && (
          <button
            className="design-icon-button design-back-button"
            title="All designs"
            aria-label="All designs"
            onClick={() =>
              chrome === "section"
                ? useDesignStore.getState().setSection(null)
                : useAppStore.getState().setActiveRightUtilityTab("design")
            }
          >
            <ArrowLeft size={15} />
          </button>
        )}
        {doc && renaming ? (
          <input
            className="design-title is-editing"
            aria-label="Design title"
            defaultValue={doc.title}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              setRenaming(false);
              const title = e.target.value.trim();
              if (title && title !== doc.title)
                void update([{ type: "title", title, expectedRevision: doc.revision }]);
            }}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.currentTarget.value = doc.title;
                e.currentTarget.blur();
              }
            }}
          />
        ) : doc ? (
          <button
            ref={exportTrigger}
            className="design-title design-title-button"
            aria-label={`${doc.title}, design actions`}
            title={editable ? "Double-click to rename" : undefined}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={!!exportMenu}
            onClick={(e) => {
              clearTimeout(titleClick.current);
              // Keyboard opens at once; a mouse click waits to see if it becomes a double click.
              if (e.detail === 0) setExportMenu(exportMenu ? undefined : true);
              else if (e.detail === 1) titleClick.current = setTimeout(() => setExportMenu((open) => (open ? undefined : true)), 220);
            }}
            onDoubleClick={() => editable && startRename()}
            // Rename lives on the title itself: double click, or F2 from the keyboard.
            onKeyDown={(e) => {
              if (e.key === "F2" && editable) {
                e.preventDefault();
                startRename();
              }
            }}
          >
            <span className="design-title-text">{doc.title}</span>
            <ChevronDown size={14} />
          </button>
        ) : (
          <strong>Loading design…</strong>
        )}
        {/* Only what needs attention: saving, read-only, or an old version on view. */}
        {status !== "saved" && <span className="design-meta">{status}</span>}
        <span className="design-spacer" />
        <DesignCommentControls active={commentMode} visible={!commentsHidden || inspectorOpen && tab === "comments"}
          count={openCommentCount}
          disabled={!doc || !!historical || previewing}
          onToggleMode={() => { if (commentMode) hideComments(); else { setCommentsHidden(false); canvas.current?.setMode("comment"); canvas.current?.focus(); } }}
          onShow={showComments} onHide={hideComments} />
      </header>
  );

  return (
    <>
    <section
      ref={root}
      className="design-panel"
      aria-label="Design canvas"
      data-design-document={documentId}
    >
      {toolbarHost
        ? createPortal(<div className="design-panel design-panel--titlebar">{toolbar}</div>, toolbarHost)
        : toolbar}
      {failure && (
        <div className="design-error" role="alert">
          {failure}
          <button
            onClick={() => {
              setFailure("");
              void reload();
            }}
          >
            Refresh
          </button>
        </div>
      )}
      {historical && (
        <div className="design-historical">
          <strong>Version {historical}</strong>
          <span className="design-spacer" />
          <button
            disabled={busy || !!session?.readOnly}
            onClick={() => void restore(historical)}
          >
            Restore document
          </button>
          <button onClick={() => setHistorical(undefined)}>Back to latest</button>
        </div>
      )}
      <div className="design-editor-body">
        <DesignCanvas
          key={documentId + ":" + activePageId}
          apiRef={canvas}
          toolbarLeading={pagePicker}
          commentControlInHeader
          history={{
            canUndo: !!doc && editable && !busy && !!undoStacks.get(doc.id)?.undo.length,
            canRedo: !!doc && editable && !busy && !!undoStacks.get(doc.id)?.redo.length,
            step: (direction) => stepRef.current(direction),
          }}
          inspector={
            !previewing && !historyOpen && doc
              ? { open: inspectorOpen, toggle: () => setInspectorOpen(!inspectorOpen) }
              : undefined
          }
          boards={canvasBoards}
          onAwarenessChange={reportAwareness}
          marks={(doc?.marks ?? []).filter(mark => doc && designPageId(doc, mark) === activePageId)}
          selectedMarkIds={selectedMarkIds}
          onMarkSelectionChange={ids => { setSelectedMarkIds(ids); if (ids.length) { setSelectedIds([]); setSelection(undefined); } }}
          onMarksChange={changeMarks}
          onMarksDelete={ids => { if (doc) void update([{ type: "canvas", expectedRevision: doc.revision, marks: (doc.marks ?? []).filter(mark => !ids.includes(mark.id)) }], "Deleted canvas annotations"); setSelectedMarkIds([]); }}
          onBoardDownload={(boardId, button) =>
            setBoardDownload(boardDownload?.boardId === boardId ? undefined : { boardId, trigger: { current: button } })
          }
          onCreateMark={mark => { if (doc) { void update([{ type: "canvas", expectedRevision: doc.revision, marks: [...(doc.marks ?? []), { ...mark, pageId: activePageId }] }], `Added ${mark.type}`); setSelectedMarkIds([mark.id]); setSelectedIds([]); setSelection(undefined); } }}
          storageKey={"aegis.design.view:" + sessionId + ":" + documentId + ":" + activePageId}
          selectedIds={selectedIds}
          layerTarget={layerTarget}
          selection={selection}
          editable={editable && !busy}
          pins={historical || commentsHidden ? [] : pins}
          onToggleComments={() => commentsHidden ? showComments() : hideComments()}
          onCommentDone={hideComments}
          activePinId={activeCommentId}
          focusTarget={focusTarget}
          onPinOpen={(id) => {
            const c = doc?.comments.find((x) => x.id === id);
            if (c) openThread(c);
          }}
          onCommentRequest={startComment}
          onEditRequest={() => startTextEdit()}
          onNavigate={navigateLayers}
          onAutoLayout={() => void applyAutoLayout("infer")}
          elementEditable={!!layerEditable(selection) && !textEdit && !composer}
          selectionIsText={(() => {
            const n = layerEditable(selection)?.node;
            return !!n?.textEditable && !!n.text;
          })()}
          onLiveRect={setLiveRect}
          onElementMove={moveLayer}
          onModeChange={(m) => {
            setCommentMode(m === "comment");
            if (m === "comment") {
              setTab("comments");
              setCommentsHidden(false);
              setBoardMenu(false);
            }
          }}
          onAreaComment={(board, rect, layers) => {
            if (!editable) return;
            setSelectedIds([board.id]);
            setSelection(undefined);
            setActiveCommentId(undefined);
            setComposer({
              boardId: board.id,
              revision: board.contentRevision,
              anchor: {
                area: true,
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                nodeIds: layers.map((l) => l.id),
              },
            });
          }}
          onElementResize={resizeLayer}
          onElementStyle={styleLayer}
          maskedNode={
            textInsert
              ? { boardId: textInsert.boardId, nodeId: "aegis-insert-preview" }
              : textEdit?.anchor.nodeId
                ? { boardId: textEdit.boardId, nodeId: textEdit.anchor.nodeId }
                : undefined
          }
          onInsertText={(board, target, tag, preview) => {
            setSelection(undefined);
            setLayerTarget(undefined);
            setTextEdit(undefined);
            setTextInsert({ boardId: board.id, revision: board.contentRevision, target, tag, ...preview });
          }}
          onInsertFrame={(board, frame) =>
            "target" in frame
              ? void insertLayer(
                  board.id,
                  board.contentRevision,
                  frame.target.containerId,
                  frame.target.index,
                  { tag: "div", name: "Frame", style: frameStyle(frame.width, frame.height) },
                  `Added a frame to ${board.name}`,
                )
              : void insertLayer(
                  board.id,
                  board.contentRevision,
                  null,
                  Number.MAX_SAFE_INTEGER,
                  { tag: "div", name: "Frame", style: frameStyle(frame.rect.width, frame.rect.height, frame.rect) },
                  `Added a frame to ${board.name}`,
                )
          }
          onCreateBoard={(rect) => void createBoard(rect)}
          onToggleLayers={toggleLayers}
          onSelectionChange={(ids) => {
            setSelectedMarkIds([]);
            setTextEdit(undefined);
            setSelectedIds(ids);
            setSelection(undefined);
            setLayerTarget(undefined);
            setComposer(undefined);
            setBoardMenu(false);
            if (!ids.length) setActiveCommentId(undefined);
          }}
          onElementSelect={(board, anchor, intent) => {
            const comment = intent === "comment";
            const next = { boardId: board.id, revision: board.contentRevision, anchor };
            if (intent === "edit") startTextEdit({ ...next, caret: canvas.current?.lastDoubleClick() });
            else if (textEdit && textEdit.anchor.nodeId !== anchor.nodeId) setTextEdit(undefined);
            setSelectedIds([board.id]);
            setSelection(next);
            // Frames re-report the selected layer after reloads; that is not a new selection.
            const reReport =
              selection?.boardId === board.id && !!anchor.nodeId && selection.anchor.nodeId === anchor.nodeId;
            const keepThread =
              reReport ||
              doc?.comments.find((c) => c.id === activeCommentId)?.anchor.nodeId === anchor.nodeId;
            if (!keepThread) {
              setActiveCommentId(undefined);
              // Commenting keeps the Comments tab; selecting goes back to Design.
              if (tab === "comments" && intent !== "comment") setTab("design");
            }
            setBoardMenu(false);
            if (
              anchor.nodeId &&
              (layerTarget?.nodeId !== anchor.nodeId ||
                layerTarget.boardId !== board.id)
            )
              setLayerTarget({
                boardId: board.id,
                nodeId: anchor.nodeId,
                request: Date.now(),
              });
            // The bridge re-reports the same node after reloads; keep its composer.
            setComposer((open) => {
              const same = open?.boardId === board.id && open.anchor.nodeId === anchor.nodeId;
              // Re-reports of the same layer keep the clicked point.
              const kept = same && !anchor.offset ? { ...next, anchor: { ...next.anchor, offset: open!.anchor.offset } } : next;
              return (comment && editable) || same ? kept : undefined;
            });
          }}
          onElementCommand={(command, dx = 0, dy = 0) => {
            if (!selection?.anchor.nodeId || !activeBoard || !editable) return;
            void run(async () => {
              if (selection.revision !== activeBoard.contentRevision)
                throw new Error(
                  "Layer changed. Select it again before editing.",
                );
              const nodeId = selection.anchor.nodeId!;
              let html: string;
              if (command === "nudge") {
                const node = findDesignLayer(
                  readDesignLayers(activeBoard.html),
                  nodeId,
                );
                if (!node) throw new Error("Layer no longer exists.");
                const style = document.createElement("div").style;
                style.cssText = node.styles.cssText;
                const computed = selection.anchor.computedStyles ?? {};
                const position = computed.position || "static";
                if (position === "static")
                  style.setProperty("position", "relative", "important");
                style.setProperty(
                  "left",
                  (position === "static" ? 0 : parseFloat(computed.left) || 0) +
                    dx +
                    "px",
                  "important",
                );
                style.setProperty(
                  "top",
                  (position === "static" ? 0 : parseFloat(computed.top) || 0) +
                    dy +
                    "px",
                  "important",
                );
                html = replaceDesignLayerStyle(
                  activeBoard.html,
                  nodeId,
                  style.cssText,
                );
              } else
                html = editDesignLayer(activeBoard.html, nodeId, {
                  type: command,
                });
              await writeDesign([
                {
                  type: "content",
                  boardId: activeBoard.id,
                  expectedRevision: activeBoard.contentRevision,
                  html,
                },
              ]);
              if (command === "remove") {
                setSelection(undefined);
                setLayerTarget(undefined);
              }
              await reload();
            });
          }}
          onChange={update}
          onPreviewChange={setPreviewing}
          overlay={(ctx) => {
            const nodes: React.ReactNode[] = [];
            // Selection controls follow the selected layer type and edit capability.
            if (textInsert) {
              const r = ctx.toScreen(textInsert.boardId, textInsert.rect);
              const finish = () => {
                setTextInsert(undefined);
                canvas.current?.resetPreview(textInsert.boardId);
                canvas.current?.focus();
              };
              if (r)
                nodes.push(
                  <InlineTextEditor
                    key="text:insert"
                    rect={r}
                    zoom={ctx.view.zoom}
                    styles={textInsert.styles}
                    text=""
                    placeholder="Text"
                    grow={textInsert.target.direction === "row"}
                    onCancel={finish}
                    onCommit={(value) => {
                      const t = textInsert;
                      finish();
                      const board = doc?.boards.find((b) => b.id === t.boardId);
                      void insertLayer(
                        t.boardId,
                        t.revision,
                        t.target.containerId,
                        t.target.index,
                        { tag: t.tag, text: value },
                        `Added text to ${board?.name ?? "the board"}`,
                      );
                    }}
                  />,
                );
            }
            if (textEdit) {
              const target = editableText(textEdit);
              const r = ctx.toScreen(textEdit.boardId, textEdit.anchor.rect);
              if (target && r)
                nodes.push(
                  <InlineTextEditor
                    key={"text:" + textEdit.anchor.nodeId}
                    rect={r}
                    zoom={ctx.view.zoom}
                    styles={textEdit.anchor.computedStyles ?? {}}
                    text={target.node.text}
                    caret={textEdit.caret}
                    onCancel={() => {
                      setTextEdit(undefined);
                      canvas.current?.focus();
                    }}
                    onCommit={(value) => {
                      setTextEdit(undefined);
                      canvas.current?.focus();
                      void changeLayer(
                        target.board,
                        editDesignLayer(target.board.html, target.node.id, { type: "text", value }),
                        `Edited text of ${target.node.name.split(" · ")[0]} on ${target.board.name}`,
                      ).catch((e) => setFailure(errorText(e)));
                    }}
                  />,
                );
            }
            if (selection && !composer && !activeComment && !textEdit && !previewing && !ctx.gesturing && (ctx.mode === "select" || ctx.mode === "pan")) {
              const r = ctx.toScreen(selection.boardId, selection.anchor.rect);
              if (r)
                nodes.push(
                  <DesignFloatingToolbar key="selection-bar" rect={r} viewport={ctx.size}>
                    {doc?.boards.find(board => board.id === selection.boardId) && <SelectionTools
                      key={selection.boardId + ":" + (selection.anchor.nodeId ?? "area")}
                      board={doc.boards.find(board => board.id === selection.boardId)!}
                      anchor={selection.anchor}
                      revision={selection.revision}
                      editable={editable && !busy}
                      onChange={(board, html) => changeLayer(board, html, "Changed selected layer style")}
                      onEditText={() => startTextEdit()}
                      onComment={() => startComment()}
                      onProperties={() => { setInspectorOpen(true); setHistoryOpen(false); setTab("design"); }}
                    />}
                  </DesignFloatingToolbar>,
                );
              // The selection's size under it, like a design tool's dimension badge.
              const box = liveRect ?? selection.anchor.rect;
              if (r && box)
                nodes.push(
                  <span
                    key="selection-size"
                    className="design-size-badge"
                    data-canvas-ui
                    style={{ left: r.x + r.width / 2, top: r.y + r.height + 6 }}
                  >
                    {Math.round(box.width)} × {Math.round(box.height)}
                  </span>,
                );
            }
            // Board toolbar under a selected board.
            if (activeBoard && !selection && !composer && !previewing && (ctx.mode === "select" || ctx.mode === "pan")) {
              const r = ctx.toScreen(activeBoard.id);
              if (r)
                nodes.push(
                  <DesignFloatingToolbar key="board-bar" rect={r} viewport={ctx.size}>
                    <button
                      aria-label="Layers"
                      title="Layers (⌥L)"
                      aria-pressed={layersOpen}
                      onClick={toggleLayers}
                    >
                      <Layers size={14} />
                    </button>
                    <span className="design-float-name">{activeBoard.name}</span>
                    <button disabled={!editable} onClick={() => startComment()}>
                      Comment <kbd>C</kbd>
                    </button>
                    <button
                      aria-label={"Preview " + activeBoard.name}
                      title="Preview (Enter)"
                      onClick={() => canvas.current?.preview(activeBoard.id)}
                    >
                      ↗
                    </button>
                    <button
                      ref={boardMenuTrigger}
                      aria-label="More board actions"
                      aria-haspopup="menu"
                      aria-expanded={boardMenu}
                      onClick={() => setBoardMenu((v) => !v)}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                    {boardMenu && (
                      <DesignActionMenu trigger={boardMenuTrigger} onClose={() => setBoardMenu(false)}>
                        <button
                          role="menuitem"
                          disabled={!editable || busy}
                          onClick={() => {
                            setBoardMenu(false);
                            void update([
                              {
                                type: "duplicate",
                                boardId: activeBoard.id,
                                expectedRevision: activeBoard.contentRevision,
                              },
                            ]);
                          }}
                        >
                          Duplicate board
                        </button>
                        <button
                          role="menuitem"
                          disabled={busy}
                          onClick={() => {
                            setBoardMenu(false);
                            void exportBoard(activeBoard.id);
                          }}
                        >
                          Export PNG
                        </button>
                        <button
                          role="menuitem"
                          disabled={!editable || busy}
                          onClick={() => {
                            setBoardMenu(false);
                            void update([
                              {
                                type: "remove",
                                boardId: activeBoard.id,
                                expectedRevision: activeBoard.contentRevision,
                              },
                            ]);
                          }}
                        >
                          Delete board
                        </button>
                      </DesignActionMenu>
                    )}
                  </DesignFloatingToolbar>,
                );
            }
            if (composer) {
              const board = doc?.boards.find((b) => b.id === composer.boardId);
              const r = ctx.toScreen(
                composer.boardId,
                composer.anchor.rect ?? (board ? { x: 0, y: 0, width: board.width, height: 0 } : undefined),
              );
              if (r)
                nodes.push(
                  ...(composer.anchor.area
                    ? [
                        <div
                          key="composer-area"
                          className="design-area-screen"
                          style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
                        />,
                      ]
                    : []),
                  <div
                    key="composer"
                    className="design-popover"
                    style={placeBeside(r, ctx.size, 320)}
                  >
                    <CommentComposer
                      canMention={canMention}
                      busy={busy}
                      onSubmit={(input) => submitComment(composer, input)}
                      onCancel={() => {
                        setComposer(undefined);
                        canvas.current?.focus();
                      }}
                    />
                  </div>,
                );
            }
            if (activeComment && !composer && !previewing && !commentsHidden) {
              const rect = ctx.pinRect(activeComment.id);
              const r = rect && ctx.toScreen(activeComment.boardId, rect);
              const board = doc?.boards.find((b) => b.id === activeComment.boardId);
              if (r) {
                nodes.push(
                  <div
                    key="thread-target"
                    className={"design-thread-target" + (activeComment.anchor.area ? " is-area" : "")}
                    style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
                  />,
                  <div
                    key="thread"
                    className="design-popover"
                    style={placeBeside(r, ctx.size, 340)}
                  >
                    <CommentThread
                      key={activeComment.id}
                      comment={activeComment}
                      user={user}
                      boardName={board?.name ?? "board"}
                      anchorLost={
                        !!board &&
                        !!activeComment.anchor.nodeId &&
                        !board.html.includes(`data-aegis-node-id="${activeComment.anchor.nodeId}"`)
                      }
                      canMention={canMention}
                      editable={editable}
                      busy={busy}
                      onReply={(input) => replyTo(activeComment, input)}
                      onResolve={() => void resolve(activeComment.id, activeComment.status !== "resolved")}
                      onClose={() => {
                        setActiveCommentId(undefined);
                        canvas.current?.focus();
                      }}
                      onCompare={(from, to) =>
                        setCompare({ boardId: activeComment.boardId, from, to, commentId: activeComment.id })
                      }
                    />
                  </div>,
                );
              }
            }
            // Prompt cards: the message behind each board, under it, to run again.
            if (chrome === "section" && !commentsHidden && !historical && !previewing && !ctx.gesturing && doc) {
              for (const board of doc.boards) {
                const asked = prompts[board.id];
                const r = asked && ctx.toScreen(board.id);
                if (!asked || !r || r.width < 140) continue;
                nodes.push(
                  <div
                    key={`prompt:${board.id}`}
                    className="design-prompt-card"
                    data-canvas-ui
                    data-prompt-board={board.id}
                    style={{ left: r.x, top: r.y + r.height + 10, maxWidth: Math.min(r.width, 380) }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <span className="design-prompt-text" title={asked.prompt}>
                      “{asked.prompt}”
                    </span>
                    <button
                      disabled={!sessionId || !!session?.readOnly}
                      title="Send this message again"
                      onClick={() =>
                        sessionId &&
                        useAppStore.getState().requestChatInjection({
                          sessionId,
                          text: asked.prompt,
                          mode: "append",
                          submit: true,
                          source: "design-rerun",
                        })
                      }
                    >
                      Re-run
                    </button>
                  </div>,
                );
              }
            }
            return nodes;
          }}
        >
          {!canvasBoards.length && !(doc?.marks ?? []).some(mark => doc && designPageId(doc, mark) === activePageId) && (
            <div className="design-canvas-empty">
              <span>▧</span>
              <p>Your boards will appear here.</p>
              <button
                data-canvas-ui
                disabled={!doc || !!session?.readOnly}
                onClick={() =>
                  inject(
                    "Design the first page in canvas " +
                      documentId +
                      ". Use design_read and design_update, then design_preview.",
                  )
                }
              >
                Describe a design in chat ↗
              </button>
            </div>
          )}

        </DesignCanvas>
        {!previewing && historyOpen && doc && (
          <HistoryPanel
            versions={versions}
            head={head}
            selected={historical}
            user={user}
            currentSessionId={sessionId ?? undefined}
            editable={!!session && !session.readOnly}
            busy={busy}
            boardName={(id) => doc.boards.find((b) => b.id === id)?.name}
            onSelect={(revision) => {
              setHistorical(revision);
              setSelection(undefined);
              setComposer(undefined);
              setActiveCommentId(undefined);
            }}
            onRestore={(revision, boardId) => void restore(revision, boardId)}
            onCompare={(from, to, boardId) => {
              const info = versions.find((v) => v.revision === to);
              setCompare({ boardId: boardId ?? info?.boardIds[0] ?? "", from, to, commentId: info?.commentId ?? undefined });
            }}
            onClose={() => {
              setHistoryOpen(false);
              setHistorical(undefined);
            }}
          />
        )}
        {!previewing && !historyOpen && doc && inspectorOpen && (
          <aside className="design-inspector" aria-label="Inspector" style={{ width: inspectorWidth }}>
            <InspectorResizer
              width={inspectorWidth}
              onPreview={setInspectorWidth}
              onCommit={saveInspectorWidth}
            />
            <div className="design-tabs" role="tablist" aria-label="Inspector views">
              {(["design", "tweaks", "code", "comments"] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => { setTab(t); if (t === "comments") setCommentsHidden(false); }}
                >
                  {t === "design" ? "Properties" : t === "tweaks" ? "Tweaks" : t === "code" ? "Code" : "Comments"}
                  {t === "comments" && openCommentCount > 0 && (
                    <span className="design-count">{openCommentCount}</span>
                  )}
                </button>
              ))}
              {tab === "comments" && (
                <button
                  className="design-comments-toggle"
                  aria-label={commentsHidden ? "Show comments" : "Hide comments"}
                  title={(commentsHidden ? "Show comments" : "Hide comments") + " (⇧C)"}
                  aria-pressed={commentsHidden}
                  onClick={() => commentsHidden ? showComments() : hideComments()}
                >
                  {commentsHidden ? <EyeOff size={16} stroke={1.5} /> : <Eye size={16} stroke={1.5} />}
                </button>
              )}
              <button className="design-inspector-close" aria-label={tab === "comments" ? "Close comments" : "Close properties"} title={tab === "comments" ? "Close comments" : "Close properties"} onClick={() => tab === "comments" ? hideComments() : setInspectorOpen(false)}><X size={14} /></button>
            </div>
            {tab !== "comments" && <DesignLayersSection>
            <LayersPopover embedded
              boards={doc.boards.filter(board => designPageId(doc, board) === activePageId)}
              selectedBoardId={selected}
              selection={selection}
              editable={editable && !busy}
              onBoardSelect={(id) => {
                setSelectedIds([id]);
                setSelection(undefined);
                setLayerTarget(undefined);
              }}
              onSelect={(board, node) =>
                selectLayer(board.id, node, board.contentRevision)
              }
              onChange={(board, html) => changeLayer(board, html)}
              onClose={() => {
                setInspectorOpen(false);
                canvas.current?.focus();
              }}
              onOpenHistory={() => {
                setHistoryOpen(true);
              }}
            />
            </DesignLayersSection>}
            {tab === "design" &&
              (selection && activeBoard && selection.anchor.nodeId ? (
                <ElementDesignTab
                  loadStyles={loadLayerStyles}
                  onAutoLayout={(kind, wrap) => void applyAutoLayout(kind, wrap)}
                  live={liveRect}
                  board={activeBoard}
                  selection={selection}
                  editable={editable && !busy}
                  onChange={(board, html) => changeLayer(board, html)}
                  onSelectLayer={(node) =>
                    selectLayer(activeBoard.id, node, activeBoard.contentRevision)
                  }
                  onSelectBoard={() => {
                    setSelection(undefined);
                    setLayerTarget(undefined);
                  }}
                />
              ) : activeBoard ? (
                <BoardDesignTab
                  board={activeBoard}
                  revision={head}
                  editable={editable}
                  busy={busy}
                  onUpdate={(ops) => update(ops)}
                  onFitHeight={async () => {
                    const height = await canvas.current?.contentHeight(activeBoard.id);
                    if (!height) return;
                    const h = Math.max(100, Math.min(4096, height));
                    if (h !== activeBoard.height)
                      void update([
                        {
                          type: "placement",
                          boardId: activeBoard.id,
                          expectedRevision: activeBoard.placementRevision,
                          height: h,
                        },
                      ]);
                  }}
                  onExport={() => void exportBoard(activeBoard.id)}
                />
              ) : (
                <div className="design-inspector-empty"><strong>Nothing selected</strong><span>Click any element in the design to edit it here.</span></div>
              ))}
            {tab === "tweaks" && <DesignTweaksTab board={activeBoard} editable={editable && !busy}
              onChange={(board, html) => changeLayer(board, html, `Saved tweaks for ${board.name}`)}
              onPreview={html => setTweakPreview(html && activeBoard ? { boardId: activeBoard.id, revision: activeBoard.contentRevision, html } : undefined)} />}
            {tab === "code" && (
              <CodeTab hideTree
                editable={editable && !busy}
                onChange={(board, html) => changeLayer(board, html)}
                board={activeBoard}
                selection={selection}
                loadStyles={async (boardId, nodeId) =>
                  (await canvas.current?.styles(boardId, nodeId)) ?? null
                }
                onBoardSelect={(board) => {
                  setSelectedIds([board.id]);
                  setSelection(undefined);
                  setLayerTarget(undefined);
                }}
                onSelect={(board, node) => selectLayer(board.id, node, board.contentRevision)}
              />
            )}
            {tab === "comments" && (
              <CommentsList
                doc={doc}
                user={user}
                activeId={activeCommentId}
                queuedIds={queuedIds}
                editable={editable && !busy}
                onOpen={(c) => openThread(c)}
                onResolve={(c) => void resolve(c.id, c.status !== "resolved")}
              />
            )}
          </aside>
        )}
        {compare && doc && sessionId && (
          <DesignCompare
            key={`${compare.boardId}:${compare.from}:${compare.to}`}
            sessionId={sessionId}
            documentId={doc.id}
            boardId={compare.boardId}
            from={compare.from}
            to={compare.to}
            info={versions.find((v) => v.revision === compare.to)}
            comment={compareComment}
            user={user}
            editable={!!session && !session.readOnly}
            onClose={() => setCompare(undefined)}
            onResolve={(id) => {
              void resolve(id);
              setCompare(undefined);
            }}
            onReply={(id) => {
              setCompare(undefined);
              const c = doc.comments.find((x) => x.id === id);
              if (c) openThread(c);
            }}
            onRestore={(revision, boardId) => void restore(revision, boardId)}
          />
        )}
      </div>
    </section>
    {exportMenu &&
      doc &&
      <DesignActionMenu trigger={exportTrigger} onClose={() => setExportMenu(undefined)} label="Design actions" align="start" className="design-export-actions">
            <button className="design-menu-icon-action" role="menuitem" disabled={!editable || busy} onClick={() => { setExportMenu(undefined); void update([{ type: "add", pageId: activePageId, name: nextBoardName(doc?.boards ?? []) }]); }}><Plus size={16} />New artboard</button>
            <button className="design-menu-icon-action" role="menuitem" onClick={() => { setExportMenu(undefined); setHistoryOpen(v => !v); setHistorical(undefined); }}><History size={16} />{historyOpen ? "Close history" : "History"}</button>
            {sessionId && <button className="design-menu-icon-action" role="menuitem" onClick={() => { setExportMenu(undefined); setStylesOpen(true); }}><Sparkles size={16} />{composerChoice?.styleName ? `Style · ${composerChoice.styleName}` : "Styles"}</button>}
            <div className="design-menu-divider" role="separator" />
            <div className="design-menu-label">Export</div>
            <button role="menuitemcheckbox" aria-checked={exportAllPages} onClick={() => setExportAllPages(!exportAllPages)}>{exportAllPages ? "✓ All pages" : "Current page"}</button>
            <button role="menuitemcheckbox" aria-checked={exportScale === 2} onClick={() => setExportScale(exportScale === 2 ? 1 : 2)}>PNG resolution · {exportScale}×</button>
            <div className="design-menu-divider" />
            <button role="menuitem" onClick={() => (setExportMenu(undefined), void exportAs("pdf"))}>
              PDF <span>{exportAllPages ? doc.boards.length : canvasBoards.length} boards · {exportAllPages ? "all pages" : "current page"}</span>
            </button>
            <button role="menuitem" onClick={() => (setExportMenu(undefined), void exportAs("html"))}>
              HTML bundle <span>{exportAllPages ? "all pages" : "current page"}, zipped</span>
            </button>
            <button
              role="menuitem"
              disabled={!activeBoard}
              onClick={() => activeBoard && (setExportMenu(undefined), void exportAs("png", activeBoard.id))}
            >
              PNG <span>{activeBoard ? `${activeBoard.name} at ${exportScale}×` : "select a board"}</span>
            </button>
            <div className="design-menu-divider" role="separator" />
            <button role="menuitem" disabled={busy || !!session?.readOnly} onClick={() => { setExportMenu(undefined); void implement(); }}>Hand off to project <span>Build with {agentName}</span></button>
      </DesignActionMenu>}
    {boardDownload && doc && (() => {
      const board = doc.boards.find((b) => b.id === boardDownload.boardId);
      if (!board) return null;
      const close = () => setBoardDownload(undefined);
      const selected = selectedIds.filter((id) => canvasBoards.some((b) => b.id === id));
      return (
        <DesignActionMenu trigger={boardDownload.trigger} onClose={close} label={`Download ${board.name}`} align="end" className="design-export-actions design-board-download">
          <button role="menuitem" onClick={() => (close(), void exportAs("png", board.id, { scale: 1 }))}>
            PNG 1× <span>{board.width} × {board.height} px</span>
          </button>
          <button role="menuitem" onClick={() => (close(), void exportAs("png", board.id, { scale: 2 }))}>
            PNG 2× <span>{board.width * 2} × {board.height * 2} px</span>
          </button>
          <button role="menuitem" onClick={() => (close(), void exportAs("pdf", board.id))}>
            PDF (.pdf) <span>One page at this board's size</span>
          </button>
          <button role="menuitem" onClick={() => (close(), void exportAs("html", board.id))}>
            HTML (.zip) <span>This board as a web page</span>
          </button>
          <div className="design-menu-divider" role="separator" />
          <button role="menuitem" disabled={!canvasBoards.length} onClick={() => (close(), void exportAs("pdf", undefined, { boardIds: canvasBoards.map((b) => b.id) }))}>
            All boards (.pdf) <span>{canvasBoards.length} on this page, in canvas order</span>
          </button>
          <button role="menuitem" disabled={selected.length < 2} onClick={() => (close(), void exportAs("pdf", undefined, { boardIds: selected }))}>
            Selected boards (.pdf) <span>{selected.length < 2 ? "Select two or more" : `${selected.length} boards`}</span>
          </button>
        </DesignActionMenu>
      );
    })()}
    {stylesOpen && sessionId && (
      <DesignStylesDialog
        sessionId={sessionId}
        cwd={session?.projectCwd ?? session?.cwd}
        value={composerChoice?.styleId}
        templateValue={composerChoice?.templateId}
        onPickTemplate={(template) => {
          useDesignStore.getState().setComposerChoice(sessionId, {
            ...(composerChoice ?? { variants: 1 }),
            templateId: template?.id,
            templateName: template?.name,
          });
          setStylesOpen(false);
        }}
        onClose={() => setStylesOpen(false)}
        onPick={(style) => {
          useDesignStore.getState().setComposerChoice(sessionId, {
            ...(composerChoice ?? { variants: 1 }),
            styleId: style?.id,
            styleName: style?.name,
          });
          setStylesOpen(false);
        }}
      />
    )}
    {/* Outside the panel, so the canvas's own control styles stay off it. */}
      {canvasOverlay && (
        <div
          ref={overlayStage}
          className="design-canvas-overlay"
          style={{
            right: !previewing && !historyOpen && doc && inspectorOpen ? inspectorWidth : historyOpen ? HISTORY_WIDTH : 0,
          }}
        >
          {canvasOverlay(overlayStage)}
        </div>
      )}
    </>
  );
}

/** Popover beside a screen rect: right, else left, else below it. */
function placeBeside(
  r: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
  width: number,
): React.CSSProperties {
  const top = Math.max(8, Math.min(r.y, size.height - 220));
  if (r.x + r.width + 12 + width <= size.width - 8)
    return { left: r.x + r.width + 12, top, width };
  if (r.x - width - 12 >= 8) return { left: r.x - width - 12, top, width };
  return {
    left: Math.max(8, Math.min(r.x, size.width - width - 8)),
    top: Math.max(8, Math.min(r.y + r.height + 12, size.height - 220)),
    width,
  };
}
