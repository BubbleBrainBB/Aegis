import { BrowserWindow, dialog, type SaveDialogOptions } from "electron";
import { writeFile } from "fs/promises";
import { isAbsolute } from "path";
import { randomUUID } from "crypto";
import { strToU8, zipSync } from "fflate";
import { ipcMainHandle } from "../util";
import { designPdf, getDesignRepository, packForDesign, previewDesign } from "./service";
import { designForPage } from "../../shared/design-pages";
import { setDesignComposerPrefs, setDesignFocus } from "./focus";
import { listDesignStyles, listProjectTemplates } from "./styles";
import { cancelQuickEdit, quickEditDesign } from "./quick-edit";
import { handOffDesign } from "./handoff";
import { designFrameHtml } from "./html";
import { getUserProfile } from "../libs/user-profile";
import type { DesignAPI, DesignAuthor } from "../../shared/design-types";

// The renderer never supplies authorship; profile lookups may spawn git.
let profile: { at: number; name: Promise<string | undefined> } | undefined;
async function user(): Promise<DesignAuthor> {
  if (!profile || Date.now() - profile.at > 30_000)
    profile = {
      at: Date.now(),
      name: getUserProfile().then(
        (p) => p.displayName,
        () => undefined,
      ),
    };
  const name = await profile.name;
  return name ? { kind: "user", name } : { kind: "user" };
}

/**
 * Ends the renderer process of one hung sandboxed frame of `owner`. Board,
 * widget and preview frames are opaque-origin srcdoc iframes that Chromium
 * runs out of process, all of a window's in one shared process: a board whose
 * logic never yields stalls them all until that process is gone. Only a
 * srcdoc subframe's process that is not the window's own is ever ended.
 */
