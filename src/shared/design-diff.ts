export interface DesignNodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** One rendered layer, captured inside a board frame. */
export interface DesignNodeSnapshot {
  id: string;
  parent?: string;
  name?: string;
  rect: DesignNodeRect;
  text: string;
  styles: Record<string, string>;
}
export interface DesignPropertyChange {
  property: string;
  before: string;
  after: string;
}
export interface DesignNodeChange {
  id: string;
  name?: string;
  props: DesignPropertyChange[];
  rectBefore: DesignNodeRect;
  rectAfter: DesignNodeRect;
}
export interface DesignSnapshotDiff {
  changed: DesignNodeChange[];
  added: string[];
  removed: string[];
  /** Union of changed and added layers in the "after" board, if any. */
  region?: DesignNodeRect;
  /** No layer identities matched: the whole board is treated as changed. */
  wholeBoard: boolean;
}

const round = (n: number) => Math.round(n);
const sameRect = (a: DesignNodeRect, b: DesignNodeRect) =>
  round(a.width) === round(b.width) && round(a.height) === round(b.height);
const union = (rects: DesignNodeRect[]) => {
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
};

/**
 * Compares two board renders by layer id. Style and text changes are reported
 * per property; a pure position shift is not, since reflow moves everything
 * below an edited layer. Size changes are reported as Width/Height.
 */
export function diffDesignSnapshots(
  before: DesignNodeSnapshot[],
  after: DesignNodeSnapshot[],
): DesignSnapshotDiff {
  const old = new Map(before.map((n) => [n.id, n]));
  const next = new Map(after.map((n) => [n.id, n]));
  const matched = after.filter((n) => old.has(n.id)).length;
  if (before.length && after.length && !matched)
    return {
      changed: [],
      added: [],
      removed: [],
      region: union(after.filter((n) => !n.parent).map((n) => n.rect)),
      wholeBoard: true,
    };
  const changed: DesignNodeChange[] = [];
  for (const n of after) {
    const o = old.get(n.id);
    if (!o) continue;
    const props: DesignPropertyChange[] = [];
    const keys = new Set([...Object.keys(o.styles), ...Object.keys(n.styles)]);
    for (const k of keys) {
      // Computed width/height follow content; compare rendered size instead.
      if (k === "width" || k === "height") continue;
      const a = o.styles[k] ?? "",
        b = n.styles[k] ?? "";
      if (a !== b) props.push({ property: k, before: a, after: b });
    }
    if (!sameRect(o.rect, n.rect)) {
      if (round(o.rect.width) !== round(n.rect.width))
        props.push({ property: "width", before: `${round(o.rect.width)}`, after: `${round(n.rect.width)}` });
      if (round(o.rect.height) !== round(n.rect.height))
        props.push({ property: "height", before: `${round(o.rect.height)}`, after: `${round(n.rect.height)}` });
    }
    if (o.text !== n.text) props.push({ property: "text", before: o.text, after: n.text });
    if (props.length)
      changed.push({ id: n.id, name: n.name ?? o.name, props, rectBefore: o.rect, rectAfter: n.rect });
  }
  // A parent whose only change is its size because a child changed is noise.
  const ownChanges = changed.filter(
    (c) =>
      !c.props.every((p) => p.property === "width" || p.property === "height") ||
      !changed.some((d) => d !== c && next.get(d.id)?.parent && isAncestor(next, c.id, d.id)),
  );
  const added = after.filter((n) => !old.has(n.id)).map((n) => n.id);
  const removed = before.filter((n) => !next.has(n.id)).map((n) => n.id);
  const topAdded = added.filter((id) => !added.includes(next.get(id)?.parent ?? ""));
  return {
    changed: ownChanges,
    added,
    removed,
    region: union([
      ...ownChanges.map((c) => c.rectAfter),
      ...topAdded.map((id) => next.get(id)!.rect),
    ]),
    wholeBoard: false,
  };
}

function isAncestor(
  nodes: Map<string, DesignNodeSnapshot>,
  ancestor: string,
  id: string,
) {
  for (let p = nodes.get(id)?.parent; p; p = nodes.get(p)?.parent)
    if (p === ancestor) return true;
  return false;
}
