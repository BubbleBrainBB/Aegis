import { BrowserWindow, session as electronSession } from "electron";
import { randomUUID } from "crypto";

/**
 * Loads one served project page in a hidden window, waits until it has
 * settled (Babel compiles JSX after load, then React renders), and returns a
 * screenshot with what the page reported: script errors, failed loads and a
 * few DOM facts a screenshot can't show. design_show, design_ready and the
 * verifier all look at pages this way.
 */
export interface ProjectCapture {
  dataUrl: string;
  width: number;
  height: number;
  /** Errors the page hit: scripts, promises, console.error, failed loads. */
  errors: string[];
  /** Measured facts worth a look (undefined CSS variables, horizontal overflow, an empty page). */
  warnings: string[];
  title: string;
}

const SETTLE_MAX_MS = 12_000;
const QUIET_MS = 500;
let tail: Promise<unknown> = Promise.resolve();

/** Runs in the page once it settled: facts the reviewer needs, not a verdict. */
const FACTS_SCRIPT = `(() => {
  const warnings = [];
  const defined = new Set();
  const used = new Map();
  const note = (text, where) => {
    const re = /var\\(\\s*(--[\\w-]+)/g; let m;
    while ((m = re.exec(text))) if (!used.has(m[1])) used.set(m[1], where);
  };
  const walk = (rules, where) => {
    for (const rule of rules) {
      if (rule.cssRules) walk(rule.cssRules, where);
      const style = rule.style;
      if (!style) continue;
      for (let i = 0; i < style.length; i++) {
        const name = style[i];
        if (name.startsWith("--")) defined.add(name);
        note(style.getPropertyValue(name), where);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules, sheet.href ? sheet.href.split("/").slice(-1)[0] : "a <style> block"); } catch (e) {}
  }
  for (const el of document.querySelectorAll("[style]")) {
    const style = el.style;
    for (let i = 0; i < style.length; i++) if (style[i].startsWith("--")) defined.add(style[i]);
    note(el.getAttribute("style") || "", "inline style on <" + el.tagName.toLowerCase() + ">");
  }
  const missing = [...used].filter(([name]) => !defined.has(name)).slice(0, 12);
  if (missing.length) warnings.push("CSS variables used but never defined (they fall back silently): " + missing.map(([n, w]) => n + " in " + w).join(", "));
  const doc = document.documentElement;
  if (doc.scrollWidth > window.innerWidth + 1) warnings.push("The page is wider than the viewport (" + doc.scrollWidth + "px at " + window.innerWidth + "px): something does not reflow or shrink.");
  const text = (document.body && document.body.innerText || "").trim();
  const painted = [...document.body ? document.body.querySelectorAll("*") : []].some((el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; });
  if (!text && !painted) warnings.push("Nothing rendered: the page is empty.");
  return { warnings, title: document.title, height: Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0) };
})()`;

export function captureProjectPage(
  url: string,
  options: { width?: number; height?: number; fullPage?: boolean; signal?: AbortSignal; maxDimension?: number } = {},
): Promise<ProjectCapture> {
  const job = tail
    .catch(() => {})
    .then(() => capture(url, options));
  tail = job;
  return job;
}

