import {
  defaultTreeAdapter,
  html as parse5Html,
  parse,
  serialize,
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
        e.tagName + (text ? " · " + text.slice(0, 42) : ""),
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
  layer: { tag: string; text?: string; style?: string; name?: string },
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
