import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import { basename, dirname, extname, join, normalize, relative, sep } from "path";
import { designLogicOf, designPropsOf } from "../../shared/design-component";
import { declaredFontFamilies, type DesignSystemPack } from "../../shared/design-system-pack";
import { sanitizeDesignHtml } from "./html";
import { summaryOf } from "./design-system";
import { builtinDesignStyles, PROJECT_DESIGN_SYSTEM, type BuiltinStyle } from "./styles";

/**
 * Design system packs: what a design's boards load. A project's pack is its
 * design-system/ folder:
 *
 *   styles.css            tokens, @font-face and component classes (local @imports inlined)
 *   fonts/, assets/…      files styles.css refers to with url(); inlined as data URLs
 *   components/Name.html  a component in the board format: template, logic, props
 *   components/Name.md    how to use it (first line: what it is)
 *   assets/name.svg|png…  images boards use as aegis-asset:name
 *
 * Built-in styles have packs too: their tokens and a small set of components.
 */

const FOLDER = "design-system";
/** A design that loads no system, even in a project that has one. */
export const NO_DESIGN_SYSTEM = "none";
const MAX_FILE = 2_000_000;
const MAX_INLINED = 12_000_000;
const MAX_CSS = 400_000;
const MAX_COMPONENTS = 40;
const MAX_ASSETS = 80;
const MIME: Record<string, string> = {
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
};

// ── Built-in packs ─────────────────────────────────────────────────────────

/** Component classes every built-in pack shares, styled only through its tokens. */
const BASE_CSS = `
.ds-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid transparent;border-radius:var(--radius-control);font:500 15px/1 var(--font-body);cursor:pointer;white-space:nowrap;text-decoration:none}
.ds-button--md{height:40px;padding:0 18px}
.ds-button--sm{height:32px;padding:0 12px;font-size:13px}
.ds-button--lg{height:48px;padding:0 24px;font-size:16px}
.ds-button--primary{background:var(--accent);color:var(--on-accent)}
.ds-button--secondary{background:transparent;color:var(--text);border-color:var(--line)}
.ds-button--ghost{background:transparent;color:var(--text)}
.ds-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:20px;display:flex;flex-direction:column;gap:10px;color:var(--text)}
.ds-card__title{margin:0;font:600 17px/1.3 var(--font-display)}
.ds-tag{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px;border-radius:999px;font:500 12px/1 var(--font-body);background:color-mix(in oklch, var(--text) 8%, transparent);color:var(--text)}
.ds-tag--accent{background:color-mix(in oklch, var(--accent) 16%, transparent);color:var(--accent)}
.ds-field{display:flex;flex-direction:column;gap:6px;font:13px/1.3 var(--font-body);color:var(--muted)}
.ds-input{height:40px;padding:0 12px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--surface);color:var(--text);font:15px var(--font-body)}
`.trim();

const BUILTIN_COMPONENTS: DesignSystemPack["components"] = {
  Button: {
    summary: "An action: primary for the main one, secondary or ghost for the rest.",
    html: '<button class="ds-button ds-button--{{ variant }} ds-button--{{ size }}">{{ label }}<aegis-slot></aegis-slot></button>',
    props: {
      label: { type: "string", default: "" },
      variant: { type: "enum", options: ["primary", "secondary", "ghost"], default: "primary" },
      size: { type: "enum", options: ["sm", "md", "lg"], default: "md" },
    },
  },
  Card: {
    summary: "A surface grouping related content, with an optional title.",
    html: '<section class="ds-card"><h3 class="ds-card__title" data-aegis-if="title">{{ title }}</h3><aegis-slot></aegis-slot></section>',
    props: { title: { type: "string", default: "" } },
  },
  Tag: {
    summary: "A short status or category label.",
    html: '<span class="ds-tag ds-tag--{{ tone }}">{{ label }}<aegis-slot></aegis-slot></span>',
    props: { label: { type: "string", default: "" }, tone: { type: "enum", options: ["neutral", "accent"], default: "neutral" } },
  },
  Field: {
    summary: "A labelled text input.",
    html: '<label class="ds-field"><span>{{ label }}</span><input class="ds-input" placeholder="{{ placeholder }}" value="{{ value }}"></label>',
    props: { label: { type: "string", default: "Label" }, placeholder: { type: "string", default: "" }, value: { type: "string", default: "" } },
  },
};