async function capture(
  url: string,
  { width = 1280, height = 800, fullPage = false, signal, maxDimension = 1600 }: { width?: number; height?: number; fullPage?: boolean; signal?: AbortSignal; maxDimension?: number },
): Promise<ProjectCapture> {
  signal?.throwIfAborted();
  const partition = `design-project-capture-${randomUUID()}`;
  const isolated = electronSession.fromPartition(partition);
  isolated.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  const errors: string[] = [];
  let inflight = 0;
  let lastActivity = Date.now();
  isolated.webRequest.onBeforeRequest((request, done) => {
    const blocked = request.url.startsWith("file:");
    if (!blocked) {
      inflight++;
      lastActivity = Date.now();
    }
    done({ cancel: blocked });
  });
  const settle = () => {
    inflight = Math.max(0, inflight - 1);
    lastActivity = Date.now();
  };
  isolated.webRequest.onCompleted((details) => {
    settle();
    if (details.statusCode >= 400) errors.push(`Failed to load ${details.url.split("/").slice(-1)[0] || details.url} (HTTP ${details.statusCode})`);
  });
  isolated.webRequest.onErrorOccurred((details) => {
    settle();
    if (details.error !== "net::ERR_ABORTED") errors.push(`Failed to load ${details.url} (${details.error})`);
  });
  const w = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Links between the project's pages are fine to follow; leaving the project is not.
  const origin = new URL(url).origin;
  w.webContents.on("will-navigate", (e, target) => {
    if (!target.startsWith(origin)) e.preventDefault();
  });
  w.webContents.on("console-message", (details) => {
    if (details.level === "error" && details.message) errors.push(details.message.slice(0, 2000));
  });
  const destroy = () => {
    if (!w.isDestroyed()) w.destroy();
  };
  const hardStop = setTimeout(destroy, SETTLE_MAX_MS + 15_000);
  signal?.addEventListener("abort", destroy, { once: true });
  try {
    await w.loadURL(url).catch((error) => {
      if (w.isDestroyed()) throw new Error("The page did not finish loading.");
      errors.push(`The page failed to load: ${error instanceof Error ? error.message : String(error)}`);
    });
    // Quiet network and a DOM that stopped changing: Babel and React are done.
    await w.webContents.executeJavaScript(
      "window.__aegisMutations=0;new MutationObserver(()=>window.__aegisMutations++).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});true",
    ).catch(() => {});
    const started = Date.now();
    let lastMutations = -1;
    let stableSince = Date.now();
    while (Date.now() - started < SETTLE_MAX_MS) {
      signal?.throwIfAborted();
      await new Promise((r) => setTimeout(r, 120));
      if (w.isDestroyed()) throw new Error("The page did not finish loading.");
      const mutations = (await w.webContents.executeJavaScript("window.__aegisMutations||0").catch(() => 0)) as number;
      if (mutations !== lastMutations) {
        lastMutations = mutations;
        stableSince = Date.now();
      }
      if (inflight === 0 && Date.now() - lastActivity > QUIET_MS && Date.now() - stableSince > QUIET_MS) break;
    }
    await w.webContents.executeJavaScript(
      "(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>null)));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true})()",
    ).catch(() => {});
    const hostErrors = (await w.webContents.executeJavaScript("(window.__aegisHost&&window.__aegisHost.errors)||[]").catch(() => [])) as unknown[];
    for (const e of hostErrors) if (typeof e === "string" && !errors.includes(e)) errors.push(e);
    const facts = (await w.webContents.executeJavaScript(FACTS_SCRIPT).catch(() => ({ warnings: [], title: "", height }))) as {
      warnings: string[];
      title: string;
      height: number;
    };
    if (fullPage && facts.height > height) {
      w.setContentSize(width, Math.min(facts.height, 6000));
      await new Promise((r) => setTimeout(r, 250));
    }
    signal?.throwIfAborted();
    let image = await w.webContents.capturePage();
    const size = image.getSize();
    if (size.width > width) image = image.resize({ width, height: Math.round((size.height * width) / size.width), quality: "best" });
    const s = image.getSize();
    if (s.width > maxDimension || s.height > maxDimension) {
      const k = maxDimension / Math.max(s.width, s.height);
      image = image.resize({ width: Math.round(s.width * k), height: Math.round(s.height * k), quality: "best" });
    }
    while (image.toPNG().length > 2_900_000) {
      const z = image.getSize();
      image = image.resize({ width: Math.max(1, Math.round(z.width * 0.8)), height: Math.max(1, Math.round(z.height * 0.8)) });
    }
    return {
      dataUrl: image.toDataURL(),
      width: image.getSize().width,
      height: image.getSize().height,
      errors: [...new Set(errors)].slice(0, 30),
      warnings: facts.warnings,
      title: facts.title,
    };
  } finally {
    clearTimeout(hardStop);
    signal?.removeEventListener("abort", destroy);
    destroy();
    await isolated.clearStorageData().catch(() => {});
  }
}
