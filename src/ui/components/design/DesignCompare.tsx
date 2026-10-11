import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { BoardFrame, type BoardInspector } from "./BoardFrame";
import { authorName, errorText, relativeTime } from "./design-ui";
import { clampZoom, zoomAt, type CanvasView, type Rect } from "./canvas-geometry";
import { diffDesignSnapshots, type DesignSnapshotDiff } from "../../../shared/design-diff";
import type {
  DesignBoard,
  DesignComment,
  DesignDocument,
  DesignRevisionInfo,
} from "../../../shared/design-types";

type Mode = "side" | "swipe" | "overlay";
const labels: Record<string, string> = {
  "font-size": "Font size",
  "font-weight": "Weight",
  "font-family": "Font",
  "line-height": "Line height",
  "letter-spacing": "Letter spacing",
  color: "Color",
  "background-color": "Fill",
  "border-radius": "Radius",
  width: "Width",
  height: "Height",
  text: "Text",
};
const label = (p: string) => labels[p] ?? p.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Before/after view of one board between two versions. */
export function DesignCompare({
  sessionId,
  documentId,
  boardId,
  from,
  to,
  info,
  comment,
  user,
  editable,
  onClose,
  onResolve,
  onReply,
  onRestore,
}: {
  sessionId: string;
  documentId: string;
  boardId: string;
  from: number;
  to: number;
  info?: DesignRevisionInfo;
  comment?: DesignComment;
  user: string;
  editable: boolean;
  onClose(): void;
  onResolve(commentId: string): void;
  onReply(commentId: string): void;
  onRestore(revision: number, boardId: string): void;
}) {
  const [docs, setDocs] = useState<[DesignDocument, DesignDocument]>();
  const [failure, setFailure] = useState("");
  const [mode, setMode] = useState<Mode>("side");
  const [split, setSplit] = useState(50);
  const [view, setView] = useState<CanvasView>({ x: 24, y: 24, zoom: 0.4 });
  const [diff, setDiff] = useState<DesignSnapshotDiff>();
  const stage = useRef<HTMLDivElement>(null);
  const before = useRef<BoardInspector | null>(null);
  const after = useRef<BoardInspector | null>(null);
  const loaded = useRef(new Set<string>());
  useEffect(() => {
    let live = true;
    Promise.all([
      window.electron.design.read({ sessionId, documentId, revision: from }),
      window.electron.design.read({ sessionId, documentId, revision: to }),
    ]).then(
      (pair) => live && setDocs(pair as [DesignDocument, DesignDocument]),
      (e) => live && setFailure(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [sessionId, documentId, from, to]);
  const a = docs?.[0].boards.find((b) => b.id === boardId);
  const b = docs?.[1].boards.find((x) => x.id === boardId);
  const sizing = b ?? a;
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el || !sizing) return;
    const panes = mode === "side" ? 2 : 1;
    const w = (el.clientWidth - 48 * panes) / panes;
    const h = el.clientHeight - 48;
    const zoom = clampZoom(Math.min(1, w / sizing.width, h / Math.max(a?.height ?? 0, b?.height ?? 0, 1)));
    setView({ x: 24, y: 24, zoom });
  }, [sizing?.id, mode, !!docs]);
  const measure = async (which: string) => {
    loaded.current.add(which);
    if (!loaded.current.has("before") || !loaded.current.has("after")) return;
    const [x, y] = await Promise.all([before.current?.snapshot(), after.current?.snapshot()]);
    setDiff(diffDesignSnapshots(x ?? [], y ?? []));
  };
  useEffect(() => {
    if (docs && (!a || !b)) setDiff(undefined);
  }, [docs, a, b]);
  const wheel = (e: React.WheelEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey)
      setView((v) => zoomAt(v, { x: e.clientX - r.left, y: e.clientY - r.top }, v.zoom * Math.exp(-e.deltaY * 0.008)));
    else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
  };
  const frame = (board: DesignBoard | undefined, which: "before" | "after", region?: Rect, style?: CSSProperties) =>
    board ? (
      <div className="design-compare-board" style={{ width: board.width, height: board.height, ...style }}>
        <BoardFrame
          ref={(api) => {
            if (which === "before") before.current = api;
            else after.current = api;
          }}
          board={board}
          onLoad={() => void measure(which)}
        />
        {region && (
          <div
            className="design-diff-region"
            style={{ left: region.x, top: region.y, width: region.width, height: region.height }}
          />
        )}
      </div>
    ) : (
      <div className="design-compare-missing">{which === "before" ? "Not in this version" : "Deleted"}</div>
    );
  const transform = {
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
    transformOrigin: "0 0",
    "--compare-zoom": view.zoom,
  } as CSSProperties;
  const beforeRegion =
    diff && !diff.wholeBoard && diff.changed.length
      ? diff.changed.reduce<Rect | undefined>((acc, c) => {
          const r = c.rectBefore;
          if (!acc) return { ...r };
          const x = Math.min(acc.x, r.x), y = Math.min(acc.y, r.y);
          return { x, y, width: Math.max(acc.x + acc.width, r.x + r.width) - x, height: Math.max(acc.y + acc.height, r.y + r.height) - y };
        }, undefined)
      : undefined;
  const who = info?.author ? authorName(info.author, user) : "Agent";
  const fromComment = comment ? `${authorName(comment.author, user)}'s comment` : undefined;
  const reply = comment?.messages.filter((m) => m.author.kind === "agent").at(-1);
  return (
    <section className="design-compare" aria-label="Compare versions">
      <header className="design-compare-bar">
        <strong>
          {who} updated {sizing?.name ?? "board"}
        </strong>
        <span>
          · v{from} → v{to}
          {fromComment ? ` · from ${fromComment}` : ""}
        </span>
        <span className="design-spacer" />
        <div className="design-seg" role="tablist" aria-label="Compare mode">
          {(
            [
              ["side", "Side by side"],
              ["swipe", "Swipe"],
              ["overlay", "Overlay"],
            ] as const
          ).map(([m, text]) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>
              {text}
            </button>
          ))}
        </div>
        <button className="design-secondary" onClick={onClose}>
          Exit compare
        </button>
      </header>
      {failure && (
        <div className="design-error" role="alert">
          {failure}
        </div>
      )}
      <div className="design-compare-body">
        <div ref={stage} className={"design-compare-stage is-" + mode} onWheel={wheel}>
          {docs && mode === "side" && (
            <>
              <div className="design-compare-pane">
                <span className="design-compare-tag">
                  v{from} · Before · {relativeTime(docs[0].updatedAt)}
                </span>
                <div style={transform}>{frame(a, "before", beforeRegion)}</div>
              </div>
              <div className="design-compare-pane">
                <span className="design-compare-tag">
                  v{to} · After · {relativeTime(docs[1].updatedAt)}
                </span>
                <div style={transform}>{frame(b, "after", diff?.region)}</div>
              </div>
            </>
          )}
          {docs && mode !== "side" && (
            <div className="design-compare-pane">
              <div style={transform}>
                <div className="design-compare-stack">
                  {frame(a, "before")}
                  {frame(b, "after", diff?.region, {
                    position: "absolute",
                    inset: 0,
                    ...(mode === "swipe"
                      ? { clipPath: `inset(0 0 0 ${split}%)` }
                      : { opacity: split / 100 }),
                  })}
                </div>
              </div>
              <label className="design-compare-slider">
                <span>{mode === "swipe" ? "v" + from : "Before"}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={split}
                  aria-label={mode === "swipe" ? "Swipe position" : "Overlay opacity"}
                  onChange={(e) => setSplit(Number(e.target.value))}
                />
                <span>{mode === "swipe" ? "v" + to : "After"}</span>
              </label>
            </div>
          )}
        </div>
        <aside className="design-compare-changes" aria-label="Changes">
          <h4>Changes in v{to}</h4>
          {!diff ? (
            <p className="design-empty-note">{a && b ? "Comparing…" : a ? "Board deleted" : "Board added"}</p>
          ) : diff.wholeBoard ? (
            <p className="design-empty-note">Board content replaced</p>
          ) : (
            <>
              <p className="design-field-hint">
                {diff.changed.length} layer{diff.changed.length === 1 ? "" : "s"} changed
                {diff.added.length ? ` · ${diff.added.length} added` : ""}
                {diff.removed.length ? ` · ${diff.removed.length} removed` : ""}
              </p>
              {diff.changed.slice(0, 12).map((c) => (
                <div className="design-change" key={c.id}>
                  <strong>{c.name ?? c.id}</strong>
                  {c.props.slice(0, 8).map((p) => (
                    <div className="design-change-prop" key={p.property}>
                      <span>{label(p.property)}</span>
                      <span className="is-before">{p.before || "—"}</span>
                      <span aria-hidden>→</span>
                      <span className="is-after">{p.after || "—"}</span>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
          {comment && (
            <div className="design-change-source">
              <h4>From comment</h4>
              <p>{comment.text}</p>
              {reply && <p className="design-change-reply">{authorName(reply.author, user)}: “{reply.text}”</p>}
              <div className="design-change-actions">
                <button
                  className="design-primary"
                  disabled={!editable || comment.status === "resolved"}
                  onClick={() => onResolve(comment.id)}
                >
                  Looks good · resolve comment
                </button>
                <button className="design-secondary" onClick={() => onReply(comment.id)}>
                  Reply
                </button>
              </div>
            </div>
          )}
          <button
            className="design-text-button"
            disabled={!editable || !a}
            onClick={() => onRestore(from, boardId)}
          >
            Restore v{from}
          </button>
        </aside>
      </div>
    </section>
  );
}
