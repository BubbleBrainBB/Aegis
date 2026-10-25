import { boardIdsInView } from "./canvas-geometry";
import type { DesignCanvasAwareness } from "../../../shared/design-types";
import { BoardNameInput } from "./BoardNameInput";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type {
  DesignAnchor,
  DesignBoard,
  DesignOperation,
} from "../../../shared/design-types";
import { rendererStateStorage } from "../../utils/renderer-state-storage";
import { findDesignLayer, readDesignLayers } from "../../../shared/design-layers";
import { ArrowsDiagonal, ChevronDown, Check, Download, Hand, Hash, MessageCircle, MousePointer, PanelRight, Play, Type } from "../icons";
import { DesignActionMenu, DesignToolButton, useDesignMenu } from "./DesignChrome";
import { BoardFrame, type BoardInspector, type BoardRuntimeEvent, type DragState, type DropTarget } from "./BoardFrame";
import type { DesignSystemPack } from "../../../shared/design-system-pack";
import { designSlides, isDesignDeck } from "../../../shared/design-deck";
import { BoardThumb } from "./BoardThumb";
import { FRAME_SIZE, snapBoard, textTagFor } from "./design-insert";
import { CanvasMarks } from "./CanvasMarks";
import { useLayoutGuides } from "./design-prefs";
import { createDesignMark, isDesignMarkType, markFromPoints, translateDesignMark, MAX_MARK_POINTS, type DesignMark, type DesignMarkType, type MarkChangeReason } from "./design-marks";
import type { LayerCss } from "./design-css";
import {
  absoluteConstraints,
  gapRegions,
  isAbsolute,
  isAutoLayout,
  paddingRegions,
  type LayerLayout,
  type PaddingSide,
} from "./design-spacing";
import {
  bounds,
  clampZoom,
  fitView,
  intersects,
  resizeRect,
  snapMove,
  toWorld,
  zoomAt,
  type CanvasView,
  type Point,
  type Rect,
} from "./canvas-geometry";

type ElementSelection = {
  boardId: string;
  revision: number;
  anchor: DesignAnchor;
};
type Gesture = {
  kind:
    | "pan"
    | "move"
    | "marquee"
    | "resize"
    | "element-drag"
    | "element-resize"
    | "comment-area"
    | "spacing"
    | "element-move-abs"
    | "tool"
    | "mark";
  pointerId: number;
  start: Point;
  view: CanvasView;
  boards: DesignBoard[];
  initialSelection: string[];
  additive: boolean;
  edge?: string;
  moved: boolean;
  /** Element gestures: the layer's board, id and starting rect (board space). */
  element?: { boardId: string; nodeId: string; rect: Rect; grab: Point };
  /** Spacing handle being dragged, with the starting values. */
  spacing?:
    | { kind: "gap"; prop: "column-gap" | "row-gap"; axis: "x" | "y"; start: number }
    | { kind: "pad"; side: PaddingSide; start: LayerLayout["padding"] };
  /** Absolute move: where it starts and what it snaps to (board space). */
  abs?: { layout: LayerLayout; convert: boolean };
  styles?: Record<string, string>;
  /** Board-body press: a release without movement picks the layer under it. */
  pick?: DesignBoard;
  /** Text and Frame tools: where the press started and where it would insert. */
  tool?: { kind: "text" | "frame"; board?: DesignBoard; world: Point; abs: boolean; target?: Promise<DropTarget | null> };
  mark?: { type: DesignMarkType; start: Point; samples: Point[]; preview: DesignMark };
};
/** A comment pin, anchored to a layer (tracked live) or a stored rect. */
export type CanvasPin = {
  id: string;
  boardId: string;
  nodeId?: string;
  /** Area comments track the union of these layers. */
  nodeIds?: string[];
  /** Click point inside the layer; without it the pin sits top-right. */
  offset?: Point;
  rect?: Rect;
  initial: string;
  status: "open" | "working" | "resolved";
};
/** Screen-space helpers for overlays (popovers, toolbars) above the canvas. */
export type CanvasOverlay = {
  view: CanvasView;
  /** Screen rect of a board, or of a rect inside it (board coordinates). */
  toScreen(boardId: string, rect?: Rect): Rect | undefined;
  /** Live rect of a pin's anchor in board coordinates. */
  pinRect(pinId: string): Rect | undefined;
  size: { width: number; height: number };
  /** An element is being dragged or resized: hide selection chrome. */
  gesturing: boolean;
  mode: CanvasMode;
};
export type CanvasMode = "select" | "pan" | "comment" | "text" | "frame" | DesignMarkType;
/** Imperative canvas actions for toolbars and inspectors outside the viewport. */
export type CanvasApi = {
  preview(boardId: string): void;
  /** Re-render a board's frame, dropping any live preview state. */
  reloadBoard(boardId: string): void;
  setMode(mode: CanvasMode): void;
  /** Client point of a recent double-click, to place the text caret there. */
  lastDoubleClick(): Point | undefined;
  /** Rendered content height of a board's page, or 0 when unavailable. */
  contentHeight(boardId: string): Promise<number>;
  /** Drop a board's live previews (resize, styles, a new layer being typed). */
  resetPreview(boardId: string): void;
  /** Authored CSS of a layer (or the board's body); null until its frame answers. */
  styles(boardId: string, nodeId?: string): Promise<LayerCss | null>;
  /** Rendered rects of layers on one board (board coordinates). */
  measure(boardId: string, ids: string[]): Promise<Record<string, { x: number; y: number; width: number; height: number } | null>>;
  focus(): void;
  /** Show a deck board's slide (0-based) on the canvas. */
  showSlide(boardId: string, index: number): void;
};
type Props = {
  /** The design system every board loads (stylesheet, components, assets). */
  system?: DesignSystemPack | null;
  /** Page picker belongs before the canvas tools, not in the host titlebar. */
  toolbarLeading?: ReactNode;
  commentControlInHeader?: boolean;
  boards: DesignBoard[];
  marks?: DesignMark[];
  selectedMarkIds?: string[];
  onMarkSelectionChange?(ids: string[]): void;
  onMarksChange?(changed: DesignMark[], reason: MarkChangeReason): void | Promise<unknown>;
  onMarksDelete?(ids: string[]): void;
  onCreateMark?(mark: DesignMark): void;
  /** The download button on a board's heading: the host shows the export menu. */
  onBoardDownload?(boardId: string, button: HTMLElement): void;
  storageKey: string;
  selectedIds: string[];
  selection?: ElementSelection;
  editable: boolean;
  onSelectionChange(ids: string[]): void;
  onAwarenessChange?(value: DesignCanvasAwareness): void;
  /** `comment`: picked in comment mode; `edit`: double-clicked to edit text. */
  onElementSelect(
    board: DesignBoard,
    anchor: DesignAnchor,
    intent?: "comment" | "edit",
  ): void;
  /** Enter / double-click on the current selection: edit its text in place. */
  onEditRequest?(): boolean;
  /** Shift+A on a selected layer: give it (or a new wrapper) auto layout. */
  onAutoLayout?(): void;
  /** Keyboard moves through the layer tree; false when there is nowhere to go. */
  onNavigate?(direction: "child" | "parent" | "next" | "prev"): boolean;
  /** Layer hidden in its frame while an in-place editor covers it. */
  maskedNode?: { boardId: string; nodeId: string };
  onModeChange?(mode: CanvasMode): void;
  /** An area dragged out in comment mode, with the layers fully inside it. */
  onAreaComment?(board: DesignBoard, rect: Rect, layers: { id: string; rect: Rect }[]): void;
  /** The selected layer can be dragged and resized (current, unlocked). */
  elementEditable?: boolean;
  onElementMove?(board: DesignBoard, nodeId: string, parentId: string, index: number): Promise<boolean>;
  onElementResize?(
    board: DesignBoard,
    nodeId: string,
    size: Record<string, string>,
  ): Promise<boolean>;
  /** The selected layer is text: handles change its width and keep its height hugging. */
  selectionIsText?: boolean;
  /** Live rect of the layer being resized or moved, for the inspector. */
  onLiveRect?(rect: Rect | undefined): void;
  /** Commit inline styles from spacing and absolute-position gestures. */
  onElementStyle?(
    board: DesignBoard,
    nodeId: string,
    styles: Record<string, string>,
    kind: "gap" | "padding" | "move" | "absolute",
  ): Promise<boolean>;
  onElementCommand(
    command: "remove" | "duplicate" | "nudge",
    dx?: number,
    dy?: number,
  ): void;
  onChange(operations: DesignOperation[]): Promise<unknown>;
  onPreviewChange(value: boolean): void;
  layerTarget?: { boardId: string; nodeId: string; request: number };
  pins?: CanvasPin[];
  activePinId?: string;
  onPinOpen?(id: string): void;
  /** C: comment on the current selection, or null to enter comment mode. */
  onCommentRequest?(): boolean;
  onToggleLayers?(): void;
  focusTarget?: { boardId: string; rect?: Rect; nonce: number };
  apiRef?: React.MutableRefObject<CanvasApi | null>;
  /** Text tool: a new text layer is previewed at `target`; the panel edits and saves it. */
  /** Image files dropped on the canvas: on a board (with where in it), or on the canvas itself. */
  onDropImages?(files: File[], at: { board?: DesignBoard; target: DropTarget | null; world: Point }): void;
  onInsertText?(
    board: DesignBoard,
    target: DropTarget,
    tag: string,
    preview: { rect: Rect; styles: Record<string, string> },
  ): void;
  /** Frame tool inside a board: in the layout at `target`, or absolute at `rect` (⌘). */
  onInsertFrame?(
    board: DesignBoard,
    frame: { target: DropTarget; width: number; height: number } | { rect: Rect },
  ): void;
  /** Frame tool outside the boards: a new blank board (world coordinates). */
  onCreateBoard?(rect: Rect): void;
  /** ⇧C: show or hide comment pins. */
  onToggleComments?(): void;
  onCommentDone?(): void;
  /** Show or hide the inspector column beside the canvas. */
  inspector?: { open: boolean; toggle(): void };
  history?: { canUndo: boolean; canRedo: boolean; step(direction: "undo" | "redo"): void };
  overlay?(ctx: CanvasOverlay): ReactNode;
  children?: React.ReactNode;
};
function readView(key: string): CanvasView | undefined {
  try {
    const v = JSON.parse(rendererStateStorage.getItem(key) || "null");
    if (v && [v.x, v.y, v.zoom].every(Number.isFinite))
      return { x: v.x, y: v.y, zoom: clampZoom(v.zoom) };
  } catch {}
}
const isTextInput = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest("input,textarea,select,[contenteditable=true]");
const rectBetween = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});

/** A board the agent is still writing (a draft from design-drafts.ts). */
const writingBoard = (b: DesignBoard) => {
  const draft = (b as { draft?: { complete: boolean } }).draft;
  return !!draft && !draft.complete;
};

