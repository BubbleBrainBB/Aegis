import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BoardThumb } from "./BoardThumb";
import { designPageId, designPages } from "../../../shared/design-pages";
import type { DesignDocument } from "../../../shared/design-types";

const MAX_BOARDS = 4;
const PAD = 14;

/**
 * A design's cover, like a file thumbnail in a design tool: the first boards
 * of its first page, laid out as they sit on the canvas, scaled to fit.
 */
export function DesignCover({ sessionId, documentId, revision }: { sessionId: string; documentId: string; revision: number }) {
  const [doc, setDoc] = useState<DesignDocument | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    let alive = true;
    void window.electron.design
      ?.read({ sessionId, documentId })
      .then((d) => alive && setDoc(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionId, documentId, revision]);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const page = doc ? designPages(doc)[0].id : undefined;
  const boards = doc
    ? doc.boards
        .filter((b) => designPageId(doc, b) === page)
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .slice(0, MAX_BOARDS)
    : [];
  let content = null;
  if (boards.length && size.width > 0) {
    const left = Math.min(...boards.map((b) => b.x));
    const top = Math.min(...boards.map((b) => b.y));
    const right = Math.max(...boards.map((b) => b.x + b.width));
    const bottom = Math.max(...boards.map((b) => b.y + b.height));
    const scale = Math.min((size.width - PAD * 2) / (right - left), (size.height - PAD * 2) / (bottom - top));
    const offsetX = (size.width - (right - left) * scale) / 2;
    const offsetY = (size.height - (bottom - top) * scale) / 2;
    content = boards.map((b) => (
      <BoardThumb
        key={b.id}
        board={b}
        width={Math.max(1, b.width * scale)}
        height={Math.max(1, b.height * scale)}
        className="design-cover-board"
        style={{ position: "absolute", left: offsetX + (b.x - left) * scale, top: offsetY + (b.y - top) * scale }}
      />
    ));
  }
  return (
    <div ref={host} className="design-cover" data-design-cover={documentId} aria-hidden="true">
      {content}
      {doc && !boards.length ? <span className="design-cover-empty">No boards yet</span> : null}
    </div>
  );
}
