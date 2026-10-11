export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export type CanvasView = Point & { zoom: number };
export const clampZoom = (zoom: number) => Math.min(4, Math.max(0.02, zoom));
export const toWorld = (point: Point, view: CanvasView): Point => ({
  x: (point.x - view.x) / view.zoom,
  y: (point.y - view.y) / view.zoom,
});
export function zoomAt(
  view: CanvasView,
  point: Point,
  nextZoom: number,
): CanvasView {
  const zoom = clampZoom(nextZoom),
    world = toWorld(point, view);
  return { zoom, x: point.x - world.x * zoom, y: point.y - world.y * zoom };
}
export function bounds(rects: Rect[]): Rect | undefined {
  if (!rects.length) return;
  const x = Math.min(...rects.map((r) => r.x)),
    y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}
export function fitView(
  rects: Rect[],
  viewport: { width: number; height: number },
): CanvasView | undefined {
  const r = bounds(rects);
  if (!r || viewport.width <= 0 || viewport.height <= 0) return;
  const zoom = clampZoom(
    Math.min(
      Math.max(1, viewport.width - 100) / Math.max(1, r.width),
      Math.max(1, viewport.height - 140) / Math.max(1, r.height),
      1,
    ),
  );
  return {
    zoom,
    x: (viewport.width - r.width * zoom) / 2 - r.x * zoom,
    y: (viewport.height - r.height * zoom) / 2 - r.y * zoom + 16,
  };
}
export function intersects(a: Rect, b: Rect) {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  );
}
export function resizeRect(
  r: Rect,
  edge: string,
  dx: number,
  dy: number,
  ratio: boolean,
): Rect {
  let width =
    r.width + (edge.includes("e") ? dx : edge.includes("w") ? -dx : 0);
  let height =
    r.height + (edge.includes("s") ? dy : edge.includes("n") ? -dy : 0);
  if (ratio && edge.length === 2) {
    const scale =
      Math.abs(width / r.width - 1) > Math.abs(height / r.height - 1)
        ? width / r.width
        : height / r.height;
    const bounded = Math.min(
      4096 / Math.max(r.width, r.height),
      Math.max(100 / Math.min(r.width, r.height), scale),
    );
    width = r.width * bounded;
    height = r.height * bounded;
  }
  width = Math.round(Math.min(4096, Math.max(100, width)));
  height = Math.round(Math.min(4096, Math.max(100, height)));
  return {
    width,
    height,
    x: Math.round(edge.includes("w") ? r.x + r.width - width : r.x),
    y: Math.round(edge.includes("n") ? r.y + r.height - height : r.y),
  };
}
export function snapMove(
  moving: Rect,
  others: Rect[],
  zoom: number,
): { dx: number; dy: number; guides: { axis: "x" | "y"; value: number }[] } {
  const threshold = 6 / zoom;
  const guides: { axis: "x" | "y"; value: number }[] = [];
  const offset = (axis: "x" | "y") => {
    const size = axis === "x" ? "width" : "height";
    let best = threshold,
      delta = 0,
      line: number | undefined;
    for (const other of others)
      for (const target of [
        other[axis],
        other[axis] + other[size] / 2,
        other[axis] + other[size],
      ]) {
        for (const source of [
          moving[axis],
          moving[axis] + moving[size] / 2,
          moving[axis] + moving[size],
        ]) {
          if (Math.abs(target - source) < best) {
            best = Math.abs(target - source);
            delta = target - source;
            line = target;
          }
        }
      }
    if (line !== undefined) guides.push({ axis, value: line });
    return delta;
  };
  return { dx: offset("x"), dy: offset("y"), guides };
}
