import type { Rect } from "./canvas-geometry";

/** Layout facts about one layer, measured inside its board frame. */
export interface LayerLayout {
  rect: Rect;
  display: string;
  direction: "row" | "column" | "grid" | "stack";
  rowGap: number;
  columnGap: number;
  /** top, right, bottom, left */
  padding: [number, number, number, number];
  position: string;
  /** Padding box of the containing block an absolute layer is placed in. */
  cb: Rect;
  children: { id: string; rect: Rect }[];
  siblings: Rect[];
}

export const isAutoLayout = (l: LayerLayout) => /flex|grid/.test(l.display);
export const isAbsolute = (l: LayerLayout) => l.position === "absolute" || l.position === "fixed";

export type GapRegion = { rect: Rect; prop: "column-gap" | "row-gap"; axis: "x" | "y" };
/** The space between consecutive in-flow children, per axis. */
export function gapRegions(l: LayerLayout): GapRegion[] {
  const out: GapRegion[] = [];
  for (let i = 1; i < l.children.length; i++) {
    const a = l.children[i - 1].rect,
      b = l.children[i].rect;
    const vOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    const hOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    if (b.x >= a.x + a.width - 0.5 && vOverlap > 0) {
      const y = Math.max(a.y, b.y);
      out.push({
        rect: { x: a.x + a.width, y, width: Math.max(0, b.x - a.x - a.width), height: vOverlap },
        prop: "column-gap",
        axis: "x",
      });
    } else if (b.y >= a.y + a.height - 0.5 && hOverlap > 0) {
      const x = Math.max(a.x, b.x);
      out.push({
        rect: { x, y: a.y + a.height, width: hOverlap, height: Math.max(0, b.y - a.y - a.height) },
        prop: "row-gap",
        axis: "y",
      });
    }
  }
  return out;
}

export type PaddingSide = "top" | "right" | "bottom" | "left";
/** Padding bands inside the layer's border box. */
export function paddingRegions(l: LayerLayout): { side: PaddingSide; rect: Rect }[] {
  const { x, y, width, height } = l.rect;
  const [t, r, b, lft] = l.padding;
  return [
    { side: "top" as const, rect: { x, y, width, height: t } },
    { side: "right" as const, rect: { x: x + width - r, y, width: r, height } },
    { side: "bottom" as const, rect: { x, y: y + height - b, width, height: b } },
    { side: "left" as const, rect: { x, y, width: lft, height } },
  ];
}

/**
 * Pins an absolute layer to the nearer edges of its containing block, so a
 * badge in the top-right stays there when the parent widens.
 */
export function absoluteConstraints(rect: Rect, cb: Rect): Record<"left" | "right" | "top" | "bottom", string> {
  const left = Math.round(rect.x - cb.x);
  const top = Math.round(rect.y - cb.y);
  const right = Math.round(cb.x + cb.width - rect.x - rect.width);
  const bottom = Math.round(cb.y + cb.height - rect.y - rect.height);
  const pinRight = rect.x + rect.width / 2 > cb.x + cb.width / 2;
  const pinBottom = rect.y + rect.height / 2 > cb.y + cb.height / 2;
  return {
    left: pinRight ? "auto" : `${left}px`,
    right: pinRight ? `${right}px` : "auto",
    top: pinBottom ? "auto" : `${top}px`,
    bottom: pinBottom ? `${bottom}px` : "auto",
  };
}
