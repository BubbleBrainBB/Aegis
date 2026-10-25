import { getDesignRepository, packForDesign } from "./service";
import { designStyleGuideFor, readDesignResource } from "./styles";
import { designSystemTokens, type DesignSystemPack } from "../../shared/design-system-pack";
import type { DesignDocument } from "../../shared/design-types";

/**
 * What the agent reads about the design system a design's boards load:
 * its guide, then what every board already has (stylesheet, tokens,
 * components with their props, assets and fonts), so the agent uses them
 * instead of re-creating them per board.
 */
const MAX_CSS_SHOWN = 24_000;

function designOf(sessionId: string, documentId?: string): DesignDocument | null {
  if (!documentId) return null;
  try {
    return getDesignRepository().read(sessionId, documentId);
  } catch {
    return null;
  }
}

/** Data URLs say nothing to the agent and cost a lot; show where they are. */
const elideData = (css: string) => css.replace(/url\(\s*(['"]?)data:[^)]*\1\s*\)/g, "url(…)");

function propsLine(props: Record<string, unknown> | null | undefined): string {
  if (!props) return "no props";
  const parts = Object.entries(props)
    .filter(([k]) => k !== "$preview")
    .map(([k, v]) => {
      const def = v as { type?: string; options?: unknown[]; default?: unknown };
      const kind = def.type === "enum" && Array.isArray(def.options) ? def.options.map(String).join("|") : def.type;
      return `${k}: ${kind}${def.default !== undefined && def.default !== "" ? ` = ${JSON.stringify(def.default)}` : ""}`;
    });
  return parts.length ? parts.join(", ") : "no props";
}

function example(name: string, props: Record<string, unknown> | null | undefined): string {
  const attrs = Object.entries(props ?? {})
    .filter(([k]) => k !== "$preview")
    .slice(0, 3)
    .map(([k, v]) => {
      const def = v as { type?: string; options?: unknown[] };
      const value = def.type === "enum" && Array.isArray(def.options) ? String(def.options[0]) : def.type === "string" ? "…" : null;
      return value === null ? null : `${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}="${value}"`;
    })
    .filter(Boolean);
  return `<aegis-use component="${name}"${attrs.length ? " " + attrs.join(" ") : ""}>…</aegis-use>`;
}

export function describePack(pack: DesignSystemPack): string {
  const tokens = designSystemTokens(pack.css);
  const components = Object.entries(pack.components);
  const assets = Object.keys(pack.assets);
  const lines = [`## Loaded on every board: ${pack.name}`, "Every board of this design loads this system's stylesheet before its own styles. Use its tokens and classes; don't redeclare them per board."];
  if (tokens.length) lines.push("", "Tokens:", ...tokens.slice(0, 80).map((t) => `- ${t.name}: ${t.value.length > 80 ? t.value.slice(0, 80) + "…" : t.value}`));
  if (pack.fonts.length) lines.push("", `Fonts it registers (use them by name in font-family): ${pack.fonts.join(", ")}.`);
  if (components.length)
    lines.push(
      "",
      "Components (design components; place one with <aegis-use component=\"Name\" prop=\"value\">children</aegis-use>, kebab-case attributes for props, data-aegis-bind-prop for values; read one with design_resources):",
      ...components.map(([name, c]) => `- ${name}: ${c.summary ? c.summary + " " : ""}Props: ${propsLine(c.props)}. e.g. ${example(name, c.props)}`),
    );
  if (assets.length) lines.push("", `Images (use as <img src="aegis-asset:name"> or url(aegis-asset:name)): ${assets.slice(0, 60).join(", ")}.`);
  if (pack.css.trim()) {
    const css = elideData(pack.css);
    lines.push("", "Stylesheet:", "```css", css.length > MAX_CSS_SHOWN ? css.slice(0, MAX_CSS_SHOWN) + "\n/* … truncated */" : css, "```");
  }
  return lines.join("\n");
}

/** design_guide's style section: the picked guide, plus what the design's boards load. */
export function designGuideStyle(sessionId: string, documentId?: string): { name: string; text: string } | null {
  const guide = designStyleGuideFor(sessionId, documentId);
  const d = designOf(sessionId, documentId);
  const pack = d ? packForDesign(d) : null;
  if (!pack) return guide;
  const text = [guide?.text, describePack(pack)].filter(Boolean).join("\n\n");
  return { name: guide?.name ?? pack.name, text };
}

/** design_resources: the design's system components (any system), and the project's templates. */
export function designResources(sessionId: string, documentId: string | undefined, kind?: string, name?: string): string {
  const d = designOf(sessionId, documentId);
  const pack = d ? packForDesign(d) : null;
  if (pack && kind === "component" && name) {
    const hit = Object.entries(pack.components).find(([n]) => n.toLowerCase() === name.toLowerCase());
    if (hit) {
      const [n, c] = hit;
      const usage = pack.id === "project" ? readDesignResource(sessionId, "component", n) : "";
      return [
        `# ${n}`,
        c.summary ?? "",
        `Use: ${example(n, c.props)}`,
        `Props: ${propsLine(c.props)}`,
        "## Template",
        c.html.trim(),
        c.logic ? `## Logic\n${c.logic.trim()}` : "",
        usage && !usage.startsWith("No component") ? `## Usage notes\n${usage}` : "",
      ].filter(Boolean).join("\n\n");
    }
  }
  const project = readDesignResource(sessionId, kind, name);
  if (!pack || kind) return project;
  return [describePack(pack), project.startsWith("This project has no design system") ? "" : project].filter(Boolean).join("\n\n");
}
