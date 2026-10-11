import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { getDesignComposerPrefs, setDesignStyleNamer } from "./focus";
import type { DesignStyleSummary } from "../../shared/design-types";

/**
 * Style guides the user can pick for a design: a few built in, and the
 * project's own DESIGN.md. The picked guide reaches the agent through
 * design_guide; <design_context> names it.
 */
interface BuiltinStyle {
  id: string;
  name: string;
  description: string;
  featured?: boolean;
  palette: { background: string; surface: string; text: string; muted: string; accent: string; line: string };
  type: { display: string; body: string };
  rules: string[];
}

const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", system-ui, sans-serif';
const SERIF = '"New York", Georgia, "Songti SC", "Noto Serif SC", serif';
const MONO = '"SF Mono", ui-monospace, Menlo, Consolas, monospace';

const BUILTIN: BuiltinStyle[] = [
  {
    id: "warm-paper",
    name: "Warm Paper",
    description: "Off-white paper, dark green ink, a serif headline. Calm and literary.",
    featured: true,
    palette: { background: "#f6f2ea", surface: "#fbf9f4", text: "#23302a", muted: "#667565", accent: "#7a5c3e", line: "#e3ddd0" },
    type: { display: SERIF, body: SANS },
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
    type: { display: SANS, body: SANS },
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
    description: "Deep green-black with sage highlights. A dark theme with warmth.",
    featured: true,
    palette: { background: "#1d2a24", surface: "#24342d", text: "#e9efe8", muted: "#a7b8ad", accent: "#7fb38f", line: "#33463d" },
    type: { display: SERIF, body: SANS },
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
    type: { display: SANS, body: SANS },
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
    type: { display: SERIF, body: SANS },
    rules: [
      "No color: hierarchy comes from size, weight and space alone.",
      `Captions, labels and data in a monospaced face (${MONO}) at 11–12px, uppercase with letter-spacing.`,
      "A visible column grid; hairline rules between sections; square corners.",
      "Images in black and white or line illustrations.",
    ],
  },
  {
    id: "lavender-haze",
    name: "Lavender Haze",
    description: "Pale lilac surfaces and a violet accent. Soft and modern.",
    palette: { background: "#f4f1fb", surface: "#ffffff", text: "#2b2540", muted: "#706a86", accent: "#8a6fd8", line: "#e4def5" },
    type: { display: SANS, body: SANS },
    rules: [
      "Sans with a medium-weight display (500–600); body at 15px with comfortable line-height.",
      "White panels on the lilac background, 16px radius, the faintest violet-tinted shadow.",
      "Violet for primary actions and selected states; secondary actions in muted text.",
      "Illustrations as simple flat shapes in tints of the accent.",
    ],
  },
];

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
    "}",
    "```",
    "",
    "## Rules",
    ...style.rules.map((rule) => `- ${rule}`),
  ].join("\n");
}

/** The project a session works in, for its DESIGN.md (set by the host). */
let projectRoot: (sessionId: string) => string | null | undefined = () => undefined;
export function setDesignProjectRoot(resolve: (sessionId: string) => string | null | undefined) {
  projectRoot = resolve;
}

const PROJECT_STYLE_ID = "project";
const MAX_PROJECT_GUIDE = 40_000;

function projectGuide(sessionId: string, cwdHint?: string): { path: string; text: string } | null {
  const root = projectRoot(sessionId) || cwdHint;
  if (!root) return null;
  for (const name of ["DESIGN.md", "design.md", "docs/DESIGN.md"]) {
    const path = join(root, name);
    try {
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      return { path, text: readFileSync(path, "utf8").slice(0, MAX_PROJECT_GUIDE) };
    } catch {
      continue;
    }
  }
  return null;
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
    serif: s.type.display === SERIF,
  }));
  const own = projectGuide(sessionId, cwdHint);
  if (own) {
    const firstLine = own.text.split("\n").find((line) => line.trim() && !line.startsWith("#"))?.trim() ?? "";
    styles.push({
      id: PROJECT_STYLE_ID,
      name: "This project",
      description: firstLine.slice(0, 160) || "The project's DESIGN.md.",
      source: "project",
      featured: false,
      palette: [],
      serif: false,
    });
  }
  return styles;
}

/** The style guide picked for a session's designs, handed to the agent by design_guide. */
export function designStyleGuideFor(sessionId: string, _documentId?: string): { name: string; text: string } | null {
  const styleId = getDesignComposerPrefs(sessionId).styleId;
  if (!styleId) return null;
  if (styleId === PROJECT_STYLE_ID) {
    const own = projectGuide(sessionId);
    return own ? { name: "This project's DESIGN.md", text: own.text } : null;
  }
  const style = BUILTIN.find((s) => s.id === styleId);
  return style ? { name: style.name, text: builtinGuide(style) } : null;
}

setDesignStyleNamer((styleId) =>
  styleId === PROJECT_STYLE_ID ? "This project's DESIGN.md" : BUILTIN.find((s) => s.id === styleId)?.name,
);
