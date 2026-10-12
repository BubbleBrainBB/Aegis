import { normalizeDesignMark, MAX_MARK_POINTS, MARK_LIMIT, MARK_COORD_LIMIT, type DesignMark, type DesignMarkPoint, type DesignMarkType } from "../../../shared/design-marks";
export * from "../../../shared/design-marks";
export type MarkChangeReason = "move" | "resize" | "text" | "style";
const freshId = () => `mark-${globalThis.crypto.randomUUID()}`;
const round = (n: number) => Math.round(n * 100) / 100;
export const MARK_PALETTE = [
  { value: "none", label: "None" },
  { value: "#e4e9f2", label: "Light gray" },
  { value: "#2a78d6", label: "Blue" },
  { value: "#141413", label: "Charcoal" },
  { value: "#ffffff", label: "White" },
  { value: "#d97757", label: "Orange" },
  { value: "#4a8c5c", label: "Green" },
  { value: "#9b6fc3", label: "Purple" },
] as const;
export const MARK_STROKE_WIDTHS = [1, 2, 3, 4, 6, 8, 12, 16] as const;
/** Fixed UI choices only; persisted external colors still round-trip unchanged. */
export function styleDesignMark(mark: DesignMark, property: "fill" | "stroke" | "strokeWidth", value: string | number): DesignMark {
  if (mark.type === "note") return mark;
  if (property === "fill" && mark.type !== "rectangle" && mark.type !== "ellipse") return mark;
  if (property === "strokeWidth") {
    if (typeof value !== "number" || !(MARK_STROKE_WIDTHS as readonly number[]).includes(value)) return mark;
  } else if (typeof value !== "string" || !MARK_PALETTE.some(color => color.value === value)) return mark;
  return normalizeDesignMark({ ...mark, [property]: value }) ?? mark;
}

