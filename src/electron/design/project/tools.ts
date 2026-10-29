import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { z } from "zod";
import { getDesignRepository } from "../service";
import type { DesignRequest } from "../repository";
import type { DesignAuthor } from "../../../shared/design-types";
import {
  DESIGN_PROJECT_CREATE_TOOL, DESIGN_READY_TOOL, DESIGN_SHOW_TOOL, DESIGN_SKILL_TOOL, DESIGN_STARTER_COPY_TOOL,
  DESIGN_VERSION_TOOL, DESIGN_VERSIONS_TOOL, type DesignToolName,
} from "../../../shared/design-tools";
import { checkedPath, createProject, pageUrl, projectFor, saveProjectVersion, showInDesignView, startProject } from "./service";
import { designInstructionsDelivered, designProjectInstructions, designSkill, designSkillList, designSkillNames, noteDesignInstructionsDelivered } from "./prompts";
import { capturePageForReview, reviewMessage, reviewProjectPage } from "./verify";

/**
 * The design_* tools for design projects. The agent writes the files with
 * its own file tools; these do what only Aegis can: make the project, show a
 * page in the Design view, check it and review it in the background, copy
 * starter components, read skills and look at versions.
 */
export interface ProjectToolSpec {
  name: DesignToolName;
  description: string;
  readOnly: boolean;
  shape: z.ZodRawShape;
  jsonSchema: Record<string, unknown>;
  run(sessionId: string, args: Record<string, any>, context: { signal?: AbortSignal }): unknown | Promise<unknown>;
}
export interface ProjectToolHost {
  author(sessionId: string): DesignAuthor;
  request(sessionId: string): DesignRequest | undefined;
}

/** How a needs_work review reaches the conversation (the host wires it to a follow-up message). */
let followUp: (sessionId: string, display: string, prompt: string) => Promise<boolean> = async () => false;
export function setDesignFollowUp(next: typeof followUp) {
  followUp = next;
}
/** Reviews still running, by session and page: a newer design_ready replaces the older one. */
const reviews = new Map<string, AbortController>();

const string = { type: "string" };
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const documentId = { type: "string", description: "The design project; default: the one this conversation works on." };

const starterDir = () => join(__dirname, "starters");
function starterKinds(): string[] {
  try {
    return readdirSync(starterDir()).filter((f) => /\.(jsx|js|css)$/.test(f)).sort();
  } catch {
    return [];
  }
}
/** The usage notes at the top of a starter file (its first comment block). */
function starterNotes(text: string): string {
  const block = /^\s*\/\*\*?([\s\S]*?)\*\//.exec(text);
  return block ? block[1].split("\n").map((l) => l.replace(/^\s*\* ?/, "")).join("\n").trim() : "";
}

function briefFor(folder: string, page: string): string {
  const brief = join(folder, page.replace(/\.[^.]+$/, "") + ".brief.md");
  try {
    return readFileSync(brief, "utf8").slice(0, 4000);
  } catch {
    return "";
  }
}

