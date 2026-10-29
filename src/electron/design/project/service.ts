import { app, BrowserWindow } from "electron";
import { mkdirSync } from "fs";
import { join } from "path";
import { getDesignRepository } from "../service";
import { designProjectRoot } from "../styles";
import type { DesignRequest } from "../repository";
import type { DesignAuthor, DesignDocument } from "../../../shared/design-types";
import { newProjectFolder, projectPath, readProjectFiles, watchProjectFolder } from "./files";
import { projectFileUrl, projectServer, stopProjectServer } from "./server";

/**
 * Design projects: a folder of files the agent writes with its own tools,
 * served by a local server and previewed in the Design view. This ties the
 * folder, the server, the watcher and the stored versions together.
 */

/** Where a chat's projects go: its project folder, or the app's own folder for chats without one. */
export function projectsRoot(sessionId: string): string {
  return designProjectRoot(sessionId) || join(app.getPath("userData"), "design-projects");
}

const watchers = new Map<string, { folder: string; stop: () => void }>();

/** Serve and watch a project's folder (idempotent). Changes reach the preview as "files" events. */
export async function startProject(doc: Pick<DesignDocument, "id" | "folder">) {
  if (!doc.folder) throw new Error("This design has no folder.");
  const folder = doc.folder;
  const watching = watchers.get(doc.id);
  if (!watching || watching.folder !== folder) {
    watching?.stop();
    const stop = watchProjectFolder(folder, (paths) => getDesignRepository().filesChanged(doc.id, paths));
    watchers.set(doc.id, { folder, stop });
  }
  return projectServer(doc.id, folder);
}

export function stopProject(documentId: string) {
  watchers.get(documentId)?.stop();
  watchers.delete(documentId);
  stopProjectServer(documentId);
}

export function createProject(
  sessionId: string,
  title: string,
  operationId: string,
  options: { author: DesignAuthor; request?: DesignRequest; system?: string | null; signal?: AbortSignal },
): DesignDocument {
  const repo = getDesignRepository();
  const folder = newProjectFolder(projectsRoot(sessionId), title, (f) => !!repo.projectForFolder(f));
  mkdirSync(folder, { recursive: true });
  return repo.createProject(sessionId, title, folder, operationId, options.signal, options.author, {
    request: options.request,
    system: options.system,
  });
}

/** The project this chat works on: the given one, or the one it most recently worked on. */
export function projectFor(sessionId: string, documentId?: string): DesignDocument {
  const repo = getDesignRepository();
  if (documentId) {
    const doc = repo.read(sessionId, documentId);
    if (doc.kind !== "project") throw new Error(`${documentId} is a canvas, not a design project; use the canvas tools for it.`);
    return doc;
  }
  const mine = repo.list(sessionId).filter((d) => d.member && d.kind === "project");
  if (!mine.length) throw new Error("This conversation has no design project yet. Create one with design_project_create.");
  return repo.read(sessionId, mine[0].id);
}

/** A file path the agent gave, checked against the project, with forward slashes. */
export function checkedPath(doc: DesignDocument, path: string): string {
  const rel = projectPath(doc.folder!, path.replace(/^\/+/, ""));
  if (!rel) throw new Error(`${JSON.stringify(path)} is outside the project folder ${doc.folder}.`);
  return rel;
}

/** Save the folder as a new version when it changed. */
export async function saveProjectVersion(
  sessionId: string,
  documentId: string,
  meta: { author?: DesignAuthor; summary?: string; request?: DesignRequest } = {},
) {
  const doc = getDesignRepository().read(sessionId, documentId);
  const files = await readProjectFiles(doc.folder!);
  return getDesignRepository().saveProjectFiles(sessionId, documentId, files, meta);
}

export async function pageUrl(doc: DesignDocument, path: string): Promise<string> {
  await startProject(doc);
  return projectFileUrl(doc.id, doc.folder!, path);
}

/** Ask the Design view to open a project page (design_show / design_ready). */
export function showInDesignView(sessionId: string, documentId: string, path: string) {
  for (const w of BrowserWindow.getAllWindows())
    if (!w.isDestroyed()) w.webContents.send("design:show", { sessionId, documentId, path });
}
