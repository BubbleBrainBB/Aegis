import { existsSync, lstatSync, readdirSync, readFileSync } from "fs";
import { basename, extname, join } from "path";
import { readBoardTokens } from "../../shared/design-tokens";
import { designSystemTokens, type DesignSystemPack } from "../../shared/design-system-pack";
import { designLogicOf, designPropsOf, parseDesignProps, DESIGN_PROPS_TYPE } from "../../shared/design-component";
import { projectDesignPack } from "./system-pack";

/**
 * How far a board strays from the design system it loads: colors written
 * out instead of its tokens, tokens it doesn't have, fonts it doesn't
 * register, raw controls where it has a component. Hints for the agent,
 * reported with design_preview's other checks.
 */

const COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([^)]*\)/gi;
const IS_COLOR = /^\s*(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([^)]*\))\s*$/i;
const GENERIC_FONTS = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong", "inherit", "initial", "unset"]);
/** Fonts every Mac (and most Windows) has: not a design system's to register. */
const SYSTEM_FONTS = new Set([
  "-apple-system", "blinkmacsystemfont", "sf pro", "sf pro text", "sf pro display", "sf pro rounded", "sf mono", "new york",
  "helvetica neue", "helvetica", "arial", "georgia", "times new roman", "times", "courier new", "courier", "menlo", "monaco",
  "consolas", "segoe ui", "roboto", "pingfang sc", "pingfang tc", "hiragino sans gb", "hiragino sans", "songti sc", "songti tc",
  "heiti sc", "stheiti", "microsoft yahei", "noto sans sc", "noto serif sc", "noto sans", "noto serif", "avenir", "avenir next",
  "futura", "gill sans", "optima", "palatino", "baskerville", "didot", "american typewriter", "verdana", "tahoma", "trebuchet ms",
]);
const normColor = (c: string) => c.toLowerCase().replace(/\s+/g, "");

function boardCss(html: string): { styles: string; inline: string[] } {
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const inline = [...html.matchAll(/\sstyle="([^"]*)"/gi)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  return { styles, inline };
}

