import { app, BrowserWindow, session as electronSession } from "electron";
import { join } from "path";
import { randomUUID } from "crypto";
import { DesignRepository } from "./repository";
import { designFrameHtml } from "./html";
import { renderChecksScript } from "./render-checks";
import { moveDesignFocus } from "./focus";
import { designProjectRoot } from "./styles";
import type { DesignDocument, DesignPreview } from "../../shared/design-types";
import { designSystemPack } from "./system-pack";
import { adherenceWarnings } from "./adherence";
import { designSlides, isDesignDeck } from "../../shared/design-deck";
import type { DesignSystemPack } from "../../shared/design-system-pack";

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
    (sessionId) => designProjectRoot(sessionId),
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
    console.warn("Failed to remove the session from its designs:", error);
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

/** The design system a design's boards load: its recorded one, else its project's. */
export function packForDesign(d: Pick<DesignDocument, "system" | "project" | "sessionId">): DesignSystemPack | null {
  try {
    return designSystemPack(d.system, d.project || designProjectRoot(d.sessionId));
  } catch (error) {
    console.warn("Failed to read the design system:", error);
    return null;
  }
}

// Each capture owns a fresh, nonpersistent Chromium session, with no preload.
// Serialize captures to bound Chromium/GPU memory even when tools run in parallel.
let captureTail: Promise<unknown> = Promise.resolve();
/** Fonts, images and two frames: the board as it will look, nothing measured. */
const READY_SCRIPT =
  "(async()=>{await (window.__aegisRuntime?window.__aegisRuntime.ready:null);await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>null)));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return []})()";
/** Where design_preview's checks run: a world of their own, apart from board logic. */
const CHECKS_WORLD = 1029;
const RUNTIME_READY_MS = 5_000;
/** A design component's logic errors, for the agent: they don't show in a screenshot. */
const RUNTIME_ERRORS =
  "(window.__aegisRuntime?[...window.__aegisRuntime.errors]:[])";
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
  /** A deck's slide to capture (0-based). */
  slide?: number,
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
        // Logic that loops while the page starts never lets it finish loading.
        const hung = new Error("The board's logic did not finish rendering within 5 s; it may loop forever. Fix the logic (or remove it with a logic operation) and preview again.");
        const loaded = await Promise.race([
          w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(designFrameHtml(b.html, randomUUID(), false, { system: packForDesign(d), slide }))}`).then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), RUNTIME_READY_MS + 3_000)),
        ]);
        if (!loaded) throw hung;
        if (scale !== 1) w.webContents.setZoomFactor(scale);
        // A design component renders after its runtime boots; logic that never
        // finishes (an endless loop) fails here, with a reason, not at the window timeout.
        const rendered = await Promise.race([
          w.webContents.executeJavaScript("window.__aegisRuntime?window.__aegisRuntime.ready.then(()=>true):true").catch(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), RUNTIME_READY_MS)),
        ]);
        if (!rendered) throw hung;
        // What the screenshot alone might not show: overlaps, clipping, emptiness, size.
        // An isolated world: the board's logic can't patch the DOM APIs the checks use.
        const warnings = (await w.webContents.executeJavaScriptInIsolatedWorld(CHECKS_WORLD, [
          { code: checks ? renderChecksScript(b.width, b.height) : READY_SCRIPT },
        ]).catch(() => (checks ? ["Checks could not run on this board; judge the screenshot alone."] : []))) as string[];
        if (checks) {
          // Reported from inside the board, so it is the board's text: quoted, one line, short.
          const errors = (await w.webContents.executeJavaScript(RUNTIME_ERRORS).catch(() => [])) as unknown[];
          for (const error of errors.filter((e): e is string => typeof e === "string").slice(0, 8))
            warnings.push(`Logic error (reported by the board): ${JSON.stringify(error.replace(/[\u0000-\u001f\u2028\u2029]+/g, " ").slice(0, 200))}`);
          // How far the board strays from the design system it loads.
          const pack = packForDesign(d);
          if (pack) warnings.push(...adherenceWarnings(b.html, pack));
        }
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

/**
 * Every board of a design as one PDF, a page per board at the board's own
 * size (CSS named pages), in the same isolated, request-blocking window as
 * previews. Boards render in their usual script-free frames.
 */
export function designPdf(
  boards: { id: string; html: string; width: number; height: number }[],
  signal?: AbortSignal,
  system?: DesignSystemPack | null,
): Promise<Uint8Array> {
  const job = captureTail
    .catch(() => {})
    .then(async () => {
      if (!boards.length) throw new Error("This design has no boards to export.");
      const escape = (html: string) => html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      // A deck is one page per slide.
      const sheets = boards.flatMap((b) => (isDesignDeck(b.html) ? designSlides(b.html).map((_, slide) => ({ ...b, slide })) : [{ ...b, slide: undefined as number | undefined }]));
      const pages = sheets
        .map(
          (b, i) =>
            `<section class="page p${i}"><iframe sandbox="allow-scripts" srcdoc="${escape(designFrameHtml(b.html, randomUUID(), false, { mode: "edit", system, slide: b.slide }))}" style="width:${b.width}px;height:${b.height}px"></iframe></section>`,
        )
        .join("");
      const sizes = sheets.map((b, i) => `@page s${i}{size:${b.width}px ${b.height}px;margin:0}.p${i}{page:s${i}}`).join("");
      // srcdoc frames inherit this policy: allow what each board's own nonce policy allows.
      const doc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src about: data:"><style>${sizes}html,body{margin:0;padding:0}.page{display:block;break-after:page}.page:last-child{break-after:auto}iframe{display:block;border:0}</style></head><body>${pages}</body></html>`;
      const partition = `design-pdf-${randomUUID()}`;
      const isolated = electronSession.fromPartition(partition);
      isolated.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
      isolated.webRequest.onBeforeRequest((request, done) =>
        done({ cancel: !request.url.startsWith("data:") && request.url !== "about:blank" && request.url !== "about:srcdoc" }),
      );
      const w = new BrowserWindow({
        show: false,
        width: Math.max(...boards.map((b) => b.width)),
        height: 900,
        webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
      });
      w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      w.webContents.on("will-navigate", (e) => e.preventDefault());
      const stop = () => {
        if (!w.isDestroyed()) w.destroy();
      };
      const timeout = setTimeout(stop, 60_000);
      signal?.addEventListener("abort", stop, { once: true });
      try {
        await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(doc)}`);
        // Design components render in their own (sandboxed, out-of-process) frames.
        await Promise.all(
          w.webContents.mainFrame.framesInSubtree
            .filter((f) => f !== w.webContents.mainFrame)
            .map((f) => f.executeJavaScript("window.__aegisRuntime?window.__aegisRuntime.ready:null").catch(() => null)),
        );
        await w.webContents.executeJavaScript(
          "(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true})()",
        );
        signal?.throwIfAborted();
        return new Uint8Array(
          await w.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { marginType: "none" } }),
        );
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
