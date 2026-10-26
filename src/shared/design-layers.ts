import {
  defaultTreeAdapter,
  html as parse5Html,
  parse,
  parseFragment,
  serialize,
  serializeOuter,
  type DefaultTreeAdapterMap,
} from "parse5";

type Element = DefaultTreeAdapterMap["element"];
const omitted = new Set([
  "br",
  "head",
  "style",
  "script",
  "title",
  "meta",
  "link",
]);
export const layerIdAttribute = "data-aegis-node-id";
export interface DesignLayer {
  id: string;
  tag: string;
  name: string;
  /** The name was given (data-aegis-layer-name), not derived from the tag and text. */
  named: boolean;
  text: string;
  textEditable: boolean;
  hidden: boolean;
  locked: boolean;
  styles: Record<string, string>;
  children: DesignLayer[];
}
export const editableLayerStyles = [
  "width",
  "height",
  "position",
  "left",
  "top",
  "padding",
  "margin",
  "display",
  "gap",
  "flex-direction",
  "justify-content",
  "align-items",
  "align-self",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "color",
  "background-color",
  "opacity",
  "border-radius",
  "border",
  "box-shadow",
] as const;
export type LayerEdit =
  | { type: "name"; value: string }
  | { type: "text"; value: string }
  | { type: "hidden" | "locked"; value: boolean }
  | { type: "remove" | "duplicate" | "up" | "down" };
const attr = (e: Element, key: string) =>
  e.attrs.find((a) => a.name === key)?.value;
