import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";

/**
 * A board is a design component: one HTML document in three parts.
 *
 *   template  the document markup (layers keep data-aegis-node-id)
 *   logic     <script type="text/x-aegis-logic"> class Board extends AegisBoard {…}
 *   props     <script type="application/x-aegis-props"> {"title":{"type":"string","default":"…"}, "$preview":{…}}
 *
 * Logic and props are inert data blocks in the head: the browser never runs
 * them; the board runtime reads them (only in frames that load it). A board
 * with neither, and no template directives, is plain static HTML.
 */
export const DESIGN_LOGIC_TYPE = "text/x-aegis-logic";
export const DESIGN_PROPS_TYPE = "application/x-aegis-props";
/** Components a board can use, injected by the host at render time (never stored on a board). */
export const DESIGN_COMPONENTS_TYPE = "application/x-aegis-components";

const MAX_LOGIC = 200_000;
const MAX_PROPS = 100_000;

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

const DIRECTIVE =
  /\sdata-aegis-(?:if|else|for|on-[a-z]+|bind-[a-z-]+|goto|deck)\b|<aegis-use\b|\{\{[\s\S]*?\}\}/i;

/** Whether a board needs the runtime: logic, props, directives or components. */
export function isDesignComponent(html: string): boolean {
  return (
    html.includes(DESIGN_LOGIC_TYPE) ||
    html.includes(DESIGN_PROPS_TYPE) ||
    DIRECTIVE.test(bodyOf(html))
  );
}

function bodyOf(html: string): string {
  const at = html.search(/<body[\s>]/i);
  return at < 0 ? html : html.slice(at);
}

const isElement = (n: Node): n is Element => "tagName" in n;
const typeOf = (e: Element) => e.attrs.find((a) => a.name === "type")?.value.trim().toLowerCase();
const textOf = (e: Element) =>
  e.childNodes.map((n) => ("value" in n && n.nodeName === "#text" ? n.value : "")).join("");

function find(parent: ParentNode, test: (e: Element) => boolean): Element | undefined {
  for (const node of parent.childNodes) {
    if (!isElement(node)) continue;
    if (test(node)) return node;
    const hit = find(node, test);
    if (hit) return hit;
  }
  return undefined;
}

function headOf(doc: DefaultTreeAdapterMap["document"]): Element {
  const html = find(doc, (e) => e.tagName === "html")!;
  return find(html, (e) => e.tagName === "head")!;
}

function block(doc: DefaultTreeAdapterMap["document"], type: string) {
  return find(doc, (e) => e.tagName === "script" && typeOf(e) === type);
}

/** The board's logic source, or null. */
export function designLogicOf(html: string): string | null {
  const e = block(parse(html), DESIGN_LOGIC_TYPE);
  return e ? textOf(e) : null;
}

/** The board's props definition, or null when absent or not valid JSON. */
export function designPropsOf(html: string): DesignPropsSpec | null {
  const e = block(parse(html), DESIGN_PROPS_TYPE);
  if (!e) return null;
  try {
    return parseDesignProps(JSON.parse(textOf(e)));
  } catch {
    return null;
  }
}

function setBlock(html: string, type: string, text: string | null): string {
  const doc = parse(html);
  const existing = block(doc, type);
  if (text === null || !text.trim()) {
    if (existing) {
      const parent = existing.parentNode as ParentNode;
      parent.childNodes = parent.childNodes.filter((n) => n !== existing);
    }
    return serialize(doc);
  }
  // `</script` would end the block early in the serialized document.
  const safe = text.replace(/<\/(script)/gi, "<\\/$1");
  const textNode = { nodeName: "#text", value: safe, parentNode: null } as unknown as Node;
  if (existing) {
    (textNode as { parentNode: unknown }).parentNode = existing;
    existing.childNodes = [textNode as DefaultTreeAdapterMap["childNode"]];
    return serialize(doc);
  }
  const head = headOf(doc);
  const script = {
    nodeName: "script",
    tagName: "script",
    attrs: [{ name: "type", value: type }],
    namespaceURI: "http://www.w3.org/1999/xhtml",
    childNodes: [] as DefaultTreeAdapterMap["childNode"][],
    parentNode: head,
  } as unknown as Element;
  (textNode as { parentNode: unknown }).parentNode = script;
  script.childNodes.push(textNode as DefaultTreeAdapterMap["childNode"]);
  head.childNodes.push(script);
  return serialize(doc);
}