function recoverSandboxFrame(owner: BrowserWindow | undefined, frameName: unknown): boolean {
  if (!owner || owner.isDestroyed() || typeof frameName !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(frameName)) return false;
  const main = owner.webContents.mainFrame;
  const frame = main.framesInSubtree.find((f) => f !== main && f.name === frameName && f.url === "about:srcdoc");
  const pid = frame?.osProcessId;
  if (!pid || pid === main.osProcessId || pid === process.pid) return false;
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

export function registerDesignIpc() {
  const handlers: Omit<DesignAPI, "onChanged"> = {
    list: (sessionId) => Promise.resolve(getDesignRepository().list(sessionId)),
    listAll: () => Promise.resolve(getDesignRepository().listAll()),
    join: (x) => Promise.resolve(getDesignRepository().join(x.sessionId, x.documentId)),
    remove: (x) => Promise.resolve(getDesignRepository().deleteDocument(x.documentId)),
    create: async (x) =>
      getDesignRepository().create(
        x.sessionId,
        x.title,
        x.brief ?? "",
        x.operationId,
        undefined,
        await user(),
      ),
    read: (x) =>
      Promise.resolve(
        getDesignRepository().read(x.sessionId, x.documentId, x.revision),
      ),
    update: async (x) =>
      getDesignRepository().update(x.sessionId, x, undefined, await user()),
    prompts: (x) =>
      Promise.resolve(getDesignRepository().boardPrompts(x.sessionId, x.documentId)),
    history: (x) =>
      Promise.resolve(getDesignRepository().history(x.sessionId, x.documentId)),
    restore: async (x) =>
      getDesignRepository().restore(
        x.sessionId,
        x.documentId,
        x.revision,
        x.expectedRevision,
        x.operationId,
        x.boardIds ?? x.boardId,
        await user(),
        {
          summary: typeof x.summary === "string" ? x.summary.slice(0, 160) : undefined,
          title: x.title === true,
          canvas: x.canvas === true,
        },
      ),
    comment: async (x) =>
      getDesignRepository().comment(x.sessionId, {
        documentId: x.documentId,
        boardId: x.boardId,
        contentRevision: x.contentRevision,
        text: x.text,
        anchor: x.anchor,
        id: x.id,
        toAgent: x.toAgent,
        author: await user(),
      }),
    reply: async (x) =>
      getDesignRepository().reply(x.sessionId, {
        documentId: x.documentId,
        commentId: x.commentId,
        id: x.id,
        text: x.text,
        toAgent: x.toAgent,
        author: await user(),
      }),
    comments: (x) =>
      Promise.resolve(
        getDesignRepository().comments(x.sessionId, x.documentId),
      ),
    resolve: (x) =>
      Promise.resolve(
        getDesignRepository().resolve(
          x.sessionId,
          x.documentId,
          x.commentId,
          x.resolved,
        ),
      ),
    focus: (x) => {
      if (typeof x?.sessionId === "string") setDesignFocus(x.sessionId, x);
      return Promise.resolve();
    },
    styles: (x) =>
      Promise.resolve(
        typeof x?.sessionId === "string"
          ? listDesignStyles(x.sessionId, typeof x.cwd === "string" && isAbsolute(x.cwd) ? x.cwd : undefined)
          : [],
      ),
    templates: (x) =>
      Promise.resolve(
        typeof x?.sessionId === "string"
          ? listProjectTemplates(x.sessionId, typeof x.cwd === "string" && isAbsolute(x.cwd) ? x.cwd : undefined)
          : [],
      ),
    quickEdit: (x) => quickEditDesign(x),
    handoff: (x) => Promise.resolve(handOffDesign(x)),
    quickEditCancel: (x) => {
      if (typeof x?.requestId === "string") cancelQuickEdit(x.requestId);
      return Promise.resolve();
    },
    system: (x) => {
      const d = getDesignRepository().read(x.sessionId, x.documentId);
      return Promise.resolve(packForDesign(d));
    },
    recoverFrame: (x, owner?: BrowserWindow) => Promise.resolve({ recovered: recoverSandboxFrame(owner, x?.frameName) }),
    composer: (x) => {
      if (typeof x?.sessionId === "string") setDesignComposerPrefs(x.sessionId, x);
      return Promise.resolve();
    },
    preview: (x) =>
      previewDesign(x.sessionId, x.documentId, x.boardId, x.revision),
    export: async (x, owner?: BrowserWindow) => {
      let d = getDesignRepository().read(
        x.sessionId,
        x.documentId,
        x.revision,
      );
      if (x.pageId !== undefined) {
        d = designForPage(d, x.pageId);
        if (x.boardId && !d.boards.some(board => board.id === x.boardId)) throw new Error("Board does not belong to this page.");
      }
      // PDF and HTML can be one board or a chosen few; a PDF goes in canvas order.
      const only = x.format === "png" ? [] : Array.isArray(x.boardIds) && x.boardIds.length ? x.boardIds : x.boardId ? [x.boardId] : [];
      if (only.length) {
        d = { ...d, boards: d.boards.filter((board) => only.includes(board.id)) };
        if (!d.boards.length) throw new Error("Those boards are not in this design.");
      }
      if (x.format === "pdf") d = { ...d, boards: [...d.boards].sort((a, b) => a.y - b.y || a.x - b.x) };
      if (!d.boards.length && x.format !== "html") throw new Error("This page has no boards to export.");
      if (x.format !== "png" && x.format !== "html" && x.format !== "pdf")
        throw new Error("Unsupported export format");
      let bytes: Uint8Array;
      if (x.format === "pdf") {
        bytes = await designPdf(d.boards, undefined, packForDesign(d));
      } else if (x.format === "png") {
        if (!x.boardId) throw new Error("Select a board to export as PNG.");
        const preview = await previewDesign(
          x.sessionId,
          x.documentId,
          x.boardId,
          x.revision,
          undefined,
          4096,
          x.scale === 2 ? 2 : 1,
          false,
        );
        bytes = Buffer.from(preview.dataUrl.split(",")[1], "base64");
      } else {
        const files: Record<string, Uint8Array> = {
          "canvas.json": strToU8(
            JSON.stringify(
              {
                ...d,
                boards: d.boards.map(({ html, ...b }) => ({
                  ...b,
                  file: `boards/${b.id}.html`,
                })),
              },
              null,
              2,
            ),
          ),
        };
        // Each board stands alone: its system's styles, components and assets inlined, and interactive.
        const system = packForDesign(d);
        for (const board of d.boards)
          files[`boards/${board.id}.html`] = strToU8(
            designFrameHtml(board.html, randomUUID(), false, { system }),
          );
        bytes = zipSync(files);
      }
      const extension = x.format === "png" ? "png" : x.format === "pdf" ? "pdf" : "zip";
      const options: SaveDialogOptions = {
        defaultPath: `${(only.length === 1 ? `${d.title} - ${d.boards[0].name}` : d.title).replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 80) || "Design"}.${extension}`,
        filters: [
          {
            name: x.format === "png" ? "PNG image" : x.format === "pdf" ? "PDF, a page per board" : "HTML design bundle",
            extensions: [extension],
          },
        ],
      };
      const result = owner && !owner.isDestroyed()
        ? await dialog.showSaveDialog(owner, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { saved: false };
      await writeFile(result.filePath, bytes);
      return { saved: true, path: result.filePath };
    },
  };
  for (const [method, handler] of Object.entries(handlers)) {
    ipcMainHandle(`design:${method}`, (event, input) => {
      // The user opened this design in this chat: its agent may use it too.
      const x = input as { sessionId?: unknown; documentId?: unknown } | undefined;
      if (typeof x?.sessionId === "string" && typeof x.documentId === "string" && method !== "remove")
        getDesignRepository().allow(x.sessionId, x.documentId);
      return (handler as (input: unknown, owner?: BrowserWindow) => unknown)(input, BrowserWindow.fromWebContents(event.sender) ?? undefined);
    });
  }
}