const set = (e: Element, key: string, value: string) => {
  const a = e.attrs.find((a) => a.name === key);
  if (a) a.value = value;
  else e.attrs.push({ name: key, value });
};
function documentModel(html: string) {
  const doc = parse(html);
  const elements: Element[] = [];
  function walk(parent: DefaultTreeAdapterMap["parentNode"]) {
    for (const node of parent.childNodes) {
      if (!("tagName" in node) || omitted.has(node.tagName)) continue;
      if (node.tagName !== "html" && node.tagName !== "body")
        elements.push(node);
      walk(node);
    }
  }
  walk(doc);
  const reserved = new Set(
    elements.map((e) => attr(e, layerIdAttribute)).filter(Boolean),
  );
  const seen = new Set<string>();
  let next = 1;
  for (const e of elements) {
    let id = attr(e, layerIdAttribute);
    if (!id || id.length > 200 || seen.has(id)) {
      do {
        id = `aegis-layer-${next++}`;
      } while (reserved.has(id));
      set(e, layerIdAttribute, id);
      reserved.add(id);
    }
    seen.add(id);
  }
  return { doc, elements };
}
export function normalizeDesignLayers(html: string): string {
  return serialize(documentModel(html).doc);
}
function textOf(e: Element): string {
  return e.childNodes
    .map((n) =>
      n.nodeName === "#text" && "value" in n
        ? n.value
        : "tagName" in n
          ? n.tagName === "br"
            ? "\n"
            : textOf(n)
          : "",
    )
    .join("");
}
// Inline styles are displayed using Chromium's CSS parser in the inspector.
export function readDesignLayers(html: string): DesignLayer[] {
  const { elements } = documentModel(html);
  const models = new Map<Element, DesignLayer>();
  const roots: DesignLayer[] = [];
  for (const e of elements) {
    const text = textOf(e).trim();
    const node: DesignLayer = {
      id: attr(e, layerIdAttribute)!,
      tag: e.tagName,
      name:
        attr(e, "data-aegis-layer-name") ||
        attr(e, "aria-label") ||
        (e.tagName === "aegis-use" && attr(e, "component")) ||
        e.tagName + (text ? " · " + text.slice(0, 42) : ""),
      named: !!attr(e, "data-aegis-layer-name"),
      text,
      textEditable:
        !e.childNodes.some((n) => "tagName" in n && n.tagName !== "br") &&
        !["img", "input", "hr", "br", "svg", "path"].includes(e.tagName),
      hidden: attr(e, "data-aegis-hidden") === "true",
      locked: attr(e, "data-aegis-locked") === "true",
      styles: { cssText: attr(e, "style") || "" },
      children: [],
    };
    models.set(e, node);
    const parent = models.get(e.parentNode as Element);
    (parent?.children ?? roots).push(node);
  }
  return roots;
}
function assertUnlocked(node: Element, allowOwnLock = false) {
  for (
    let e: Element | undefined = node;
    e && "attrs" in e;
    e = e.parentNode as Element
  ) {
    if (
      attr(e, "data-aegis-locked") === "true" &&
      !(e === node && allowOwnLock)
    )
      throw new Error("Unlock this layer or its parent before editing.");
  }
}
function cloneLayer(node: Element): Element {
  const clone: Element = {
    ...node,
    attrs: node.attrs
      .filter((a) => a.name !== layerIdAttribute && a.name !== "id")
      .map((a) => ({ ...a })),
    childNodes: [],
  };
  clone.childNodes = node.childNodes.map((child) => {
    const next = "tagName" in child ? cloneLayer(child) : { ...child };
    next.parentNode = clone;
    return next;
  });
  return clone;
}
export function editDesignLayer(
  html: string,
  nodeId: string,
  edit: LayerEdit,
): string {
  const { doc, elements } = documentModel(html);
  const node = elements.find((e) => attr(e, layerIdAttribute) === nodeId);
  if (!node) throw new Error("Layer no longer exists. Select a current layer.");
  assertUnlocked(node, edit.type === "locked");
  if (edit.type === "name")
    set(node, "data-aegis-layer-name", edit.value.trim().slice(0, 160));
  if (edit.type === "hidden" || edit.type === "locked")
    set(node, `data-aegis-${edit.type}`, String(edit.value));
  if (edit.type === "text") {
    if (node.childNodes.some((n) => "tagName" in n && n.tagName !== "br"))
      throw new Error(
        "Select a text layer; replacing a group would remove its children.",
      );
    node.childNodes = [];
    edit.value.split("\n").forEach((value, index) => {
      if (index)
        node.childNodes.push({
          nodeName: "br",
          tagName: "br",
          namespaceURI: node.namespaceURI,
          attrs: [],
          childNodes: [],
          parentNode: node,
        });
      node.childNodes.push({ nodeName: "#text", value, parentNode: node });
    });
  }
  const siblings = node.parentNode!.childNodes;
  const index = siblings.indexOf(node);
  if (edit.type === "remove") siblings.splice(index, 1);
  if (edit.type === "up" || edit.type === "down") {
    const offset = edit.type === "up" ? -1 : 1;
    let target = index + offset;
    while (
      target >= 0 &&
      target < siblings.length &&
      !("tagName" in siblings[target])
    )
      target += offset;
    if (target >= 0 && target < siblings.length)
      [siblings[index], siblings[target]] = [siblings[target], siblings[index]];
  }
  if (edit.type === "duplicate") {
    const clone = cloneLayer(node);
    clone.parentNode = node.parentNode;
    siblings.splice(index + 1, 0, clone);
  }
  return normalizeDesignLayers(serialize(doc));
}
export function replaceDesignLayerStyle(
  html: string,
  nodeId: string,
  cssText: string,
): string {
  const { doc, elements } = documentModel(html);
  const node = elements.find((e) => attr(e, layerIdAttribute) === nodeId);
  if (!node) throw new Error("Layer no longer exists.");
  assertUnlocked(node);
  set(node, "style", cssText);
  return serialize(doc);
}

export function findDesignLayer(
  nodes: DesignLayer[],
  id?: string,
): DesignLayer | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const nested = findDesignLayer(n.children, id);
    if (nested) return nested;
  }
}
/** Ancestors of a layer, outermost first (excluding the layer itself). */
export function designLayerPath(
  nodes: DesignLayer[],
  id: string,
  path: DesignLayer[] = [],
): DesignLayer[] | undefined {
  for (const n of nodes) {
    if (n.id === id) return path;
    const found = designLayerPath(n.children, id, [...path, n]);
    if (found) return found;
  }
}
export function readBoardBackground(html: string) {
  const body = bodyOf(parse(html));
  const style = (body && attr(body, "style")) || "";
  return /(?:^|;)\s*background(?:-color)?\s*:\s*([^;!]+)/i
    .exec(style)?.[1]
    ?.trim();
}
/** Sets the board's page background on <body>, keeping other inline styles. */
export function setBoardBackground(html: string, color: string) {
  const doc = parse(html);
  const body = bodyOf(doc);
  if (!body) throw new Error("Board has no body.");
  const rest = (attr(body, "style") || "")
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d && !/^background(-color)?\s*:/i.test(d));
  if (color.trim()) rest.push(`background: ${color.trim()}`);
  set(body, "style", rest.join("; "));
  return serialize(doc);
}
function bodyOf(doc: DefaultTreeAdapterMap["document"]) {
  const html = doc.childNodes.find(
    (n): n is Element => "tagName" in n && n.tagName === "html",
  );
  return html?.childNodes.find(
    (n): n is Element => "tagName" in n && n.tagName === "body",
  );
}

