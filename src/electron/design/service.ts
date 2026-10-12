import { app, BrowserWindow, session as electronSession } from "electron";
import { join } from "path";
import { randomUUID } from "crypto";
import { DesignRepository } from "./repository";
import { designFrameHtml } from "./html";
import { renderChecksScript } from "./render-checks";
import { moveDesignFocus } from "./focus";
import type { DesignPreview } from "../../shared/design-types";

let repository: DesignRepository | undefined;
export function getDesignRepository() {
  if (repository) return repository;
  repository = new DesignRepository(
    join(app.getPath("userData"), "designs", "design.db"),
    (event) => {
      for (const w of BrowserWindow.getAllWindows())
        if (!w.isDestroyed())
          w.webContents.send("design:changed", event);
    },
  );
  // No turn survives a restart, so nothing can still be working on a comment.
  repository.resetWorking();
  return repository;
}

/** A deleted conversation's designs go with it; best effort, never blocks the delete. */
export function deleteSessionDesigns(sessionId: string) {
  try {
    getDesignRepository().deleteSession(sessionId);
  } catch (error) {
    console.warn("Failed to delete the session's designs:", error);
  }
}

/** A draft chat's designs follow it when it becomes a real session. */
export function moveSessionDesigns(from: string, to: string) {
  try {
    getDesignRepository().moveSession(from, to);
    moveDesignFocus(from, to);
  } catch (error) {
    console.warn("Failed to move the draft's designs:", error);
  }
}

/** Called when a chat message carrying a design comment is actually sent. */
export function markDesignCommentSent(
  sessionId: string,
  ref: { documentId: string; commentId: string; messageId: string },
  chatCreatedAt: number,
) {
  getDesignRepository().markWorking(
    sessionId,
    ref.documentId,
    ref.commentId,
    ref.messageId,
    chatCreatedAt,
  );
}

/** Turn ended (complete, error or stop): settle comments still marked working. */
export function settleDesignTurn(sessionId: string, agentName?: string) {
  return getDesignRepository().settleWorking(
    sessionId,
    agentName ? { kind: "agent", name: agentName } : undefined,
  );
}

// Each capture owns a fresh, nonpersistent Chromium session, with no preload.
// Serialize captures to bound Chromium/GPU memory even when tools run in parallel.
let captureTail: Promise<unknown> = Promise.resolve();
/** Fonts, images and two frames: the board as it will look, nothing measured. */
const READY_SCRIPT =
  "(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>null)));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return []})()";
export function previewDesign(
  sessionId: string,
  documentId: string,
  boardId: string,
  revision: number,
  signal?: AbortSignal,
  maxDimension = 1600,
  scale: 1 | 2 = 1,
  /** Measure the board for the agent (exports skip this). */
  checks = true,
): Promise<DesignPreview> {
  const job = captureTail
    .catch(() => {})
    .then(async () => {
      signal?.throwIfAborted();
      const d = getDesignRepository().read(sessionId, documentId, revision);
      const b = d.boards.find((b) => b.id === boardId);
      if (!b) throw new Error("Board not found.");
      const partition = `design-capture-${randomUUID()}`;
      const isolated = electronSession.fromPartition(partition);
      isolated.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
      isolated.webRequest.onBeforeRequest((request, done) =>
        done({
          cancel:
            !request.url.startsWith("data:") && request.url !== "about:blank",
        }),
      );
      const w = new BrowserWindow({
        show: false,
        width: b.width * scale,
        height: b.height * scale,
        useContentSize: true,
        webPreferences: {
          partition,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      w.webContents.on("will-navigate", (e) => e.preventDefault());
      const stop = () => {
        if (!w.isDestroyed()) w.destroy();
      };
      const timeout = setTimeout(stop, 15000);
      signal?.addEventListener("abort", stop, { once: true });
      try {
        await w.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(designFrameHtml(b.html, randomUUID(), false))}`,
        );
        if (scale !== 1) w.webContents.setZoomFactor(scale);
        // What the screenshot alone might not show: overlaps, clipping, emptiness, size.
        const warnings = (await w.webContents.executeJavaScript(
          checks ? renderChecksScript(b.width, b.height) : READY_SCRIPT,
        ).catch(() => (checks ? ["Checks could not run on this board; judge the screenshot alone."] : []))) as string[];
        signal?.throwIfAborted();
        let image = await w.webContents.capturePage();
        // HiDPI displays capture at the device pixel ratio; export exact pixels.
        if (image.getSize().width > b.width * scale)
          image = image.resize({
            width: b.width * scale,
            height: Math.round((image.getSize().height * b.width * scale) / image.getSize().width),
            quality: "best",
          });
        const capturedSize = image.getSize();
        if (
          capturedSize.width > maxDimension ||
          capturedSize.height > maxDimension
        ) {
          const scale =
            maxDimension / Math.max(capturedSize.width, capturedSize.height);
          image = image.resize({
            width: Math.round(capturedSize.width * scale),
            height: Math.round(capturedSize.height * scale),
          });
        }
        // Keep actual model image delivery below the SDK observation limit.
        if (maxDimension <= 1600)
          while (image.toPNG().length > 2_900_000) {
            const size = image.getSize();
            image = image.resize({
              width: Math.max(1, Math.round(size.width * 0.8)),
              height: Math.max(1, Math.round(size.height * 0.8)),
            });
          }
        signal?.throwIfAborted();
        return {
          dataUrl: image.toDataURL(),
          revision,
          boardId,
          width: image.getSize().width,
          height: image.getSize().height,
          warnings,
        };
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", stop);
        stop();
        await isolated.clearStorageData().catch(() => {});
      }
    });
  captureTail = job;
  return job;
}