/** Readable text on the accent: dark ink on light accents, white on dark ones. */
function onAccent(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#111111" : "#ffffff";
}

function builtinPack(style: BuiltinStyle): DesignSystemPack {
  const p = style.palette;
  const tokens = `:root{--background:${p.background};--surface:${p.surface};--text:${p.text};--muted:${p.muted};--accent:${p.accent};--on-accent:${onAccent(p.accent)};--line:${p.line};--font-display:${style.type.display};--font-body:${style.type.body};--radius:${style.shape.radius};--radius-control:${style.shape.control};--shadow:${style.shape.shadow}}`;
  const css = `${tokens}\n${BASE_CSS}`;
  return { id: style.id, name: style.name, css, components: BUILTIN_COMPONENTS, assets: {}, fonts: [], signature: hash(css) };
}

// ── Project packs ──────────────────────────────────────────────────────────

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function inside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return !!rel && !rel.startsWith("..") && !rel.includes(`..${sep}`) && !rel.startsWith(sep);
}

function readFileSmall(file: string, max = MAX_FILE): Buffer | null {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(file);
  } catch {
    return null;
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => !f.startsWith(".")).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Every file a pack reads, with its size and mtime: the cache key. */
function signatureOf(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3 || parts.length > 400) return;
    for (const f of list(d)) {
      const path = join(d, f);
      try {
        const st = statSync(path);
        if (st.isDirectory()) walk(path, depth + 1);
        else parts.push(`${relative(dir, path)}:${st.size}:${st.mtimeMs}`);
      } catch {}
    }
  };
  walk(dir, 0);
  return hash(parts.join("|"));
}