/**
 * Moves a layer to `index` among the element children of `parentId` (counted
 * without the moved layer). Used for drag-to-reorder and moving into another
 * auto layout container; locks on the layer and the target are respected.
 */
export function moveDesignLayer(
  html: string,
  nodeId: string,
  parentId: string,
  index: number,
): string {
  const { doc, elements } = documentModel(html);
  const node = elements.find((e) => attr(e, layerIdAttribute) === nodeId);
  const parent = elements.find((e) => attr(e, layerIdAttribute) === parentId);
  if (!node || !parent) throw new Error("Layer no longer exists.");
  assertUnlocked(node);
  assertUnlocked(parent);
  for (let p: Element | undefined = parent; p && "attrs" in p; p = p.parentNode as Element)
    if (p === node) throw new Error("A layer cannot move into itself.");
  const from = node.parentNode!.childNodes;
  from.splice(from.indexOf(node), 1);
  const siblings = parent.childNodes.filter(
    (n): n is Element => "tagName" in n && !omitted.has(n.tagName),
  );
  const target = siblings[Math.max(0, Math.min(index, siblings.length))];
  node.parentNode = parent;
  if (target) parent.childNodes.splice(parent.childNodes.indexOf(target), 0, node);
  else {
    // After the last layer, before trailing text such as whitespace.
    const last = siblings.at(-1);
    parent.childNodes.splice(last ? parent.childNodes.indexOf(last) + 1 : parent.childNodes.length, 0, node);
  }
  return serialize(doc);
}

/**
 * Inserts a new empty layer at `index` among the element children of
 * `parentId` (the page body without one), for the Text and Frame tools.
 * Text goes in through the text edit so line breaks match in-place editing.
 */
export function insertDesignLayer(
  html: string,
  parentId: string | undefined,
  index: number,
  layer: { tag: string; text?: string; style?: string; name?: string; attrs?: Record<string, string> },
): { html: string; nodeId: string } {
  if (!/^[a-z][a-z0-9]*$/.test(layer.tag) || omitted.has(layer.tag))
    throw new Error("This kind of layer cannot be inserted.");
  const { doc, elements } = documentModel(html);
  const parent = parentId
    ? elements.find((e) => attr(e, layerIdAttribute) === parentId)
    : bodyOf(doc);
  if (!parent) throw new Error("Layer no longer exists.");
  if (parentId) assertUnlocked(parent);
  const ids = new Set(elements.map((e) => attr(e, layerIdAttribute)));
  let n = elements.length + 1;
  while (ids.has(`aegis-layer-${n}`)) n++;
  const nodeId = `aegis-layer-${n}`;
  const node = defaultTreeAdapter.createElement(layer.tag, parse5Html.NS.HTML, [
    { name: layerIdAttribute, value: nodeId },
    ...(layer.name ? [{ name: "data-aegis-layer-name", value: layer.name }] : []),
    ...(layer.style ? [{ name: "style", value: layer.style }] : []),
    // A few plain attributes (an image's src and alt); the sanitizer still decides what stays.
    ...Object.entries(layer.attrs ?? {})
      .filter(([name]) => ["src", "alt", "title"].includes(name))
      .map(([name, value]) => ({ name, value })),
  ]);
  const siblings = parent.childNodes.filter(
    (c): c is Element => "tagName" in c && !omitted.has(c.tagName),
  );
  const target = siblings[Math.max(0, Math.min(index, siblings.length))];
  node.parentNode = parent;
  if (target) parent.childNodes.splice(parent.childNodes.indexOf(target), 0, node);
  else {
    const last = siblings.at(-1);
    parent.childNodes.splice(last ? parent.childNodes.indexOf(last) + 1 : parent.childNodes.length, 0, node);
  }
  const out = serialize(doc);
  const next = layer.text ? editDesignLayer(out, nodeId, { type: "text", value: layer.text }) : out;
  // HTML parsing rewrites invalid nesting (a div in a p, a row outside its table);
  // refuse instead of saving a tree that moved the layer or added stray ones.
  const check = documentModel(next);
  const placed = check.elements.find((e) => attr(e, layerIdAttribute) === nodeId);
  const parentNode = placed?.parentNode as Element | undefined;
  const inPlace = parentId
    ? !!parentNode && "tagName" in parentNode && attr(parentNode, layerIdAttribute) === parentId
    : !!parentNode && "tagName" in parentNode && parentNode.tagName === "body";
  if (!inPlace || check.elements.length !== elements.length + 1)
    throw new Error("A layer can't be added here. Try the space beside it.");
  return { html: next, nodeId };
}

