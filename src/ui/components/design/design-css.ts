/** Authored CSS of one layer, as the board's inspector reports it. */
export type CssDecl = [property: string, value: string];
export interface LayerCss {
  tag: string;
  text: string;
  own: CssDecl[];
  /** Inherited declarations grouped by the nearest ancestor that sets them. */
  inherited: { id?: string; label: string; decls: CssDecl[] }[];
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const declList = (v: unknown, max: number): CssDecl[] =>
  (Array.isArray(v) ? v : [])
    .filter(
      (d): d is [string, string] =>
        Array.isArray(d) &&
        typeof d[0] === "string" &&
        typeof d[1] === "string" &&
        /^-?[a-z][a-z0-9-]*$/.test(d[0]) &&
        d[0].length < 60,
    )
    .slice(0, max)
    .map(([k, v]) => [k, v.slice(0, 1000)]);

/** Validates the frame's reply; the frame runs untrusted board content. */
export function toLayerCss(v: unknown): LayerCss | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const tag = str(o.tag, 40);
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return null;
  return {
    tag,
    text: str(o.text, 80),
    own: declList(o.own, 80),
    inherited: (Array.isArray(o.inherited) ? o.inherited : [])
      .slice(0, 8)
      .flatMap((g) => {
        if (!g || typeof g !== "object") return [];
        const label = str(g.label, 80);
        const decls = declList(g.decls, 40);
        if (!label || !decls.length) return [];
        return [{ ...(typeof g.id === "string" ? { id: g.id.slice(0, 200) } : {}), label, decls }];
      }),
  };
}

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
/** Serialized rgb()/rgba() colors back to hex, the way designs are usually written. */
export function hexColors(value: string): string {
  return value.replace(
    /rgba?\(\s*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d*\.?\d+)(%?))?\s*\)/g,
    (_, r, g, b, a, pct) => {
      const alpha = a === undefined ? 1 : pct ? Number(a) / 100 : Number(a);
      return ("#" + hex2(+r) + hex2(+g) + hex2(+b) + (alpha < 1 ? hex2(alpha * 255) : "")).toUpperCase();
    },
  );
}

/** A single color value, for a swatch; undefined for anything else. */
export function swatchColor(property: string, value: string): string | undefined {
  if (!/color$/.test(property)) return undefined;
  const v = value.replace(/\s*!important$/i, "").trim();
  return /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+)$/i.test(v) &&
    !/^(inherit|initial|unset|currentcolor|transparent|revert)$/i.test(v)
    ? v
    : undefined;
}

export const cssText = (decls: CssDecl[]) =>
  decls.map(([k, v]) => `${k}: ${hexColors(v)};`).join("\n");

export interface InlineCssDeclaration {
  property: string;
  value: string;
  important: boolean;
}

/** Parse a declaration list, never a selector/rule. No DOM or CSS is executed. */
export function parseInlineCss(source: string): InlineCssDeclaration[] {
  if (source.length > 32_000) throw new Error("Inline CSS is too long.");
  const declarations: InlineCssDeclaration[] = [];
  let buffer = "", quote = "", escaped = false, comment = false;
  const brackets: string[] = [];
  function flush() {
    const text = buffer.trim();
    buffer = "";
    if (!text) return;
    const match = /^(--[a-zA-Z_][\w-]*|-?[a-zA-Z][\w-]*)\s*:\s*([\s\S]+)$/.exec(text);
    if (!match) throw new Error(`Expected a CSS declaration: ${text.slice(0, 60)}`);
    const property = match[1].startsWith("--") ? match[1] : match[1].toLowerCase();
    const important = /!\s*important\s*$/i.test(match[2]);
    const value = match[2].replace(/!\s*important\s*$/i, "").trim();
    if (!value) throw new Error(`Enter a value for ${property}.`);
    declarations.push({ property, value, important });
    if (declarations.length > 200) throw new Error("Use at most 200 inline declarations.");
  }
  for (let i = 0; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (comment) {
      if (ch === "*" && next === "/") { comment = false; i++; buffer += " "; }
      continue;
    }
    if (escaped) { buffer += ch; escaped = false; continue; }
    if (ch === "\\") { buffer += ch; escaped = true; continue; }
    if (quote) { buffer += ch; if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buffer += ch; continue; }
    if (ch === "/" && next === "*") { comment = true; i++; continue; }
    if (ch === "{" || ch === "}") throw new Error("Enter declarations only, without selectors or braces.");
    if (ch === "(" || ch === "[") brackets.push(ch);
    if (ch === ")" || ch === "]") {
      if (brackets.pop() !== (ch === ")" ? "(" : "[")) throw new Error("Unbalanced CSS brackets.");
    }
    if (ch === ";" && brackets.length === 0) flush();
    else buffer += ch;
  }
  if (quote || comment || escaped || brackets.length) throw new Error("Finish the CSS string, comment or function before saving.");
  flush();
  return declarations;
}

export const inlineCssText = (decls: InlineCssDeclaration[]) =>
  decls.map(({ property, value, important }) => `${property}: ${value}${important ? " !important" : ""};`).join("\n");

/** Never seed the editor from LayerCss.own: it merges rule and inline sources. */
export function formatInlineCss(source: string): string {
  try { return inlineCssText(parseInlineCss(source)); } catch { return source; }
}
