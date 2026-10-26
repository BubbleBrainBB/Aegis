import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { createHash } from "crypto";
import { basename, dirname, extname, join, normalize, relative, sep } from "path";
import { designLogicOf, designPropsOf } from "../../shared/design-component";
import { declaredFontFamilies, type DesignSystemPack } from "../../shared/design-system-pack";
import { sanitizeDesignHtml } from "./html";
import { summaryOf } from "./design-system";
import { builtinDesignStyles, PROJECT_DESIGN_SYSTEM, type BuiltinStyle } from "./styles";
import { BUILTIN_COMPONENT_CSS, builtinComponents } from "./builtin-components";
import { expandDesignIcons } from "./icons";
import { fontFaceRule, libraryFaces, libraryFamiliesIn } from "./font-library";

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
 * Built-in styles have packs too: their bundled fonts, tokens and the
 * built-in components (builtin-components.ts).
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

/** Readable text on the accent: dark ink on light accents, white on dark ones. */
function onAccent(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#111111" : "#ffffff";
}

const SEMANTIC = {
  light: { success: "#1f8a5b", warning: "#b26b00", danger: "#c4362b" },
  dark: { success: "#5cc48d", warning: "#e3a948", danger: "#ef7a6d" },
};

const builtinCache = new Map<string, DesignSystemPack>();
function builtinPack(style: BuiltinStyle): DesignSystemPack {
  const hit = builtinCache.get(style.id);
  if (hit) return hit;
  const p = style.palette;
  const semantic = style.dark ? SEMANTIC.dark : SEMANTIC.light;
  const raised = `color-mix(in oklch, ${p.surface} 92%, ${style.dark ? "#ffffff" : p.text})`;
  const faces = style.fonts.map(fontFaceRule).filter(Boolean);
  const families = [...new Set(style.fonts.map((f) => f.family))];
  const { components, complete } = builtinComponents();
  const tokens = `:root{--background:${p.background};--surface:${p.surface};--raised:${raised};--text:${p.text};--muted:${p.muted};--accent:${p.accent};--on-accent:${onAccent(p.accent)};--line:${p.line};--success:${semantic.success};--warning:${semantic.warning};--danger:${semantic.danger};--font-display:${style.type.display};--font-body:${style.type.body};--font-mono:${style.type.mono};--radius:${style.shape.radius};--radius-control:${style.shape.control};--shadow:${style.shape.shadow};--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:24px;--space-6:32px;--space-7:48px;--space-8:64px;--duration-fast:120ms;--duration-base:200ms;--duration-slow:320ms;--ease:cubic-bezier(.2,.7,.2,1);--focus-ring:0 0 0 2px var(--background),0 0 0 4px color-mix(in oklch, var(--accent) 70%, transparent)}`;
  const css = [
    `/* ${style.name}. Fonts: ${families.join(", ")} (SIL Open Font License 1.1). */`,
    ...faces,
    tokens,
    style.dark ? "html{color-scheme:dark}" : "",
    BUILTIN_COMPONENT_CSS,
  ].filter(Boolean).join("\n");
  const pack: DesignSystemPack = { id: style.id, name: style.name, css, components, assets: {}, fonts: families, signature: hash(complete ? css : `${css}\n/* no icons */`) };
  // Kept only when whole: a build missing fonts or icons tries again next time.
  if (complete && faces.length === style.fonts.length) builtinCache.set(style.id, pack);
  return pack;
}

// ── Project packs ──────────────────────────────────────────────────────────

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function inside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return !!rel && !rel.startsWith("..") && !rel.includes(`..${sep}`) && !rel.startsWith(sep);
}

/**
 * A regular file that really is inside the pack folder: no symlinks (a
 * cloned repo's design-system/assets/logo.png -> ~/.ssh/id_ed25519 must not
 * be inlined into boards) and nothing resolving outside it.
 */
function readFileSmall(file: string, max = MAX_FILE, root?: string): Buffer | null {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > max) return null;
    if (root && !inside(realpathSync(root), realpathSync(file))) return null;
    return readFileSync(file);
  } catch {
    return null;
  }
}