export function projectToolSpecs(host: ProjectToolHost): ProjectToolSpec[] {
  return [
    {
      name: DESIGN_PROJECT_CREATE_TOOL,
      description:
        "Create a design project: a folder (under designs/ in the user's project) of HTML/JSX/CSS files that you write with your own file tools, served by Aegis and shown to the user in the Design view. Use it only when the user explicitly asks for an interactive or clickable prototype, a working app, or HTML files; designs, mockups, screens and 设计稿 go on the canvas (design_create). This chat is interactive, even when permissions are bypassed: questions you ask with your question tool (such as AskUserQuestion) reach the user as a card they answer. Ask first: for a new or open-ended request, ask your clarifying questions BEFORE calling this (what it is for and who uses it, visual direction, fidelity, how many variations and of what, what should be adjustable; with your question tool when you have one, in one focused round), then end your turn and build from the answers. Skip the questions only when the request already settles them or it is a small change to existing work. If this conversation already has a project, keep working in it instead (its folder is in <design_context>). Returns the folder and, the first time, the design instructions to follow.",
      readOnly: false,
      shape: {
        title: z.string().describe('Short name of the project, e.g. "Reader App". It names the folder.'),
        operationId: z.string().describe("A new unique id for this call; reuse it only to retry the same call."),
      },
      jsonSchema: object({ title: string, operationId: string }, ["title", "operationId"]),
      async run(sessionId, a, { signal }) {
        const doc = createProject(sessionId, a.title, a.operationId, { author: host.author(sessionId), request: host.request(sessionId), signal });
        await startProject(doc);
        const instructions = designInstructionsDelivered(sessionId) ? "" : designProjectInstructions();
        noteDesignInstructionsDelivered(sessionId);
        return {
          guide: [
            `Created the design project ${JSON.stringify(doc.title)} (documentId ${doc.id}) in the folder ${JSON.stringify(doc.folder)}. Write its files there with your file tools (paths relative to that folder in the design_* tools), then call design_show with the first page as soon as it exists.`,
            instructions ? `\nFollow these design instructions for this project:\n\n${instructions}` : "",
            `\nSkills (read with design_skill before starting work they cover):\n${designSkillList()}`,
          ].join("\n"),
        };
      },
    },
    {
      name: DESIGN_SHOW_TOOL,
      description:
        "Show a page of the design project to the user in the Design view while you work (saves the folder as a version). Call it as soon as the first version of a page lands so the user watches it take shape. For the end-of-turn delivery use design_ready instead.",
      readOnly: false,
      shape: {
        path: z.string().describe('The page, relative to the project folder, e.g. "Reader App.html".'),
        documentId: z.string().optional().describe(documentId.description),
      },
      jsonSchema: object({ path: string, documentId }, ["path"]),
      async run(sessionId, a) {
        const doc = projectFor(sessionId, a.documentId);
        const path = checkedPath(doc, a.path);
        if (!existsSync(join(doc.folder!, path))) throw new Error(`No file ${JSON.stringify(path)} in ${doc.folder}. Write it first.`);
        const { document } = await saveProjectVersion(sessionId, doc.id, { author: host.author(sessionId), request: host.request(sessionId) });
        const url = await pageUrl(document, path);
        showInDesignView(sessionId, doc.id, path);
        return { guide: `Showing ${JSON.stringify(path)} in the Design view (version ${document.revision}, served at ${url}).` };
      },
    },
    {
      name: DESIGN_READY_TOOL,
      description:
        "Deliver a page at the end of your turn: shows it to the user, loads it, and returns its console errors and failed loads. When it loads cleanly it starts a background review (screenshots at desktop and phone width) that only messages this conversation if it finds problems. Fix every error it returns and call it again. Then end your turn with a very short summary; don't call the work done, it is out for review. Pass skip_review for trivial changes.",
      readOnly: false,
      shape: {
        path: z.string().describe("The main page, relative to the project folder."),
        documentId: z.string().optional().describe(documentId.description),
        skip_review: z.boolean().optional().describe("Skip the background review (trivial copy or color edits, repetitive changes)."),
      },
      jsonSchema: object({ path: string, documentId, skip_review: { type: "boolean", description: "Skip the background review for trivial changes." } }, ["path"]),
      async run(sessionId, a, { signal }) {
        const doc = projectFor(sessionId, a.documentId);
        const path = checkedPath(doc, a.path);
        if (!existsSync(join(doc.folder!, path))) throw new Error(`No file ${JSON.stringify(path)} in ${doc.folder}. Write it first.`);
        const { document } = await saveProjectVersion(sessionId, doc.id, { author: host.author(sessionId), request: host.request(sessionId) });
        const url = await pageUrl(document, path);
        showInDesignView(sessionId, doc.id, path);
        const captures = await capturePageForReview(url, signal);
        const errors = [...new Set([...captures.desktop.errors, ...captures.phone.errors])];
        const warnings = [...new Set([...captures.desktop.warnings, ...captures.phone.warnings.map((w) => `At phone width: ${w}`)])];
        if (errors.length)
          return {
            guide: [
              `${JSON.stringify(path)} has errors (version ${document.revision}). The user is looking at it: fix these and call design_ready again.`,
              ...errors.map((e) => `- ${e}`),
              ...(warnings.length ? ["Also measured:", ...warnings.map((w) => `- ${w}`)] : []),
            ].join("\n"),
          };
        const key = `${sessionId}\u0000${path}`;
        reviews.get(key)?.abort();
        if (!a.skip_review) {
          const controller = new AbortController();
          reviews.set(key, controller);
          const request = host.request(sessionId)?.prompt ?? "";
          void reviewProjectPage({ url, page: path, request, brief: briefFor(doc.folder!, path), captures }, controller.signal)
            .then(async (review) => {
              if (controller.signal.aborted || !review || review.verdict === "done") return;
              const message = reviewMessage(path, review);
              await followUp(sessionId, message.display, message.prompt);
            })
            .catch(() => {})
            .finally(() => {
              if (reviews.get(key) === controller) reviews.delete(key);
            });
        }
        return {
          guide: [
            `${JSON.stringify(path)} loads cleanly and is open for the user (version ${document.revision}).`,
            a.skip_review ? "Review skipped." : "A background review started; if it finds problems they arrive as a message. Don't wait for it: write your short summary now and end your turn.",
            ...(warnings.length ? ["Measured (fix what visibly matters):", ...warnings.map((w) => `- ${w}`)] : []),
          ].join("\n"),
        };
      },
    },
    {
      name: DESIGN_SKILL_TOOL,
      description: `Read a design skill: the recipe for one kind of design work. Read the matching one before you start. Skills: ${designSkillNamesSafe().join(", ")}.`,
      readOnly: true,
      shape: { name: z.string().describe('The skill, e.g. "hi-fi-design".') },
      jsonSchema: object({ name: string }, ["name"]),
      run(_sessionId, a) {
        const skill = designSkill(a.name);
        if (!skill) throw new Error(`No skill ${JSON.stringify(a.name)}. Skills:\n${designSkillList()}`);
        return { guide: `# ${skill.title}\n\n${skill.body}` };
      },
    },
    {
      name: DESIGN_STARTER_COPY_TOOL,
      description: `Copy a starter component into the design project instead of hand-drawing it: device frames, window chrome, a pannable canvas for comparing options. Returns its path and usage notes. Kinds: ${starterKinds().join(", ") || "(none in this build)"}.`,
      readOnly: false,
      shape: {
        kind: z.string().describe('The starter, e.g. "design_canvas.jsx".'),
        documentId: z.string().optional().describe(documentId.description),
        dest: z.string().optional().describe("Where to put it, relative to the project folder; default: the folder root, same name."),
      },
      jsonSchema: object({ kind: string, documentId, dest: string }, ["kind"]),
      run(sessionId, a) {
        const kinds = starterKinds();
        const kind = kinds.find((k) => k === a.kind || k.replace(/[-_]/g, "") === String(a.kind).replace(/[-_]/g, ""));
        if (!kind) throw new Error(`No starter ${JSON.stringify(a.kind)}. Kinds: ${kinds.join(", ")}.`);
        const doc = projectFor(sessionId, a.documentId);
        const dest = checkedPath(doc, a.dest || kind);
        const target = join(doc.folder!, dest);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(starterDir(), kind), target);
        const notes = starterNotes(readFileSync(target, "utf8"));
        return { guide: `Copied ${kind} to ${JSON.stringify(dest)}.${notes ? `\n\nUsage notes:\n${notes}` : ""}` };
      },
    },
    {
      name: DESIGN_VERSIONS_TOOL,
      description: "List the design project's versions (newest first): number, time, who made it and what changed. Use only when the user brings up earlier versions.",
      readOnly: true,
      shape: { documentId: z.string().optional().describe(documentId.description) },
      jsonSchema: object({ documentId }, []),
      run(sessionId, a) {
        const doc = projectFor(sessionId, a.documentId);
        const rows = getDesignRepository().history(sessionId, doc.id).slice(0, 100);
        return {
          guide: rows
            .map((r) => `v${r.revision} · ${new Date(r.createdAt).toISOString()} · ${r.author?.kind === "user" ? "user" : r.author?.name ?? "agent"} · ${r.summary ?? ""}`)
            .join("\n") || "No versions yet.",
        };
      },
    },
    {
      name: DESIGN_VERSION_TOOL,
      description: "One version of the design project: its file list, or, with paths (up to 20), those files' contents at that version. To restore, read the old files and write them back with your file tools.",
      readOnly: true,
      shape: {
        version: z.number().int().min(1).describe("The version number (v3 → 3)."),
        paths: z.array(z.string()).max(20).optional().describe("Files to read at that version."),
        documentId: z.string().optional().describe(documentId.description),
      },
      jsonSchema: object({ version: { type: "integer", minimum: 1 }, paths: { type: "array", items: string, maxItems: 20 }, documentId }, ["version"]),
      run(sessionId, a) {
        const doc = projectFor(sessionId, a.documentId);
        const repo = getDesignRepository();
        const at = repo.read(sessionId, doc.id, a.version);
        if (!a.paths?.length)
          return { guide: `Version ${a.version} files:\n${(at.files ?? []).map((f) => `- ${f.path} (${f.size} bytes)`).join("\n") || "(none)"}` };
        const parts = (a.paths as string[]).map((p) => {
          try {
            const bytes = repo.projectFile(sessionId, doc.id, p, a.version);
            const text = bytes.toString("utf8");
            return /\u0000/.test(text) ? `## ${p}\n(binary, ${bytes.length} bytes)` : `## ${p}\n${text}`;
          } catch (e) {
            return `## ${p}\n(${e instanceof Error ? e.message : String(e)})`;
          }
        });
        return { guide: parts.join("\n\n") };
      },
    },
  ];
}

function designSkillNamesSafe(): string[] {
  try {
    return designSkillNames();
  } catch {
    return [];
  }
}

