import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, extname, join } from "path";

/**
 * A project's own design system, as files the agent and the user can both
 * read:
 *
 *   design-system/README.md          principles, tokens, voice (or DESIGN.md at the root)
 *   design-system/components/Name.md how to use a component (first line: what it is)
 *   design-system/components/Name.html  its reference markup (optional)
 *   design-system/templates/slug.html   a representative page to start boards from
 *   design-system/templates/slug.md     what the template is for (optional)
 *
 * Small and explicit on purpose: a few components with real usage notes and
 * two or three pages guide an agent better than a large unexplained library.
 */
export interface DesignSystemComponent {
  name: string;
  summary: string;
  usage: string;
  html?: string;
}
export interface DesignSystemTemplate {
  id: string;
  name: string;
  summary: string;
  html: string;
}
export interface ProjectDesignSystem {
  /** The folder it was read from, relative to the project. */
  folder: string;
  guide: string | null;
  components: DesignSystemComponent[];
  templates: DesignSystemTemplate[];
}

const FOLDER = "design-system";
const MAX_FILE = 120_000;
const MAX_COMPONENTS = 40;
const MAX_TEMPLATES = 24;

function readSmall(path: string): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size > MAX_FILE) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function listFiles(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => extname(f).toLowerCase() === ext && !f.startsWith("."))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** The first meaningful line of a note, without Markdown markers. */
export function summaryOf(text: string | null | undefined): string {
  const line = (text ?? "").split("\n").map((l) => l.replace(/^#+\s*|^[-*>]\s*/, "").trim()).find(Boolean) ?? "";
  return line.slice(0, 160);
}

const titleOf = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The project's design system, or null when it has neither a guide nor resources. */
export function readProjectDesignSystem(root: string | null | undefined): ProjectDesignSystem | null {
  if (!root) return null;
  const dir = join(root, FOLDER);
  const guide = readSmall(join(dir, "README.md")) ?? readSmall(join(root, "DESIGN.md")) ?? readSmall(join(root, "design.md"));
  const componentsDir = join(dir, "components");
  const names = new Set([...listFiles(componentsDir, ".md"), ...listFiles(componentsDir, ".html")].map((f) => basename(f, extname(f))));
  const components = [...names].slice(0, MAX_COMPONENTS).map((name) => {
    const usage = readSmall(join(componentsDir, `${name}.md`)) ?? "";
    const html = readSmall(join(componentsDir, `${name}.html`)) ?? undefined;
    return { name, summary: summaryOf(usage) || "Reference markup", usage, ...(html ? { html } : {}) };
  });
  const templatesDir = join(dir, "templates");
  const templates = listFiles(templatesDir, ".html")
    .slice(0, MAX_TEMPLATES)
    .flatMap((file) => {
      const id = basename(file, ".html");
      const html = readSmall(join(templatesDir, file));
      if (!html) return [];
      const note = readSmall(join(templatesDir, `${id}.md`));
      return [{ id, name: titleOf(id), summary: summaryOf(note) || summaryOf(html.replace(/<[^>]+>/g, " ")), html }];
    });
  if (!guide && !components.length && !templates.length) return null;
  return { folder: FOLDER, guide, components, templates };
}

/** What the agent sees first: the guide's place, and the resources by name. */
export function designSystemIndex(system: ProjectDesignSystem): string {
  const lines = [`## This project's design system (${system.folder}/)`];
  if (system.components.length)
    lines.push("Components (read one with design_resources before using it; follow its usage, don't guess its variants):", ...system.components.map((c) => `- ${c.name}: ${c.summary}`));
  if (system.templates.length)
    lines.push("Templates (representative pages; when one fits the request, read it with design_resources and build from its structure with the task's real content):", ...system.templates.map((t) => `- ${t.id}: ${t.summary}`));
  return lines.join("\n");
}