export function DesignCanvas(props: Props) {
  const {
    boards,
    selectedIds,
    selection,
    editable,
    onSelectionChange,
    onElementSelect,
    onChange,
    storageKey,
    onPreviewChange,
  } = props;
  const viewport = useRef<HTMLDivElement>(null);
  const inspectors = useRef(new Map<string, BoardInspector>());
  const [view, setView] = useState<CanvasView>(
    () => readView(storageKey) ?? { x: 80, y: 100, zoom: 0.5 },
  );
  const viewRef = useRef(view);
  const [mode, setMode] = useState<CanvasMode>("select");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    if (mode !== "text") setInsertHint(undefined);
  }, [mode]);
  const [space, setSpace] = useState(false);
  const spaceRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<Gesture | undefined>(undefined);
  const [patches, setPatches] = useState<Record<string, Rect>>({});
  const patchesRef = useRef<Record<string, Rect>>({});
  const [marquee, setMarquee] = useState<Rect>();
  const [guides, setGuides] = useState<{ axis: "x" | "y"; value: number }[]>(
    [],
  );
  const [hover, setHover] = useState<ElementSelection>();
  const hoverBoard = useRef<string | undefined>(undefined);
  const [previewId, setPreviewId] = useState<string>();
  // The slide each deck board shows on the canvas.
  const [deckSlide, setDeckSlide] = useState<Record<string, number>>({});
  // What each component board's runtime last reported: logic errors, a hang.
  const [runtimeIssues, setRuntimeIssues] = useState<Record<string, { errors: string[]; hung: boolean }>>({});
  const onBoardRuntime = useCallback((boardId: string, event: BoardRuntimeEvent) => {
    if (event.type === "goto") return;
    setRuntimeIssues((all) => {
      const was = all[boardId];
      const next = event.type === "hung" ? { errors: was?.errors ?? [], hung: true } : { errors: event.errors, hung: false };
      if (!next.hung && !next.errors.length) {
        if (!was) return all;
        const { [boardId]: _, ...rest } = all;
        return rest;
      }
      return { ...all, [boardId]: next };
    });
  }, []);
  const [zoomMenu, setZoomMenu] = useState(false);
  const [shapesMenu, setShapesMenu] = useState(false);
  const shapesTrigger = useRef<HTMLButtonElement>(null);
  const [markDraft, setMarkDraft] = useState<DesignMark>();
  const [editMarkId, setEditMarkId] = useState<string>();
  const [markGesturing, setMarkGesturing] = useState(false);
  const markGesturingRef = useRef(false);
  const [layoutGuides, setLayoutGuides] = useLayoutGuides();
  const zoomTrigger = useRef<HTMLButtonElement>(null);
  const zoomList = useRef<HTMLDivElement>(null);
  useDesignMenu(zoomMenu, zoomList, zoomTrigger, () => setZoomMenu(false));
  const [saving, setSaving] = useState(false);
  const [measured, setMeasured] = useState<Record<string, Rect | null>>({});
  const [loads, setLoads] = useState(0);
  const editIntent = useRef<string | undefined>(undefined);
  // Comment mode: the board-space point of the last click, and a dragged area.
  const commentClick = useRef<{ boardId: string; point: Point; at: number } | undefined>(undefined);
  const [area, setArea] = useState<Rect>();
  /** Text tool hover / Frame tool press: where the new layer would land. */
  const [insertHint, setInsertHint] = useState<{ boardId: string; target: DropTarget }>();
  /** Frame tool drag, in world coordinates; no board means a new board. */
  const [draw, setDraw] = useState<{ rect: Rect; boardId?: string; label: string }>();
  const [renamingBoard, setRenamingBoard] = useState<string>();
  const hintQuery = useRef<{ busy: boolean; next?: [DesignBoard, Point]; board?: string }>({ busy: false });
  // Pointer capture retargets dblclick, so remember the handle that was pressed.
  const lastHandle = useRef<{ edge: string; at: number } | undefined>(undefined);
  const lastDouble = useRef<{ x: number; y: number; at: number } | undefined>(undefined);
  const [frameEpochs, setFrameEpochs] = useState<Record<string, number>>({});
  // Live element gestures: drop target while dragging, rect while resizing.
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  dragStateRef.current = dragState;
  const [dragPoint, setDragPoint] = useState<Point>();
  const [elementRect, setElementRect] = useState<Rect>();
  useEffect(() => {
    latest.current.onLiveRect?.(elementRect);
  }, [elementRect]);
  // Layout of the selected layer: drives spacing handles and absolute moves.
  const [layerLayout, setLayerLayout] = useState<{ key: string; layout: LayerLayout }>();
  const [absGuides, setAbsGuides] = useState<{ axis: "x" | "y"; value: number }[]>([]);
  const layoutKey = selection?.anchor.nodeId
    ? `${selection.boardId}:${selection.anchor.nodeId}:${boards.find((b) => b.id === selection.boardId)?.contentRevision}`
    : "";
  const flight = useRef<{ busy: boolean; next?: () => Promise<unknown> }>({ busy: false });
  // Coalesce frame round-trips: at most one in flight, latest request wins.
  const send = (job: () => Promise<unknown>) => {
    const f = flight.current;
    if (f.busy) {
      f.next = job;
      return;
    }
    f.busy = true;
    void job().finally(() => {
      f.busy = false;
      const next = f.next;
      f.next = undefined;
      if (next) send(next);
    });
  };
  const latest = useRef(props);
  latest.current = props;
  const ready = useRef(false);
  const touched = useRef(!!readView(storageKey));
  const canEdit = editable && !saving;
  const marks = props.marks ?? [];
  const selectedMarkIds = props.selectedMarkIds ?? [];
  const selectedBoards = boards.filter((b) => selectedIds.includes(b.id));
  const selectedMarks = marks.filter(m => selectedMarkIds.includes(m.id));
  const previewBoard = boards.find((b) => b.id === previewId);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const lastAwareness = useRef("");
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setViewportSize(old => old.width === el.clientWidth && old.height === el.clientHeight
      ? old : { width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const focusedBoardId = previewBoard?.id;
    const visibleBoardIds = focusedBoardId ? [focusedBoardId]
      : boardIdsInView(boards.map(b => ({ ...b, ...(patches[b.id] ?? {}) })), view, viewportSize);
    const value = { visibleBoardIds, focusedBoardId };
    const key = JSON.stringify([storageKey, value]);
    if (key === lastAwareness.current) return;
    lastAwareness.current = key;
    latest.current.onAwarenessChange?.(value);
  }, [boards, patches, view, viewportSize, previewBoard?.id, storageKey]);


  // The layer the panel last asked a frame to select (keyboard, layers list).
  // A frame's reply to an older request is stale: stepping quickly would
  // otherwise snap back. Clicks are never affected (they are not replies).
  const expectedLayer = useRef<{ boardId: string; nodeId: string } | null>(null);
  useEffect(() => {
    const target = props.layerTarget;
    expectedLayer.current = target ? { boardId: target.boardId, nodeId: target.nodeId } : null;
    if (!target) return;
    // The iframe may be reloading after a content revision. Retry briefly; all
    // replies are still validated against that frame's current nonce.
    const select = () =>
      inspectors.current.get(target.boardId)?.selectNode(target.nodeId);
    select();
    const retry = setTimeout(select, 180);
    return () => clearTimeout(retry);
  }, [props.layerTarget, boards]);

  // Pins follow their layer when the agent edits the board; fall back to the
  // stored rect only when the layer no longer renders.
  const pins = props.pins ?? [];
  const pinKey = pins
    .map((p) => p.id + ":" + (p.nodeIds?.join(",") ?? p.nodeId))
    .join("|");
  const boardKey = boards.map((b) => b.id + ":" + b.contentRevision).join("|");
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const next: Record<string, Rect | null> = {};
      for (const b of boards) {
        const onBoard = pins.filter(
          (p) => p.boardId === b.id && (p.nodeId || p.nodeIds?.length),
        );
        const api = inspectors.current.get(b.id);
        if (!onBoard.length || !api) continue;
        const ids = [...new Set(onBoard.flatMap((p) => p.nodeIds ?? [p.nodeId!]))];
        const { rects } = await api.measure(ids);
        for (const p of onBoard) {
          const found = (p.nodeIds ?? [p.nodeId!])
            .map((id) => rects[id])
            .filter((r): r is Rect => !!r);
          next[p.id] = found.length ? bounds(found)! : null;
        }
      }
      if (!cancelled) setMeasured(next);
    };
    const timer = setTimeout(() => void run(), 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pinKey, boardKey, loads]);
  useEffect(() => {
    if (!layoutKey || !selection?.anchor.nodeId) return setLayerLayout(undefined);
    let live = true;
    const api = inspectors.current.get(selection.boardId);
    const id = selection.anchor.nodeId;
    const timer = setTimeout(async () => {
      const layout = await api?.layout(id);
      if (live && layout) setLayerLayout({ key: layoutKey, layout });
    }, 40);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [layoutKey, loads]);
  const currentLayout = layerLayout?.key === layoutKey ? layerLayout.layout : undefined;
  // Layer names for the comment-mode hover tag.
  const trees = useMemo(
    () => (mode === "comment" ? new Map(boards.map((b) => [b.id, readDesignLayers(b.html)])) : undefined),
    [boardKey, mode],
  );
  const pinRect = (id: string): Rect | undefined => {
    const pin = pins.find((p) => p.id === id);
    if (!pin) return undefined;
    return measured[id] ?? pin.rect;
  };
  /** Where a pin sits: the clicked point inside its layer, else top-right. */
  const pinPoint = (pin: CanvasPin): Point | undefined => {
    const r = pinRect(pin.id);
    if (!r) return undefined;
    if (!pin.offset || pin.nodeIds) return { x: r.x + r.width, y: r.y };
    return {
      x: r.x + Math.min(Math.max(pin.offset.x, 0), r.width),
      y: r.y + Math.min(Math.max(pin.offset.y, 0), r.height),
    };
  };
  useEffect(() => {
    const m = props.maskedNode;
    if (!m) return;
    const api = inspectors.current.get(m.boardId);
    api?.mask(m.nodeId);
    return () => api?.mask(null);
  }, [props.maskedNode?.boardId, props.maskedNode?.nodeId]);
  useEffect(() => {
    const target = props.focusTarget;
    if (!target) return;
    const b = boards.find((x) => x.id === target.boardId);
    if (!b || !viewport.current) return;
    const s = size();
    const r = target.rect ?? { x: 0, y: 0, width: b.width, height: b.height };
    const fitBoard = Math.min(
      (s.width - 120) / Math.max(1, b.width),
      (s.height - 120) / Math.max(1, b.height),
    );
    const z = clampZoom(Math.max(viewRef.current.zoom, Math.min(0.6, fitBoard)));
    touched.current = true;
    changeView({
      zoom: z,
      x: s.width / 2 - (b.x + r.x + r.width / 2) * z,
      y: s.height / 2 - (b.y + r.y + r.height / 2) * z,
    });
  }, [props.focusTarget?.nonce]);

  if (props.apiRef)
    props.apiRef.current = {
      preview: (id) => preview(id),
      reloadBoard: (id) => setFrameEpochs((m) => ({ ...m, [id]: (m[id] ?? 0) + 1 })),
      setMode: (m) => setMode(m),
      lastDoubleClick: () =>
        lastDouble.current && Date.now() - lastDouble.current.at < 1500
          ? { x: lastDouble.current.x, y: lastDouble.current.y }
          : undefined,
      contentHeight: async (id) =>
        (await inspectors.current.get(id)?.measure([]))?.height ?? 0,
      resetPreview: (id) => inspectors.current.get(id)?.resetPreview(),
      styles: async (id, nodeId) => (await inspectors.current.get(id)?.styles(nodeId)) ?? null,
      measure: async (id, ids) => (await inspectors.current.get(id)?.measure(ids))?.rects ?? {},
      focus: () => viewport.current?.focus({ preventScroll: true }),
      showSlide: (id, index) => setDeckSlide((all) => ({ ...all, [id]: Math.max(0, index) })),
    };

  function changeView(next: CanvasView) {
    viewRef.current = next;
    setView(next);
  }
  function size() {
    return {
      width: viewport.current?.clientWidth ?? 0,
      height: viewport.current?.clientHeight ?? 0,
    };
  }
  function fit(target: Rect[] = [...boards, ...marks]) {
    const next = fitView(target, size());
    if (next) {
      touched.current = true;
      changeView(next);
    }
    setZoomMenu(false);
  }
  function zoom(next: number) {
    const s = size();
    touched.current = true;
    changeView(
      zoomAt(viewRef.current, { x: s.width / 2, y: s.height / 2 }, next),
    );
  }
  function preview(id?: string) {
    cancel();
    viewport.current?.focus({ preventScroll: true });
    setPreviewId(id);
    onPreviewChange(!!id);
    setZoomMenu(false);
  }
  function cancel() {
    const g = gesture.current;
    gesture.current = undefined;
    setArea(undefined);
    setDraw(undefined);
    setMarkDraft(undefined);
    if (g?.kind === "tool") setInsertHint(undefined);
    if (g?.element) {
      const api = inspectors.current.get(g.element.boardId);
      if (g.kind === "element-drag" && g.moved) void api?.dragEnd(false);
      if (g.kind === "element-resize" || g.kind === "spacing" || g.kind === "element-move-abs") {
        api?.resetPreview();
        setAbsGuides([]);
        if (g.kind === "spacing") setLayerLayout(undefined);
      }
      setDragState(null);
      setDragPoint(undefined);
      setElementRect(undefined);
    }
    if (g?.kind === "marquee")
      latest.current.onSelectionChange(g.initialSelection);
    patchesRef.current = {};
    setPatches({});
    setMarquee(undefined);
    setGuides([]);
    setDragging(false);
    if (g && viewport.current?.hasPointerCapture(g.pointerId))
      viewport.current.releasePointerCapture(g.pointerId);
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      if (touched.current) {
        try {
          rendererStateStorage.setItem(storageKey, JSON.stringify(view));
        } catch {}
      }
    }, 160);
    return () => clearTimeout(timer);
  }, [view, storageKey]);
  useEffect(
    () => () => {
      if (touched.current) {
        try {
          rendererStateStorage.setItem(
            storageKey,
            JSON.stringify(viewRef.current),
          );
        } catch {}
      }
    },
    [storageKey],
  );
  useEffect(() => {
    setHover(undefined);
    hoverBoard.current = undefined;
    latest.current.onModeChange?.(mode);
  }, [mode]);
  useEffect(() => {
    if (!canEdit && gesture.current?.kind === "mark") cancel();
  }, [canEdit]);
  useEffect(() => {
    // A page/document change must not commit a gesture into its successor.
    cancel();
    setShapesMenu(false);
    setEditMarkId(undefined);
  }, [storageKey]);
  useLayoutEffect(() => {
    if ((!boards.length && !marks.length) || ready.current || !viewport.current) return;
    ready.current = true;
    if (!touched.current) {
      const next = fitView([...boards, ...marks], size());
      if (next) changeView(next);
    }
  }, [boards, marks]);
  useEffect(() => {
    if (previewId && !previewBoard) {
      setPreviewId(undefined);
      onPreviewChange(false);
    }
  }, [previewId, previewBoard, onPreviewChange]);
  useEffect(() => {
    const release = () => {
      spaceRef.current = false;
      setSpace(false);
    };
    const keyup = (e: KeyboardEvent) => {
      if (e.code === "Space") release();
    };
    const blur = () => {
      release();
      cancel();
    };
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
    };
  }, []);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      // Overlays scroll themselves; pins and on-canvas labels still pan the canvas.
      if (
        previewId ||
        isTextInput(e.target) ||
        (e.target instanceof Element &&
          e.target.closest("[data-canvas-ui]") &&
          !e.target.closest(".design-pin"))
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      if (gesture.current || markGesturingRef.current) return;
      touched.current = true;
      const v = viewRef.current,
        r = el.getBoundingClientRect();
      const factor =
        e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      if (e.ctrlKey || e.metaKey)
        changeView(
          zoomAt(
            v,
            { x: e.clientX - r.left, y: e.clientY - r.top },
            v.zoom * Math.exp(-e.deltaY * factor * 0.008),
          ),
        );
      else
        changeView({
          ...v,
          x: v.x - (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * factor,
          y: v.y - (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * factor,
        });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [previewId]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = viewport.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const boardAt = (target: EventTarget | null) =>
    target instanceof Element
      ? boards.find(
          (b) =>
            b.id ===
            target.closest("[data-board-id]")?.getAttribute("data-board-id"),
        )
      : undefined;
  function inspect(board: DesignBoard, p: Point, isHover = false) {
    const point = toWorld(p, viewRef.current);
    inspectors.current
      .get(board.id)
      ?.inspect(point.x - board.x, point.y - board.y, isHover);
  }
  /** Text tool hover: one drop-target query in flight, the latest point queued. */
  function queryHint(board: DesignBoard, world: Point) {
    const q = hintQuery.current;
    if (q.busy) {
      q.next = [board, world];
      return;
    }
    q.busy = true;
    void (async () => {
      const t = await inspectors.current.get(board.id)?.dropTarget(world.x - board.x, world.y - board.y);
      q.busy = false;
      if (modeRef.current === "text" && !gesture.current && q.board === board.id)
        setInsertHint(t ? { boardId: board.id, target: t } : undefined);
      const next = q.next;
      q.next = undefined;
      if (next) queryHint(...next);
    })();
  }
  /** Text tool click: preview the new layer in its frame and hand it to the panel to edit. */
  async function insertText(board: DesignBoard, target: Promise<DropTarget | null>) {
    const t = await target;
    if (!t) return;
    const tag = textTagFor(t);
    const preview = await inspectors.current.get(board.id)?.previewInsert(t, tag, "Text");
    if (!preview) return;
    setMode("select");
    props.onInsertText?.(board, t, tag, preview);
  }
  function start(e: ReactPointerEvent<HTMLDivElement>) {
    if (
      previewId ||
      !(e.target instanceof Element) ||
      e.target.closest("[data-canvas-ui]") ||
      ![0, 1].includes(e.button)
    )
      return;
    e.preventDefault();
    viewport.current!.focus({ preventScroll: true });
    setZoomMenu(false);
    commentClick.current = undefined;
    const point = local(e),
      board = boardAt(e.target);
    const hand = e.button === 1 || spaceRef.current || mode === "pan";
    if (!hand && isDesignMarkType(mode)) {
      if (!canEdit || !props.onCreateMark) return;
      const world = toWorld(point, viewRef.current);
      const draft = createDesignMark(mode, world);
      gesture.current = { kind: "mark", pointerId: e.pointerId, start: point, view: viewRef.current, boards: [], initialSelection: [...selectedIds], additive: false, moved: false, mark: { type: mode, start: world, samples: [world], preview: draft } };
      props.onMarkSelectionChange?.([]);
      onSelectionChange([]);
      setMarkDraft(mode === "freehand" ? undefined : draft);
      viewport.current!.setPointerCapture(e.pointerId);
      return;
    }
    if (!hand && selectedMarkIds.length) props.onMarkSelectionChange?.([]);
    const edge = e.target.closest("[data-resize]")?.getAttribute("data-resize");
    let kind: Gesture["kind"] = "pan",
      moving: DesignBoard[] = [],
      pick: DesignBoard | undefined;
    if (!hand && mode === "comment" && board && !e.target.closest(".design-board-label")) {
      // A click comments on a layer; a drag outlines an area of this board.
      const w = toWorld(point, viewRef.current);
      gesture.current = {
        kind: "comment-area",
        pointerId: e.pointerId,
        start: point,
        view: viewRef.current,
        boards: [board],
        initialSelection: [...selectedIds],
        additive: false,
        moved: false,
        element: { boardId: board.id, nodeId: "", rect: { x: 0, y: 0, width: 0, height: 0 }, grab: { x: w.x - board.x, y: w.y - board.y } },
      };
      viewport.current!.setPointerCapture(e.pointerId);
      return;
    }
    if (!hand && (mode === "text" || mode === "frame") && !e.target.closest(".design-board-label")) {
      if (!canEdit) return;
      const world = toWorld(point, viewRef.current);
      const abs = mode === "frame" && (e.metaKey || e.ctrlKey);
      const target =
        board && !abs
          ? inspectors.current.get(board.id)?.dropTarget(world.x - board.x, world.y - board.y) ?? Promise.resolve(null)
          : undefined;
      if (mode === "frame" && board && target)
        void target.then((t) => {
          if (gesture.current?.tool?.target === target) setInsertHint(t ? { boardId: board.id, target: t } : undefined);
        });
      gesture.current = {
        kind: "tool",
        pointerId: e.pointerId,
        start: point,
        view: viewRef.current,
        boards: board ? [board] : [],
        initialSelection: [...selectedIds],
        additive: false,
        moved: false,
        tool: { kind: mode, board, world, abs, target },
      };
      viewport.current!.setPointerCapture(e.pointerId);
      return;
    }
    const elementEdge = e.target
      .closest("[data-element-resize]")
      ?.getAttribute("data-element-resize");
    lastHandle.current = elementEdge ? { edge: elementEdge, at: Date.now() } : undefined;
    const sel = selection;
    const selBoard = sel && boards.find((b) => b.id === sel.boardId);
    const canElement =
      !hand && canEdit && mode === "select" && !!props.elementEditable &&
      !!sel?.anchor.nodeId && !!sel.anchor.rect && !!selBoard &&
      sel.revision === selBoard.contentRevision;
    const spacingHandle = e.target.closest("[data-spacing]")?.getAttribute("data-spacing");
    if (canElement && sel && selBoard && currentLayout && spacingHandle) {
      const [kind, which, axis] = spacingHandle.split(":");
      const spacing =
        kind === "gap"
          ? {
              kind: "gap" as const,
              prop: which as "column-gap" | "row-gap",
              axis: axis as "x" | "y",
              start: which === "row-gap" ? currentLayout.rowGap : currentLayout.columnGap,
            }
          : { kind: "pad" as const, side: which as PaddingSide, start: currentLayout.padding };
      gesture.current = {
        kind: "spacing",
        pointerId: e.pointerId,
        start: point,
        view: viewRef.current,
        boards: [],
        initialSelection: [...selectedIds],
        additive: false,
        moved: false,
        element: { boardId: selBoard.id, nodeId: sel.anchor.nodeId!, rect: { ...sel.anchor.rect! }, grab: { x: 0, y: 0 } },
        spacing,
      };
      viewport.current!.setPointerCapture(e.pointerId);
      return;
    }
    if (canElement && sel && selBoard) {
      const world = toWorld(point, viewRef.current);
      const local = { x: world.x - selBoard.x, y: world.y - selBoard.y };
      const r = sel.anchor.rect!;
      const inside =
        local.x >= r.x && local.x <= r.x + r.width &&
        local.y >= r.y && local.y <= r.y + r.height;
      // As in Figma: only auto-layout (flex/grid) children reorder. Absolute
      // layers and children of plain flow move freely; ⌘ frees any layer.
      const inPlainFlow = sel.anchor.computedStyles?.["parent-layout"] === "block";
      const freeMove =
        !elementEdge && inside &&
        (e.metaKey || inPlainFlow || (!!currentLayout && isAbsolute(currentLayout)));
      if (elementEdge || (board?.id === selBoard.id && inside && !e.shiftKey)) {
        gesture.current = {
          kind: elementEdge ? "element-resize" : freeMove ? "element-move-abs" : "element-drag",
          abs: freeMove && currentLayout ? { layout: currentLayout, convert: !isAbsolute(currentLayout) } : undefined,
          pointerId: e.pointerId,
          start: point,
          view: viewRef.current,
          boards: [],
          initialSelection: [...selectedIds],
          additive: false,
          edge: elementEdge ?? undefined,
          moved: false,
          element: {
            boardId: selBoard.id,
            nodeId: sel.anchor.nodeId!,
            rect: { ...r },
            grab: { x: local.x - r.x, y: local.y - r.y },
          },
        };
        viewport.current!.setPointerCapture(e.pointerId);
        setHover(undefined);
        hoverBoard.current = undefined;
        return;
      }
    }
    if (!hand) {
      if (edge && board && canEdit) {
        kind = "resize";
        moving = [board];
      } else if (board) {
        // As in Figma: a click inside a board picks the layer under it; the
        // label (or the body of an already selected board) moves the board.
        const onLabel = !!e.target.closest(".design-board-label");
        if (
          !onLabel &&
          (mode === "comment" ||
            selection?.boardId === board.id ||
            (!e.shiftKey && (!canEdit || !selectedIds.includes(board.id))))
        ) {
          inspect(board, point);
          return;
        }
        if (!onLabel && !e.shiftKey) pick = board;
        const ids = e.shiftKey
          ? selectedIds.includes(board.id)
            ? selectedIds.filter((id) => id !== board.id)
            : [...selectedIds, board.id]
          : selectedIds.includes(board.id)
            ? selectedIds
            : [board.id];
        onSelectionChange(ids);
        if (!canEdit || !ids.includes(board.id)) return;
        kind = "move";
        moving = boards.filter((b) => ids.includes(b.id));
      } else {
        kind = "marquee";
        if (!e.shiftKey) onSelectionChange([]);
      }
    }
    gesture.current = {
      kind,
      pointerId: e.pointerId,
      start: point,
      view: viewRef.current,
      boards: moving.map((b) => ({ ...b })),
      initialSelection: [...selectedIds],
      additive: e.shiftKey,
      edge: edge ?? undefined,
      moved: false,
      pick,
    };
    viewport.current!.setPointerCapture(e.pointerId);
    setHover(undefined);
    hoverBoard.current = undefined;
    if (kind === "pan") setDragging(true);
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current,
      point = local(e);
    if (!g) {
      const board = boardAt(e.target);
      if (mode === "text") {
        hintQuery.current.board = board?.id;
        if (board && !spaceRef.current && canEdit) queryHint(board, toWorld(point, viewRef.current));
        else {
          hintQuery.current.next = undefined;
          setInsertHint(undefined);
        }
        return;
      }
      hoverBoard.current = mode === "comment" ? board?.id : undefined;
      if (mode === "comment" && board && !spaceRef.current)
        inspect(board, point, true);
      else setHover(undefined);
      return;
    }
    const dx = point.x - g.start.x,
      dy = point.y - g.start.y;
    if (!g.moved && Math.hypot(dx, dy) < 3) return;
    if (g.kind === "mark" && g.mark) {
      g.moved = true;
      let end = toWorld(point, g.view);
      const m = g.mark;
      if (m.type === "freehand") {
        const last = m.samples.at(-1)!;
        if (Math.hypot(end.x - last.x, end.y - last.y) * g.view.zoom >= 1) m.samples.push(end);
        if (m.samples.length > MAX_MARK_POINTS * 2) m.samples = m.samples.filter((_, i) => i % 2 === 0 || i === m.samples.length - 1);
        m.preview = markFromPoints(m.samples, m.preview.id) ?? m.preview;
      } else {
        if (e.shiftKey && ["rectangle", "ellipse", "line", "arrow"].includes(m.type)) {
          const x = end.x - m.start.x, y = end.y - m.start.y;
          if (m.type === "line" || m.type === "arrow") {
            const angle = Math.round(Math.atan2(y, x) / (Math.PI / 4)) * Math.PI / 4, length = Math.hypot(x, y);
            end = { x: m.start.x + Math.cos(angle) * length, y: m.start.y + Math.sin(angle) * length };
          } else {
            const side = Math.max(Math.abs(x), Math.abs(y));
            end = { x: m.start.x + Math.sign(x || 1) * side, y: m.start.y + Math.sign(y || 1) * side };
          }
        }
        m.preview = createDesignMark(m.type, m.start, end, m.preview.id);
      }
      setMarkDraft(m.preview);
      return;
    }
    if (g.kind === "tool") {
      g.moved = true;
      // The tool chosen at press time, even if a shortcut changed the mode mid-drag.
      if (g.tool?.kind !== "frame") return;
      const a = g.tool.world;
      const w = toWorld(point, g.view);
      const b = g.tool.board;
      if (b) {
        const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
        const p = { x: clamp(w.x, b.x, b.x + b.width), y: clamp(w.y, b.y, b.y + b.height) };
        const r = rectBetween(a, p);
        setDraw({ rect: r, boardId: b.id, label: `${Math.round(r.width)} × ${Math.round(r.height)}` });
      } else {
        const snapped = snapBoard(a, rectBetween(a, w), 16 / g.view.zoom);
        setDraw(snapped);
      }
      return;
    }
    if (g.kind === "comment-area") {
      g.moved = true;
      setHover(undefined);
      const b = g.boards[0];
      const a = g.element!.grab;
      const w = toWorld(point, g.view);
      const p = {
        x: Math.min(Math.max(w.x - b.x, 0), b.width),
        y: Math.min(Math.max(w.y - b.y, 0), b.height),
      };
      setArea(rectBetween(a, p));
      return;
    }
    if ((g.kind === "spacing" || g.kind === "element-move-abs") && g.element) {
      g.moved = true;
      setDragging(true);
      const el = g.element;
      const api = inspectors.current.get(el.boardId);
      if (!api) return;
      const ddx = dx / g.view.zoom,
        ddy = dy / g.view.zoom;
      let styles: Record<string, string> = {};
      if (g.kind === "spacing" && g.spacing?.kind === "gap") {
        const v = Math.max(0, Math.round(g.spacing.start + (g.spacing.axis === "x" ? ddx : ddy)));
        styles = { [g.spacing.prop]: `${v}px` };
      } else if (g.kind === "spacing" && g.spacing?.kind === "pad") {
        const side = g.spacing.side;
        const i = ["top", "right", "bottom", "left"].indexOf(side);
        const delta = side === "top" ? ddy : side === "bottom" ? -ddy : side === "left" ? ddx : -ddx;
        const v = Math.max(0, Math.round(g.spacing.start[i] + delta));
        const opposite = { top: "bottom", bottom: "top", left: "right", right: "left" }[side];
        const sides = e.shiftKey ? ["top", "right", "bottom", "left"] : e.altKey ? [side, opposite] : [side];
        for (const sd of sides) styles[`padding-${sd}`] = `${v}px`;
      } else if (!g.abs) {
        // ⌘ pressed before the layer's layout arrived: fetch it once, then move.
        if (!(g as Gesture & { fetching?: boolean }).fetching) {
          (g as Gesture & { fetching?: boolean }).fetching = true;
          send(async () => {
            const layout = await api.layout(el.nodeId);
            if (layout && gesture.current === g) g.abs = { layout, convert: !isAbsolute(layout) };
          });
        }
        return;
      } else if (g.abs) {
        const r0 = g.abs.layout.rect;
        let next = { ...r0, x: r0.x + ddx, y: r0.y + ddy };
        let guides: { axis: "x" | "y"; value: number }[] = [];
        if (!e.altKey) {
          const snap = snapMove(next, [g.abs.layout.cb, ...g.abs.layout.siblings], g.view.zoom);
          next = { ...next, x: next.x + snap.dx, y: next.y + snap.dy };
          guides = snap.guides;
        }
        setAbsGuides(guides);
        styles = { ...absoluteConstraints(next, g.abs.layout.cb) };
        if (g.abs.convert)
          Object.assign(styles, { position: "absolute", width: `${Math.round(r0.width)}px`, margin: "0px" });
      }
      g.styles = styles;
      send(async () => {
        if (gesture.current !== g) return;
        const layout = await api.previewStyle(el.nodeId, styles);
        if (gesture.current !== g || !layout) return;
        if (g.kind === "spacing") setLayerLayout({ key: layoutKey, layout });
        else {
          setElementRect(layout.rect);
          setLayerLayout({ key: layoutKey, layout: { ...layout } });
        }
      });
      return;
    }
    if (g.element) {
      const el = g.element;
      const api = inspectors.current.get(el.boardId);
      const b = boards.find((x) => x.id === el.boardId);
      if (!api || !b) return;
      if (g.kind === "element-drag") {
        if (!g.moved) {
          g.moved = true;
          setDragging(true);
          send(async () => {
            if (!(await api.dragStart(el.nodeId)) && gesture.current === g) {
              // Absolute or locked layers do not reorder.
              gesture.current = undefined;
              setDragging(false);
              setDragPoint(undefined);
            }
          });
        }
        setDragPoint(point);
        const w = toWorld(point, g.view);
        send(async () => {
          if (gesture.current !== g) return;
          const state = await api.dragOver(w.x - b.x, w.y - b.y);
          if (gesture.current !== g) return;
          dragStateRef.current = state;
          setDragState(state);
        });
      } else {
        g.moved = true;
        setDragging(true);
        const r = el.rect, edge = g.edge!;
        let width = r.width, height = r.height;
        const ddx = dx / g.view.zoom, ddy = dy / g.view.zoom;
        if (edge.includes("e")) width = r.width + ddx;
        if (edge.includes("w")) width = r.width - ddx;
        if (edge.includes("s")) height = r.height + ddy;
        if (edge.includes("n")) height = r.height - ddy;
        if (e.shiftKey && edge.length === 2 && r.width && r.height) {
          const scale = Math.max(width / r.width, height / r.height);
          width = r.width * scale;
          height = r.height * scale;
        }
        width = Math.max(8, Math.round(width));
        height = Math.max(8, Math.round(height));
        // Text wraps to its width and hugs its height, except when the
        // top or bottom edge alone is dragged.
        const text = !!props.selectionIsText;
        const corner = edge.length === 2;
        const setWidth = /[ew]/.test(edge) || (!text && e.shiftKey && corner);
        const setHeight = text ? !/[ew]/.test(edge) : /[ns]/.test(edge) || (e.shiftKey && corner);
        const size: Record<string, string> = {};
        // A dragged size is what the person asked for: lift layout limits so
        // the handle stays under the pointer.
        if (setWidth) Object.assign(size, { width: width + "px", "max-width": "none", "flex-shrink": "0" });
        if (setHeight) Object.assign(size, { height: height + "px", "max-height": "none" });
        (g as Gesture & { size?: typeof size }).size = size;
        send(async () => {
          if (gesture.current !== g) return;
          const layout = await api.previewStyle(el.nodeId, size);
          if (gesture.current === g && layout) setElementRect(layout.rect);
        });
      }
      return;
    }
    g.moved = true;
    setDragging(true);
    if (g.kind === "pan") {
      touched.current = true;
      changeView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
    } else if (g.kind === "marquee") {
      const r = rectBetween(g.start, point);
      setMarquee(r);
      const world = {
        ...toWorld({ x: r.x, y: r.y }, g.view),
        width: r.width / g.view.zoom,
        height: r.height / g.view.zoom,
      };
      onSelectionChange([
        ...new Set([
          ...(g.additive ? g.initialSelection : []),
          ...boards.filter((b) => intersects(b, world)).map((b) => b.id),
        ]),
      ]);
    } else {
      const next: Record<string, Rect> = {};
      if (g.kind === "resize")
        next[g.boards[0].id] = resizeRect(
          g.boards[0],
          g.edge!,
          dx / g.view.zoom,
          dy / g.view.zoom,
          e.shiftKey,
        );
      else {
        let x = dx / g.view.zoom,
          y = dy / g.view.zoom;
        const horizontal = Math.abs(x) >= Math.abs(y);
        if (e.shiftKey) {
          if (horizontal) y = 0;
          else x = 0;
        }
        const box = bounds(g.boards)!;
        const snapped = e.altKey
          ? { dx: 0, dy: 0, guides: [] }
          : snapMove(
              { ...box, x: box.x + x, y: box.y + y },
              boards.filter((b) => !g.boards.some((m) => m.id === b.id)),
              g.view.zoom,
            );
        if (!e.shiftKey || horizontal) x += snapped.dx;
        if (!e.shiftKey || !horizontal) y += snapped.dy;
        setGuides(snapped.guides);
        for (const b of g.boards)
          next[b.id] = {
            x: Math.round(Math.max(-100000, Math.min(100000, b.x + x))),
            y: Math.round(Math.max(-100000, Math.min(100000, b.y + y))),
            width: b.width,
            height: b.height,
          };
      }
      patchesRef.current = next;
      setPatches(next);
    }
  }
  async function save(operations: DesignOperation[]) {
    if (!operations.length || saving) return;
    setSaving(true);
    try {
      await onChange(operations);
    } finally {
      setSaving(false);
      patchesRef.current = {};
      setPatches({});
    }
  }
  function end(e: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    // Flush the final position before React paints another frame.
    move(e);
    gesture.current = undefined;
    setDragging(false);
    setMarquee(undefined);
    setGuides([]);
    if (viewport.current?.hasPointerCapture(e.pointerId))
      viewport.current.releasePointerCapture(e.pointerId);
    if (g.kind === "mark" && g.mark) {
      setMarkDraft(undefined);
      if (!canEdit) return;
      if (g.mark.type !== "freehand" || g.moved) props.onCreateMark?.(g.mark.preview);
      if (g.mark.type === "note") setEditMarkId(g.mark.preview.id);
      if (g.mark.type !== "freehand") setMode("select");
      return;
    }
    if (g.kind === "tool" && g.tool) {
      const tool = g.tool;
      const drawn = draw;
      setDraw(undefined);
      setInsertHint(undefined);
      if (tool.kind === "text") {
        if (!g.moved && tool.board && tool.target) void insertText(tool.board, tool.target);
        return;
      }
      const sized = g.moved && drawn && drawn.rect.width >= 8 && drawn.rect.height >= 8 ? drawn.rect : undefined;
      setMode("select");
      const b = tool.board;
      if (!b) {
        const last = boards.at(-1);
        props.onCreateBoard?.(
          sized ?? { x: tool.world.x, y: tool.world.y, width: last?.width ?? 1280, height: last?.height ?? 800 },
        );
        return;
      }
      const size = sized ?? { ...tool.world, ...FRAME_SIZE };
      if (tool.abs) {
        props.onInsertFrame?.(b, { rect: { ...size, x: size.x - b.x, y: size.y - b.y } });
        return;
      }
      void tool.target?.then((t) => {
        if (t) props.onInsertFrame?.(b, { target: t, width: size.width, height: size.height });
      });
      return;
    }
    if (g.kind === "comment-area") {
      const b = g.boards[0];
      const region = area;
      setArea(undefined);
      if (!g.moved || !region || region.width < 4 || region.height < 4) {
        commentClick.current = { boardId: b.id, point: g.element!.grab, at: Date.now() };
        inspect(b, g.start);
        return;
      }
      const api = inspectors.current.get(b.id);
      void (async () => {
        const layers = (await api?.nodesIn(region)) ?? [];
        props.onAreaComment?.(b, region, layers);
      })();
      return;
    }
    if ((g.kind === "spacing" || g.kind === "element-move-abs") && g.element) {
      const el = g.element;
      const b = boards.find((x) => x.id === el.boardId);
      setAbsGuides([]);
      if (!g.moved || !g.styles || !b) {
        setElementRect(undefined);
        if (g.kind === "element-move-abs" && b) inspect(b, local(e));
        return;
      }
      const styles = g.styles;
      const kind =
        g.kind === "element-move-abs"
          ? g.abs?.convert ? "absolute" : "move"
          : g.spacing?.kind === "gap" ? "gap" : "padding";
      send(async () => {
        await new Promise((r) => setTimeout(r, 0));
        setElementRect(undefined);
        if (props.onElementStyle && !(await props.onElementStyle(b, el.nodeId, styles, kind)))
          setFrameEpochs((m) => ({ ...m, [b.id]: (m[b.id] ?? 0) + 1 }));
      });
      return;
    }
    if (g.element) {
      const el = g.element;
      const api = inspectors.current.get(el.boardId);
      const b = boards.find((x) => x.id === el.boardId);
      const finish = () => {
        setDragState(null);
        setDragPoint(undefined);
        setElementRect(undefined);
      };
      if (!g.moved) {
        // A press without movement is a click: select what is under it.
        if (b && g.kind === "element-drag") inspect(b, local(e));
        finish();
        return;
      }
      if (g.kind === "element-drag") {
        // Wait for the last preview so the drop matches what was shown.
        send(async () => {
          const state = dragStateRef.current;
          await api?.dragEnd(!!state?.moved);
          finish();
          if (b && state?.moved && props.onElementMove)
            if (!(await props.onElementMove(b, el.nodeId, state.containerId, state.index)))
              setFrameEpochs((m) => ({ ...m, [b.id]: (m[b.id] ?? 0) + 1 }));
        });
      } else {
        const size = (g as Gesture & { size?: Record<string, string> }).size;
        send(async () => {
          finish();
          if (b && size && props.onElementResize)
            if (!(await props.onElementResize(b, el.nodeId, size)))
              setFrameEpochs((m) => ({ ...m, [b.id]: (m[b.id] ?? 0) + 1 }));
        });
      }
      return;
    }
    // A click without movement on a selected board's body picks the layer under it.
    if (!g.moved && g.kind === "move" && g.pick) {
      inspect(g.pick, g.start);
      return;
    }
    if (!g.moved || !["move", "resize"].includes(g.kind)) return;
    const operations: DesignOperation[] = g.boards.flatMap((b) => {
      const p = patchesRef.current[b.id];
      return p &&
        (p.x !== b.x ||
          p.y !== b.y ||
          p.width !== b.width ||
          p.height !== b.height)
        ? [
            {
              type: "placement" as const,
              boardId: b.id,
              expectedRevision: b.placementRevision,
              ...p,
            },
          ]
        : [];
    });
    if (operations.length) void save(operations);
    else {
      patchesRef.current = {};
      setPatches({});
    }
  }
  function key(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented || isTextInput(e.target)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (shapesMenu) { setShapesMenu(false); shapesTrigger.current?.focus(); }
      else if (zoomMenu) { setZoomMenu(false); zoomTrigger.current?.focus(); }
      else if (previewId) preview();
      else if (gesture.current) cancel();
      else if (mode === "text" || mode === "frame" || isDesignMarkType(mode)) setMode("select");
      else if (selectedMarkIds.length) props.onMarkSelectionChange?.([]);
      // One level at a time: a layer steps out to its board, a board to nothing.
      else if (selection?.anchor.nodeId && mode !== "comment") onSelectionChange([selection.boardId]);
      else {
        onSelectionChange([]);
        setZoomMenu(false);
        if (mode === "comment") { setMode("select"); props.onCommentDone?.(); }
      }
      return;
    }
    if (previewId) return;
    if (gesture.current?.kind === "mark" && (e.metaKey || e.ctrlKey) && ["z", "y"].includes(e.key.toLowerCase())) { cancel(); return; }
    if (e.code === "Space") {
      e.preventDefault();
      spaceRef.current = true;
      setSpace(true);
      return;
    }
    // Mark controls own object editing; canvas zoom/tools still work from a focused mark.
    // Unhandled undo bubbles to DesignPanel's window handler.
    if (e.target instanceof Element && e.target.closest("[data-design-marks]")) {
      const zoomShortcut = ((e.metaKey || e.ctrlKey) && (e.code === "Digit0" || ["+", "=", "-"].includes(e.key))) || (e.shiftKey && ["Digit0", "Digit1", "Digit2"].includes(e.code));
      const toolShortcut = !e.metaKey && !e.ctrlKey && !e.altKey && ["v", "h", "t", "f", "c", "n", "p", "r", "o", "l"].includes(e.key.toLowerCase());
      if (!zoomShortcut && !toolShortcut) return;
    }
    if (selectedMarkIds.length && !e.metaKey && !e.ctrlKey && !e.altKey && ["Delete", "Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      if (!canEdit || markGesturing || gesture.current) return;
      if (e.key === "Delete" || e.key === "Backspace") props.onMarksDelete?.(selectedMarkIds);
      else {
        const step = e.shiftKey ? 10 : 1;
        void props.onMarksChange?.(marks.filter(m => selectedMarkIds.includes(m.id)).map(m => translateDesignMark(m, e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0)), "move");
      }
      return;
    }
    if (e.shiftKey && e.code === "KeyA" && !e.metaKey && !e.ctrlKey && selection?.anchor.nodeId && canEdit) {
      // Auto layout: the selected container lays out its children, or the layer gets wrapped in one.
      e.preventDefault();
      props.onAutoLayout?.();
      return;
    }
    if (e.altKey && e.code === "KeyL") {
      // On macOS ⌥L produces "¬" in e.key, so match the physical key.
      e.preventDefault();
      props.onToggleLayers?.();
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      if (e.code === "Digit0") { e.preventDefault(); fit(); return; }
      if (e.key === "+" || e.key === "=") { e.preventDefault(); zoom(viewRef.current.zoom * 1.25); return; }
      if (e.key === "-") { e.preventDefault(); zoom(viewRef.current.zoom / 1.25); return; }
      if (e.key.toLowerCase() === "a") {
        e.preventDefault();
        props.onMarkSelectionChange?.([]);
        onSelectionChange(boards.map((b) => b.id));
      }
      if (e.key.toLowerCase() === "d" && canEdit && selectedIds.length) {
        e.preventDefault();
        if (selection?.anchor.nodeId) {
          props.onElementCommand("duplicate");
          return;
        }
        void save(
          selectedBoards.map((b) => ({
            type: "duplicate",
            boardId: b.id,
            expectedRevision: b.contentRevision,
          })),
        );
      }
      return;
    }
    if (e.shiftKey && ["Digit0", "Digit1", "Digit2"].includes(e.code)) {
      e.preventDefault();
      if (e.code === "Digit0") zoom(1);
      if (e.code === "Digit1") fit();
      if (e.code === "Digit2") fit([...selectedBoards, ...selectedMarks]);
      return;
    }
    if (e.key.toLowerCase() === "v") setMode("select");
    if (e.key.toLowerCase() === "h") setMode("pan");
    if (e.key.toLowerCase() === "t" && canEdit) setMode("text");
    if (e.key.toLowerCase() === "f" && canEdit) setMode("frame");
    if (canEdit && props.onCreateMark && !e.altKey && !e.repeat) {
      if (e.key.toLowerCase() === "n") setMode("note");
      if (e.key.toLowerCase() === "p") setMode("freehand");
      if (e.key.toLowerCase() === "r") setMode("rectangle");
      if (e.key.toLowerCase() === "o") setMode("ellipse");
      if (e.key.toLowerCase() === "l") setMode(e.shiftKey ? "arrow" : "line");
    }
    if (e.key.toLowerCase() === "c" && e.shiftKey && !e.altKey) {
      e.preventDefault();
      props.onToggleComments?.();
      return;
    }
    if (e.key.toLowerCase() === "c" && !e.altKey) {
      // Enter comment mode; a current selection gets its composer right away.
      e.preventDefault();
      setMode("comment");
      props.onCommentRequest?.();
    }
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoom(viewRef.current.zoom * 1.25);
    }
    if (e.key === "-") {
      e.preventDefault();
      zoom(viewRef.current.zoom / 1.25);
    }
    // Layer tree: Enter edits text or goes into a layer, Shift+Enter goes up,
    // Tab and Shift+Tab move across siblings (boards when none is selected).
    if (e.key === "Enter" && e.shiftKey && props.onNavigate?.("parent")) {
      e.preventDefault();
      return;
    }
    if (e.key === "Tab" && (selection?.anchor.nodeId || selectedIds.length === 1) && props.onNavigate?.(e.shiftKey ? "prev" : "next")) {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && selection?.anchor.nodeId && (props.onEditRequest?.() || props.onNavigate?.("child"))) {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && selectedIds.length === 1) {
      e.preventDefault();
      preview(selectedIds[0]);
    }
    if (!canEdit || gesture.current) return;
    if (selection?.anchor.nodeId) {
      if (["Delete", "Backspace"].includes(e.key)) {
        e.preventDefault();
        props.onElementCommand("remove");
      }
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        props.onElementCommand(
          "nudge",
          e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0,
          e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0,
        );
      }
      return;
    }
    if (["Delete", "Backspace"].includes(e.key) && selectedIds.length) {
      e.preventDefault();
      void save(
        selectedBoards.map((b) => ({
          type: "remove",
          boardId: b.id,
          expectedRevision: b.contentRevision,
        })),
      );
      onSelectionChange([]);
    }
    if (
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) &&
      selectedIds.length
    ) {
      e.preventDefault();
      const delta = e.shiftKey ? 10 : 1;
      void save(
        selectedBoards.map((b) => ({
          type: "placement",
          boardId: b.id,
          expectedRevision: b.placementRevision,
          x:
            b.x +
            (e.key === "ArrowLeft"
              ? -delta
              : e.key === "ArrowRight"
                ? delta
                : 0),
          y:
            b.y +
            (e.key === "ArrowUp" ? -delta : e.key === "ArrowDown" ? delta : 0),
        })),
      );
    }
  }
  const highlight = hover ?? selection;
  return (
    <div
      ref={viewport}
      tabIndex={0}
      aria-label="Design canvas viewport"
      onDragOver={(e) => {
        if (!props.onDropImages || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
        if (!props.onDropImages || !files.length) return;
        e.preventDefault();
        const world = toWorld(local(e), viewRef.current);
        // The board under the drop (frames swallow the event target, so by geometry).
        const board = [...boards].reverse().find((b) => world.x >= b.x && world.x <= b.x + b.width && world.y >= b.y && world.y <= b.y + b.height && !writingBoard(b));
        const target = board ? inspectors.current.get(board.id)?.dropTarget(world.x - board.x, world.y - board.y) ?? Promise.resolve(null) : Promise.resolve(null);
        void target.then((t) => props.onDropImages?.(files, { board, target: t ?? null, world }));
      }}
      className={[
        "design-viewport",
        (mode === "pan" || space) && "is-pan",
        dragging && "is-dragging",
        mode === "comment" && "is-inspecting",
        (mode === "text" || mode === "frame" || isDesignMarkType(mode)) && "is-inserting is-" + mode,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ "--design-zoom": view.zoom } as CSSProperties}
      data-view-x={view.x}
      data-view-y={view.y}
      data-view-zoom={view.zoom}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={cancel}
      onLostPointerCapture={() => {
        if (gesture.current) cancel();
      }}
      onPointerLeave={() => {
        setHover(undefined);
        hoverBoard.current = undefined;
      }}
      onKeyDown={key}
      onDoubleClick={(e) => {
        if (mode !== "select") return;
        // Pointer capture can retarget the second click to the viewport.
        const label = Array.from(viewport.current?.querySelectorAll<HTMLElement>("[data-rename-board]") ?? [])
          .find(el => { const r = el.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; });
        if (label) {
          if (editable) setRenamingBoard(label.dataset.renameBoard);
          return;
        }
        const edge =
          (e.target instanceof Element &&
            e.target.closest("[data-element-resize]")?.getAttribute("data-element-resize")) ||
          (lastHandle.current && Date.now() - lastHandle.current.at < 600
            ? lastHandle.current.edge
            : undefined);
        if (edge && selection?.anchor.nodeId) {
          // Double-click a handle: that dimension hugs its content.
          const b = boards.find((x) => x.id === selection.boardId);
          const size: Record<string, string> = {};
          if (/[ew]/.test(edge)) size.width = "fit-content";
          if (/[ns]/.test(edge)) size.height = "";
          if (b) void props.onElementResize?.(b, selection.anchor.nodeId, size);
          return;
        }
        // Pointer capture retargets dblclick to the viewport: resolve by position.
        const w = toWorld(local(e), viewRef.current);
        const b =
          boardAt(e.target) ??
          boards.find(
            (x) => w.x >= x.x && w.x <= x.x + x.width && w.y >= x.y && w.y <= x.y + x.height,
          );
        if (
          b &&
          !spaceRef.current &&
          !(e.target instanceof Element && e.target.closest("[data-canvas-ui]"))
        ) {
          // Double-click selects the layer under the pointer and edits its text.
          editIntent.current = b.id;
          lastDouble.current = { x: e.clientX, y: e.clientY, at: Date.now() };
          inspect(b, local(e));
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {props.children}
      <div
        className="design-canvas-tools"
        data-canvas-ui
        role="toolbar"
        aria-label="Canvas tools"
      >
        {props.toolbarLeading && <>{props.toolbarLeading}<span className="design-tools-divider" /></>}
        <DesignToolButton
          title="Select and move (V)"
          aria-label="Select and move"
          aria-pressed={mode === "select"}
          onClick={() => setMode("select")}
        >
          <MousePointer size={17} stroke={1.5} />
        </DesignToolButton>
        <DesignToolButton
          title="Hand tool (H) · hold Space to pan"
          aria-label="Hand tool"
          aria-pressed={mode === "pan"}
          onClick={() => setMode("pan")}
        >
          <Hand size={17} stroke={1.5} />
        </DesignToolButton>
        <DesignToolButton
          title="Text (T)"
          aria-label="Text tool"
          aria-pressed={mode === "text"}
          disabled={!canEdit}
          onClick={() => setMode(mode === "text" ? "select" : "text")}
        >
          <Type size={17} stroke={1.5} />
        </DesignToolButton>
        <DesignToolButton
          title="Frame (F) · drag outside a board for a new board"
          aria-label="Frame tool"
          aria-pressed={mode === "frame"}
          disabled={!canEdit}
          onClick={() => setMode(mode === "frame" ? "select" : "frame")}
        >
          <Hash size={17} stroke={1.5} />
        </DesignToolButton>
        {!props.commentControlInHeader && <DesignToolButton
          title="Comment · C"
          aria-label="Comment mode"
          aria-pressed={mode === "comment"}
          onClick={() => setMode(mode === "comment" ? "select" : "comment")}
        >
          <MessageCircle size={17} stroke={1.5} />
        </DesignToolButton>}
        {props.onCreateMark && <>
          <DesignToolButton title="Note (N)" aria-label="Note tool" aria-pressed={mode === "note"} disabled={!canEdit} onClick={() => setMode(mode === "note" ? "select" : "note")}><MarkToolIcon type="note" /></DesignToolButton>
          <DesignToolButton title="Draw (P)" aria-label="Draw tool" aria-pressed={mode === "freehand"} disabled={!canEdit} onClick={() => setMode(mode === "freehand" ? "select" : "freehand")}><MarkToolIcon type="freehand" /></DesignToolButton>
          <div className="design-mark-shapes">
            <button ref={shapesTrigger} title="Shapes" aria-label="Shapes" aria-haspopup="menu" aria-expanded={shapesMenu} aria-pressed={["rectangle", "ellipse", "line", "arrow"].includes(mode)} disabled={!canEdit} onClick={() => setShapesMenu(v => !v)}><MarkToolIcon type={["rectangle", "ellipse", "line", "arrow"].includes(mode) ? mode as DesignMarkType : "rectangle"} /></button>
            {shapesMenu && <DesignActionMenu trigger={shapesTrigger} label="Shapes" className="design-mark-shape-menu" onClose={() => setShapesMenu(false)}>
              {([ ["rectangle", "Rectangle", "R"], ["ellipse", "Ellipse", "O"], ["line", "Line", "L"], ["arrow", "Arrow", "⇧L"] ] as const).map(([kind, label, shortcut]) => <button key={kind} role="menuitemradio" aria-checked={mode === kind} onClick={() => { setMode(kind); setShapesMenu(false); viewport.current?.focus({ preventScroll: true }); }}><MarkToolIcon type={kind} />{label}<kbd>{shortcut}</kbd></button>)}
            </DesignActionMenu>}
          </div>
        </>}
      </div>
      {(mode === "text" || mode === "frame") && !previewId && (
        <div className="design-mode-hint" data-canvas-ui role="status">
          {mode === "text" ? <Type size={14} /> : <Hash size={14} />}
          <span>
            {mode === "text"
              ? "Click to add text"
              : "Drag to draw a frame · outside a board for a new board"}
          </span>
          <button onClick={() => setMode("select")}>
            Done <kbd>Esc</kbd>
          </button>
        </div>
      )}
      {isDesignMarkType(mode) && !previewId && <div className="design-mode-hint" data-canvas-ui role="status">
        <MarkToolIcon type={mode} />
        <span>{mode === "note" ? "Click or drag to add a note" : mode === "freehand" ? "Drag to draw · Esc when done" : `Drag to draw ${mode === "ellipse" || mode === "arrow" ? "an" : "a"} ${mode} · Shift to constrain`}</span>
        <button onClick={() => setMode("select")}>Done <kbd>Esc</kbd></button>
      </div>}
      {mode === "comment" && !previewId && (
        <div className="design-mode-hint" data-canvas-ui role="status">
          <MessageCircle size={14} />
          <span>Click to comment · drag for an area</span>
          <button onClick={() => { setMode("select"); props.onCommentDone?.(); }}>
            Done <kbd>Esc</kbd>
          </button>
        </div>
      )}
      <div className="design-canvas-zoom" data-canvas-ui>
        <DesignToolButton aria-label="Play design" title="Play design (Enter)" disabled={!boards.length} onClick={() => preview(selectedIds[0] ?? boards[0]?.id)}><Play size={16} stroke={1.5} /></DesignToolButton>
        {props.inspector && <>
          <DesignToolButton className="design-inspector-toggle" aria-label={props.inspector.open ? "Hide inspector" : "Show inspector"} title="Properties" aria-pressed={props.inspector.open} onClick={props.inspector.toggle}><PanelRight size={16} stroke={1.5} /></DesignToolButton>
          <span className="design-tools-divider" />
        </>}
        <button ref={zoomTrigger} className="design-zoom" aria-label="Zoom options" aria-haspopup="menu" aria-expanded={zoomMenu} onClick={() => setZoomMenu(v => !v)}>
          <span>{Math.round(view.zoom * 100)}%</span><ChevronDown size={12} />
        </button>
        {zoomMenu && <div ref={zoomList} className="design-zoom-menu" role="menu" aria-label="Zoom">
          <button role="menuitem" onClick={() => zoom(viewRef.current.zoom * 1.25)}>Zoom in <kbd>⌘+</kbd></button>
          <button role="menuitem" onClick={() => zoom(viewRef.current.zoom / 1.25)}>Zoom out <kbd>⌘−</kbd></button>
          <button role="menuitem" onClick={() => fit()}>Fit canvas <kbd>⌘0</kbd></button>
          <button role="menuitem" disabled={!selectedIds.length && !selectedMarkIds.length} onClick={() => fit([...selectedBoards, ...selectedMarks])}>Fit selection <kbd>⇧2</kbd></button>
          <div className="design-menu-divider" role="separator" />
          <div className="design-menu-label">Now {Math.round(view.zoom * 100)}%</div>
          {[25,50,75,100,150,200].map(percent => <button key={percent} role="menuitemradio" aria-checked={Math.round(view.zoom * 100) === percent} onClick={() => { zoom(percent / 100); setZoomMenu(false); zoomTrigger.current?.focus(); }}>{percent}% {Math.round(view.zoom * 100) === percent && <Check size={12} />}</button>)}
          <div className="design-menu-divider" role="separator" />
          <button role="menuitemcheckbox" aria-checked={layoutGuides} onClick={() => setLayoutGuides(!layoutGuides)}>Layout guides {layoutGuides && <Check size={12} />}</button>
          {props.history && <>
            <div className="design-menu-divider" role="separator" />
            <button role="menuitem" disabled={!props.history.canUndo} onClick={() => { setZoomMenu(false); zoomTrigger.current?.focus(); props.history?.step("undo"); }}>Undo <kbd>⌘Z</kbd></button>
            <button role="menuitem" disabled={!props.history.canRedo} onClick={() => { setZoomMenu(false); zoomTrigger.current?.focus(); props.history?.step("redo"); }}>Redo <kbd>⇧⌘Z</kbd></button>
          </>}
        </div>}
      </div>
      <div
        className="design-world"
        style={{
          transform:
            "translate(" +
            view.x +
            "px," +
            view.y +
            "px) scale(" +
            view.zoom +
            ")",
        }}
      >
        {boards.map((b) => {
          const p = patches[b.id] ?? b,
            isSelected = selectedIds.includes(b.id);
          return (
            <div
              key={b.id}
              data-board-id={b.id}
              className={
                "design-board" +
                (isSelected ? " is-selected" : "") +
                // A layer inside is selected: the board is context, not the target.
                (selection?.boardId === b.id ? " has-layer-selection" : "") +
                // The agent is writing this board right now.
                (writingBoard(b) ? " is-writing" : "")
              }
              data-board-writing={writingBoard(b) ? "true" : undefined}
              style={{ left: p.x, top: p.y, width: p.width, height: p.height }}
            >
              <div className="design-board-heading">
                {renamingBoard === b.id && editable ? (
                  <BoardNameInput key={b.id} name={b.name} autoFocus className="design-board-name-input"
                    onDone={() => setRenamingBoard(undefined)}
                    onSave={name => { void onChange([{ type: "placement", boardId: b.id, expectedRevision: b.placementRevision, name }]); }} />
                ) : <button
                  className="design-board-label" data-rename-board={b.id}
                  title={b.name}
                  onDoubleClick={e => { e.stopPropagation(); if (editable) setRenamingBoard(b.id); }}
                  onKeyDown={e => { if (editable && (e.key === "Enter" || e.key === "F2")) { e.preventDefault(); e.stopPropagation(); setRenamingBoard(b.id); } }}
                  onClick={e => { if (e.detail === 0) onSelectionChange([b.id]); }}
                >{b.name}</button>}
                {writingBoard(b) ? <span>Writing…</span> : null}
                {isDesignDeck(b.html) ? (() => {
                  const count = designSlides(b.html).length;
                  const at = Math.min(deckSlide[b.id] ?? 0, Math.max(0, count - 1));
                  const go = (to: number) => setDeckSlide((all) => ({ ...all, [b.id]: Math.max(0, Math.min(count - 1, to)) }));
                  return count ? (
                    <span className="design-deck-nav" data-canvas-ui>
                      <button data-canvas-ui aria-label={`Previous slide of ${b.name}`} disabled={at <= 0} onClick={() => go(at - 1)}>‹</button>
                      <span aria-label="Slide">{at + 1} / {count}</span>
                      <button data-canvas-ui aria-label={`Next slide of ${b.name}`} disabled={at >= count - 1} onClick={() => go(at + 1)}>›</button>
                    </span>
                  ) : null;
                })() : null}
                {runtimeIssues[b.id] ? (
                  <span
                    className="design-board-issue"
                    title={runtimeIssues[b.id].hung ? "This board's logic stopped responding; showing its template without logic." : runtimeIssues[b.id].errors.join("\n")}
                  >
                    {runtimeIssues[b.id].hung ? "Logic paused" : "Logic error"}
                  </span>
                ) : null}
                <button
                  data-canvas-ui
                  className="design-board-preview"
                  title="Preview board (Enter)"
                  aria-label={"Preview " + b.name}
                  onClick={() => preview(b.id)}
                >
                  <ArrowsDiagonal size={14} stroke={1.6} />
                </button>
                {props.onBoardDownload ? (
                  <button
                    data-canvas-ui
                    className="design-board-preview"
                    title="Download"
                    aria-label={"Download " + b.name}
                    aria-haspopup="menu"
                    onClick={(e) => props.onBoardDownload?.(b.id, e.currentTarget)}
                  >
                    <Download size={14} stroke={1.6} />
                  </button>
                ) : null}
              </div>
              <BoardFrame
                key={frameEpochs[b.id] ?? 0}
                ref={(api) => {
                  if (api) inspectors.current.set(b.id, api);
                  else inspectors.current.delete(b.id);
                }}
                board={patches[b.id] ? { ...b, ...p } : b}
                mode={writingBoard(b) ? "static" : "edit"}
                system={props.system}
                slide={isDesignDeck(b.html) ? Math.min(deckSlide[b.id] ?? 0, Math.max(0, designSlides(b.html).length - 1)) : undefined}
                onRuntime={(event) => onBoardRuntime(b.id, event)}
                onLoad={() => {
                  setLoads((n) => n + 1);
                  // A layer picked for this board (e.g. just inserted) while its frame reloaded.
                  const t = props.layerTarget;
                  if (t?.boardId === b.id && Date.now() - t.request < 5000)
                    inspectors.current.get(b.id)?.selectNode(t.nodeId);
                }}
                onInspect={(anchor, hovering, requested) => {
                  const expected = expectedLayer.current;
                  if (requested && (!expected || expected.boardId !== b.id || expected.nodeId !== anchor.nodeId)) return;
                  if (hovering) {
                    if (hoverBoard.current === b.id)
                      setHover({
                        boardId: b.id,
                        revision: b.contentRevision,
                        anchor,
                      });
                  } else if (mode === "select" && !anchor.nodeId) {
                    // The page background is the board itself.
                    editIntent.current = undefined;
                    setHover(undefined);
                    onSelectionChange([b.id]);
                  } else {
                    // A hit-test on a locked layer gets no reply; don't let its click linger.
                    const click =
                      commentClick.current && Date.now() - commentClick.current.at < 1500
                        ? commentClick.current
                        : undefined;
                    // Only a real click comments; re-reports after reloads just reselect.
                    const commenting = mode === "comment" && click?.boardId === b.id;
                    if (commenting && anchor.rect) {
                      anchor = {
                        ...anchor,
                        offset: {
                          x: Math.round(click.point.x - anchor.rect.x),
                          y: Math.round(click.point.y - anchor.rect.y),
                        },
                      };
                    }
                    commentClick.current = undefined;
                    onElementSelect(
                      b,
                      anchor,
                      commenting
                        ? "comment"
                        : editIntent.current === b.id
                          ? "edit"
                          : undefined,
                    );
                    editIntent.current = undefined;
                    setHover(undefined);
                  }
                }}
              />
              {pins
                .filter((pin) => pin.boardId === b.id && pin.status !== "resolved")
                .map((pin) => {
                  const at = pinPoint(pin);
                  if (!at) return null;
                  return (
                    <button
                      key={pin.id}
                      data-canvas-ui
                      data-comment-id={pin.id}
                      className={
                        "design-pin" +
                        (pin.id === props.activePinId ? " is-active" : "") +
                        (pin.status === "working" ? " is-working" : "") +
                        ((pin.nodeId || pin.nodeIds?.length) && measured[pin.id] === null
                          ? " is-detached"
                          : "")
                      }
                      aria-label={"Open comment by " + pin.initial}
                      style={{ left: at.x, top: at.y }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => props.onPinOpen?.(pin.id)}
                    >
                      {pin.initial}
                    </button>
                  );
                })}
              {selection?.boardId === b.id && currentLayout && (() => {
                const g = gesture.current;
                const spacingLive = g?.kind === "spacing";
                const absLive = g?.kind === "element-move-abs" && g.moved;
                const idle =
                  !g && !hover && !!props.elementEditable && canEdit && mode === "select" && !space;
                const L = currentLayout;
                const parts: React.ReactNode[] = [];
                if (layoutGuides && (idle || spacingLive) && isAutoLayout(L)) {
                  for (const p of paddingRegions(L)) {
                    const r = p.rect;
                    if (r.width > 0.5 && r.height > 0.5)
                      parts.push(<div key={"pad-" + p.side} className="design-spacing-band" style={{ left: r.x, top: r.y, width: r.width, height: r.height }} />);
                    const at = {
                      top: { x: L.rect.x + L.rect.width / 2, y: L.rect.y + L.padding[0] },
                      right: { x: L.rect.x + L.rect.width - L.padding[1], y: L.rect.y + L.rect.height / 2 },
                      bottom: { x: L.rect.x + L.rect.width / 2, y: L.rect.y + L.rect.height - L.padding[2] },
                      left: { x: L.rect.x + L.padding[3], y: L.rect.y + L.rect.height / 2 },
                    }[p.side];
                    parts.push(
                      <div
                        key={"padh-" + p.side}
                        data-spacing={"pad:" + p.side}
                        aria-label={"Padding " + p.side}
                        className={"design-spacing-handle " + (p.side === "top" || p.side === "bottom" ? "is-h" : "is-v")}
                        style={{ left: at.x, top: at.y }}
                      />,
                    );
                  }
                  gapRegions(L).forEach((gp, i) => {
                    const r = gp.rect;
                    parts.push(
                      <div key={"gap-" + i} className="design-spacing-band is-gap" style={{ left: r.x, top: r.y, width: r.width, height: r.height }} />,
                      <div
                        key={"gaph-" + i}
                        data-spacing={`gap:${gp.prop}:${gp.axis}`}
                        aria-label="Gap"
                        className={"design-spacing-handle " + (gp.axis === "x" ? "is-v" : "is-h")}
                        style={{ left: r.x + r.width / 2, top: r.y + r.height / 2 }}
                      />,
                    );
                  });
                  if (spacingLive && g?.spacing) {
                    const text =
                      g.spacing.kind === "gap"
                        ? `Gap ${Math.round(g.spacing.prop === "row-gap" ? L.rowGap : L.columnGap)}`
                        : `Padding ${Math.round(L.padding[["top", "right", "bottom", "left"].indexOf(g.spacing.side)])}`;
                    parts.push(
                      <span key="spacing-label" className="design-board-label-pill" style={{ left: L.rect.x, top: L.rect.y }}>
                        {text}
                      </span>,
                    );
                  }
                }
                if (absLive) {
                  for (const gd of absGuides)
                    parts.push(
                      <div
                        key={"g" + gd.axis + gd.value}
                        className={"design-element-guide is-" + gd.axis}
                        style={gd.axis === "x" ? { left: gd.value, top: 0, height: b.height } : { top: gd.value, left: 0, width: b.width }}
                      />,
                    );
                  const r = L.rect,
                    cb = L.cb;
                  const c = absoluteConstraints(r, cb);
                  const dist = (key: string, x: number, y: number, w: number, h: number, value: string) =>
                    parts.push(
                      <div key={key} className="design-distance" style={{ left: x, top: y, width: w, height: h }}>
                        <span>{parseInt(value)}</span>
                      </div>,
                    );
                  if (c.left !== "auto") dist("dl", cb.x, r.y + r.height / 2, r.x - cb.x, 0, c.left);
                  if (c.right !== "auto") dist("dr", r.x + r.width, r.y + r.height / 2, cb.x + cb.width - r.x - r.width, 0, c.right);
                  if (c.top !== "auto") dist("dt", r.x + r.width / 2, cb.y, 0, r.y - cb.y, c.top);
                  if (c.bottom !== "auto") dist("db", r.x + r.width / 2, r.y + r.height, 0, cb.y + cb.height - r.y - r.height, c.bottom);
                  parts.push(
                    <span key="abs-label" className="design-board-label-pill" style={{ left: r.x, top: r.y + r.height, transform: "translateY(6px) scale(calc(1 / var(--design-zoom)))" }}>
                      {(g?.abs?.convert ? "Absolute · " : "") +
                        [c.top !== "auto" && `Top ${parseInt(c.top)}`, c.bottom !== "auto" && `Bottom ${parseInt(c.bottom)}`, c.left !== "auto" && `Left ${parseInt(c.left)}`, c.right !== "auto" && `Right ${parseInt(c.right)}`]
                          .filter(Boolean)
                          .join(" · ")}
                    </span>,
                  );
                }
                return parts;
              })()}
              {insertHint?.boardId === b.id && (
                <>
                  <div
                    className={"design-insert-line" + (insertHint.target.line.width ? " is-h" : " is-v")}
                    style={{
                      left: insertHint.target.line.x,
                      top: insertHint.target.line.y,
                      width: insertHint.target.line.width || undefined,
                      height: insertHint.target.line.height || undefined,
                    }}
                  />
                  <span
                    className="design-insert-tag"
                    style={{ left: insertHint.target.line.x, top: insertHint.target.line.y }}
                  >
                    {insertHint.target.name ?? b.name} · {insertHint.target.position} of {insertHint.target.count}
                  </span>
                </>
              )}
              {area && gesture.current?.kind === "comment-area" && gesture.current.boards[0]?.id === b.id && (
                <div
                  className="design-area"
                  style={{ left: area.x, top: area.y, width: area.width, height: area.height }}
                >
                  <span className="design-area-size">
                    {Math.round(area.width)} × {Math.round(area.height)}
                  </span>
                </div>
              )}
              {hover && mode === "comment" && hover.boardId === b.id && hover.anchor.rect && hover.anchor.nodeId && (
                <span
                  className="design-hover-tag"
                  style={{ left: hover.anchor.rect.x, top: hover.anchor.rect.y }}
                >
                  {findDesignLayer(trees?.get(b.id) ?? [], hover.anchor.nodeId)?.name.split(" · ")[0] ?? "Layer"}
                </span>
              )}
              {highlight?.boardId === b.id &&
                highlight.revision === b.contentRevision &&
                highlight.anchor.rect &&
                !(dragPoint && !hover) && (() => {
                  const r = (!hover && elementRect) || highlight.anchor.rect;
                  const handlesOn =
                    !hover && !!props.elementEditable && canEdit &&
                    mode === "select" && !space && !!highlight.anchor.nodeId;
                  return (
                    <div
                      className={"design-selection" + (hover ? " is-hover" : "")}
                      style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
                    >
                      {handlesOn &&
                        r.width * view.zoom >= 16 &&
                        r.height * view.zoom >= 16 &&
                        // Small layers keep corners only, so their middle stays draggable.
                        (r.width * view.zoom < 40 || r.height * view.zoom < 40
                          ? ["nw", "ne", "se", "sw"]
                          : ["nw", "n", "ne", "e", "se", "s", "sw", "w"]
                        ).map((edge) => (
                          <div
                            key={edge}
                            data-element-resize={edge}
                            className={"design-resize-handle is-element handle-" + edge}
                            aria-label={"Resize layer " + edge}
                          />
                        ))}
                    </div>
                  );
                })()}
              {isSelected &&
                !selection &&
                selectedIds.length === 1 &&
                canEdit &&
                mode === "select" &&
                !space &&
                ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((edge) => (
                  <div
                    key={edge}
                    data-resize={edge}
                    className={"design-resize-handle handle-" + edge}
                    aria-label={"Resize " + edge}
                  />
                ))}
            </div>
          );
        })}
        <CanvasMarks marks={marks} selectedIds={selectedMarkIds} zoom={view.zoom} editable={canEdit}
          interactive={mode === "select" && !space && !previewId}
          onSelect={(id, additive) => props.onMarkSelectionChange?.(additive ? selectedMarkIds.includes(id) ? selectedMarkIds.filter(x => x !== id) : [...selectedMarkIds, id] : [id])}
          onChange={(changed, reason) => props.onMarksChange?.(changed, reason)} onDelete={props.onMarksDelete}
          editId={editMarkId} onEditEnd={() => setEditMarkId(undefined)}
          onGestureChange={active => { markGesturingRef.current = active; setMarkGesturing(active); }} />
        {markDraft && <div className="design-mark-draft"><CanvasMarks marks={[markDraft]} selectedIds={[]} zoom={view.zoom} editable={false} interactive={false} onSelect={() => {}} onChange={() => {}} /></div>}
      </div>
      {(() => {
        const g = gesture.current;
        const el = g?.element;
        const b = el && boards.find((x) => x.id === el.boardId);
        if (!g || !el || !b) return null;
        const screen = (r: Rect) => ({
          left: view.x + (b.x + r.x) * view.zoom,
          top: view.y + (b.y + r.y) * view.zoom,
          width: r.width * view.zoom,
          height: r.height * view.zoom,
        });
        if (g.kind === "element-drag" && dragPoint) {
          const ghost = {
            left: dragPoint.x - el.grab.x * view.zoom,
            top: dragPoint.y - el.grab.y * view.zoom,
            width: el.rect.width * view.zoom,
            height: el.rect.height * view.zoom,
          };
          const c = dragState && screen(dragState.containerRect);
          const kind =
            dragState?.direction === "row"
              ? "Auto layout →"
              : dragState?.direction === "column"
                ? "Auto layout ↓"
                : dragState?.direction === "grid"
                  ? "Grid"
                  : "Stack ↓";
          return (
            <>
              {c && (
                <>
                  <div className="design-drop-container" style={c} />
                  <span
                    className="design-drop-tag"
                    style={{ left: c.left + c.width, top: Math.max(4, c.top - 22) }}
                  >
                    {dragState!.name} · {kind}
                  </span>
                </>
              )}
              <div className="design-drag-ghost" style={ghost} />
              {dragState && (
                <span
                  className="design-size-label"
                  style={{ left: ghost.left, top: ghost.top + ghost.height + 8 }}
                >
                  Position {dragState.position + 1} of {dragState.count}
                </span>
              )}
            </>
          );
        }
        if (g.kind === "element-resize" && elementRect) {
          const r = screen(elementRect);
          return (
            <span
              className="design-size-label"
              style={{ left: r.left + r.width / 2, top: r.top + r.height + 10, transform: "translateX(-50%)" }}
            >
              W {Math.round(elementRect.width)} · H {Math.round(elementRect.height)} · Fixed
            </span>
          );
        }
        return null;
      })()}
      {props.overlay?.({
        view,
        size: size(),
        gesturing: !!dragPoint || !!elementRect || markGesturing || !!markDraft,
        mode,
        pinRect,
        toScreen(boardId, rect) {
          const b = boards.find((x) => x.id === boardId);
          if (!b) return undefined;
          const p = patches[b.id] ?? b;
          const r = rect ?? { x: 0, y: 0, width: p.width, height: p.height };
          return {
            x: view.x + (p.x + r.x) * view.zoom,
            y: view.y + (p.y + r.y) * view.zoom,
            width: r.width * view.zoom,
            height: r.height * view.zoom,
          };
        },
      })}
      {guides.map((g, i) => (
        <div
          key={i}
          className={"design-guide guide-" + g.axis}
          style={
            g.axis === "x"
              ? { left: view.x + g.value * view.zoom }
              : { top: view.y + g.value * view.zoom }
          }
        />
      ))}
      {draw && (
        <div
          className={"design-draw" + (draw.boardId ? "" : " is-board")}
          style={{
            left: view.x + draw.rect.x * view.zoom,
            top: view.y + draw.rect.y * view.zoom,
            width: draw.rect.width * view.zoom,
            height: draw.rect.height * view.zoom,
          }}
        >
          <span className="design-draw-size">{draw.label}</span>
        </div>
      )}
      {marquee && (
        <div
          className="design-marquee"
          style={{
            left: marquee.x,
            top: marquee.y,
            width: marquee.width,
            height: marquee.height,
          }}
        />
      )}
      <div className="design-canvas-hint">
        {selectedIds.length > 1
          ? selectedIds.length + " boards selected"
          : mode === "comment"
            ? ""
            : "Space · drag to pan     ⌘ / Ctrl · scroll to zoom"}
      </div>
      {previewBoard && (
        <BoardPreview
          board={previewBoard}
          boards={[...boards].sort((a, b) => a.y - b.y || a.x - b.x)}
          system={props.system}
          onNavigate={(id) => setPreviewId(id)}
          onClose={() => preview()}
        />
      )}
    </div>
  );
}

function MarkToolIcon({ type }: { type: DesignMarkType }) {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {type === "note" ? <path d="M3 3h14v10l-4 4H3V3Zm10 14v-4h4M6 7h8M6 10h5" /> : type === "ellipse" ? <ellipse cx="10" cy="10" rx="7" ry="6" /> : type === "rectangle" ? <rect x="3" y="4" width="14" height="12" rx="1" /> : type === "freehand" ? <path d="M3 15c-2-5 5-13 7-11s-7 12-3 12 5-9 7-7-3 7 3 5" /> : <path d={type === "arrow" ? "M3 17 17 3M8 3h9v9" : "M3 17 17 3"} />}
  </svg>;
}

/** Room the presenter column takes beside a playing deck (CSS .is-presenting). */
const PRESENTER_WIDTH = 324;

function BoardPreview({
  board,
  boards,
  system,
  onNavigate,
  onClose,
}: {
  board: DesignBoard;
  boards: DesignBoard[];
  system?: DesignSystemPack | null;
  onNavigate(id: string): void;
  onClose(): void;
}) {
  const index = boards.findIndex((b) => b.id === board.id);
  const go = (delta: number) => {
    const next = boards[index + delta];
    if (next) onNavigate(next.id);
  };
  // A deck plays slide by slide, then moves on to the next board.
  const slides = useMemo(() => (isDesignDeck(board.html) ? designSlides(board.html) : []), [board.html]);
  const [slide, setSlide] = useState(0);
  const [presenter, setPresenter] = useState(false);
  const [started, setStarted] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => setSlide(0), [board.id]);
  useEffect(() => {
    if (!presenter) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [presenter]);
  const step = (delta: number) => {
    if (!slides.length) return go(delta);
    const next = slide + delta;
    if (next >= 0 && next < slides.length) setSlide(next);
    else go(delta);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTextInput(e.target)) return;
      if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); step(-1); }
      if (e.key === "ArrowRight" || e.key === "PageDown" || (slides.length && e.key === " ")) { e.preventDefault(); step(1); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const stage = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1),
    [fit, setFit] = useState(true);
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const resize = () => {
      if (fit)
        setZoom(
          Math.max(
            0.01,
            Math.min(
              1,
              // The presenter column takes its own room beside the slide.
              (el.clientWidth - 48 - (presenter ? PRESENTER_WIDTH : 0)) / board.width,
              (el.clientHeight - 48) / board.height,
            ),
          ),
        );
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    return () => observer.disconnect();
  }, [fit, board.width, board.height, presenter]);
  return (
    <div
      className="design-board-preview-overlay"
      data-canvas-ui
      role="region"
      aria-label="Board preview"
    >
      <header>
        <button onClick={onClose}>← Back to canvas</button>
        <strong>{board.name}</strong>
        <span className="design-preview-meta">
          {board.width} × {board.height}
        </span>
        {boards.length > 1 && (
          <span className="design-preview-nav">
            <button aria-label="Previous board" disabled={index <= 0} onClick={() => go(-1)}>
              ‹
            </button>
            <span>
              {index + 1} / {boards.length}
            </span>
            <button
              aria-label="Next board"
              disabled={index >= boards.length - 1}
              onClick={() => go(1)}
            >
              ›
            </button>
          </span>
        )}
        {slides.length ? (
          <span className="design-preview-nav">
            <button aria-label="Previous slide" disabled={slide <= 0} onClick={() => setSlide(slide - 1)}>‹</button>
            <span aria-label="Slide">Slide {slide + 1} / {slides.length}</span>
            <button aria-label="Next slide" disabled={slide >= slides.length - 1} onClick={() => setSlide(slide + 1)}>›</button>
          </span>
        ) : null}
        {slides.length ? (
          <button aria-pressed={presenter} onClick={() => { setPresenter(!presenter); setStarted(Date.now()); }}>
            Presenter view
          </button>
        ) : null}
        <button aria-pressed={fit} onClick={() => setFit(true)}>
          Fit page
        </button>
        <button
          aria-pressed={!fit}
          onClick={() => {
            setFit(false);
            setZoom(1);
          }}
        >
          100%
        </button>
        <button aria-label="Close preview" onClick={onClose}>
          ×
        </button>
      </header>
      <div ref={stage} className={presenter && slides.length ? "design-preview-stage is-presenting" : "design-preview-stage"}>
        <div
          style={{
            width: board.width * zoom,
            height: board.height * zoom,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: board.width,
              height: board.height,
              transform: "scale(" + zoom + ")",
              transformOrigin: "top left",
            }}
          >
            <BoardFrame
              board={board}
              preview
              system={system}
              slide={slides.length ? slide : undefined}
              onRuntime={(event) => {
                if (event.type !== "goto") return;
                // A board link names its target by name (or id).
                const want = event.board.trim().toLowerCase();
                const target = boards.find((b) => b.id === event.board) ?? boards.find((b) => b.name.trim().toLowerCase() === want);
                if (target) onNavigate(target.id);
              }}
            />
          </div>
        </div>
        {presenter && slides.length ? (
          <aside className="design-presenter" aria-label="Presenter view">
            <div className="design-presenter-time" aria-label="Elapsed">
              {(() => {
                const sec = Math.floor((Date.now() - started) / 1000);
                return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
              })()}
            </div>
            <div className="design-presenter-next">
              <span>{slide + 1 < slides.length ? `Next · ${slides[slide + 1].title}` : "End of deck"}</span>
              {slide + 1 < slides.length ? (
                <BoardThumb board={board} width={260} height={Math.round((260 * board.height) / board.width)} system={system} slide={slide + 1} />
              ) : null}
            </div>
            <div className="design-presenter-notes">
              <span>Notes</span>
              <p>{slides[slide]?.notes || "No notes for this slide."}</p>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