// ── Auto layout ────────────────────────────────────────────────────────────

export type AutoLayoutKind = "row" | "column" | "grid";
type Box = { x: number; y: number; width: number; height: number };

/**
 * How laid-out children read: a row when their centers spread wider than
 * tall, else a column; for a grid, rows group children that overlap
 * vertically and the longest row gives the column count.
 */
export function inferAutoLayout(rects: Box[]): { direction: "row" | "column"; columns: number } {
  if (rects.length < 2) return { direction: "column", columns: 1 };
  const cx = rects.map((r) => r.x + r.width / 2);
  const cy = rects.map((r) => r.y + r.height / 2);
  const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
  const direction = spread(cx) > spread(cy) ? "row" : "column";
  const rows: Box[][] = [];
  for (const r of [...rects].sort((a, b) => a.y - b.y)) {
    const row = rows.find((group) => group.some((o) => Math.min(o.y + o.height, r.y + r.height) - Math.max(o.y, r.y) > 0));
    if (row) row.push(r);
    else rows.push([r]);
  }
  return { direction, columns: Math.max(...rows.map((row) => row.length)) };
}

/** Inline declarations in order, with their !important flags. */
function declarations(css: string): [string, string][] {
  return css
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const at = d.indexOf(":");
      return at > 0 ? ([d.slice(0, at).trim().toLowerCase(), d.slice(at + 1).trim()] as [string, string]) : null;
    })
    .filter((d): d is [string, string] => !!d);
}
const cssText = (decls: [string, string][]) => decls.map(([k, v]) => `${k}: ${v}`).join("; ");
const POSITION_PROPS = ["position", "left", "top", "right", "bottom", "inset", "z-index"];
const LAYOUT_PROPS = ["display", "flex-direction", "flex-wrap", "grid-template-columns", "grid-template-rows"];

function layoutDeclarations(kind: AutoLayoutKind, columns: number, keepGap: string | undefined): [string, string][] {
  const important = (v: string) => `${v} !important`;
  return [
    ["display", important(kind === "grid" ? "grid" : "flex")],
    ...(kind === "grid"
      ? ([["grid-template-columns", important(`repeat(${Math.max(1, Math.min(12, columns))}, minmax(0, 1fr))`)]] as [string, string][])
      : ([["flex-direction", important(kind)]] as [string, string][])),
    ["gap", keepGap ?? important("12px")],
  ];
}

/**
 * Makes a layer lay out its children: flex in a row or column, or a grid of
 * `columns`. Keeps an existing gap (else 12px) and drops the children's own
 * inline positioning, so they follow the layout. A re-layout: what classes
 * position stays, sizes are kept, and the result is one undoable change.
 */
export function setAutoLayout(html: string, nodeId: string, layout: { kind: AutoLayoutKind; columns?: number }): string {
  const { doc, elements } = documentModel(html);
  const node = elements.find((e) => attr(e, layerIdAttribute) === nodeId);
  if (!node) throw new Error("Layer no longer exists.");
  assertUnlocked(node);
  const own = declarations(attr(node, "style") || "");
  const gap = own.find(([k]) => k === "gap")?.[1];
  const rest = own.filter(([k]) => !LAYOUT_PROPS.includes(k) && k !== "gap");
  set(node, "style", cssText([...rest, ...layoutDeclarations(layout.kind, layout.columns ?? 2, gap)]));
  for (const child of node.childNodes) {
    if (!("tagName" in child) || omitted.has(child.tagName)) continue;
    const decls = declarations(attr(child, "style") || "");
    const kept = decls.filter(([k]) => !POSITION_PROPS.includes(k));
    if (kept.length !== decls.length) set(child, "style", cssText(kept));
  }
  return serialize(doc);
}

/**
 * Wraps a layer in a new auto layout container (named "Auto layout") at its
 * place. The layer's own inline positioning moves to the container.
 */
