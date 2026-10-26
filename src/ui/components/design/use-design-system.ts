import { useEffect, useMemo, useState } from "react";
import type { DesignSystemPack } from "../../../shared/design-system-pack";

/**
 * What a design's boards load, from the main process: its design system
 * (one object per signature, so frames keyed on it reload only when the
 * system really changes) plus the design's own images (aegis-asset:img_…),
 * fetched as boards come to need ones not yet held. Refetched when the
 * window regains focus (project files may have changed) and when `version`
 * does (the design's system or revision).
 */
const cache = new Map<string, DesignSystemPack | null>();
const inflight = new Map<string, Promise<DesignSystemPack | null>>();
const images = new Map<string, Record<string, string>>();

function fetchPack(sessionId: string, documentId: string): Promise<DesignSystemPack | null> {
  const key = `${sessionId}:${documentId}`;
  let pending = inflight.get(key);
  if (!pending) {
    const previous = cache.get(key);
    pending = (window.electron?.design?.system?.({ sessionId, documentId, signature: previous?.signature }) ?? Promise.resolve(null))
      .catch(() => null)
      .then((answer) => {
        const next = answer && "unchanged" in answer ? previous ?? null : previous && answer && previous.signature === answer.signature ? previous : answer ?? null;
        cache.set(key, next);
        return next;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

async function fetchImages(sessionId: string, documentId: string): Promise<Record<string, string>> {
  const key = documentId;
  const have = images.get(key) ?? {};
  const added = (await window.electron?.design?.assets?.({ sessionId, documentId, have: Object.keys(have) }).catch(() => ({}))) ?? {};
  if (!Object.keys(added).length) return have;
  const next = { ...have, ...added };
  images.set(key, next);
  return next;
}

export function useDesignSystem(
  sessionId: string | undefined,
  documentId: string | undefined,
  /** Changes when the design's recorded system or its images may have. */
  version?: unknown,
): DesignSystemPack | null {
  const key = sessionId && documentId ? `${sessionId}:${documentId}` : "";
  const [pack, setPack] = useState<DesignSystemPack | null>(() => (key ? cache.get(key) ?? null : null));
  const [own, setOwn] = useState<Record<string, string>>(() => (documentId ? images.get(documentId) ?? {} : {}));
  useEffect(() => {
    if (!sessionId || !documentId) {
      setPack(null);
      setOwn({});
      return;
    }
    let live = true;
    const load = () => {
      void fetchPack(sessionId, documentId).then((p) => live && setPack(p));
      void fetchImages(sessionId, documentId).then((m) => live && setOwn(m));
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.removeEventListener("focus", load);
    };
  }, [sessionId, documentId, version]);
  // One object until the system or the set of images changes.
  return useMemo(() => {
    if (!Object.keys(own).length) return pack;
    return {
      id: pack?.id ?? "none",
      name: pack?.name ?? "",
      css: pack?.css ?? "",
      components: pack?.components ?? {},
      assets: { ...(pack?.assets ?? {}), ...own },
      fonts: pack?.fonts ?? [],
      signature: `${pack?.signature ?? ""}:${Object.keys(own).join(",")}`,
    };
  }, [pack, own]);
}
