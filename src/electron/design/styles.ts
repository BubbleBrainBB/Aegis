import { getDesignComposerPrefs, setDesignStyleResolver, setDesignTemplateNamer } from "./focus";
import { designSystemIndex, readProjectDesignSystem, summaryOf, type ProjectDesignSystem } from "./design-system";
import { sanitizeDesignHtml } from "./html";
import type { DesignStyleSummary } from "../../shared/design-types";

/**
 * Style guides the user can pick for a design: a few built in, and the
 * project's own design system (design-system/ or DESIGN.md), which applies
 * by default when the project has one. The picked guide reaches the agent through
 * design_guide; <design_context> names it.
 */
interface BuiltinStyle {
  id: string;
  name: string;
  description: string;
  featured?: boolean;
  palette: { background: string; surface: string; text: string; muted: string; accent: string; line: string };
  /** Font stacks: a bundled face first (see fonts), then system fallbacks with CJK. */
  type: { display: string; body: string; mono: string };
  /** Bundled OFL faces (src/electron/design/fonts) the style's pack registers. */
  fonts: FontFace[];
  serif: boolean;
  dark?: boolean;
  /** Corner radii and elevation its components use (from its rules). */
  shape: { radius: string; control: string; shadow: string };
  rules: string[];
  /** How its copy reads: tone and casing. */
  voice: string;
  /** What images and illustrations suit it. */
  imagery: string;
}

interface FontFace {
  family: string;
  file: string;
  weight: string;
  style?: "italic";
}

const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", system-ui, sans-serif';
const SERIF = '"New York", Georgia, "Songti SC", "Noto Serif SC", serif';
const MONO = '"SF Mono", ui-monospace, Menlo, Consolas, monospace';

/** The bundled faces, by family (variable weights where the family has them). */
const FACES: Record<string, FontFace[]> = {
  Newsreader: [
    { family: "Newsreader", file: "newsreader-latin-wght-normal.woff2", weight: "200 800" },
    { family: "Newsreader", file: "newsreader-latin-wght-italic.woff2", weight: "200 800", style: "italic" },
  ],
  "Source Sans 3": [{ family: "Source Sans 3", file: "source-sans-3-latin-wght-normal.woff2", weight: "200 900" }],
  Geist: [{ family: "Geist", file: "geist-latin-wght-normal.woff2", weight: "100 900" }],
  "Geist Mono": [{ family: "Geist Mono", file: "geist-mono-latin-wght-normal.woff2", weight: "100 900" }],
  Fraunces: [{ family: "Fraunces", file: "fraunces-latin-wght-normal.woff2", weight: "100 900" }],
  Figtree: [{ family: "Figtree", file: "figtree-latin-wght-normal.woff2", weight: "300 900" }],
  "Bricolage Grotesque": [{ family: "Bricolage Grotesque", file: "bricolage-grotesque-latin-wght-normal.woff2", weight: "200 800" }],
  "Instrument Serif": [
    { family: "Instrument Serif", file: "instrument-serif-latin-400-normal.woff2", weight: "400" },
    { family: "Instrument Serif", file: "instrument-serif-latin-400-italic.woff2", weight: "400", style: "italic" },
  ],
  "JetBrains Mono": [{ family: "JetBrains Mono", file: "jetbrains-mono-latin-wght-normal.woff2", weight: "100 800" }],
  Manrope: [{ family: "Manrope", file: "manrope-latin-wght-normal.woff2", weight: "200 800" }],
};

/** A style's type: bundled families first, each falling back to a system stack. */
function typeOf(display: string, body: string, mono = "Geist Mono"): Pick<BuiltinStyle, "type" | "fonts" | "serif"> {
  const serif = ["Newsreader", "Fraunces", "Instrument Serif"].includes(display);
  const stack = (family: string, fallback: string) => `"${family}", ${fallback}`;
  const families = [...new Set([display, body, mono])];
  return {
    type: { display: stack(display, serif ? SERIF : SANS), body: stack(body, SANS), mono: stack(mono, MONO) },
    fonts: families.flatMap((f) => FACES[f] ?? []),
    serif,
  };
}