function list(dir: string): string[] {
  try {
    if (lstatSync(dir).isSymbolicLink()) return [];
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
function dataUrl(file: string, inliner: Inliner, root: string): string | null {
  const mime = MIME[extname(file).toLowerCase()];
  if (!mime) return null;
  const bytes = readFileSmall(file, MAX_FILE, root);
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
  const bytes = readFileSmall(file, MAX_CSS, dir);
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
    const url = dataUrl(target, inliner, dir);
    return url ? `url("${url}")` : "url()";
  });
}

/** A component file in the board format: its template (with its own styles), logic and props. */
function readComponent(file: string, root: string): { html: string; logic: string | null; props: Record<string, unknown> | null } | null {
  const bytes = readFileSmall(file, 200_000, root);
  if (!bytes) return null;
  const clean = sanitizeDesignHtml(expandDesignIcons(bytes.toString("utf8")));
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

function readProjectPack(root: string, signature: string): ProjectPackReport | null {
  const dir = join(root, FOLDER);
  if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) return null;
  const inliner: Inliner = { budget: MAX_INLINED, warnings: [] };
  const stylesFile = join(dir, "styles.css");
  const css = existsSync(stylesFile) ? readStyles(dir, stylesFile, inliner) : "";
  const components: DesignSystemPack["components"] = {};
  const componentsDir = join(dir, "components");
  for (const f of list(componentsDir).filter((f) => extname(f).toLowerCase() === ".html").slice(0, MAX_COMPONENTS)) {
    const name = basename(f, ".html");
    let c: ReturnType<typeof readComponent>;
    try {
      c = readComponent(join(componentsDir, f), dir);
    } catch (error) {
      inliner.warnings.push(`components/${f}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!c) {
      inliner.warnings.push(`components/${f} could not be read (over 200 KB?).`);
      continue;
    }
    const usage = readFileSmall(join(componentsDir, `${name}.md`), 120_000, dir)?.toString("utf8");
    components[name] = { ...c, summary: summaryOf(usage) || undefined };
  }
  const assets: Record<string, string> = {};
  const assetsDir = join(dir, "assets");
  for (const f of list(assetsDir).filter((f) => MIME[extname(f).toLowerCase()]?.startsWith("image/")).slice(0, MAX_ASSETS)) {
    const url = dataUrl(join(assetsDir, f), inliner, dir);
    if (url) assets[basename(f, extname(f))] = url;
  }
  if (!css.trim() && !Object.keys(components).length && !Object.keys(assets).length) return null;
  return {
    pack: { id: PROJECT_DESIGN_SYSTEM, name: "This project", css, components, assets, fonts: declaredFontFamilies(css), signature },
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
  const report = readProjectPack(root, signature);
  projectCache.set(root, { signature, report });
  if (projectCache.size > 20) projectCache.delete(projectCache.keys().next().value as string);
  return report;
}

/**
 * A design's pack with the font library's faces its boards name added, so
 * any board can use a bundled font whatever system it loads (or none).
 */
export function withLibraryFonts(pack: DesignSystemPack | null, boards: readonly { html: string }[] | undefined): DesignSystemPack | null {
  const have = new Set((pack?.fonts ?? []).map((f) => f.toLowerCase()));
  const used = libraryFamiliesIn((boards ?? []).map((b) => b.html)).filter((f) => !have.has(f.toLowerCase()));
  if (!used.length) return pack;
  const faces = used.flatMap(libraryFaces).map(fontFaceRule).filter(Boolean).join("\n");
  return {
    id: pack?.id ?? NO_DESIGN_SYSTEM,
    name: pack?.name ?? "",
    css: pack?.css ? `${faces}\n${pack.css}` : faces,
    components: pack?.components ?? {},
    assets: pack?.assets ?? {},
    fonts: [...(pack?.fonts ?? []), ...used],
    signature: `${pack?.signature ?? ""}+${used.join(",")}`,
  };
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
