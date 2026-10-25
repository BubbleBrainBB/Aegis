import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DesignAnchor, DesignBoard } from "../../../shared/design-types";
import type {
  DesignNodeRect,
  DesignNodeSnapshot,
} from "../../../shared/design-diff";
import { sanitizeDesignHtml } from "../../../shared/design-html";
import { designFrameHtml, type DesignComponentSource } from "../../../shared/design-frame";
import { isDesignComponent } from "../../../shared/design-component";
import { resolveDesignAssets, type DesignSystemPack } from "../../../shared/design-system-pack";
import { isBoardHung, markBoardHung, recoverSandboxFrames, useSandboxEpoch } from "../../utils/sandbox-frames";
import type { LayerLayout } from "./design-spacing";
import { toLayerCss, type LayerCss } from "./design-css";

export interface BoardInspector {
  inspect(x: number, y: number, hover?: boolean): void;
  selectNode(nodeId: string): void;
  /** Current rendered rects of layers (null when missing or not rendered). */
  measure(
    ids: string[],
  ): Promise<{ rects: Record<string, DesignNodeRect | null>; height: number }>;
  snapshot(): Promise<DesignNodeSnapshot[]>;
  /** Hide only glyphs while editing; keep the layer’s background, border and layout. */
  mask(nodeId: string | null): void;
  /** Live drag preview: the layer moves inside the frame until dragEnd. */
  dragStart(nodeId: string): Promise<boolean>;
  dragOver(x: number, y: number): Promise<DragState | null>;
  dragEnd(commit: boolean): Promise<void>;
  /** Live size preview; resetPreview restores the saved inline styles. */
  previewSize(
    nodeId: string,
    size: { width?: string; height?: string },
  ): Promise<DesignNodeRect | null>;
  resetPreview(): void;
  /** Box, auto layout, padding and containing block of one layer. */
  layout(nodeId: string): Promise<LayerLayout | null>;
  /** Live style preview (gap, padding, offsets…); resetPreview restores. */
  previewStyle(nodeId: string, styles: Record<string, string>): Promise<LayerLayout | null>;
  /** Authored CSS of a layer (the page body without one) and what it inherits. */
  styles(nodeId?: string): Promise<LayerCss | null>;
  /** Where a new layer would go for a point (Text and Frame tools); null when locked. */
  dropTarget(x: number, y: number): Promise<DropTarget | null>;
  /** Live preview of a new layer at a drop target; resetPreview removes it. */
  previewInsert(
    target: Pick<DropTarget, "containerId" | "index">,
    tag: string,
    text: string,
  ): Promise<{ rect: DesignNodeRect; styles: Record<string, string> } | null>;
  /** Outermost layers fully inside a board-space rect (area comments). */
  nodesIn(rect: DesignNodeRect): Promise<{ id: string; rect: DesignNodeRect }[]>;
}
export interface DropTarget {
  /** The containing layer, or null for the page body. */
  containerId: string | null;
  /** Index among the container's layer children, as insertDesignLayer counts them. */
  index: number;
  /** Visible position, for the "n of m" label. */
  position: number;
  count: number;
  direction: "row" | "column" | "grid" | "stack";
  name: string | null;
  /** Insertion line in board space: zero width (vertical) or zero height. */
  line: DesignNodeRect;
  containerTag: string;
  nearTag: string | null;
}
export interface DragState {
  containerId: string;
  index: number;
  /** Visible position, for the "Position n of m" label. */
  position: number;
  count: number;
  direction: "row" | "column" | "grid" | "stack";
  name: string;
  containerRect: DesignNodeRect;
  rect: DesignNodeRect;
  moved: boolean;
}
/** What a board's runtime tells the canvas: logic errors, board links, a hang. */
export type BoardRuntimeEvent =
  | { type: "errors"; errors: string[] }
  | { type: "goto"; board: string }
  | { type: "hung" };
const PING_MS = 2500;
const PONG_MS = 2000;

const finite = (r: unknown): r is DesignNodeRect =>
  !!r &&
  typeof r === "object" &&
  ["x", "y", "width", "height"].every((k) =>
    Number.isFinite((r as Record<string, unknown>)[k]),
  );

function toLayout(l: any): LayerLayout | null {
  if (!l || !finite(l.rect) || !finite(l.cb)) return null;
  const num = (v: unknown) => (Number.isFinite(v) ? (v as number) : 0);
  return {
    rect: l.rect,
    display: typeof l.display === "string" ? l.display.slice(0, 40) : "block",
    direction: ["row", "column", "grid", "stack"].includes(l.direction) ? l.direction : "stack",
    rowGap: num(l.rowGap),
    columnGap: num(l.columnGap),
    padding: [0, 1, 2, 3].map((i) => num(l.padding?.[i])) as LayerLayout["padding"],
    position: typeof l.position === "string" ? l.position.slice(0, 20) : "static",
    cb: l.cb,
    children: (Array.isArray(l.children) ? l.children : [])
      .filter((c: any) => typeof c?.id === "string" && finite(c.rect))
      .slice(0, 200),
    siblings: (Array.isArray(l.siblings) ? l.siblings : []).filter(finite).slice(0, 100),
  };
}