const BUILTIN: BuiltinStyle[] = [
  {
    id: "warm-paper",
    name: "Warm Paper",
    description: "Off-white paper, dark green ink, a serif headline. Calm and literary.",
    featured: true,
    palette: { background: "#f6f2ea", surface: "#fbf9f4", text: "#23302a", muted: "#667565", accent: "#7a5c3e", line: "#e3ddd0" },
    ...typeOf("Newsreader", "Source Sans 3"),
    shape: { radius: "6px", control: "999px", shadow: "none" },
    voice: "Calm and literate: full sentences, sentence case, no exclamation marks; headlines read like a book title.",
    imagery: "Natural light, paper, hands and objects; muted, slightly warm photos or fine line drawings. No glossy 3D or stock smiles.",
    rules: [
      "Large serif headlines (48–72px on desktop) at weight 400 with tight line-height; sans body text at 15–17px.",
      "Generous whitespace; sections separated by space or a hairline in the line color, not boxes.",
      "Buttons are pill-shaped in the text color with background-colored text; secondary buttons are outlined.",
      "Use the accent sparingly: one highlight, a link underline, a small label.",
    ],
  },
  {
    id: "quiet-slate",
    name: "Quiet Slate",
    description: "Cool grey surfaces, slate ink and one indigo accent. Product UI that stays out of the way.",
    featured: true,
    palette: { background: "#eff1f4", surface: "#ffffff", text: "#2f3244", muted: "#6a6f85", accent: "#4f5bd5", line: "#e1e3ea" },
    ...typeOf("Geist", "Geist"),
    shape: { radius: "12px", control: "8px", shadow: "0 1px 2px rgba(31, 35, 50, 0.06)" },
    voice: "Plain and exact: short labels in sentence case, verbs on buttons, numbers with units; nothing clever.",
    imagery: "Product screenshots and simple diagrams; icons in the line style at one size. Photos only where a person or place is the point.",
    rules: [
      "Sans throughout; a restrained scale (28 / 20 / 15 / 13px) with weights 600 and 400.",
      "White cards on the grey background with a 1px line border and 10–12px radius; no heavy shadows.",
      "Primary actions in the accent; everything else neutral. Status colors only for status.",
      "Dense but aligned: an 8px spacing grid, consistent label/value columns, tabular numbers.",
    ],
  },
  {
    id: "forest-night",
    name: "Forest Night",
    dark: true,
    description: "Deep green-black with sage highlights. A dark theme with warmth.",
    featured: true,
    palette: { background: "#1d2a24", surface: "#24342d", text: "#e9efe8", muted: "#a7b8ad", accent: "#7fb38f", line: "#33463d" },
    ...typeOf("Fraunces", "Figtree"),
    shape: { radius: "10px", control: "8px", shadow: "none" },
    voice: "Warm and assured: short sentences, sentence case, a little poetry in headlines but plain labels.",
    imagery: "Nature at dusk, desaturated greens and warm lamplight; never neon or high-saturation stock.",
    rules: [
      "Dark surfaces stepped by lightness (background, then surface), never pure black.",
      "Text in the light ink at 90% for body; muted for secondary. Keep contrast at least 4.5:1.",
      "The sage accent marks the primary action and active states; no glows or gradients.",
      "Imagery and illustrations in desaturated tones so the accent stays the brightest thing.",
    ],
  },
  {
    id: "citrus-pop",
    name: "Citrus Pop",
    description: "Cream, near-black and a bright orange. Friendly and energetic.",
    palette: { background: "#fff8ec", surface: "#ffffff", text: "#2a2118", muted: "#7b6a58", accent: "#f07a28", line: "#f0e2cc" },
    ...typeOf("Bricolage Grotesque", "Figtree"),
    shape: { radius: "18px", control: "14px", shadow: "none" },
    voice: "Upbeat and direct: short punchy lines, sentence case, numbers and prices up front; one playful line per section at most.",
    imagery: "Bright, sunlit product and lifestyle shots on plain backgrounds, or bold flat shapes in the accent; cut-outs work well.",
    rules: [
      "Bold sans headlines (weight 700, slightly tight tracking) with plain body text.",
      "Orange for the main call to action and one decorative shape per section at most.",
      "Rounded corners (14–20px) and soft tinted fills instead of borders.",
      "Short, upbeat copy; numbers and prices set large.",
    ],
  },
  {
    id: "editorial-mono",
    name: "Editorial Mono",
    description: "Black on white with a monospaced utility face. Typographic and strict.",
    palette: { background: "#ffffff", surface: "#ffffff", text: "#111111", muted: "#6b6b6b", accent: "#111111", line: "#dddddd" },
    ...typeOf("Instrument Serif", "Geist", "JetBrains Mono"),
    shape: { radius: "0px", control: "0px", shadow: "none" },
    voice: "Terse and editorial: headlines as statements, labels in uppercase mono, no marketing adjectives.",
    imagery: "Black-and-white photography with strong contrast, or line illustration; captions under every image.",
    rules: [
      "No color: hierarchy comes from size, weight and space alone.",
      "Captions, labels and data in the mono face (var(--font-mono)) at 11–12px, uppercase with letter-spacing.",
      "A visible column grid; hairline rules between sections; square corners.",
      "Images in black and white or line illustrations.",
    ],
  },
  {
    id: "lavender-haze",
    name: "Lavender Haze",
    description: "Pale lilac surfaces and a violet accent. Soft and modern.",
    palette: { background: "#f4f1fb", surface: "#ffffff", text: "#2b2540", muted: "#706a86", accent: "#8a6fd8", line: "#e4def5" },
    ...typeOf("Manrope", "Manrope"),
    shape: { radius: "16px", control: "12px", shadow: "0 6px 20px rgba(138, 111, 216, 0.10)" },
    voice: "Friendly and reassuring: second person, sentence case, gentle verbs (\"Get started\", \"Take a look\").",
    imagery: "Soft gradients of the accent, rounded flat illustration, people in calm settings; pastel, never harsh.",
    rules: [
      "Sans with a medium-weight display (500–600); body at 15px with comfortable line-height.",
      "White panels on the lilac background, 16px radius, the faintest violet-tinted shadow.",
      "Violet for primary actions and selected states; secondary actions in muted text.",
      "Illustrations as simple flat shapes in tints of the accent.",
    ],
  },
  {
    id: "swiss-grid",
    name: "Swiss Grid",
    description: "White, black and a signal red on a strict grid. Confident and information-first.",
    palette: { background: "#ffffff", surface: "#f5f5f4", text: "#141414", muted: "#5f5f5c", accent: "#e1251b", line: "#e2e2df" },
    ...typeOf("Geist", "Geist"),
    shape: { radius: "4px", control: "4px", shadow: "none" },
    voice: "Factual and declarative: short noun phrases, sentence case, numbers wherever possible; no adjectives that a number could replace.",
    imagery: "Cropped, high-contrast photography placed on the grid, or pure typography; no illustration.",
    rules: [
      "A 12-column grid with strong left alignment; flush-left, ragged-right text; no centred blocks except a single hero line.",
      "Huge, heavy display type (weight 700–800, tracking -0.03em) against small body text: two or three sizes, far apart.",
      "Red only for the one thing that must be seen first; everything else black, white and grey.",
      "Thick rules (2–4px, text color) to mark sections; numbers and labels in the mono face.",
    ],
  },
  {
    id: "midnight-ink",
    name: "Midnight Ink",
    description: "Ink-blue darkness with an electric blue accent. A developer tool or night-mode product.",
    dark: true,
    palette: { background: "#0e1220", surface: "#161b2e", text: "#e6e9f2", muted: "#9097ad", accent: "#6d8bff", line: "#262d45" },
    ...typeOf("Geist", "Geist"),
    shape: { radius: "12px", control: "8px", shadow: "0 1px 0 rgba(255, 255, 255, 0.04) inset" },
    voice: "Technical and confident: precise terms, sentence case, code and keys in the mono face; no hype.",
    imagery: "Product UI, terminals and diagrams; abstract imagery only as a subtle background texture.",
    rules: [
      "Surfaces step up in lightness (background, surface, then a raised panel at 4% more); borders are hairlines in the line color.",
      "Code, keys and figures in the mono face; body in the sans at 14–15px.",
      "The blue accent marks primary actions, focus rings and selected rows; status colors stay muted until something is wrong.",
      "No neon glows; a single soft gradient is allowed in a hero background at most.",
    ],
  },
  {
    id: "terracotta",
    name: "Terracotta",
    description: "Sand, clay and a soft serif. Earthy, warm and hospitable.",
    palette: { background: "#f5eee6", surface: "#fbf7f2", text: "#3a2a22", muted: "#80695c", accent: "#c0573a", line: "#e8dccf" },
    ...typeOf("Fraunces", "Manrope"),
    shape: { radius: "14px", control: "999px", shadow: "0 10px 30px rgba(120, 72, 44, 0.08)" },
    voice: "Warm and welcoming: hospitable, sensory words, sentence case, unhurried sentences.",
    imagery: "Sunlit food, interiors, craft and travel; warm earthy tones, film grain welcome.",
    rules: [
      "Soft serif headlines (weight 400–500, optical size large) with relaxed sans body at 16px and line-height 1.6.",
      "Rounded cards on sand with a warm, wide, faint shadow; pill buttons.",
      "Clay accent for actions and highlights; illustrations and photos in warm, sunlit tones.",
      "Plenty of air: sections at least 96px apart on desktop.",
    ],
  },
  {
    id: "mint-fresh",
    name: "Mint Fresh",
    description: "Clean white, cool mint and a deep teal. Health, finance or anything that should feel trustworthy.",
    palette: { background: "#f6faf8", surface: "#ffffff", text: "#13302a", muted: "#5b736c", accent: "#0f7b67", line: "#dcebe5" },
    ...typeOf("Figtree", "Figtree"),
    shape: { radius: "14px", control: "10px", shadow: "0 1px 3px rgba(19, 48, 42, 0.06)" },
    voice: "Clear and trustworthy: plain words, sentence case, figures with units and context; reassure without exclaiming.",
    imagery: "Clean product shots, simple charts and friendly people; a cool, bright palette with lots of white.",
    rules: [
      "Friendly geometric sans at weight 600 for headings, 400 for body; numbers set large with tabular figures.",
      "White cards on a near-white mint page; the accent's 10% tint for highlighted rows and chips.",
      "Teal for primary actions and positive values; one warm color (the warning token) for attention.",
      "Charts in tints of the accent; never more than three series colors.",
    ],
  },
];

