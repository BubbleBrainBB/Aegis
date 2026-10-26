import { readFileSync } from "fs";
import { join } from "path";

/**
 * The design canvas's font library: OFL faces bundled with the app
 * (src/electron/design/fonts), usable on any board by family name whether
 * or not the design loads a built-in style. Remote fonts never load in a
 * board, so these are the ones beyond the system's own.
 */
export interface FontFace {
  family: string;
  file: string;
  weight: string;
  style?: "italic";
}

export interface LibraryFont {
  family: string;
  /** What it is and where it reads well, for the agent. */
  note: string;
  faces: FontFace[];
}

const face = (family: string, file: string, weight: string, style?: "italic"): FontFace => ({ family, file, weight, ...(style ? { style } : {}) });

export const FONT_LIBRARY: LibraryFont[] = [
  { family: "Newsreader", note: "Text serif with real italics; literary, editorial headlines and long reading. 200–800.", faces: [face("Newsreader", "newsreader-latin-wght-normal.woff2", "200 800"), face("Newsreader", "newsreader-latin-wght-italic.woff2", "200 800", "italic")] },
  { family: "Fraunces", note: "Soft, characterful display serif; warm brands, food, hospitality. 100–900.", faces: [face("Fraunces", "fraunces-latin-wght-normal.woff2", "100 900")] },
  { family: "Instrument Serif", note: "Condensed high-contrast display serif; fashion, editorial covers. 400 and italic only, for large sizes.", faces: [face("Instrument Serif", "instrument-serif-latin-400-normal.woff2", "400"), face("Instrument Serif", "instrument-serif-latin-400-italic.woff2", "400", "italic")] },
  { family: "Geist", note: "Neutral, precise grotesque; product UI, developer tools, dashboards. 100–900.", faces: [face("Geist", "geist-latin-wght-normal.woff2", "100 900")] },
  { family: "Figtree", note: "Friendly geometric sans; consumer apps, health, finance. 300–900.", faces: [face("Figtree", "figtree-latin-wght-normal.woff2", "300 900")] },
  { family: "Manrope", note: "Modern rounded-geometric sans; calm SaaS and mobile. 200–800.", faces: [face("Manrope", "manrope-latin-wght-normal.woff2", "200 800")] },
  { family: "Source Sans 3", note: "Humanist sans; long UI text and documents, pairs with serifs. 200–900.", faces: [face("Source Sans 3", "source-sans-3-latin-wght-normal.woff2", "200 900")] },
  { family: "Bricolage Grotesque", note: "Quirky display grotesque with optical character; bold, playful brands. 200–800.", faces: [face("Bricolage Grotesque", "bricolage-grotesque-latin-wght-normal.woff2", "200 800")] },
  { family: "Geist Mono", note: "Clean monospace; labels, figures, code. 100–900.", faces: [face("Geist Mono", "geist-mono-latin-wght-normal.woff2", "100 900")] },
  { family: "JetBrains Mono", note: "Sturdy coding monospace; terminals, technical captions. 100–800.", faces: [face("JetBrains Mono", "jetbrains-mono-latin-wght-normal.woff2", "100 800")] },
];

export function libraryFaces(family: string): FontFace[] {
  return FONT_LIBRARY.find((f) => f.family === family)?.faces ?? [];
}

const ruleCache = new Map<string, string>();
/** A face as an @font-face rule with its file inlined, or "" when the file is missing. */
export function fontFaceRule(f: FontFace): string {
  const key = `${f.file}`;
  let rule = ruleCache.get(key);
  if (rule === undefined) {
    try {
      const url = `data:font/woff2;base64,${readFileSync(join(__dirname, "fonts", f.file)).toString("base64")}`;
      rule = `@font-face{font-family:"${f.family}";src:url("${url}") format("woff2");font-weight:${f.weight};font-style:${f.style ?? "normal"};font-display:swap}`;
      ruleCache.set(key, rule);
    } catch {
      return "";
    }
  }
  return rule;
}

// Longest names first, so "Geist Mono" is taken before "Geist" is looked for.
const BY_LENGTH = [...FONT_LIBRARY].sort((a, b) => b.family.length - a.family.length);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERNS = BY_LENGTH.map((f) => [f.family, new RegExp(`(["']?)\\b${escape(f.family)}\\b\\1`, "gi")] as const);

/** The library families a board's CSS names (in font-family, font or custom properties). */
export function libraryFamiliesIn(htmls: readonly string[]): string[] {
  const used = new Set<string>();
  for (const html of htmls) {
    if (!html) continue;
    let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>|\sstyle="([^"]*)"|\sstyle='([^']*)'/gi)].map((m) => m[1] ?? m[2] ?? m[3] ?? "").join("\n");
    for (const [family, pattern] of PATTERNS) {
      if (!pattern.test(css)) continue;
      used.add(family);
      css = css.replace(pattern, "");
      pattern.lastIndex = 0;
    }
  }
  return FONT_LIBRARY.map((f) => f.family).filter((f) => used.has(f));
}
