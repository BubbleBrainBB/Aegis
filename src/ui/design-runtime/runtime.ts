/**
 * The design component runtime: runs inside a board's sandboxed frame (opaque
 * origin, no network, no host access) and renders the board's template with
 * its logic and props through React. Bundled with React by
 * scripts/build-design-runtime.mjs into src/shared/design-runtime-bundle.ts.
 *
 * Template layers keep their data-aegis-node-id, so the canvas inspector finds
 * the same layers it finds in a static board. In "edit" mode nothing reacts to
 * input (the canvas owns it); in "play" mode events and board links work.
 */
import {
  Component as ReactComponent,
  createElement as h,
  Fragment,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

const LOGIC_TYPE = "text/x-aegis-logic";
const PROPS_TYPE = "application/x-aegis-props";
const COMPONENTS_TYPE = "application/x-aegis-components";

const script = document.currentScript as HTMLScriptElement | null;
const mode: "edit" | "play" = script?.dataset.mode === "play" ? "play" : "edit";
const nonce = script?.nonce || script?.getAttribute("nonce") || "";

// ── Messages to the canvas ─────────────────────────────────────────────────

function post(event: string, body: Record<string, unknown> = {}) {
  try {
    parent.postMessage({ type: "aegis-design-runtime", nonce, event, ...body }, "*");
  } catch {
    /* capture windows have no parent */
  }
}
const errors: string[] = [];
let errorTimer: ReturnType<typeof setTimeout> | null = null;
function report(error: unknown, where?: string) {
  const message = `${where ? where + ": " : ""}${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
  if (errors.includes(message)) return;
  errors.push(message);
  if (errors.length > 20) errors.shift();
  console.error("[board]", message);
  if (!errorTimer)
    errorTimer = setTimeout(() => {
      errorTimer = null;
      post("errors", { errors: [...errors] });
    }, 50);
}

// ── Expressions ────────────────────────────────────────────────────────────

type Scope = Record<string, unknown>;
type Expr = (scope: Scope) => unknown;
const exprCache = new Map<string, Expr>();
/** Compile a template expression; failures evaluate to undefined and are reported. */
function expr(source: string, where: string): Expr {
  const key = source;
  let fn = exprCache.get(key);
  if (!fn) {
    try {
      // Sloppy-mode `with` so bare names resolve from the scope, then globals.
      const compiled = new Function("$scope", `with($scope){return (${source});}`) as Expr;
      fn = (scope) => {
        try {
          return compiled(scope);
        } catch (error) {
          report(error, `${where} {{ ${source.slice(0, 80)} }}`);
          return undefined;
        }
      };
    } catch (error) {
      report(error, `${where} {{ ${source.slice(0, 80)} }}`);
      fn = () => undefined;
    }
    exprCache.set(key, fn);
  }
  return fn;
}
/** Statements for event handlers: `select('week')` or `open = !open`. */
function handler(source: string, where: string): (scope: Scope) => void {
  let compiled: ((scope: Scope) => unknown) | null = null;
  try {
    compiled = new Function("$scope", `with($scope){${source};}`) as (scope: Scope) => unknown;
  } catch (error) {
    report(error, `${where} ${source.slice(0, 80)}`);
  }
  return (scope) => {
    try {
      compiled?.(scope);
    } catch (error) {
      report(error, `${where} ${source.slice(0, 80)}`);
    }
  };
}

/**
 * A child scope with its own names (loop variables, $event). Defined, not
 * assigned: assigning would reach the parent scope's state-setting proxy.
 */
function local(scope: Scope, names: Record<string, unknown>): Scope {
  const inner = Object.create(scope) as Scope;
  for (const [k, v] of Object.entries(names)) Object.defineProperty(inner, k, { value: v, writable: true, enumerable: true, configurable: true });
  return inner;
}

const INTERP = /\{\{([\s\S]+?)\}\}/g;
type Part = string | Expr;
function parts(text: string, where: string): Part[] | null {
  if (!text.includes("{{")) return null;
  const out: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(INTERP)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(expr(m[1].trim(), where));
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
const show = (v: unknown) => (v === null || v === undefined || v === false ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const join = (p: Part[], scope: Scope) => p.map((x) => (typeof x === "string" ? x : show(x(scope)))).join("");

// ── Template ───────────────────────────────────────────────────────────────

interface TText {
  kind: "text";
  text: string;
  parts: Part[] | null;
}
interface TElement {
  kind: "element";
  tag: string;
  attrs: [string, string, Part[] | null][];
  binds: [string, Expr][];
  events: [string, (scope: Scope) => void][];
  goto?: string;
  ifExpr?: Expr;
  /** This element is the else branch of the preceding if. */
  isElse?: boolean;
  forSpec?: { item: string; index?: string; list: Expr };
  keyExpr?: Expr;
  children: TNode[];
  component?: string;
  slot?: boolean;
}
type TNode = TText | TElement;

const EVENTS: Record<string, string> = {
  click: "onClick", dblclick: "onDoubleClick", input: "onInput", change: "onChange", submit: "onSubmit",
  keydown: "onKeyDown", keyup: "onKeyUp", focus: "onFocus", blur: "onBlur",
  mouseenter: "onMouseEnter", mouseleave: "onMouseLeave", mousedown: "onMouseDown", mouseup: "onMouseUp",
  pointerdown: "onPointerDown", pointerup: "onPointerUp", pointerenter: "onPointerEnter", pointerleave: "onPointerLeave",
  scroll: "onScroll", wheel: "onWheel",
};

function compileChildren(nodes: NodeListOf<ChildNode> | ChildNode[]): TNode[] {
  const out: TNode[] = [];
  for (const n of Array.from(nodes)) {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = n.textContent ?? "";
      out.push({ kind: "text", text, parts: parts(text, "text") });
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const e = n as Element;
      const tag = e.localName;
      if (tag === "script" || tag === "style" && e.closest("body") === null) continue;
      out.push(compileElement(e));
    }
  }
  return out;
}

function compileElement(e: Element): TElement {
  const where = `<${e.localName}${e.getAttribute("data-aegis-layer-name") ? ` "${e.getAttribute("data-aegis-layer-name")}"` : ""}>`;
  const node: TElement = { kind: "element", tag: e.localName, attrs: [], binds: [], events: [], children: [] };
  for (const { name, value } of Array.from(e.attributes)) {
    if (name === "data-aegis-if") node.ifExpr = expr(value, `${where} if`);
    else if (name === "data-aegis-else") node.isElse = true;
    else if (name === "data-aegis-for") {
      const m = /^\s*(?:\(\s*([\w$]+)\s*(?:,\s*([\w$]+)\s*)?\)|([\w$]+))\s+(?:in|of)\s+([\s\S]+)$/.exec(value);
      if (m) node.forSpec = { item: m[1] ?? m[3], index: m[2], list: expr(m[4], `${where} for`) };
      else report(new Error(`for must look like "item in items" or "(item, i) in items"`), where);
    } else if (name === "data-aegis-key") node.keyExpr = expr(value, `${where} key`);
    else if (name.startsWith("data-aegis-on-")) {
      const event = EVENTS[name.slice("data-aegis-on-".length)];
      if (event) node.events.push([event, handler(value, `${where} on ${name.slice(14)}`)]);
      else report(new Error(`unknown event ${name.slice(14)}`), where);
    } else if (name.startsWith("data-aegis-bind-")) node.binds.push([name.slice(16), expr(value, `${where} ${name.slice(16)}`)]);
    else if (name === "data-aegis-goto") node.goto = value;
    else if (tagIsUse(e) && name === "component") node.component = value;
    else node.attrs.push([name, value, parts(value, `${where} ${name}`)]);
  }
  if (e.localName === "aegis-slot") node.slot = true;
  const content = e.localName === "template" ? (e as HTMLTemplateElement).content.childNodes : e.childNodes;
  node.children = compileChildren(content);
  return node;
}
const tagIsUse = (e: Element) => e.localName === "aegis-use";

// ── Attributes → React props ───────────────────────────────────────────────

const RENAME: Record<string, string> = {
  class: "className", for: "htmlFor", tabindex: "tabIndex", colspan: "colSpan", rowspan: "rowSpan",
  readonly: "readOnly", maxlength: "maxLength", minlength: "minLength", autocomplete: "autoComplete",
  autofocus: "autoFocus", contenteditable: "contentEditable", spellcheck: "spellCheck", srcset: "srcSet",
  crossorigin: "crossOrigin", enterkeyhint: "enterKeyHint", inputmode: "inputMode",
};
const BOOLEAN = new Set(["disabled", "checked", "selected", "hidden", "readonly", "required", "multiple", "open", "autofocus"]);

function styleObject(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  let depth = 0, quote = "", cur = "";
  const flush = () => {
    const at = cur.indexOf(":");
    if (at > 0) {
      const key = cur.slice(0, at).trim();
      const value = cur.slice(at + 1).trim();
      if (key && value) out[key.startsWith("--") ? key : key.toLowerCase().replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    cur = "";
  };
  for (const ch of css) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === ";" && depth <= 0) { flush(); continue; }
    cur += ch;
  }
  flush();
  return out;
}
const safeSrc = (v: string) => /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/i.test(v);
const safeHref = (v: string) => /^#[\w-]*$/.test(v);

function setProp(props: Record<string, unknown>, tag: string, name: string, value: unknown) {
  const lower = name.toLowerCase();
  if (lower.startsWith("on")) return;
  if (lower === "src") {
    if (typeof value === "string" && safeSrc(value)) props.src = value;
    return;
  }
  if (lower === "href") {
    if (typeof value === "string" && safeHref(value)) props.href = value;
    return;
  }
  if (lower === "style") {
    props.style = value && typeof value === "object" ? value : styleObject(String(value ?? ""));
    return;
  }
  if (lower === "class" && value && typeof value === "object" && !Array.isArray(value)) {
    props.className = Object.entries(value as Record<string, unknown>).filter(([, on]) => on).map(([k]) => k).join(" ");
    return;
  }
  if (lower === "class" && Array.isArray(value)) {
    props.className = value.filter(Boolean).join(" ");
    return;
  }
  if (BOOLEAN.has(lower)) {
    const on = value === "" || (value !== false && value !== null && value !== undefined && value !== "false");
    // Uncontrolled form state: the canvas and play mode both let it change.
    if (lower === "checked" && (tag === "input")) props.defaultChecked = on;
    else if (lower === "selected" && tag === "option") return;
    else props[RENAME[lower] ?? lower] = on;
    return;
  }
  if (lower === "value" && (tag === "input" || tag === "textarea" || tag === "select")) {
    props.defaultValue = show(value);
    return;
  }
  props[RENAME[lower] ?? name] = typeof value === "string" ? value : show(value);
}

// ── Logic ──────────────────────────────────────────────────────────────────

/** Base class for board and component logic. */
class AegisBoard {
  props: Record<string, unknown>;
  state: Record<string, unknown> = {};
  /** @internal */ __rerender: () => void = () => {};
  constructor(props: Record<string, unknown>) {
    this.props = props;
  }
  setState(patch: Record<string, unknown> | ((state: Record<string, unknown>, props: Record<string, unknown>) => Record<string, unknown>)) {
    const next = typeof patch === "function" ? patch(this.state, this.props) : patch;
    if (!next || typeof next !== "object") return;
    this.state = { ...this.state, ...next };
    this.__rerender();
  }
  /** Extra values for the template, computed on every render. */
  values(): Record<string, unknown> {
    return {};
  }
  mounted() {}
  updated() {}
  unmounted() {}
}
const LIFECYCLE = new Set(["constructor", "values", "mounted", "updated", "unmounted", "setState", "__rerender"]);

type LogicClass = new (props: Record<string, unknown>) => AegisBoard;
const logicCache = new Map<string, LogicClass | null>();
function compileLogic(source: string | null, where: string): LogicClass | null {
  if (!source?.trim()) return null;
  if (logicCache.has(source)) return logicCache.get(source)!;
  let cls: LogicClass | null = null;
  try {
    const made = new Function("AegisBoard", `${source}\n;return typeof Board !== "undefined" ? Board : (typeof Component !== "undefined" ? Component : null);`)(AegisBoard);
    if (typeof made !== "function") throw new Error("logic must define `class Board extends AegisBoard { … }`");
    cls = made as LogicClass;
  } catch (error) {
    report(error, `${where} logic`);
  }
  logicCache.set(source, cls);
  return cls;
}

function methodsOf(instance: AegisBoard): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let proto = Object.getPrototypeOf(instance); proto && proto !== AegisBoard.prototype && proto !== Object.prototype; proto = Object.getPrototypeOf(proto))
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (LIFECYCLE.has(name) || name in out) continue;
      const v = (instance as unknown as Record<string, unknown>)[name];
      if (typeof v === "function") out[name] = (v as (...a: unknown[]) => unknown).bind(instance);
    }
  return out;
}

/**
 * The template scope: props, state, computed values and methods. Assigning to
 * a state key from a handler (`open = !open`) updates state.
 */
function scopeFor(instance: AegisBoard | null, props: Record<string, unknown>): Scope {
  let values: Record<string, unknown> = {};
  if (instance) {
    try {
      values = instance.values() ?? {};
    } catch (error) {
      report(error, "values()");
    }
  }
  const base: Scope = Object.assign(Object.create(null), props, instance?.state ?? {}, values, instance ? methodsOf(instance) : {}, {
    $props: props,
    $state: instance?.state ?? {},
    $board: instance,
  });
  if (!instance) return base;
  return new Proxy(base, {
    has: (target, key) => key in target,
    // State reads are live: a second click before the re-render sees the first's update.
    get(target, key) {
      if (typeof key === "string" && key in instance.state) return instance.state[key];
      return target[key as string];
    },
    set(target, key, value) {
      if (typeof key === "string" && key in instance.state) {
        instance.setState({ [key]: value });
        return true;
      }
      target[key as string] = value;
      return true;
    },
  });
}

// ── Components ─────────────────────────────────────────────────────────────

interface ComponentSource {
  html: string;
  logic?: string | null;
  props?: Record<string, unknown> | null;
}
interface CompiledComponent {
  template: TNode[];
  logic: LogicClass | null;
  defaults: Record<string, unknown>;
}
let componentSources: Record<string, ComponentSource> = {};
const compiledComponents = new Map<string, CompiledComponent | null>();
function readComponents(doc: Document) {
  const block = doc.querySelector(`script[type="${COMPONENTS_TYPE}"]`);
  if (!block) return;
  try {
    const parsed = JSON.parse(block.textContent || "{}");
    if (parsed && typeof parsed === "object") componentSources = parsed;
    compiledComponents.clear();
  } catch (error) {
    report(error, "components");
  }
}
function defaultsOf(spec: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!spec) return {};
  const out: Record<string, unknown> = {};
  for (const [k, def] of Object.entries(spec)) {
    if (k === "$preview") continue;
    if (def && typeof def === "object" && "default" in def) out[k] = (def as { default: unknown }).default;
  }
  return { ...out, ...((spec.$preview as Record<string, unknown>) ?? {}) };
}
function componentOf(name: string): CompiledComponent | null {
  if (compiledComponents.has(name)) return compiledComponents.get(name)!;
  const source = componentSources[name];
  let compiled: CompiledComponent | null = null;
  if (source && typeof source.html === "string") {
    const doc = new DOMParser().parseFromString(source.html, "text/html");
    // A component's own styles (parsed into its head) apply once per board.
    const styles = [...doc.querySelectorAll("style")].map((st) => st.textContent ?? "").join("\n");
    if (styles.trim() && !document.head.querySelector(`style[data-aegis-component="${CSS.escape(name)}"]`)) {
      const el = document.createElement("style");
      el.setAttribute("data-aegis-component", name);
      el.setAttribute("data-aegis-frame", "");
      el.textContent = styles;
      document.head.append(el);
    }
    compiled = {
      template: compileChildren(doc.body.childNodes),
      logic: compileLogic(source.logic ?? null, `<${name}>`),
      defaults: defaultsOf(source.props),
    };
  } else report(new Error(`component "${name}" is not in this design's system`), "<aegis-use>");
  compiledComponents.set(name, compiled);
  return compiled;
}

// ── Rendering ──────────────────────────────────────────────────────────────

interface RenderContext {
  /** Children passed to the component being rendered (for <aegis-slot>). */
  slot?: { nodes: TNode[]; scope: Scope; ctx: RenderContext };
  /** Inside a component's own template: its layers are not board layers. */
  inComponent?: boolean;
  /** The node id the component's root element takes. */
  rootId?: string;
  rootName?: string;
  instance?: string;
}

function render(nodes: TNode[], scope: Scope, ctx: RenderContext, keyPrefix = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let previousIf: boolean | null = null;
  nodes.forEach((n, i) => {
    const key = `${keyPrefix}${i}`;
    if (n.kind === "text") {
      out.push(n.parts ? join(n.parts, scope) : n.text);
      return;
    }
    if (n.isElse) {
      if (previousIf === true) {
        previousIf = null;
        return;
      }
      previousIf = null;
    } else if (n.ifExpr) {
      previousIf = !!n.ifExpr(scope);
      if (!previousIf) return;
    } else previousIf = null;
    if (n.forSpec) {
      const raw = n.forSpec.list(scope);
      const list = typeof raw === "number" ? Array.from({ length: Math.max(0, Math.min(raw, 1000)) }, (_, k) => k) : Array.isArray(raw) ? raw.slice(0, 1000) : [];
      list.forEach((item, index) => {
        const inner = local(scope, { [n.forSpec!.item]: item, ...(n.forSpec!.index ? { [n.forSpec!.index]: index } : {}) });
        const k = n.keyExpr ? show(n.keyExpr(inner)) : String(index);
        out.push(element(n, inner, { ...ctx, instance: String(index) }, `${key}:${k}`));
      });
      return;
    }
    out.push(element(n, scope, ctx, key));
  });
  return out;
}

function element(n: TElement, scope: Scope, ctx: RenderContext, key: string): ReactNode {
  if (n.slot) return h(Fragment, { key }, ctx.slot ? render(ctx.slot.nodes, ctx.slot.scope, ctx.slot.ctx, key + "s") : null);
  if (n.component !== undefined || n.tag === "aegis-use") return h(Instance, { key, node: n, scope, ctx });
  const props: Record<string, unknown> = { key };
  for (const [name, raw, p] of n.attrs) {
    if (ctx.inComponent && name === "data-aegis-node-id") continue;
    setProp(props, n.tag, name, p ? join(p, scope) : raw);
  }
  for (const [name, value] of n.binds) setProp(props, n.tag, name, value(scope));
  if (ctx.instance !== undefined && !ctx.inComponent) props["data-aegis-instance"] = ctx.instance;
  if (ctx.rootId) {
    props["data-aegis-node-id"] = ctx.rootId;
    if (ctx.rootName) props["data-aegis-layer-name"] = ctx.rootName;
  }
  if (mode === "play") {
    for (const [event, run] of n.events)
      props[event] = (e: Event) => {
        if (event === "onSubmit") e.preventDefault();
        run(local(scope, { $event: e }));
      };
    if (n.goto) {
      const previous = props.onClick as ((e: Event) => void) | undefined;
      props.onClick = (e: Event) => {
        previous?.(e);
        e.preventDefault();
        post("goto", { board: n.goto });
      };
      props.style = { cursor: "pointer", ...((props.style as object) ?? {}) };
    }
  }
  const childCtx: RenderContext = { ...ctx, rootId: undefined, rootName: undefined };
  if (n.tag === "textarea") {
    if (!("defaultValue" in props)) props.defaultValue = n.children.map((c) => (c.kind === "text" ? (c.parts ? join(c.parts, scope) : c.text) : "")).join("");
    return h("textarea", props);
  }
  const children = render(n.children, scope, childCtx, key + ".");
  return h(n.tag, props, ...(children.length ? children : []));
}

interface LogicHolder {
  current: { cls: LogicClass | null; instance: AegisBoard | null };
}
/**
 * Holds one logic instance across renders; a new logic source starts a new
 * one. `holder` keeps it across remounts (the board's own logic).
 */
function useLogic(cls: LogicClass | null, props: Record<string, unknown>, holder?: LogicHolder) {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const local = useRef<LogicHolder["current"]>({ cls: null, instance: null });
  const ref = holder ?? local;
  if (ref.current.cls !== cls) {
    let instance: AegisBoard | null = null;
    if (cls) {
      try {
        instance = new cls(props);
      } catch (error) {
        report(error, "logic constructor");
      }
    }
    ref.current = { cls, instance };
  }
  const instance = ref.current.instance;
  if (instance) {
    instance.props = props;
    instance.__rerender = () => rerender();
  }
  useEffect(() => {
    if (!instance) return;
    try {
      instance.mounted();
    } catch (error) {
      report(error, "mounted()");
    }
    return () => {
      try {
        instance.unmounted();
      } catch (error) {
        report(error, "unmounted()");
      }
    };
  }, [instance]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    try {
      instance?.updated();
    } catch (error) {
      report(error, "updated()");
    }
  });
  return instance;
}