/** The built-in styles (their packs come from system-pack.ts). */
export function builtinDesignStyles(): readonly BuiltinStyle[] {
  return BUILTIN;
}
export type { BuiltinStyle };
export const PROJECT_DESIGN_SYSTEM = "project";

function builtinGuide(style: BuiltinStyle): string {
  const p = style.palette;
  return [
    `# ${style.name}`,
    style.description,
    "",
    "## Tokens",
    "```css",
    ":root {",
    `  --background: ${p.background};`,
    `  --surface: ${p.surface};`,
    `  --text: ${p.text};`,
    `  --muted: ${p.muted};`,
    `  --accent: ${p.accent};`,
    `  --line: ${p.line};`,
    `  --font-display: ${style.type.display};`,
    `  --font-body: ${style.type.body};`,
    `  --font-mono: ${style.type.mono};`,
    `  --radius: ${style.shape.radius}; --radius-control: ${style.shape.control}; --shadow: ${style.shape.shadow};`,
    "  --success, --warning, --danger: semantic colors; --raised: a surface one step up; --on-accent: text on the accent;",
    "  --space-1 … --space-8: 4, 8, 12, 16, 24, 32, 48, 64px; --duration-fast/base/slow: 120/200/320ms; --ease;",
    "}",
    "```",
    `Its fonts (${[...new Set(style.fonts.map((f) => f.family))].join(", ")}) are bundled and registered on every board: use the font tokens, never a remote font.`,
    "",
    "## Rules",
    ...style.rules.map((rule) => `- ${rule}`),
    "",
    "## Voice",
    style.voice,
    "",
    "## Imagery",
    style.imagery,
  ].join("\n");
}