export function adherenceWarnings(html: string, pack: DesignSystemPack): string[] {
  const warnings: string[] = [];
  const systemTokens = designSystemTokens(pack.css);
  const boardTokens = readBoardTokens(html);
  const { styles, inline } = boardCss(html);
  // Root token declarations are the board's own vocabulary, not usage.
  const usage = [styles.replace(/(?::root|html|body)\s*\{[^}]*\}/gi, ""), ...inline].join("\n");

  const colorTokens = systemTokens.filter((t) => IS_COLOR.test(t.value));
  if (colorTokens.length) {
    const known = new Set([...systemTokens, ...boardTokens].map((t) => normColor(t.value)));
    const literal = [...new Set((usage.match(COLOR) ?? []).map(normColor))].filter((c) => !known.has(c) && !/^#(?:fff|ffffff|000|000000)$/.test(c) && !/^rgba?\(0,0,0,0\)$/.test(c));
    if (literal.length >= 2)
      warnings.push(
        `${literal.length} colors are written out instead of the design system's tokens (${literal.slice(0, 4).join(", ")}${literal.length > 4 ? ", …" : ""}). Use its tokens, e.g. var(${colorTokens[0].name}).`,
      );
  }

  const declared = new Set([...systemTokens, ...boardTokens].map((t) => t.name));
  for (const m of usage.matchAll(/--[\w-]+(?=\s*:)/g)) declared.add(m[0]);
  const missing = [...new Set([...usage.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]))].filter((n) => !declared.has(n));
  if (missing.length) warnings.push(`Tokens the design system doesn't have: ${missing.slice(0, 6).join(", ")}. They render as nothing; use the system's tokens.`);

  const registered = new Set(pack.fonts.map((f) => f.toLowerCase()));
  const families = new Set<string>();
  for (const m of usage.matchAll(/font-family\s*:\s*([^;}]+)/gi))
    for (const f of m[1].split(",")) {
      const name = f.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
      if (name && !name.startsWith("var(") && !GENERIC_FONTS.has(name) && !SYSTEM_FONTS.has(name) && !registered.has(name)) families.add(f.trim().replace(/^['"]|['"]$/g, ""));
    }
  if (families.size)
    warnings.push(`Fonts that are neither the design system's nor system fonts: ${[...families].slice(0, 4).join(", ")}. They won't load on the canvas${pack.fonts.length ? `; the system has ${pack.fonts.join(", ")}` : ""}.`);

  const names = new Set(Object.keys(pack.components).map((n) => n.toLowerCase()));
  const body = html.replace(/<aegis-use\b[\s\S]*?<\/aegis-use>/gi, "");
  const raw: [string, string][] = [["button", "Button"], ["input", "Field"]];
  for (const [tag, component] of raw) {
    if (!names.has(component.toLowerCase())) continue;
    const count = (body.match(new RegExp(`<${tag}\\b(?![^>]*class="[^"]*\\bds-)`, "gi")) ?? []).length;
    if (count >= 2) warnings.push(`${count} raw <${tag}> elements: the design system has a ${component} component (<aegis-use component="${component}">).`);
  }
  const unknown = [...new Set([...html.matchAll(/<aegis-use\b[^>]*\bcomponent="([^"]+)"/gi)].map((m) => m[1]))].filter((n) => !names.has(n.toLowerCase()));
  if (unknown.length) warnings.push(`Components this design system doesn't have: ${unknown.join(", ")}.`);
  return warnings;
}

// ── design_system_check ───────────────────────────────────────────────────

/** A project design system's report: what boards will load, and what is wrong with it. */
export function checkProjectDesignSystem(root: string | null | undefined): string {
  if (!root) return "This conversation has no project folder, so there is no project design system to check.";
  const dir = join(root, "design-system");
  if (!existsSync(dir)) return "This project has no design-system/ folder. Create design-system/styles.css (tokens, fonts, component classes), components/Name.html (+ Name.md) and assets/ to give its designs a system.";
  const ok: string[] = [];
  const problems: string[] = [];
  const report = projectDesignPack(root);
  if (!existsSync(join(dir, "README.md"))) problems.push("README.md is missing: the guide agents read first (principles, voice, layout).");
  else ok.push("README.md guide");
  if (!existsSync(join(dir, "styles.css"))) problems.push("styles.css is missing: boards load no stylesheet, tokens or fonts.");
  const pack = report?.pack;
  problems.push(...(report?.warnings ?? []));
  if (pack) {
    const tokens = designSystemTokens(pack.css);
    ok.push(`styles.css: ${Math.round(pack.css.length / 1024)} KB, ${tokens.length} tokens`);
    if (!tokens.length && pack.css.trim()) problems.push("styles.css declares no tokens on :root; boards can't refer to its colors and type by name.");
    const declared = new Set(tokens.map((t) => t.name));
    const undefinedVars = [...new Set([...pack.css.matchAll(/var\(\s*(--[\w-]+)\s*[,)]/g)].map((m) => m[1]))].filter((n) => !declared.has(n) && !new RegExp(`${n}\\s*:`).test(pack.css));
    if (undefinedVars.length) problems.push(`styles.css uses tokens it never declares: ${undefinedVars.slice(0, 8).join(", ")}.`);
    if (/url\(\)/.test(pack.css)) problems.push("styles.css refers to files outside design-system/ or remote URLs; those never load in a board (inline them under design-system/).");
    const faces = (pack.css.match(/@font-face/gi) ?? []).length;
    if (faces) ok.push(`${faces} @font-face rule${faces === 1 ? "" : "s"}: ${pack.fonts.join(", ")}`);
    const names = Object.keys(pack.components);
    const lower = new Map<string, string>();
    for (const name of names) {
      if (lower.has(name.toLowerCase())) problems.push(`Components ${lower.get(name.toLowerCase())} and ${name} differ only in case.`);
      lower.set(name.toLowerCase(), name);
      const c = pack.components[name];
      if (!c.html.replace(/<style>[\s\S]*?<\/style>/g, "").trim()) problems.push(`components/${name}.html has no template markup.`);
      if (c.logic)
        try {
          new Function("AegisBoard", c.logic); // compiles only; never runs
        } catch (e) {
          problems.push(`components/${name}.html logic does not compile: ${(e as Error).message}`);
        }
      if (!existsSync(join(dir, "components", `${name}.md`))) problems.push(`components/${name}.md is missing: agents won't know when to use ${name}.`);
    }
    for (const file of safeList(join(dir, "components")).filter((f) => extname(f) === ".html")) {
      const source = readText(join(dir, "components", file));
      if (source && source.includes(DESIGN_PROPS_TYPE)) {
        const m = new RegExp(`<script type="${DESIGN_PROPS_TYPE}">([\\s\\S]*?)</script>`).exec(source);
        try {
          parseDesignProps(JSON.parse(m?.[1] ?? "{}"));
        } catch (e) {
          problems.push(`components/${file} props: ${(e as Error).message}`);
        }
      }
      if (source && designLogicOf(source) === null && /<script(?![^>]*type=)/i.test(source)) problems.push(`components/${file} has a plain <script>; logic goes in <script type="text/x-aegis-logic">.`);
    }
    if (names.length) ok.push(`${names.length} component${names.length === 1 ? "" : "s"}: ${names.join(", ")}`);
    const assets = Object.keys(pack.assets);
    if (assets.length) ok.push(`${assets.length} image${assets.length === 1 ? "" : "s"} (aegis-asset:name): ${assets.slice(0, 12).join(", ")}${assets.length > 12 ? ", …" : ""}`);
    for (const file of safeList(join(dir, "templates")).filter((f) => extname(f) === ".html")) {
      const source = readText(join(dir, "templates", file)) ?? "";
      const unknown = [...new Set([...source.matchAll(/<aegis-use\b[^>]*\bcomponent="([^"]+)"/gi)].map((m) => m[1]))].filter((n) => !lower.has(n.toLowerCase()));
      if (unknown.length) problems.push(`templates/${file} uses components the system doesn't have: ${unknown.join(", ")}.`);
      if (designPropsOf(source) === null && source.includes(DESIGN_PROPS_TYPE)) problems.push(`templates/${basename(file)} has props that are not valid JSON.`);
    }
  } else if (!problems.length) problems.push("design-system/ has nothing boards can load yet (styles.css, components/*.html or assets/).");
  return [
    "# Design system check",
    ...ok.map((l) => `✓ ${l}`),
    ...(problems.length ? ["", "Problems:", ...problems.map((p) => `- ${p}`)] : ["", "No problems found."]),
  ].join("\n");
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => !f.startsWith("."));
  } catch {
    return [];
  }
}
function readText(file: string): string | null {
  try {
    const st = lstatSync(file);
    return st.isFile() && !st.isSymbolicLink() && st.size <= 300_000 ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}