// The iframe paints only. The canvas owns all pointer/keyboard/wheel input,
// including input above board content. Hit testing crosses a nonce-bound bridge.
export const BoardFrame = memo(
  forwardRef<
    BoardInspector,
    {
      board: DesignBoard;
      preview?: boolean;
      /**
       * static: render the template without its runtime (a board the agent
       * is still writing). Defaults to edit on the canvas, play in preview.
       */
      mode?: "edit" | "play" | "static";
      /** Components the board can use besides its design system's. */
      components?: Record<string, DesignComponentSource>;
      /** The design system the board loads. Keep the object stable: a new one reloads the frame. */
      system?: DesignSystemPack | null;
      /** `requested`: the frame answering selectNode rather than reporting a click. */
      onInspect?: (anchor: DesignAnchor, hover: boolean, requested?: boolean) => void;
      onLoad?: () => void;
      onRuntime?: (event: BoardRuntimeEvent) => void;
    }
  >(function BoardFrame({ board, preview = false, mode: requestedMode, components, system, onInspect, onLoad, onRuntime }, ref) {
    const frame = useRef<HTMLIFrameElement>(null);
    const pending = useRef(new Map<string, (data: any) => void>());
    // A hung board falls back to its template without the runtime until its HTML changes.
    const [hungHtml, setHungHtml] = useState<string | null>(null);
    const mode = (hungHtml !== null && hungHtml === board.html) || isBoardHung(board.html) ? "static" : requestedMode ?? (preview ? "play" : "edit");
    // A recovered sandbox process: every frame starts over in a fresh one.
    const sandboxEpoch = useSandboxEpoch();
    // A board owns one iframe/nonce for its lifetime. Content updates go through
    // the bridge; changing srcDoc for every streamed chunk navigates the frame.
    // Switching runtime on or off (component ↔ static, mode) needs a new frame.
    const scripted = mode !== "static" && isDesignComponent(board.html);
    const lifetime = useMemo(() => {
      const token = crypto.randomUUID();
      return { token, html: board.html, source: designFrameHtml(board.html, token, !preview, { mode, components, system }) };
    }, [board.id, preview, mode, scripted, components, system, sandboxEpoch]);
    const { token } = lifetime;
    // What the frame holds: sanitized, with the system's asset references resolved.
    const html = useMemo(() => resolveDesignAssets(sanitizeDesignHtml(board.html), system?.assets), [board.html, system]);
    const [recovery, setRecovery] = useState<{ token: string; html: string; source: string; epoch: string } | null>(null);
    const source = preview ? designFrameHtml(html, token, false, { mode, components, system })
      : recovery?.token === token ? recovery.source : lifetime.source;
    const onRuntimeRef = useRef(onRuntime);
    onRuntimeRef.current = onRuntime;
    const ready = useRef<string | null>(null);
    const applied = useRef<string | null>(null);
    const [loadEpoch, setLoadEpoch] = useState(0);
    const onLoadRef = useRef(onLoad);
    onLoadRef.current = onLoad;
    const request = <T,>(type: string, body: object, fallback: T) =>
      new Promise<any>((resolve) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          pending.current.delete(id);
          resolve(fallback);
        }, 1500);
        pending.current.set(id, (data) => {
          clearTimeout(timer);
          resolve(data);
        });
        frame.current?.contentWindow?.postMessage(
          { type, nonce: token, request: id, ...body },
          "*",
        );
      });
    useImperativeHandle(
      ref,
      () => ({
        async dragStart(nodeId) {
          const r = await request("aegis-design-drag-start", { nodeId }, { ok: false });
          return r?.ok === true;
        },
        async dragOver(x, y) {
          const r = await request("aegis-design-drag-over", { x, y }, null);
          if (
            !r?.ok ||
            typeof r.containerId !== "string" ||
            !Number.isInteger(r.index) ||
            !finite(r.containerRect) ||
            !finite(r.rect)
          )
            return null;
          return {
            containerId: r.containerId.slice(0, 200),
            index: r.index,
            position: Number.isInteger(r.position) ? r.position : r.index,
            count: Number.isInteger(r.count) ? r.count : r.index + 1,
            direction: ["row", "column", "grid", "stack"].includes(r.direction) ? r.direction : "stack",
            name: typeof r.name === "string" ? r.name.slice(0, 80) : "",
            containerRect: r.containerRect,
            rect: r.rect,
            moved: r.moved === true,
          };
        },
        async dragEnd(commit) {
          await request("aegis-design-drag-end", { commit }, null);
        },
        async previewSize(nodeId, size) {
          const r = await request("aegis-design-preview-size", { nodeId, ...size }, null);
          const rect = r?.rects?.[nodeId];
          return finite(rect) ? rect : null;
        },
        async layout(nodeId) {
          return toLayout((await request("aegis-design-layout", { nodeId }, null))?.layout);
        },
        async previewStyle(nodeId, styles) {
          return toLayout((await request("aegis-design-preview-style", { nodeId, styles }, null))?.layout);
        },
        async styles(nodeId) {
          return toLayerCss((await request("aegis-design-styles", { nodeId }, null))?.css);
        },
        async dropTarget(x, y) {
          const t = (await request("aegis-design-drop-target", { x, y }, null))?.target;
          if (!t || typeof t !== "object" || !finite(t.line) || !Number.isInteger(t.index)) return null;
          const tag = (v: unknown) => (typeof v === "string" && /^[a-z][a-z0-9-]*$/.test(v) ? v : null);
          return {
            containerId: typeof t.containerId === "string" ? t.containerId.slice(0, 200) : null,
            index: Math.max(0, t.index),
            position: Number.isInteger(t.position) ? t.position : t.index + 1,
            count: Number.isInteger(t.count) ? t.count : t.index + 1,
            direction: ["row", "column", "grid", "stack"].includes(t.direction) ? t.direction : "stack",
            name: typeof t.name === "string" ? t.name.slice(0, 80) : null,
            line: t.line,
            containerTag: tag(t.containerTag) ?? "div",
            nearTag: tag(t.nearTag),
          };
        },
        async previewInsert(target, tag, text) {
          const r = await request("aegis-design-preview-insert", { ...target, tag, text }, null);
          if (!finite(r?.rect)) return null;
          const styles = Object.fromEntries(
            Object.entries((r.styles ?? {}) as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === "string" && e[0].length < 40 && e[1].length < 500,
            ),
          );
          return { rect: r.rect, styles };
        },
        async nodesIn(rect) {
          const r = await request("aegis-design-nodes-in", { rect }, { rects: {} });
          return Object.entries((r?.rects ?? {}) as Record<string, unknown>)
            .filter((e): e is [string, DesignNodeRect] => finite(e[1]))
            .slice(0, 50)
            .map(([id, rect]) => ({ id: id.slice(0, 200), rect }));
        },
        resetPreview() {
          frame.current?.contentWindow?.postMessage(
            { type: "aegis-design-preview-reset", nonce: token },
            "*",
          );
        },
        mask(nodeId) {
          frame.current?.contentWindow?.postMessage(
            { type: "aegis-design-mask", nonce: token, nodeId },
            "*",
          );
        },
        async measure(ids) {
          const data = await request(
            "aegis-design-measure",
            { ids },
            { rects: {}, height: 0 },
          );
          const rects: Record<string, DesignNodeRect | null> = {};
          for (const id of ids)
            rects[id] = finite(data?.rects?.[id]) ? data.rects[id] : null;
          return {
            rects,
            height: Number.isFinite(data?.height) ? data.height : 0,
          };
        },
        async snapshot() {
          const data = await request("aegis-design-snapshot", {}, { nodes: [] });
          return (Array.isArray(data?.nodes) ? data.nodes : [])
            .filter(
              (n: any) =>
                typeof n?.id === "string" &&
                finite(n.rect) &&
                n.styles &&
                typeof n.styles === "object",
            )
            .map(
              (n: any): DesignNodeSnapshot => ({
                id: n.id.slice(0, 200),
                ...(typeof n.parent === "string" ? { parent: n.parent } : {}),
                ...(typeof n.name === "string" ? { name: n.name.slice(0, 160) } : {}),
                rect: n.rect,
                text: typeof n.text === "string" ? n.text.slice(0, 200) : "",
                styles: Object.fromEntries(
                  Object.entries(n.styles).filter(
                    ([k, v]) => k.length < 50 && typeof v === "string" && v.length < 1000,
                  ),
                ) as Record<string, string>,
              }),
            );
        },
        selectNode(nodeId: string) {
          frame.current?.contentWindow?.postMessage(
            { type: "aegis-design-select-node", nonce: token, nodeId },
            "*",
          );
        },
        inspect(x, y, hover = false) {
          frame.current?.contentWindow?.postMessage(
            { type: "aegis-design-hit-test", nonce: token, x, y, hover },
            "*",
          );
        },
      }),
      [token],
    );
    useEffect(() => {
      const receive = (e: MessageEvent) => {
        if (
          e.source !== frame.current?.contentWindow ||
          e.data?.nonce !== token
        )
          return;
        if (e.data.type === "aegis-design-runtime") {
          const d = e.data;
          if (d.event === "pong" && typeof d.request === "string") {
            pending.current.get(d.request)?.(d);
            pending.current.delete(d.request);
          } else if (d.event === "errors" && Array.isArray(d.errors))
            onRuntimeRef.current?.({ type: "errors", errors: d.errors.filter((x: unknown) => typeof x === "string").slice(0, 20).map((x: string) => x.slice(0, 500)) });
          else if (d.event === "goto" && typeof d.board === "string") onRuntimeRef.current?.({ type: "goto", board: d.board.slice(0, 200) });
          else if (d.event === "updated" || d.event === "ready") onRuntimeRef.current?.({ type: "errors", errors: [] });
          return;
        }
        if (
          (e.data.type === "aegis-design-patched" ||
            e.data.type === "aegis-design-rects" ||
            e.data.type === "aegis-design-snapshot" ||
            e.data.type === "aegis-design-drag-state" ||
            e.data.type === "aegis-design-layout" ||
            e.data.type === "aegis-design-styles" ||
            e.data.type === "aegis-design-insert") &&
          typeof e.data.request === "string"
        ) {
          pending.current.get(e.data.request)?.(e.data);
          pending.current.delete(e.data.request);
          return;
        }
        if (e.data.type !== "aegis-design-select") return;
        const a = e.data.anchor,
          r = a?.rect;
        if (
          !a ||
          typeof a.text !== "string" ||
          !r ||
          ![r.x, r.y, r.width, r.height].every(Number.isFinite)
        )
          return;
        onInspect?.(
          {
            text: a.text.slice(0, 180),
            computedStyles:
              a.computedStyles && typeof a.computedStyles === "object"
                ? (Object.fromEntries(
                    Object.entries(a.computedStyles).filter(
                      ([k, v]) =>
                        k.length < 50 &&
                        typeof v === "string" &&
                        v.length < 1000,
                    ),
                  ) as Record<string, string>)
                : {},
            ...(typeof a.nodeId === "string"
              ? { nodeId: a.nodeId.slice(0, 200) }
              : {}),
            ...(typeof a.instance === "string" && /^\d{1,4}$/.test(a.instance) ? { instance: a.instance } : {}),
            rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          },
          e.data.hover === true,
          // A reply to selectNode, as opposed to a click.
          e.data.requested === true,
        );
      };
      window.addEventListener("message", receive);
      return () => window.removeEventListener("message", receive);
    }, [token, onInspect]);
    useEffect(() => {
      if (!scripted || ready.current !== token) return;
      // Watchdog: a board whose logic stops answering falls back to static.
      let missed = 0;
      let live = true;
      const timer = setInterval(() => {
        const id = crypto.randomUUID();
        const answered = setTimeout(() => {
          pending.current.delete(id);
          if (!live) return;
          missed += 1;
          if (missed >= 2) {
            clearInterval(timer);
            markBoardHung(board.html);
            setHungHtml(board.html);
            onRuntimeRef.current?.({ type: "hung" });
            // The stuck process holds every sandboxed frame; end it so they all come back.
            void recoverSandboxFrames(token);
          }
        }, PONG_MS);
        pending.current.set(id, () => {
          clearTimeout(answered);
          missed = 0;
        });
        frame.current?.contentWindow?.postMessage({ type: "aegis-design-ping", nonce: token, request: id }, "*");
      }, PING_MS);
      return () => {
        live = false;
        clearInterval(timer);
      };
    }, [scripted, token, loadEpoch, board.html]);
    useEffect(() => {
      if (preview || ready.current !== token || applied.current === html) return;
      let current = true;
      applied.current = null; // A → B → A must supersede an in-flight B patch too.
      void request("aegis-design-patch", { html }, { ok: false }).then((result) => {
        if (!current) return;
        if (result?.ok) {
          applied.current = html;
          // Re-measure selection/pins after layout changes, without navigation.
          onLoadRef.current?.();
        } else {
          // A broken bridge gets one full, sandboxed recovery for these bytes.
          ready.current = null;
          setRecovery({ token, html, source: designFrameHtml(html, token, true, { mode, components, system }), epoch: crypto.randomUUID() });
        }
      });
      return () => { current = false; };
    }, [html, token, preview, loadEpoch]);
    return (
      <iframe
        key={recovery?.token === token ? recovery.epoch : token}
        ref={frame}
        name={token}
        title={board.name}
        srcDoc={source}
        sandbox="allow-scripts"
        tabIndex={-1}
        referrerPolicy="no-referrer"
        onLoad={() => {
          ready.current = token;
          applied.current = resolveDesignAssets(sanitizeDesignHtml(recovery?.token === token ? recovery.html : lifetime.html), system?.assets);
          setLoadEpoch(n => n + 1);
          onLoadRef.current?.();
        }}
        style={{ width: board.width, height: board.height }}
      />
    );
  }),
);
