import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * The design project prompt and its skills: Markdown files under prompts/,
 * copied next to the compiled code by build-design-assets. The core prompt
 * reaches a conversation once (the result of design_project_create, or the
 * next message of a chat that works on a project); skills are read on
 * demand with design_skill.
 */
const dir = () => join(__dirname, "prompts");

let core: string | undefined;
export function designProjectInstructions(): string {
  core ??= readFileSync(join(dir(), "core.md"), "utf8").trim();
  return core;
}

export interface DesignSkill {
  name: string;
  title: string;
  description: string;
  body: string;
}
let skills: DesignSkill[] | undefined;
function loadSkills(): DesignSkill[] {
  if (skills) return skills;
  const out: DesignSkill[] = [];
  for (const file of readdirSync(join(dir(), "skills")).filter((f) => f.endsWith(".md")).sort()) {
    const text = readFileSync(join(dir(), "skills", file), "utf8");
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!match) continue;
    const meta = Object.fromEntries(
      match[1].split("\n").map((line) => {
        const i = line.indexOf(":");
        return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
      }),
    );
    out.push({ name: meta.name || file.replace(/\.md$/, ""), title: meta.title || meta.name, description: meta.description || "", body: match[2].trim() });
  }
  skills = out;
  return out;
}

export function designSkillNames(): string[] {
  return loadSkills().map((s) => s.name);
}

/** One skill, by name or title, forgiving about case and separators. */
export function designSkill(name: string): DesignSkill | undefined {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const wanted = key(name);
  return loadSkills().find((s) => key(s.name) === wanted || key(s.title) === wanted);
}

export function designSkillList(): string {
  return loadSkills()
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");
}

/**
 * Which conversations already have the core prompt. In memory: after a
 * restart a conversation gets it once more, which also covers a context
 * that was compacted meanwhile.
 */
const delivered = new Set<string>();

/** A draft chat became a real session: what it already got moves along. */
export function moveDesignInstructions(from: string, to: string) {
  if (delivered.delete(from)) delivered.add(to);
}

/** The core prompt for this message, the first time a design conversation needs it. */
export function takeDesignInstructions(sessionId: string, needed: boolean): string {
  if (!needed || delivered.has(sessionId)) return "";
  delivered.add(sessionId);
  return `\n\n<design_instructions>\n${designProjectInstructions()}\n</design_instructions>`;
}
/** design_project_create returns the prompt too; a conversation that got it there doesn't need it again. */
export function noteDesignInstructionsDelivered(sessionId: string) {
  delivered.add(sessionId);
}
export function designInstructionsDelivered(sessionId: string) {
  return delivered.has(sessionId);
}
