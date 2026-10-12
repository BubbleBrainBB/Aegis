import { mkdirSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { getDesignRepository } from "./service";
import { designProjectRoot } from "./styles";
import { readBoardTokens } from "../../shared/design-tokens";

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
  const used = new Set<string>();
  const boards = chosen.map((b, i) => {
    let file = `${slugOf(b.name, `board-${i + 1}`)}.html`;
    while (used.has(file)) file = file.replace(/(-\d+)?\.html$/, `-${used.size + 1}.html`);
    used.add(file);
    writeFileSync(join(dir, file), b.html, "utf8");
    return { name: b.name, file, width: b.width, height: b.height };
  });
  const tokens = new Map<string, string>();
  for (const b of chosen) for (const t of readBoardTokens(b.html)) tokens.set(t.name, t.value);
  const readme = [
    `# ${doc.title}: design handoff`,
    "",
    `From Aegis design ${doc.id}, version ${doc.revision}. Read the latest with design_read if it has changed.`,
    "",
    "## Boards",
    "Each is a static HTML page; open it in a browser to see it.",
    ...boards.map((b) => `- ${b.name} (${b.width} × ${b.height}): ${b.file}`),
    "",
    ...(tokens.size ? ["## Tokens", ...[...tokens].map(([name, value]) => `- ${name}: ${value}`), ""] : []),
    "## Implementing",
    "- Build these screens with the project's own components, styles and tokens; the HTML is a reference for layout, type, spacing and copy, not code to paste in.",
    "- Match the layout and hierarchy; where the project already has a pattern for something, use it.",
    "- Ask before adding a dependency.",
    "",
  ].join("\n");
  writeFileSync(join(dir, "README.md"), readme, "utf8");
  const folder = relative(root, dir);
  return { folder, files: [join(folder, "README.md"), ...boards.map((b) => join(folder, b.file))], boards };
}
