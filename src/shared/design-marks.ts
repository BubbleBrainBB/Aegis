/** Canvas-owned annotations. These are document data, separate from board HTML/comments. */
export const DESIGN_MARK_TYPES = ["note", "rectangle", "ellipse", "line", "arrow", "freehand"] as const;
export type DesignMarkType = (typeof DESIGN_MARK_TYPES)[number];
export type DesignMarkPoint = { x: number; y: number };
export interface DesignMark {
  id: string;
  type: DesignMarkType;
  pageId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  /** Plain text only; never interpreted as HTML. */
  text?: string;
  fontSize?: number;
  /** Local coordinates inside the mark bounds; ordered endpoints preserve line direction. */
  points?: DesignMarkPoint[];
}
export const MAX_DESIGN_MARKS = 200;
export const MAX_MARK_POINTS = 2048;
export const MAX_MARK_TEXT = 5000;
export const MARK_LIMIT = 8000;
export const MARK_COORD_LIMIT = 1_000_000;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const idValue = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function isDesignMarkType(value: unknown): value is DesignMarkType {
  return typeof value === "string" && (DESIGN_MARK_TYPES as readonly string[]).includes(value);
}
export function normalizeMarkColor(value: unknown, fallback: string): string {
  return typeof value === "string" && (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) || value === "transparent" || value === "none") ? value : fallback;
}
export function normalizeDesignMark(value: unknown): DesignMark | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!idValue(v.id) || !isDesignMarkType(v.type) || !finite(v.x) || !finite(v.y) || !finite(v.width) || !finite(v.height) || v.width < 0 || v.height < 0) return null;
  const width = clamp(v.width, 1, MARK_LIMIT), height = clamp(v.height, 1, MARK_LIMIT);
  const line = v.type === "line" || v.type === "arrow" || v.type === "freehand";
  let points: DesignMarkPoint[] | undefined;
  if (line) {
    if (!Array.isArray(v.points) || v.points.length < 2 || v.points.length > MAX_MARK_POINTS) return null;
    points = [];
    for (const point of v.points) {
      if (!point || typeof point !== "object" || !finite(point.x) || !finite(point.y)) return null;
      points.push({ x: clamp(point.x, 0, width), y: clamp(point.y, 0, height) });
    }
    if (v.type !== "freehand" && points.length !== 2) return null;
  }
  return {
    id: v.id, type: v.type,
    ...(idValue(v.pageId) ? { pageId: v.pageId } : {}),
    x: clamp(v.x, -MARK_COORD_LIMIT, MARK_COORD_LIMIT), y: clamp(v.y, -MARK_COORD_LIMIT, MARK_COORD_LIMIT), width, height,
    fill: normalizeMarkColor(v.fill, v.type === "note" ? "#fff3b0" : line ? "none" : "#e4e9f2"),
    stroke: normalizeMarkColor(v.stroke, v.type === "note" ? "#4a4220" : "#2a78d6"),
    strokeWidth: finite(v.strokeWidth) ? clamp(v.strokeWidth, 0, 64) : 2,
    ...(v.type === "note" ? { text: typeof v.text === "string" ? v.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, MAX_MARK_TEXT) : "", fontSize: finite(v.fontSize) ? clamp(v.fontSize, 8, 120) : 14 } : {}),
    ...(points ? { points } : {}),
  };
}
export function normalizeDesignMarks(value: unknown): DesignMark[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>(), marks: DesignMark[] = [];
  for (const raw of value) {
    const mark = normalizeDesignMark(raw);
    if (!mark || ids.has(mark.id)) continue;
    ids.add(mark.id); marks.push(mark);
    if (marks.length === MAX_DESIGN_MARKS) break;
  }
  return marks;
}

/** Validate untrusted writes before normalization; never silently drop or truncate objects. */
export function validateDesignMarks(value: unknown): DesignMark[] {
  if (!Array.isArray(value) || value.length > MAX_DESIGN_MARKS) throw new Error("Too many or invalid canvas objects.");
  const ids = new Set<string>();
  return value.map(raw => {
    const mark = normalizeDesignMark(raw);
    if (!mark || ids.has(mark.id)) throw new Error("Invalid canvas object or duplicate object ID.");
    for (const [key, limit] of [["x", MARK_COORD_LIMIT], ["y", MARK_COORD_LIMIT], ["width", MARK_LIMIT], ["height", MARK_LIMIT]] as const)
      if (Math.abs(raw[key]) > limit || ((key === "width" || key === "height") && raw[key] < 1)) throw new Error("Canvas object is outside the supported bounds.");
    if (raw.text !== undefined && (typeof raw.text !== "string" || raw.text.length > MAX_MARK_TEXT)) throw new Error("Invalid canvas note text.");
    if (raw.pageId !== undefined && raw.pageId !== mark.pageId) throw new Error("Invalid canvas page ID.");
    for (const key of ["fill", "stroke"] as const)
      if (raw[key] !== undefined && normalizeMarkColor(raw[key], "invalid") === "invalid") throw new Error("Invalid canvas object color.");
    if (raw.strokeWidth !== undefined && (!finite(raw.strokeWidth) || raw.strokeWidth < 0 || raw.strokeWidth > 64)) throw new Error("Invalid canvas stroke width.");
    if (raw.fontSize !== undefined && (!finite(raw.fontSize) || raw.fontSize < 8 || raw.fontSize > 120)) throw new Error("Invalid canvas font size.");
    if (Array.isArray(raw.points) && raw.points.some((point: DesignMarkPoint, index: number) => point?.x !== mark.points?.[index]?.x || point?.y !== mark.points?.[index]?.y)) throw new Error("Canvas path points must fit its bounds.");
    ids.add(mark.id);
    return mark;
  });
}
