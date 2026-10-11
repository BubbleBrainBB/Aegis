import type { Rect } from "./canvas-geometry";
import type { DropTarget } from "./BoardFrame";

const TEXT_TAGS = new Set(["p", "span", "small", "label", "em", "strong", "b", "i"]);
/** Tag for a new text layer: follow nearby text, else a paragraph (a span in a row). */
export function textTagFor(t: Pick<DropTarget, "containerTag" | "nearTag" | "direction">): string {
  if (t.containerTag === "ul" || t.containerTag === "ol") return "li";
  if (t.nearTag && TEXT_TAGS.has(t.nearTag)) return t.nearTag;
  return t.direction === "row" ? "span" : "p";
}

export const FRAME_SIZE = { width: 200, height: 120 };
/** A new frame: a vertical auto layout container of the drawn size. */
export function frameStyle(width: number, height: number, at?: { x: number; y: number }) {
  return [
    ...(at ? [`position: absolute`, `left: ${Math.round(at.x)}px`, `top: ${Math.round(at.y)}px`] : []),
    "display: flex",
    "flex-direction: column",
    "gap: 12px",
    "padding: 16px",
    `width: ${Math.round(width)}px`,
    `height: ${Math.round(height)}px`,
    "flex-shrink: 0",
  ].join("; ");
}

const DEVICES = [
  { name: "Phone", width: 390, height: 844 },
  { name: "Tablet", width: 768, height: 1024 },
  { name: "Laptop", width: 1280, height: 800 },
  { name: "Desktop", width: 1440, height: 900 },
];
/**
 * A new board drawn from `anchor` to the pointer: widths near a device snap
 * to it (and its height when close). Sizes stay within the board limits.
 */
export function snapBoard(anchor: { x: number; y: number }, rect: Rect, tolerance: number) {
  let { width, height } = rect;
  const device = DEVICES.find((d) => Math.abs(width - d.width) <= tolerance);
  if (device) {
    width = device.width;
    if (Math.abs(height - device.height) <= tolerance) height = device.height;
  }
  width = Math.round(Math.min(4096, Math.max(100, width)));
  height = Math.round(Math.min(4096, Math.max(100, height)));
  return {
    rect: {
      x: rect.x < anchor.x ? anchor.x - width : anchor.x,
      y: rect.y < anchor.y ? anchor.y - height : anchor.y,
      width,
      height,
    },
    label: `${width} × ${height}` + (device ? ` · ${device.name} ✓` : ""),
  };
}
