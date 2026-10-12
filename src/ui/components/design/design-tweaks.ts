import { parse, type DefaultTreeAdapterMap } from "parse5";

export type DesignTweakValue = string | number | boolean | null | string[];
export type DesignTweakEditor = "text" | "color" | "int" | "float" | "range" | "boolean" | "enum";
export interface DesignTweakControl {
  name: string;
  editor: DesignTweakEditor;
  section?: string;
  default?: DesignTweakValue;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { label: string; value: DesignTweakValue }[];
}
const editors = new Set(["text", "color", "int", "float", "range", "boolean", "enum"]);
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const scalar = (v: unknown): v is DesignTweakValue => v === null || typeof v === "boolean" ||
  (typeof v === "string" && v.length <= 4096) || (typeof v === "number" && Number.isFinite(v)) ||
  (Array.isArray(v) && v.length <= 64 && v.every((x) => typeof x === "string" && x.length <= 256));
const numeric = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : undefined;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export const equalTweakValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function validateTweakValue(control: DesignTweakControl, value: unknown): asserts value is DesignTweakValue {
  if (!scalar(value)) throw new Error(`Invalid value for ${control.name}.`);
  switch (control.editor) {
    case "boolean": if (typeof value !== "boolean") throw new Error(`${control.name} must be on or off.`); break;
    case "text": if (typeof value !== "string") throw new Error(`${control.name} must be text.`); break;
    case "color":
      if (typeof value !== "string" && !control.options?.some((o) => equalTweakValue(o.value, value))) throw new Error(`Choose a color for ${control.name}.`);
      break;
    case "enum":
      if (!control.options?.some((o) => equalTweakValue(o.value, value))) throw new Error(`Choose an available option for ${control.name}.`);
      break;
    default: {
      if (typeof value !== "number" || !Number.isFinite(value) || (control.editor === "int" && !Number.isInteger(value))) throw new Error(`${control.name} must be a valid ${control.editor === "int" ? "integer" : "number"}.`);
      const min = control.min ?? (control.editor === "range" ? 0 : undefined);
      const max = control.max ?? (control.editor === "range" ? 100 : undefined);
      if ((min !== undefined && value < min) || (max !== undefined && value > max)) throw new Error(`${control.name} is outside its allowed range.`);
    }
  }
}

// Aegis adaptation: declarative bindings survive its script-free HTML sanitizer.
// No arbitrary selectors, runtime code or implicit CSS-to-control inference.
import { designLayerPath, editableLayerStyles, editDesignLayer, findDesignLayer, readDesignLayers, replaceDesignLayerStyle } from "../../../shared/design-layers";
import { inlineCssText, parseInlineCss } from "./design-css";