/** The project a session works in, for its DESIGN.md (set by the host). */
let projectRoot: (sessionId: string) => string | null | undefined = () => undefined;
export function setDesignProjectRoot(resolve: (sessionId: string) => string | null | undefined) {
  projectRoot = resolve;
}

const PROJECT_STYLE_ID = "project";
const MAX_PROJECT_GUIDE = 40_000;

/** The project folder a session works in, if it has one. */
export function designProjectRoot(sessionId: string): string | null {
  return projectRoot(sessionId) || null;
}

/** The project's design system for a session (its folder, or a DESIGN.md). */
function projectSystem(sessionId: string, cwdHint?: string): ProjectDesignSystem | null {
  return readProjectDesignSystem(projectRoot(sessionId) || cwdHint);
}

/** The styles to offer in a session: built in, then the project's own. */
export function listDesignStyles(sessionId: string, cwdHint?: string): DesignStyleSummary[] {
  const styles: DesignStyleSummary[] = BUILTIN.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    source: "builtin",
    featured: !!s.featured,
    palette: [s.palette.background, s.palette.text, s.palette.accent, s.palette.line],
    serif: s.serif,
  }));
  const own = projectSystem(sessionId, cwdHint);
  if (own) {
    const counts = [
      own.components.length ? `${own.components.length} component${own.components.length === 1 ? "" : "s"}` : "",
      own.templates.length ? `${own.templates.length} template${own.templates.length === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    styles.push({
      id: PROJECT_STYLE_ID,
      name: "This project",
      description: [summaryOf(own.guide) || "The project's own design system.", counts.join(" · ")].filter(Boolean).join(" "),
      source: "project",
      featured: true,
      palette: [],
      serif: false,
    });
  }
  return styles;
}

/** The project's templates, to show and pick (HTML sanitized like any board). */
export function listProjectTemplates(sessionId: string, cwdHint?: string): { id: string; name: string; summary: string; html: string }[] {
  return (projectSystem(sessionId, cwdHint)?.templates ?? []).map((t) => ({ ...t, html: sanitizeDesignHtml(t.html) }));
}

/**
 * The style guide in effect: the one the user picked, else the project's own
 * design system when it has one (a project's system applies by default).
 */
export function effectiveDesignStyle(sessionId: string): { id: string; name: string } | null {
  const picked = getDesignComposerPrefs(sessionId).styleId;
  if (picked) {
    if (picked === PROJECT_STYLE_ID) return projectSystem(sessionId) ? { id: picked, name: "This project's design system" } : null;
    const style = BUILTIN.find((s) => s.id === picked);
    return style ? { id: style.id, name: style.name } : null;
  }
  return projectSystem(sessionId) ? { id: PROJECT_STYLE_ID, name: "This project's design system" } : null;
}

/** One component or template from the project's design system, for the agent. */
export function readDesignResource(sessionId: string, kind?: string, name?: string): string {
  const own = projectSystem(sessionId);
  if (!own) return "This project has no design system (no design-system/ folder or DESIGN.md).";
  if (!kind || !name) return designSystemIndex(own) + (own.guide ? "\n\nThe guide itself comes with design_guide." : "");
  if (kind === "component") {
    const c = own.components.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!c) return `No component named ${JSON.stringify(name)}. ${designSystemIndex(own)}`;
    return [`# ${c.name}`, c.usage.trim(), c.html ? `## Reference markup\n${c.html.trim()}` : ""].filter(Boolean).join("\n\n");
  }
  if (kind === "template") {
    const t = own.templates.find((x) => x.id.toLowerCase() === name.toLowerCase());
    if (!t) return `No template named ${JSON.stringify(name)}. ${designSystemIndex(own)}`;
    return `# Template: ${t.name}\n${t.summary}\n\nBuild from its structure, sizes and components; replace its sample copy with the task's content.\n\n${t.html.trim()}`;
  }
  return `Unknown kind ${JSON.stringify(kind)}: use "component" or "template".`;
}

/** The style guide picked for a session's designs, handed to the agent by design_guide. */
export function designStyleGuideFor(sessionId: string, _documentId?: string): { name: string; text: string } | null {
  const style = effectiveDesignStyle(sessionId);
  if (!style) return null;
  if (style.id === PROJECT_STYLE_ID) {
    const own = projectSystem(sessionId);
    if (!own) return null;
    return { name: style.name, text: [own.guide?.slice(0, MAX_PROJECT_GUIDE).trim(), designSystemIndex(own)].filter(Boolean).join("\n\n") };
  }
  const builtin = BUILTIN.find((s) => s.id === style.id);
  return builtin ? { name: builtin.name, text: builtinGuide(builtin) } : null;
}

/** A template picked in the composer, by id, when the project still has it. */
export function designTemplateName(sessionId: string, templateId: string): string | undefined {
  return projectSystem(sessionId)?.templates.find((t) => t.id === templateId)?.name;
}

setDesignStyleResolver((sessionId) => effectiveDesignStyle(sessionId)?.name);
setDesignTemplateNamer(designTemplateName);