function Instance({ node, scope, ctx }: { node: TElement; scope: Scope; ctx: RenderContext }) {
  const name = node.component ?? "";
  const compiled = componentOf(name);
  const props: Record<string, unknown> = { ...(compiled?.defaults ?? {}) };
  for (const [attr, raw, p] of node.attrs) {
    if (attr === "data-aegis-node-id" || attr === "data-aegis-layer-name" || attr === "style" || attr === "class") continue;
    props[attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = p ? join(p, scope) : raw;
  }
  for (const [attr, value] of node.binds) props[attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value(scope);
  const instance = useLogic(compiled?.logic ?? null, props);
  const id = ctx.inComponent ? undefined : node.attrs.find(([a]) => a === "data-aegis-node-id")?.[1];
  const layerName = node.attrs.find(([a]) => a === "data-aegis-layer-name")?.[1] || name;
  if (!compiled)
    return h("div", {
      "data-aegis-node-id": id,
      "data-aegis-layer-name": layerName,
      style: { padding: 12, border: "1px dashed #d33", color: "#d33", font: "12px system-ui" },
    }, `Missing component ${name}`);
  const inner = scopeFor(instance, props);
  const roots = compiled.template.filter((t) => t.kind === "element" || (t.kind === "text" && t.text.trim()));
  const childCtx: RenderContext = {
    inComponent: true,
    slot: { nodes: node.children, scope, ctx },
    instance: ctx.instance,
  };
  // One root takes the instance's layer id, so the canvas selects the instance.
  if (roots.length === 1 && roots[0].kind === "element")
    return h(Fragment, null, render(roots, inner, { ...childCtx, rootId: id, rootName: layerName }));
  return h("div", { "data-aegis-node-id": id, "data-aegis-layer-name": layerName, style: { display: "block" } }, render(compiled.template, inner, childCtx));
}

class Boundary extends ReactComponent<{ children?: ReactNode; epoch: number }, { failed: boolean; epoch: number }> {
  state = { failed: false, epoch: 0 };
  static getDerivedStateFromProps(props: { epoch: number }, state: { failed: boolean; epoch: number }) {
    return props.epoch !== state.epoch ? { failed: false, epoch: props.epoch } : null;
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    report(error, "render");
  }
  render() {
    return this.state.failed
      ? h("div", { style: { padding: 16, font: "13px system-ui", color: "#b42318" } }, "This board's logic failed to render. Its errors are listed for the agent.")
      : this.props.children;
  }
}

interface BoardSource {
  template: TNode[];
  logic: LogicClass | null;
  props: Record<string, unknown>;
}
/** The board's logic instance outlives remounts, so a saved edit keeps its state. */
const boardLogic: LogicHolder = { current: { cls: null, instance: null } };
function Board({ source }: { source: BoardSource }) {
  const instance = useLogic(source.logic, source.props, boardLogic);
  return h(Fragment, null, render(source.template, scopeFor(instance, source.props), {}));
}

// ── Boot and updates ───────────────────────────────────────────────────────

function readSource(doc: Document): BoardSource {
  const logic = doc.querySelector(`script[type="${LOGIC_TYPE}"]`)?.textContent ?? null;
  let props: Record<string, unknown> = {};
  const propsBlock = doc.querySelector(`script[type="${PROPS_TYPE}"]`);
  if (propsBlock)
    try {
      props = defaultsOf(JSON.parse(propsBlock.textContent || "{}"));
    } catch (error) {
      report(error, "props");
    }
  return { template: compileChildren(doc.body.childNodes), logic: compileLogic(logic, "board"), props };
}

let root: Root | null = null;
let epoch = 0;
/**
 * Every paint is a fresh mount: the canvas moves and previews layers in the
 * DOM directly (drags, size previews), which React must not reconcile against.
 */
function paint(source: BoardSource) {
  epoch += 1;
  root?.unmount();
  document.body.replaceChildren();
  root = createRoot(document.body);
  flushSync(() => root!.render(h(Boundary, { epoch }, h(Board, { source }))));
}

function boot() {
  readComponents(document);
  paint(readSource(document));
  post("ready", { mode });
}

/** A saved change: new head styles, body attributes and template; logic state survives when its source is unchanged. */
function update(html: string) {
  const next = new DOMParser().parseFromString(html, "text/html");
  const owned = (n: Element) => n.hasAttribute("data-aegis-frame") || n.hasAttribute("data-aegis-runtime") || n.matches(`script[type="${COMPONENTS_TYPE}"]`);
  for (const n of [...document.head.children]) if (!owned(n)) n.remove();
  for (const n of [...next.head.children]) if (n.localName !== "script") document.head.append(document.importNode(n, true));
  for (const a of [...document.body.attributes]) if (!next.body.hasAttribute(a.name)) document.body.removeAttribute(a.name);
  for (const a of [...next.body.attributes]) document.body.setAttribute(a.name, a.value);
  errors.length = 0;
  paint(readSource(next));
  post("updated");
}

const runtime = {
  mode,
  errors,
  ready: null as Promise<void> | null,
  update(html: string) {
    update(html);
  },
};
(window as unknown as { __aegisRuntime: typeof runtime }).__aegisRuntime = runtime;
runtime.ready = new Promise<void>((resolve) => {
  const start = () => {
    try {
      boot();
    } catch (error) {
      report(error, "boot");
    }
    resolve();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
});

// The canvas pings to tell a busy board from a hung one.
window.addEventListener("message", (e) => {
  const d = e.data;
  if (e.source !== parent || d?.nonce !== nonce) return;
  if (d.type === "aegis-design-ping") post("pong", { request: d.request });
});