export interface AegisTweakControl extends DesignTweakControl {
  target: { nodeId: string; kind: "style" | "text"; property?: string; on?: string; off?: string };
  value?: DesignTweakValue;
  unavailable?: string;
}
export interface AegisTweaksSource {
  status: "ready" | "absent" | "invalid";
  controls: AegisTweakControl[];
  message?: string;
}
const styleProperties = new Set<string>(editableLayerStyles);
const units = new Set(["", "px", "%", "em", "rem", "vw", "vh", "deg", "s", "ms"]);
const safeStyleValue = (value: string) => value.length <= 1000 && !/[;{}<>\\\u0000-\u001f]/.test(value) && !/url\s*\(|expression\s*\(|!\s*important/i.test(value);

/** v1 body[data-aegis-tweaks]: {version:1,controls:[{name,editor,target,...}]}. */
export function readDesignTweaks(html: string): AegisTweaksSource {
  const doc = parse(html);
  let body: DefaultTreeAdapterMap["element"] | undefined;
  const walk = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node && node.tagName === "body") body = node;
    if ("childNodes" in node) for (const child of node.childNodes) walk(child);
  };
  walk(doc);
  const raw = body?.attrs.find((a) => a.name === "data-aegis-tweaks")?.value;
  if (raw === undefined) return { status: "absent", controls: [] };
  const invalid = (message: string): AegisTweaksSource => ({ status: "invalid", controls: [], message });
  if (raw.length > 64_000) return invalid("This board's tweak definitions are too large.");
  let definition: unknown;
  try { definition = JSON.parse(raw); } catch { return invalid("This board's tweak definitions are not valid JSON."); }
  if (!object(definition) || definition.version !== 1 || !Array.isArray(definition.controls) || definition.controls.length > 64) return invalid("This board needs a supported v1 tweak definition.");
  const tree = readDesignLayers(html), controls: AegisTweakControl[] = [], names = new Set<string>(), bindings = new Set<string>();
  for (const spec of definition.controls) {
    if (!object(spec) || typeof spec.name !== "string" || !spec.name.trim() || spec.name.length > 120 || names.has(spec.name) || forbidden.has(spec.name) || !editors.has(String(spec.editor)) || !object(spec.target)) return invalid("A tweak has an invalid name, editor or target.");
    names.add(spec.name);
    const target = spec.target;
    if (typeof target.nodeId !== "string" || !target.nodeId || target.nodeId.length > 200 || (target.kind !== "style" && target.kind !== "text")) return invalid(`The ${spec.name} target is invalid.`);
    if (target.kind === "style" && (typeof target.property !== "string" || !styleProperties.has(target.property))) return invalid(`The ${spec.name} style is not editable.`);
    const binding = `${target.nodeId}\0${target.kind}\0${target.property ?? ""}`;
    if (bindings.has(binding)) return invalid(`Multiple tweaks bind the same target as ${spec.name}.`);
    bindings.add(binding);
    if (target.kind === "text" && spec.editor !== "text") return invalid(`The ${spec.name} text binding needs a text editor.`);
    if (spec.unit !== undefined && (typeof spec.unit !== "string" || !units.has(spec.unit))) return invalid(`The ${spec.name} unit is not supported.`);
    const control: AegisTweakControl = { name: spec.name, editor: spec.editor as DesignTweakEditor, target: { nodeId: target.nodeId, kind: target.kind, ...(target.kind === "style" ? { property: target.property as string } : {}) } };
    if (typeof spec.section === "string") control.section = spec.section.slice(0, 120);
    if (typeof spec.unit === "string") control.unit = spec.unit;
    for (const key of ["min", "max", "step"] as const) {
      if (spec[key] !== undefined) {
        const n = numeric(spec[key]);
        if (n === undefined || (key === "step" && n <= 0)) return invalid(`The ${spec.name} range is invalid.`);
        control[key] = n;
      }
    }
    if (control.min !== undefined && control.max !== undefined && control.min > control.max) return invalid(`The ${spec.name} range is reversed.`);
    if (Array.isArray(spec.options)) control.options = spec.options.slice(0, 64).flatMap((option) => {
      const v = object(option) && own(option, "value") ? option.value : option;
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return [];
      if (!safeStyleValue(String(v))) return [];
      return [{ value: v, label: String(object(option) ? option.label ?? v : v).slice(0, 120) }];
    });
    if (control.editor === "enum" && !control.options?.length) return invalid(`The ${spec.name} options are missing.`);
    if (control.editor === "boolean") {
      if (target.kind !== "style" || typeof target.on !== "string" || typeof target.off !== "string" || !safeStyleValue(target.on) || !safeStyleValue(target.off) || target.on === target.off) return invalid(`The ${spec.name} switch needs distinct on/off style values.`);
      control.target.on = target.on; control.target.off = target.off;
    }
    const node = findDesignLayer(tree, target.nodeId);
    if (!node) control.unavailable = "Its target layer no longer exists.";
    else if ((designLayerPath(tree, node.id) ?? []).some((n) => n.locked)) control.unavailable = "Unlock the target layer or its parent to edit it.";
    else if (target.kind === "text") {
      if (!node.textEditable) control.unavailable = "This target contains child layers and cannot be replaced as text.";
      else control.value = node.text;
    } else {
      try {
        const declaration = parseInlineCss(node.styles.cssText).filter((d) => d.property === target.property).at(-1);
        const value = declaration?.value;
        if (value !== undefined) {
          if (control.editor === "boolean") control.value = value === target.on ? true : value === target.off ? false : undefined;
          else if (["int", "float", "range"].includes(control.editor)) {
            const unit = control.unit ?? "";
            const number = unit && value.endsWith(unit) ? value.slice(0, -unit.length) : !unit ? value : "";
            if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(number)) control.value = Number(number);
          } else if (control.editor === "enum") control.value = control.options?.find((o) => String(o.value) === value)?.value;
          else control.value = value;
        }
      } catch { control.unavailable = "Fix this layer's inline CSS before using its tweaks."; }
    }
    controls.push(control);
  }
  return { status: "ready", controls };
}

/** Apply only explicitly bound text or whitelisted inline properties. */
export function applyDesignTweaks(html: string, overrides: Record<string, DesignTweakValue>, supports?: (property: string, value: string) => boolean): string {
  const source = readDesignTweaks(html);
  if (source.status !== "ready") throw new Error(source.message ?? "This board has no tweak definitions.");
  let result = html;
  for (const [name, value] of Object.entries(overrides)) {
    const control = source.controls.find((c) => c.name === name);
    if (!control) throw new Error(`The ${name} tweak is no longer defined.`);
    if (control.unavailable) throw new Error(control.unavailable);
    validateTweakValue(control, value);
    if (control.target.kind === "text") {
      result = editDesignLayer(result, control.target.nodeId, { type: "text", value: value as string });
    } else {
      const node = findDesignLayer(readDesignLayers(result), control.target.nodeId);
      if (!node) throw new Error("The target layer no longer exists.");
      const v = control.editor === "boolean" ? (value ? control.target.on! : control.target.off!) :
        typeof value === "number" && ["int", "float", "range"].includes(control.editor) ? `${value}${control.unit ?? ""}` : String(value);
      if (!safeStyleValue(v)) throw new Error(`The ${name} style value is not supported.`);
      if (supports && !supports(control.target.property!, v)) throw new Error(`Invalid ${control.target.property}: ${v}`);
      const declarations = parseInlineCss(node.styles.cssText).filter((d) => d.property !== control.target.property);
      declarations.push({ property: control.target.property!, value: v, important: true });
      result = replaceDesignLayerStyle(result, node.id, inlineCssText(declarations));
    }
  }
  return result;
}
