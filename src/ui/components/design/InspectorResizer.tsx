import { useEffect, useState } from "react";

const KEY = "aegis.design.inspectorWidth";
export const INSPECTOR_WIDTH = 288;
const MIN = 240;
const MAX = 640;
/** Leave the canvas usable when the panel itself is narrow. */
const clamp = (w: number, room: number) =>
  Math.round(Math.max(MIN, Math.min(MAX, room - 320, w)));

/** Inspector width, remembered per viewer; a convenience, so storage may fail. */
export function useInspectorWidth() {
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(KEY));
      return Number.isFinite(v) && v >= MIN && v <= MAX ? v : INSPECTOR_WIDTH;
    } catch {
      return INSPECTOR_WIDTH;
    }
  });
  const save = (w: number) => {
    setWidth(w);
    try {
      if (w === INSPECTOR_WIDTH) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(w));
    } catch {}
  };
  return [width, setWidth, save] as const;
}

/** Drag handle on the inspector's left edge; double-click restores the default. */
export function InspectorResizer({
  width,
  onPreview,
  onCommit,
}: {
  width: number;
  onPreview(width: number): void;
  onCommit(width: number): void;
}) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const cursor = document.body.style.cursor;
    const select = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = select;
    };
  }, [dragging]);
  const room = (el: Element) => el.closest(".design-panel")?.getBoundingClientRect().width ?? 1200;
  return (
    <div
      className={"design-inspector-resizer" + (dragging ? " is-dragging" : "")}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize inspector"
      aria-valuenow={width}
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const target = e.currentTarget;
        const id = e.pointerId;
        const startX = e.clientX;
        const total = room(target);
        let last = width;
        target.setPointerCapture(id);
        setDragging(true);
        const move = (m: PointerEvent) => {
          if (m.pointerId !== id) return;
          last = clamp(width + startX - m.clientX, total);
          onPreview(last);
        };
        const end = (m: PointerEvent) => {
          if (m.pointerId !== id) return;
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", end);
          window.removeEventListener("pointercancel", end);
          if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
          setDragging(false);
          onCommit(last);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
      }}
      onDoubleClick={() => onCommit(INSPECTOR_WIDTH)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onCommit(clamp(width + (e.key === "ArrowLeft" ? step : -step), room(e.currentTarget)));
        }
      }}
    />
  );
}
