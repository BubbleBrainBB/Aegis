import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import type { AddressInfo } from "net";
import { extname, join } from "path";
import libraries from "../../../shared/design-project-libraries.json";
import { DESIGN_HOST_SCRIPT } from "./host-script";
import { isInside } from "./files";

/**
 * One local HTTP server per design project, serving only its folder under a
 * random token (127.0.0.1, its own port, so each project is its own origin).
 * Pages get the host script, and the pinned library URLs the design prompt
 * uses are answered from the copies shipped with the app, so prototypes run
 * offline with their integrity hashes intact. The files on disk keep the
 * public URLs, so they still work when handed off.
 */
interface Running {
  server: Server;
  port: number;
  token: string;
  folder: string;
  /** The folder with links resolved: what every served file must stay inside. */
  root: string;
}
const servers = new Map<string, Promise<Running>>();

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".tsx": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".obj": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};

const libraryDir = () => join(__dirname, "libs");

/** A page as served: the host script first in <head>, the pinned libraries local. */
export function servedPage(html: string, token: string): string {
  let out = html;
  for (const lib of libraries) out = out.split(lib.url).join(`/${token}/__aegis/lib/${lib.file}`);
  const tag = `<script src="/${token}/__aegis/host.js"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(out);
  if (head) return out.slice(0, head.index + head[0].length) + tag + out.slice(head.index + head[0].length);
  const html_ = /<html(\s[^>]*)?>/i.exec(out);
  if (html_) return out.slice(0, html_.index + html_[0].length) + tag + out.slice(html_.index + html_[0].length);
  return tag + out;
}

function send(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

async function handle(running: Running, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url || "/", "http://127.0.0.1").pathname);
  } catch {
    return send(res, 400, "Bad request");
  }
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== running.token) return send(res, 404, "Not found");
  const rest = segments.slice(1).join("/");

  if (rest === "__aegis/host.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(req.method === "HEAD" ? undefined : DESIGN_HOST_SCRIPT);
  }
  if (rest.startsWith("__aegis/lib/")) {
    const lib = libraries.find((l) => l.file === rest.slice("__aegis/lib/".length));
    if (!lib) return send(res, 404, "Not found");
    try {
      const bytes = await fs.readFile(join(libraryDir(), `${lib.file}.gz`));
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Encoding": "gzip",
        "Cache-Control": "public, max-age=31536000, immutable",
        // The prompt's tags load these with crossorigin="anonymous".
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(req.method === "HEAD" ? undefined : bytes);
    } catch {
      return send(res, 500, "Library missing from this build of Aegis.");
    }
  }

  if (!rest) return sendIndex(running, res);
  const target = join(running.folder, rest);
  let real: string;
  try {
    real = await fs.realpath(target);
  } catch {
    return send(res, 404, `No file ${rest} in this design.`);
  }
  // Links and ../ never reach outside the project.
  if (!isInside(running.root, real)) return send(res, 404, "Not found");
  let stat;
  try {
    stat = await fs.stat(real);
  } catch {
    return send(res, 404, "Not found");
  }
  if (stat.isDirectory()) return send(res, 404, "Not found");
  const ext = extname(real).toLowerCase();
  const type = TYPES[ext] ?? "application/octet-stream";
  // Pages change under the agent's hands: never cached.
  if (ext === ".html" || ext === ".htm") {
    const html = await fs.readFile(real, "utf8");
    return send(res, 200, req.method === "HEAD" ? "" : servedPage(html, running.token), type);
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Cache-Control": "no-store" });
  if (req.method === "HEAD") return res.end();
  res.end(await fs.readFile(real));
}

/** The folder root: links to its pages, for opening the project in a browser. */
async function sendIndex(running: Running, res: ServerResponse) {
  const entries = await fs.readdir(running.folder).catch(() => [] as string[]);
  const pages = entries.filter((name) => /\.html?$/i.test(name)).sort();
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const items = pages.map((p) => `<li><a href="/${running.token}/${encodeURI(p)}">${escape(p)}</a></li>`).join("");
  send(res, 200, `<!doctype html><meta charset="utf-8"><title>Design</title><ul>${items || "<li>No pages yet.</li>"}</ul>`, TYPES[".html"]);
}

async function start(folder: string): Promise<Running> {
  const root = await fs.realpath(folder).catch(() => folder);
  const running = { token: randomUUID(), folder, root, port: 0 } as Running;
  running.server = createServer((req, res) => {
    void handle(running, req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "Server error");
      else res.destroy();
    });
  });
  running.port = await new Promise<number>((resolve, reject) => {
    running.server.once("error", reject);
    running.server.listen(0, "127.0.0.1", () => resolve((running.server.address() as AddressInfo).port));
  });
  running.server.unref();
  return running;
}

/** The project's server, started on first use. */
export async function projectServer(documentId: string, folder: string): Promise<{ base: string; origin: string }> {
  let running = servers.get(documentId);
  if (running) {
    const r = await running.catch(() => null);
    // A project moved to another folder gets a fresh server.
    if (!r || r.folder !== folder) {
      r?.server.close();
      servers.delete(documentId);
      running = undefined;
    }
  }
  if (!running) {
    running = start(folder);
    servers.set(documentId, running);
    running.catch(() => servers.delete(documentId));
  }
  const r = await running;
  return { origin: `http://127.0.0.1:${r.port}`, base: `http://127.0.0.1:${r.port}/${r.token}/` };
}

/** The URL a project file is served at. */
export async function projectFileUrl(documentId: string, folder: string, path: string): Promise<string> {
  const { base } = await projectServer(documentId, folder);
  return base + path.split("/").map(encodeURIComponent).join("/");
}

export function stopProjectServer(documentId: string) {
  const running = servers.get(documentId);
  servers.delete(documentId);
  void running?.then((r) => r.server.close()).catch(() => {});
}
