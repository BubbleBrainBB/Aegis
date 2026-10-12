import { dialog } from "electron";
import { writeFile } from "fs/promises";
import { isAbsolute } from "path";
import { randomUUID } from "crypto";
import { strToU8, zipSync } from "fflate";
import { ipcMainHandle } from "../util";
import { getDesignRepository, previewDesign } from "./service";
import { setDesignComposerPrefs, setDesignFocus } from "./focus";
import { listDesignStyles, listProjectTemplates } from "./styles";
import { cancelQuickEdit, quickEditDesign } from "./quick-edit";
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

export function registerDesignIpc() {
  const handlers: Omit<DesignAPI, "onChanged"> = {
    list: (sessionId) => Promise.resolve(getDesignRepository().list(sessionId)),
    listAll: () => Promise.resolve(getDesignRepository().listAll()),
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
    quickEditCancel: (x) => {
      if (typeof x?.requestId === "string") cancelQuickEdit(x.requestId);
      return Promise.resolve();
    },
    composer: (x) => {
      if (typeof x?.sessionId === "string") setDesignComposerPrefs(x.sessionId, x);
      return Promise.resolve();
    },
    preview: (x) =>
      previewDesign(x.sessionId, x.documentId, x.boardId, x.revision),
    export: async (x) => {
      const d = getDesignRepository().read(
        x.sessionId,
        x.documentId,
        x.revision,
      );
      if (x.format !== "png" && x.format !== "html")
        throw new Error("Unsupported export format");
      let bytes: Uint8Array;
      if (x.format === "png") {
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
        for (const board of d.boards)
          files[`boards/${board.id}.html`] = strToU8(
            designFrameHtml(board.html, randomUUID(), false),
          );
        bytes = zipSync(files);
      }
      const result = await dialog.showSaveDialog({
        defaultPath: `${d.title.replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 80) || "Design"}.${x.format === "png" ? "png" : "zip"}`,
        filters: [
          {
            name: x.format === "png" ? "PNG image" : "HTML design bundle",
            extensions: [x.format === "png" ? "png" : "zip"],
          },
        ],
      });
      if (result.canceled || !result.filePath) return { saved: false };
      await writeFile(result.filePath, bytes);
      return { saved: true, path: result.filePath };
    },
  };
  for (const [method, handler] of Object.entries(handlers)) {
    ipcMainHandle(`design:${method}`, (_event, input) =>
      (handler as (input: unknown) => unknown)(input),
    );
  }
}
