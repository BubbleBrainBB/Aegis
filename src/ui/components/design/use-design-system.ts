import { useEffect, useState } from "react";
import type { DesignSystemPack } from "../../../shared/design-system-pack";

/**
 * The design system a design's boards load, from the main process. One
 * object per signature, so frames keyed on it reload only when the system
 * really changes; refetched when the window regains focus (project files
 * may have changed) and when the design's recorded system does.
 */
const cache = new Map<string, DesignSystemPack | null>();
const inflight = new Map<string, Promise<DesignSystemPack | null>>();

function fetchPack(sessionId: string, documentId: string): Promise<DesignSystemPack | null> {
  const key = `${sessionId}:${documentId}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = (window.electron?.design?.system?.({ sessionId, documentId }) ?? Promise.resolve(null))
      .catch(() => null)
      .then((pack) => {
        const previous = cache.get(key);
        const next = previous && pack && previous.signature === pack.signature ? previous : pack ?? null;
        cache.set(key, next);
        return next;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

export function useDesignSystem(
  sessionId: string | undefined,
  documentId: string | undefined,
  /** Changes when the design's recorded system does (e.g. its `system` field). */
  version?: unknown,
): DesignSystemPack | null {
  const key = sessionId && documentId ? `${sessionId}:${documentId}` : "";
  const [pack, setPack] = useState<DesignSystemPack | null>(() => (key ? cache.get(key) ?? null : null));
  useEffect(() => {
    if (!sessionId || !documentId) {
      setPack(null);
      return;
    }
    let live = true;
    const load = () => void fetchPack(sessionId, documentId).then((p) => live && setPack(p));
    load();
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.removeEventListener("focus", load);
    };
  }, [sessionId, documentId, version]);
  return pack;
}