export function wrapInAutoLayout(
  html: string,
  nodeId: string,
  layout: { kind: AutoLayoutKind; columns?: number },
): { html: string; nodeId: string } {
  const { doc, elements } = documentModel(html);
  const node = elements.find((e) => attr(e, layerIdAttribute) === nodeId);
  if (!node) throw new Error("Layer no longer exists.");
  assertUnlocked(node);
  const parent = node.parentNode as Element;
  if (!parent || !("tagName" in parent)) throw new Error("This layer can't be wrapped.");
  const ids = new Set(elements.map((e) => attr(e, layerIdAttribute)));
  let n = elements.length + 1;
  while (ids.has(`aegis-layer-${n}`)) n++;
  const wrapperId = `aegis-layer-${n}`;
  const decls = declarations(attr(node, "style") || "");
  const positioned = decls.filter(([k]) => POSITION_PROPS.includes(k));
  const wrapper = defaultTreeAdapter.createElement("div", parse5Html.NS.HTML, [
    { name: layerIdAttribute, value: wrapperId },
    { name: "data-aegis-layer-name", value: "Auto layout" },
    { name: "style", value: cssText([...positioned, ...layoutDeclarations(layout.kind, layout.columns ?? 2, undefined)]) },
  ]);
  if (positioned.length) set(node, "style", cssText(decls.filter(([k]) => !POSITION_PROPS.includes(k))));
  const siblings = parent.childNodes;
  siblings.splice(siblings.indexOf(node), 1, wrapper);
  wrapper.parentNode = parent;
  wrapper.childNodes.push(node);
  node.parentNode = wrapper;
  const out = serialize(doc);
  // Parsing must keep the wrapper where it was put (no div inside a p): the
  // layer stays in the wrapper, and the wrapper in the layer's old parent.
  const parentId = attr(parent, layerIdAttribute);
  const reparsed = documentModel(out).elements;
  const placedIn = reparsed.find((e) => attr(e, layerIdAttribute) === nodeId)?.parentNode as Element | undefined;
  const wrapperIn = reparsed.find((e) => attr(e, layerIdAttribute) === wrapperId)?.parentNode as Element | undefined;
  const sameParent = parentId
    ? !!wrapperIn && "tagName" in wrapperIn && attr(wrapperIn, layerIdAttribute) === parentId
    : !!wrapperIn && "tagName" in wrapperIn && wrapperIn.tagName === parent.tagName;
  if (!placedIn || !("tagName" in placedIn) || attr(placedIn, layerIdAttribute) !== wrapperId || !sameParent)
    throw new Error("This layer can't be wrapped here.");
  return { html: out, nodeId: wrapperId };
}

// ── One layer's markup (quick edits) ───────────────────────────────────────

/** A layer's own HTML (the element and everything inside it). */
export function readLayerHtml(html: string, nodeId: string): string {
  const { elements } = documentModel(html);
  const node = elements.find((e) => attr(e, layerIdAttribute) === nodeId);
  if (!node) throw new Error("Layer no longer exists.");
  return serializeOuter(node);
}

/**
 * Replaces a layer with new markup for it: exactly one root element, which
 * keeps the layer's id (so selection, comments and history still point at
 * it). Refuses several roots, locked layers, and markup that HTML would move
 * elsewhere (a div inside a p).
 */
export function replaceLayerHtml(html: string, nodeId: string, fragment: string): string {
  const { doc, elements } = documentModel(html);
  const node = elements.find((e) => attr(e, layerIdAttribute) === nodeId);
  if (!node) throw new Error("Layer no longer exists.");
  assertUnlocked(node);
  const parent = node.parentNode as Element;
  const parsed = parseFragment(parent, fragment, {});
  const roots = parsed.childNodes.filter((n): n is Element => "tagName" in n);
  const strayText = parsed.childNodes.some((n) => n.nodeName === "#text" && "value" in n && n.value.trim());
  if (roots.length !== 1 || strayText) throw new Error("The edit must be exactly one element.");
  const root = roots[0];
  set(root, layerIdAttribute, nodeId);
  const siblings = parent.childNodes;
  siblings.splice(siblings.indexOf(node), 1, root);
  root.parentNode = parent;
  const out = normalizeDesignLayers(serialize(doc));
  // HTML parsing must keep it where it was (no div inside a p): same tag, same parent.
  const parentId = attr(parent, layerIdAttribute);
  const placed = documentModel(out).elements.find((e) => attr(e, layerIdAttribute) === nodeId);
  const placedIn = placed?.parentNode as Element | undefined;
  const sameParent = parentId
    ? !!placedIn && "tagName" in placedIn && attr(placedIn, layerIdAttribute) === parentId
    : !!placedIn && "tagName" in placedIn && placedIn.tagName === parent.tagName;
  if (!placed || placed.tagName !== root.tagName || !sameParent) throw new Error("That markup can't go here.");
  return out;
}