interface Inliner {
  budget: number;
  warnings: string[];
}
function dataUrl(file: string, inliner: Inliner): string | null {
  const mime = MIME[extname(file).toLowerCase()];
  if (!mime) return null;
  const bytes = readFileSmall(file);
  if (!bytes) {
    inliner.warnings.push(`${basename(file)} is missing or over ${MAX_FILE / 1_000_000} MB.`);
    return null;
  }
  if (inliner.budget - bytes.length < 0) {
    inliner.warnings.push(`${basename(file)} left out: the design system's fonts and images exceed ${MAX_INLINED / 1_000_000} MB.`);
    return null;
  }
  inliner.budget -= bytes.length;
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** styles.css with local @imports inlined and local url() files as data URLs. */
function readStyles(dir: string, file: string, inliner: Inliner, seen = new Set<string>()): string {
  if (seen.has(file) || seen.size > 20) return "";
  seen.add(file);
  const bytes = readFileSmall(file, MAX_CSS);
  if (!bytes) return "";
  let css = bytes.toString("utf8");
  css = css.replace(/@import\s+(?:url\()?\s*(['"])([^'"]+)\1\s*\)?[^;]*;/g, (all, _q, ref: string) => {
    if (/^[a-z]+:/i.test(ref)) return "";
    const target = normalize(join(dirname(file), ref));
    return inside(dir, target) ? readStyles(dir, target, inliner, seen) : "";
  });
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (all, _q, ref: string) => {
    if (/^(data|aegis-asset):/i.test(ref)) return all;
    if (/^[a-z]+:/i.test(ref) || ref.startsWith("//")) return "url()"; // remote: never loads in a board
    const target = normalize(join(dirname(file), ref.split(/[?#]/)[0]));
    if (!inside(dir, target)) return "url()";
    const url = dataUrl(target, inliner);
    return url ? `url("${url}")` : "url()";
  });
}

/** A component file in the board format: its template (with its own styles), logic and props. */
function readComponent(file: string): { html: string; logic: string | null; props: Record<string, unknown> | null } | null {
  const bytes = readFileSmall(file, 200_000);
  if (!bytes) return null;
  const clean = sanitizeDesignHtml(bytes.toString("utf8"));
  const logic = designLogicOf(clean);
  const props = designPropsOf(clean) as Record<string, unknown> | null;
  const styles = [...clean.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => `<style>${m[1]}</style>`).join("");
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(clean)?.[1] ?? "";
  const template = body.replace(/<script type="(?:text\/x-aegis-logic|application\/x-aegis-props)">[\s\S]*?<\/script>/g, "").trim();
  return { html: styles + template, logic, props };
}

export interface ProjectPackReport {
  pack: DesignSystemPack;
  warnings: string[];
}

function readProjectPack(root: string): ProjectPackReport | null {
  const dir = join(root, FOLDER);
  if (!existsSync(dir)) return null;
  const inliner: Inliner = { budget: MAX_INLINED, warnings: [] };
  const stylesFile = join(dir, "styles.css");
  const css = existsSync(stylesFile) ? readStyles(dir, stylesFile, inliner) : "";
  const components: DesignSystemPack["components"] = {};
  const componentsDir = join(dir, "components");
  for (const f of list(componentsDir).filter((f) => extname(f).toLowerCase() === ".html").slice(0, MAX_COMPONENTS)) {
    const name = basename(f, ".html");
    const c = readComponent(join(componentsDir, f));
    if (!c) {
      inliner.warnings.push(`components/${f} could not be read (over 200 KB?).`);
      continue;
    }
    const usage = readFileSmall(join(componentsDir, `${name}.md`), 120_000)?.toString("utf8");
    components[name] = { ...c, summary: summaryOf(usage) || undefined };
  }
  const assets: Record<string, string> = {};
  const assetsDir = join(dir, "assets");
  for (const f of list(assetsDir).filter((f) => MIME[extname(f).toLowerCase()]?.startsWith("image/")).slice(0, MAX_ASSETS)) {
    const url = dataUrl(join(assetsDir, f), inliner);
    if (url) assets[basename(f, extname(f))] = url;
  }
  if (!css.trim() && !Object.keys(components).length && !Object.keys(assets).length) return null;
  return {
    pack: { id: PROJECT_DESIGN_SYSTEM, name: "This project", css, components, assets, fonts: declaredFontFamilies(css), signature: signatureOf(dir) },
    warnings: inliner.warnings,
  };
}

const projectCache = new Map<string, { signature: string; report: ProjectPackReport | null }>();
/** The project's pack (cached until any of its files change), or null. */
export function projectDesignPack(root: string | null | undefined): ProjectPackReport | null {
  if (!root) return null;
  const dir = join(root, FOLDER);
  if (!existsSync(dir)) return null;
  const signature = signatureOf(dir);
  const hit = projectCache.get(root);
  if (hit?.signature === signature) return hit.report;
  const report = readProjectPack(root);
  projectCache.set(root, { signature, report });
  if (projectCache.size > 20) projectCache.delete(projectCache.keys().next().value as string);
  return report;
}

/**
 * The pack a design's boards load: its recorded system, else the project's
 * own when the project has one. Null renders boards as they are.
 */
export function designSystemPack(system: string | null | undefined, projectRoot: string | null | undefined): DesignSystemPack | null {
  if (system === NO_DESIGN_SYSTEM) return null;
  if (system && system !== PROJECT_DESIGN_SYSTEM) {
    const style = builtinDesignStyles().find((s) => s.id === system);
    return style ? builtinPack(style) : null;
  }
  return projectDesignPack(projectRoot)?.pack ?? null;
}