/** Replace (or, with an empty string, remove) the board's logic. */
export function setDesignLogic(html: string, js: string): string {
  if (js.length > MAX_LOGIC) throw new Error(`Logic must be at most ${MAX_LOGIC} characters.`);
  return setBlock(html, DESIGN_LOGIC_TYPE, js);
}

/** One exact, unique replacement inside the logic (like patch for the template). */
export function patchDesignLogic(html: string, findText: string, replace: string): string {
  const js = designLogicOf(html);
  if (js === null) throw new Error("LOGIC_NOT_FOUND: this board has no logic yet; set it with a logic operation.");
  const at = js.indexOf(findText);
  if (at < 0) throw new Error("PATCH_NOT_FOUND: read the board and use its exact current logic.");
  if (js.indexOf(findText, at + 1) >= 0) throw new Error("PATCH_AMBIGUOUS: include more surrounding code for a unique match.");
  return setDesignLogic(html, js.slice(0, at) + replace + js.slice(at + findText.length));
}

/** Replace (or, with null, remove) the board's props definition. */
export function setDesignProps(html: string, props: unknown): string {
  if (props === null) return setBlock(html, DESIGN_PROPS_TYPE, null);
  const spec = parseDesignProps(props);
  const text = JSON.stringify(spec, null, 2);
  if (text.length > MAX_PROPS) throw new Error(`Props must be at most ${MAX_PROPS} characters.`);
  return setBlock(html, DESIGN_PROPS_TYPE, text);
}

// ── Props ────────────────────────────────────────────────────────────────

export const DESIGN_PROP_TYPES = ["string", "number", "boolean", "color", "enum", "image", "list", "object"] as const;
export type DesignPropType = (typeof DESIGN_PROP_TYPES)[number];
export interface DesignPropDef {
  type: DesignPropType;
  default?: unknown;
  label?: string;
  description?: string;
  /** enum only. */
  options?: (string | number)[];
}
/** Prop name → definition, plus optional `$preview` values the canvas renders with. */
export type DesignPropsSpec = Record<string, DesignPropDef | Record<string, unknown>> & {
  $preview?: Record<string, unknown>;
};

const PROP_NAME = /^[a-zA-Z_$][\w$]{0,63}$/;

/** Validates a props definition; throws a message the agent can act on. */
export function parseDesignProps(value: unknown): DesignPropsSpec {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error('Props must be an object: {"title":{"type":"string","default":"Hello"}}.');
  const out: DesignPropsSpec = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (name === "$preview") {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("$preview must be an object of prop values.");
      out.$preview = raw as Record<string, unknown>;
      continue;
    }
    if (!PROP_NAME.test(name)) throw new Error(`"${name}" is not a valid prop name (letters, digits, _ or $).`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Prop "${name}" must be an object with a type.`);
    const def = raw as Record<string, unknown>;
    if (!DESIGN_PROP_TYPES.includes(def.type as DesignPropType))
      throw new Error(`Prop "${name}" needs a type: ${DESIGN_PROP_TYPES.join(", ")}.`);
    if (def.type === "enum" && (!Array.isArray(def.options) || !def.options.length))
      throw new Error(`Enum prop "${name}" needs options.`);
    out[name] = {
      type: def.type as DesignPropType,
      ...("default" in def ? { default: def.default } : {}),
      ...(typeof def.label === "string" ? { label: def.label.slice(0, 80) } : {}),
      ...(typeof def.description === "string" ? { description: def.description.slice(0, 500) } : {}),
      ...(Array.isArray(def.options) ? { options: def.options.filter((o) => typeof o === "string" || typeof o === "number").slice(0, 50) } : {}),
    };
  }
  return out;
}

/** The values a board renders with: defaults, overridden by $preview. */
export function designPropValues(spec: DesignPropsSpec | null | undefined): Record<string, unknown> {
  if (!spec) return {};
  const values: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(spec)) {
    if (name === "$preview") continue;
    if (def && typeof def === "object" && "default" in def) values[name] = (def as DesignPropDef).default;
  }
  return { ...values, ...(spec.$preview ?? {}) };
}
