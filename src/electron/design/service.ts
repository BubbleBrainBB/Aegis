import { app, BrowserWindow, session as electronSession } from "electron";
import { join } from "path";
import { randomUUID } from "crypto";
import { DesignRepository } from "./repository";
import { designFrameHtml, sanitizeDesignHtml } from "./html";
import { renderChecksScript } from "./render-checks";
import { moveDesignFocus } from "./focus";
import { designProjectRoot } from "./styles";
import type { DesignDocument, DesignPreview } from "../../shared/design-types";
import { designSystemPack, withLibraryFonts } from "./system-pack";
import { adherenceWarnings } from "./adherence";
import { designSlides, isDesignDeck } from "../../shared/design-deck";
import { resolveFrameAssets, type DesignSystemPack } from "../../shared/design-system-pack";
import { designLogicOf } from "../../shared/design-component";

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
export function packForDesign(d: Pick<DesignDocument, "system" | "project" | "sessionId"> & { boards?: readonly { html: string }[] }): DesignSystemPack | null {
  try {
    return withLibraryFonts(designSystemPack(d.system, d.project || designProjectRoot(d.sessionId)), d.boards);
  } catch (error) {
    console.warn("Failed to read the design system:", error);
    return null;
  }
}

/**
 * What a design's boards load when the main process renders them: its
 * design system, plus the design's own images (aegis-asset:img_…).
 */
export function renderSystemFor(d: Pick<DesignDocument, "id" | "system" | "project" | "sessionId"> & { boards?: readonly { html: string }[] }): DesignSystemPack | null {
  const pack = packForDesign(d);
  let images: Record<string, string> = {};
  try {
    images = getDesignRepository().renderAssets(d.id);
  } catch {}
  if (!pack && !Object.keys(images).length) return null;
  return {
    id: pack?.id ?? "none",
    name: pack?.name ?? "",
    css: pack?.css ?? "",
    components: pack?.components ?? {},
    assets: { ...(pack?.assets ?? {}), ...images },
    fonts: pack?.fonts ?? [],
    signature: `${pack?.signature ?? ""}:${Object.keys(images).join(",")}`,
  };
}

// Each capture owns a fresh, nonpersistent Chromium session, with no preload.
// Serialize captures to bound Chromium/GPU memory even when tools run in parallel.
let captureTail: Promise<unknown> = Promise.resolve();
/** Fonts, images and two frames: the board as it will look, nothing measured. */
// Every registered face is loaded explicitly: fonts.ready alone can resolve
// before layout has asked for a face, and text in a loading face is not painted yet.
const READY_SCRIPT =
  "(async()=>{await (window.__aegisRuntime?window.__aegisRuntime.ready:null);await Promise.all([...document.fonts].map(f=>f.load().catch(()=>null)));await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>null)));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return []})()";
/** Where design_preview's checks run: a world of their own, apart from board logic. */
const CHECKS_WORLD = 1029;
const RUNTIME_READY_MS = 5_000;
/** A design component's logic errors, for the agent: they don't show in a screenshot. */
const RUNTIME_ERRORS =
  "(window.__aegisRuntime?[...window.__aegisRuntime.errors]:[])";
const SAVED_EDIT_MS = 4_000;
/** Reported from inside the board, so it is the board's text: quoted, one line, short. */
const quoted = (text: string) => JSON.stringify(text.replace(/[\u0000-\u001f\u2028\u2029]+/g, " ").slice(0, 200));
/**
 * The canvas applies every saved edit by rebuilding the board's page under its
 * running logic, which a fresh load never exercises. This replays one such
 * edit (the same HTML) and reports what the logic had added to the page and
 * did not put back, and the errors it raised. Nodes that come and go on their
 * own are left alone: only a kind of node that was there, stayed there, and is
 * entirely gone after the edit counts.
 */
async function savedEditWarnings(w: BrowserWindow, html: string, known: readonly string[]): Promise<string[]> {
  const script = `(async()=>{const rt=window.__aegisRuntime;if(!rt||typeof rt.added!=="function")return null;const wait=ms=>new Promise(r=>setTimeout(r,ms));const first=rt.added();if(first.length)await wait(250);const before=rt.added();rt.update(${JSON.stringify(html)});await wait(300);return {first,before,after:rt.added(),errors:[...rt.errors]}})()`;
  const result = (await Promise.race([
    w.webContents.executeJavaScript(script).catch(() => null),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), SAVED_EDIT_MS)),
  ])) as { first?: unknown; before?: unknown; after?: unknown; errors?: unknown } | "hung" | null;
  if (result === "hung") return ["After a saved edit the board's logic did not finish within 4 s; its updated() may loop forever."];
  if (!result || typeof result !== "object") return [];
  const tags = (value: unknown) => {
    const counts = new Map<string, number>();
    if (Array.isArray(value))
      for (const tag of value.slice(0, 200))
        if (typeof tag === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return counts;
  };
  const first = tags(result.first), before = tags(result.before), after = tags(result.after);
  const lost = [...before].filter(([tag]) => first.has(tag) && !after.has(tag)).slice(0, 6);
  const out: string[] = [];
  if (lost.length)
    out.push(
      `After a saved edit, what the logic added to the page is gone (${lost.map(([tag, n]) => (n > 1 ? `${n} ${tag}` : tag)).join(", ")}): the canvas rebuilds the page on every edit and keeps the logic running, so mounted() does not run again and that part of the board goes blank. Add these nodes in a method that both mounted() and updated() call (design_guide topic components).`,
    );
  if (Array.isArray(result.errors))
    for (const error of result.errors.filter((e): e is string => typeof e === "string" && !known.includes(e)).slice(0, 4))
      out.push(`Logic error after a saved edit (reported by the board): ${quoted(error)}`);
  return out;
}

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
      const system = renderSystemFor(d);
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
          // After a timeout the window is destroyed and this rejects; the race is already decided.
          w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(designFrameHtml(b.html, randomUUID(), false, { system, slide }))}`).then(() => true, (error) => {
            if (w.isDestroyed()) return false;
            throw error;
          }),
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
        let logicErrors: string[] = [];
        if (checks) {
          const errors = (await w.webContents.executeJavaScript(RUNTIME_ERRORS).catch(() => [])) as unknown[];
          logicErrors = (Array.isArray(errors) ? errors : []).filter((e): e is string => typeof e === "string");
          for (const error of logicErrors.slice(0, 8)) warnings.push(`Logic error (reported by the board): ${quoted(error)}`);
          // How far the board strays from the design system it loads.
          const pack = packForDesign(d);
          if (pack) warnings.push(...adherenceWarnings(b.html, pack));
        }
        signal?.throwIfAborted();
        let image = await w.webContents.capturePage();
        // The screenshot is the fresh load; then one saved edit, as the canvas applies it.
        if (checks && designLogicOf(b.html)?.trim())
          warnings.push(...(await savedEditWarnings(w, resolveFrameAssets(sanitizeDesignHtml(b.html), system?.assets), logicErrors)));
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
      const doc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src about: data:"><style>${sizes}html,body{margin:0;padding:0}.page{display:block;break-after:page}.page:last-child{break-after:auto}iframe{display:block;border:0}</style></head><body>${pages}</body></html>`;
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
          "(async()=>{await Promise.all([...document.fonts].map(f=>f.load().catch(()=>null)));await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true})()",
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
