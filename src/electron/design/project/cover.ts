import { getDesignRepository } from "../service";
import { captureProjectPage } from "./capture";
import { pageUrl } from "./service";

/**
 * Card covers for design projects: the first page at a desktop size, small,
 * kept per version so the Design home doesn't load every prototype live.
 */
const covers = new Map<string, Promise<{ dataUrl: string } | null>>();

export function projectCover(sessionId: string, documentId: string): Promise<{ dataUrl: string } | null> {
  const doc = getDesignRepository().read(sessionId, documentId);
  if (doc.kind !== "project") return Promise.resolve(null);
  const page = (doc.files ?? []).find((f) => !f.path.includes("/") && /\.html?$/i.test(f.path))?.path;
  if (!page) return Promise.resolve(null);
  const key = `${documentId}:${doc.revision}`;
  let cover = covers.get(key);
  if (!cover) {
    cover = pageUrl(doc, page)
      .then((url) => captureProjectPage(url, { width: 1280, height: 800, maxDimension: 640 }))
      .then((c) => ({ dataUrl: c.dataUrl }))
      .catch(() => null);
    // Older versions' covers go.
    for (const k of covers.keys()) if (k.startsWith(`${documentId}:`)) covers.delete(k);
    covers.set(key, cover);
  }
  return cover;
}
