import { mkdirSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { getDesignRepository } from "./service";
import { designProjectRoot } from "./styles";
import { readBoardTokens } from "../../shared/design-tokens";
import { randomUUID } from "crypto";
import { renderSystemFor } from "./service";
import { designFrameHtml } from "./html";
import { isDesignComponent, designLogicOf } from "../../shared/design-component";
import { designSystemTokens } from "../../shared/design-system-pack";

/**
 * Hands boards to the project for implementing: each chosen board's HTML and
 * a README (sizes, tokens, how to use them) under .aegis/design/<design>/.
 * The files are references for the agent that writes the real code; they are
 * not meant to be copied in as they are.
 */
export interface DesignHandoff {
  folder: string;
  files: string[];
  boards: { name: string; file: string; width: number; height: number }[];
}

export const slugOf = (text: string, fallback: string) =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || fallback;

export function handOffDesign(input: { sessionId: string; documentId: string; boardIds?: string[] }): DesignHandoff {
  const root = designProjectRoot(input.sessionId);
  if (!root) throw new Error("This conversation has no project folder to hand the design to.");
  const doc = getDesignRepository().read(input.sessionId, input.documentId);
  const chosen = input.boardIds?.length ? doc.boards.filter((b) => input.boardIds!.includes(b.id)) : doc.boards;
  if (!chosen.length) throw new Error("Choose at least one board.");
  const dir = join(root, ".aegis", "design", slugOf(doc.title, "design"));
  mkdirSync(dir, { recursive: true });
  const pack = renderSystemFor(doc);
  const extra: string[] = [];
  const used = new Set<string>();
  const boards = chosen.map((b, i) => {
    let file = `${slugOf(b.name, `board-${i + 1}`)}.html`;
    while (used.has(file)) file = file.replace(/(-\d+)?\.html$/, `-${used.size + 1}.html`);
    used.add(file);
    if (pack || isDesignComponent(b.html)) {
      // A page that renders as on the canvas (its system, components and logic), plus its source.
      writeFileSync(join(dir, file), designFrameHtml(b.html, randomUUID(), false, { mode: "play", system: pack }), "utf8");
      mkdirSync(join(dir, "source"), { recursive: true });
      writeFileSync(join(dir, "source", file), b.html, "utf8");
      extra.push(join("source", file));
    } else writeFileSync(join(dir, file), b.html, "utf8");
    return { name: b.name, file, width: b.width, height: b.height };
  });
  if (pack?.css) {
    writeFileSync(join(dir, "design-system.css"), pack.css, "utf8");
    extra.push("design-system.css");
  }
  // The design's images as files, for the implementing agent to copy into the project.
  const images = getDesignRepository().assetList(input.sessionId, doc.id).filter((a) => chosen.some((b) => b.html.includes(`aegis-asset:${a.id}`)));
  if (images.length) {
    mkdirSync(join(dir, "images"), { recursive: true });
    const data = getDesignRepository().assetData(input.sessionId, doc.id, images.map((a) => a.id));
    for (const a of images) {
      const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" }[a.mime] ?? "bin";
      writeFileSync(join(dir, "images", `${a.id}.${ext}`), Buffer.from(data[a.id].split(",")[1], "base64"));
      extra.push(join("images", `${a.id}.${ext}`));
    }
  }
  const usedComponents = pack
    ? Object.keys(pack.components).filter((name) => {
        const pattern = new RegExp(`<aegis-use\\b[^>]*component="${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
        return chosen.some((b) => pattern.test(b.html));
      })
    : [];
  const interactive = chosen.filter((b) => designLogicOf(b.html));
  const tokens = new Map<string, string>();
  for (const b of chosen) for (const t of readBoardTokens(b.html)) tokens.set(t.name, t.value);
  const readme = [
    `# ${doc.title}: design handoff`,
    "",
    `From Aegis design ${doc.id}, version ${doc.revision}. Read the latest with design_read if it has changed.`,
    "",
    "## Boards",
    extra.length
      ? "Each opens in a browser as it looks on the canvas; source/ has its design source (template markup, and any logic and props)."
      : "Each is a static HTML page; open it in a browser to see it.",
    ...boards.map((b) => `- ${b.name} (${b.width} × ${b.height}): ${b.file}`),
    "",
    ...(tokens.size ? ["## Tokens", ...[...tokens].map(([name, value]) => `- ${name}: ${value}`), ""] : []),
    ...(images.length
      ? ["## Images", `images/ holds the images the boards use (aegis-asset:<id> in source/ is images/<id>.*): ${images.map((a) => `${a.id} (${a.name}${a.width ? `, ${a.width} × ${a.height}` : ""})`).join(", ")}.`, ""]
      : []),
    ...(pack?.css
      ? [
          `## Design system: ${pack.name}`,
          "design-system.css is what every board loads (tokens, fonts, component classes).",
          ...designSystemTokens(pack.css).slice(0, 40).map((t) => `- ${t.name}: ${t.value.length > 80 ? t.value.slice(0, 80) + "…" : t.value}`),
          ...(usedComponents.length
            ? ["", `Components these boards use (<aegis-use component="…"> in source/): ${usedComponents.join(", ")}. Map each to the project's own component of that role.`]
            : []),
          "",
        ]
      : []),
    ...(interactive.length
      ? [
          "## Interactions",
          `${interactive.map((b) => b.name).join(", ")} ${interactive.length === 1 ? "has" : "have"} logic: <script type="text/x-aegis-logic"> in source/ (state and handlers), wired with data-aegis-on-* attributes, {{ }} values and data-aegis-if / data-aegis-for. Implement the same behaviour with the project's state and events.`,
          "",
        ]
      : []),
    "## Implementing",
    "- Build these screens with the project's own components, styles and tokens; the HTML is a reference for layout, type, spacing and copy, not code to paste in.",
    "- Match the layout and hierarchy; where the project already has a pattern for something, use it.",
    ...(chosen.some((b) => b.html.includes("data-aegis-starter"))
      ? ['- Elements marked data-aegis-starter="frame" or "chrome" are a presentation frame (device bezel, status bar, browser or window chrome): build only what is inside data-aegis-starter="content".']
      : []),
    "- Ask before adding a dependency.",
    "",
  ].join("\n");
  writeFileSync(join(dir, "README.md"), readme, "utf8");
  const folder = relative(root, dir);
  return { folder, files: [join(folder, "README.md"), ...boards.map((b) => join(folder, b.file)), ...extra.map((f) => join(folder, f))], boards };
}
