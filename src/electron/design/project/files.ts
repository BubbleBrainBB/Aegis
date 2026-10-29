import { existsSync, promises as fs, watch, type FSWatcher } from "fs";
import { join, relative, resolve, sep } from "path";

/**
 * A design project's folder on disk: where it goes, what is in it, and when
 * it changes. The agent writes the files with its own tools; the app reads
 * them to serve, preview, verify and keep versions.
 */

/** Projects live in the user's project, under designs/<name>/. */
export const DESIGN_PROJECTS_DIR = "designs";
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 25_000_000;
const MAX_TOTAL_BYTES = 200_000_000;
/** Never versioned or watched: dependencies, VCS and OS clutter. */
const SKIPPED = new Set(["node_modules", ".git", ".DS_Store", "Thumbs.db"]);

/** A folder name from a design title: readable (spaces and CJK kept), safe on every OS. */
export function projectFolderName(title: string): string {
  const cleaned = title
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .slice(0, 80);
  return cleaned || "Untitled design";
}

/**
 * A new project folder inside root/designs: the title's name, or "<name> 2",
 * "<name> 3"… when that folder is already taken.
 */
export function newProjectFolder(root: string, title: string, taken: (folder: string) => boolean): string {
  const base = join(root, DESIGN_PROJECTS_DIR, projectFolderName(title));
  for (let n = 1; n < 1000; n++) {
    const folder = n === 1 ? base : `${base} ${n}`;
    if (!existsSync(folder) && !taken(folder)) return folder;
  }
  throw new Error("Could not find a free folder name for this design.");
}

/** Whether a path stays inside a folder (after resolving it). */
export function isInside(folder: string, path: string): boolean {
  const rel = relative(folder, resolve(folder, path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
}

/** A project-relative path with forward slashes, or null when it leaves the folder. */
export function projectPath(folder: string, path: string): string | null {
  const absolute = resolve(folder, path);
  if (!isInside(folder, absolute)) return null;
  return relative(folder, absolute).split(sep).join("/");
}

/** Every file in a project, for a version. Skips dependencies and hidden files. */
export async function readProjectFiles(folder: string): Promise<{ path: string; bytes: Buffer }[]> {
  const out: { path: string; bytes: Buffer }[] = [];
  let total = 0;
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIPPED.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      // Links could point anywhere: a project's files are its own.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (out.length >= MAX_FILES) throw new Error(`A design project holds up to ${MAX_FILES} files.`);
      const stat = await fs.stat(full);
      if (stat.size > MAX_FILE_BYTES) continue;
      total += stat.size;
      if (total > MAX_TOTAL_BYTES) throw new Error("A design project holds up to 200 MB of files.");
      out.push({ path: relative(folder, full).split(sep).join("/"), bytes: await fs.readFile(full) });
    }
  };
  await walk(folder);
  return out;
}

/**
 * Watches a project folder and reports changed paths, batched: an agent's
 * burst of writes arrives as one change, so the preview reloads once.
 */
export function watchProjectFolder(folder: string, onChange: (paths: string[]) => void): () => void {
  let watcher: FSWatcher | null = null;
  let pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    const paths = [...pending];
    pending = new Set();
    if (paths.length) onChange(paths);
  };
  try {
    watcher = watch(folder, { recursive: true }, (_event, name) => {
      if (!name) return;
      const path = String(name).split(sep).join("/");
      if (path.split("/").some((part) => SKIPPED.has(part) || part.startsWith("."))) return;
      pending.add(path);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 150);
    });
    watcher.on("error", () => {});
  } catch {
    // A folder that can't be watched still serves; the preview reloads on demand.
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}

/** The project's files for the Design view's list: paths and sizes, no contents. */
export async function listProjectFiles(folder: string): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (SKIPPED.has(entry.name) || entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push({ path: relative(folder, full).split(sep).join("/"), size: (await fs.stat(full)).size });
    }
  };
  await walk(folder);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