/** Move one ordered endpoint; the other stays fixed even when the line reverses direction. */
export function moveDesignMarkEndpoint(mark: DesignMark, endpoint: 0 | 1, dx: number, dy: number, constrain = false): DesignMark {
  if ((mark.type !== "line" && mark.type !== "arrow") || mark.points?.length !== 2 || !Number.isFinite(dx) || !Number.isFinite(dy)) return mark;
  const world = mark.points.map(point => ({ x: mark.x + point.x, y: mark.y + point.y }));
  const anchor = world[endpoint === 0 ? 1 : 0];
  let x = world[endpoint].x + dx - anchor.x, y = world[endpoint].y + dy - anchor.y;
  if (constrain) {
    const angle = Math.round(Math.atan2(y, x) / (Math.PI / 4)) * Math.PI / 4, length = Math.hypot(x, y);
    x = Math.cos(angle) * length; y = Math.sin(angle) * length;
  }
  // Scale the vector uniformly at the bounds, preserving direction and the fixed endpoint.
  const factor = Math.min(1, MARK_LIMIT / Math.max(Math.abs(x), Math.abs(y)));
  world[endpoint] = { x: round(anchor.x + x * factor), y: round(anchor.y + y * factor) };
  const left = Math.min(world[0].x, world[1].x), top = Math.min(world[0].y, world[1].y);
  if (Math.abs(left) > MARK_COORD_LIMIT || Math.abs(top) > MARK_COORD_LIMIT) return mark;
  const width = Math.max(1, Math.abs(world[1].x - world[0].x)), height = Math.max(1, Math.abs(world[1].y - world[0].y));
  return normalizeDesignMark({ ...mark, x: left, y: top, width, height, points: world.map(point => ({ x: point.x - left, y: point.y - top })) }) ?? mark;
}
export function createDesignMark(type: DesignMarkType, start: DesignMarkPoint, end?: DesignMarkPoint, id = freshId(), pageId?: string): DesignMark {
  const size = type === "note" ? [240, 180] : type === "ellipse" ? [96, 96] : type === "line" || type === "arrow" ? [160, 0] : [120, 120];
  const finish = end ?? { x: start.x + size[0], y: start.y + size[1] };
  const x = Math.min(start.x, finish.x), y = Math.min(start.y, finish.y);
  const mark = normalizeDesignMark({ id, type, pageId, x, y, width: Math.max(1, Math.abs(finish.x - start.x)), height: Math.max(1, Math.abs(finish.y - start.y)), ...(type === "line" || type === "arrow" || type === "freehand" ? { points: [{ x: start.x - x, y: start.y - y }, { x: finish.x - x, y: finish.y - y }] } : {}) });
  if (!mark) throw new Error("Invalid canvas mark coordinates");
  return mark;
}
/** Build a pen mark from world-space samples. Decimation retains both endpoints. */
export function markFromPoints(samples: DesignMarkPoint[], id = freshId(), pageId?: string): DesignMark | null {
  const valid = samples.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (valid.length < 2) return null;
  const step = Math.max(1, Math.ceil((valid.length - 1) / (MAX_MARK_POINTS - 1)));
  const points = valid.filter((_, i) => i % step === 0);
  if (points[points.length - 1] !== valid[valid.length - 1]) points.push(valid[valid.length - 1]);
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  const width = Math.max(1, Math.max(...points.map(p => p.x)) - x), height = Math.max(1, Math.max(...points.map(p => p.y)) - y);
  return normalizeDesignMark({ id, type: "freehand", pageId, x, y, width, height, points: points.map(p => ({ x: round(p.x - x), y: round(p.y - y) })) });
}
export function translateDesignMark(mark: DesignMark, dx: number, dy: number): DesignMark {
  return normalizeDesignMark({ ...mark, x: round(mark.x + dx), y: round(mark.y + dy) }) ?? mark;
}
export function resizeDesignMark(mark: DesignMark, edge: string, dx: number, dy: number, preserveRatio = false): DesignMark {
  const min = mark.type === "note" ? 80 : 2;
  let width = Math.max(min, Math.min(8000, mark.width + (edge.includes("w") ? -dx : edge.includes("e") ? dx : 0)));
  let height = Math.max(mark.type === "note" ? 40 : 1, Math.min(8000, mark.height + (edge.includes("n") ? -dy : edge.includes("s") ? dy : 0)));
  if (preserveRatio && edge.length === 2) {
    const ratio = Math.abs(width / mark.width - 1) > Math.abs(height / mark.height - 1) ? width / mark.width : height / mark.height;
    const scale = Math.min(8000 / Math.max(mark.width, mark.height), Math.max(min / mark.width, (mark.type === "note" ? 40 : 1) / mark.height, ratio));
    width = mark.width * scale; height = mark.height * scale;
  }
  const points = mark.points?.map(p => ({ x: round(p.x * width / mark.width), y: round(p.y * height / mark.height) }));
  return normalizeDesignMark({ ...mark, x: edge.includes("w") ? mark.x + mark.width - width : mark.x, y: edge.includes("n") ? mark.y + mark.height - height : mark.y, width: round(width), height: round(height), points }) ?? mark;
}
export function markPath(mark: DesignMark): string {
  const points = mark.points;
  if (!points?.length) return "";
  if (mark.type !== "freehand" || points.length < 3) return points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
  let path = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    path += ` Q${a.x},${a.y} ${round((a.x + b.x) / 2)},${round((a.y + b.y) / 2)}`;
  }
  const end = points[points.length - 1];
  return `${path} L${end.x},${end.y}`;
}
export function markArrowHead(mark: DesignMark): string | undefined {
  if (mark.type !== "arrow" || !mark.points || mark.points.length < 2) return;
  const [a, b] = mark.points, angle = Math.atan2(b.y - a.y, b.x - a.x), length = Math.min(Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.max(10, mark.strokeWidth * 4));
  const point = (offset: number) => `${round(b.x - Math.cos(angle + offset) * length)},${round(b.y - Math.sin(angle + offset) * length)}`;
  return `${point(Math.PI / 6)} ${b.x},${b.y} ${point(-Math.PI / 6)}`;
}
