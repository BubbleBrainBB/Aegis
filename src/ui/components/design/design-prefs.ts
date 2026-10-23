import { useState } from "react";

/**
 * A per-viewer on/off preference. Storage may be unavailable (private window,
 * blocked site data), so reads fall back and writes are best effort.
 */
export function useStoredFlag(key: string, fallback: boolean) {
  const [value, setValue] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v === "true";
    } catch {
      return fallback;
    }
  });
  const save = (next: boolean) => {
    setValue(next);
    try {
      if (next === fallback) localStorage.removeItem(key);
      else localStorage.setItem(key, String(next));
    } catch {}
  };
  return [value, save] as const;
}

/** Whether the inspector column is shown. */
export const useInspectorOpen = () => useStoredFlag("aegis.design.inspectorOpen", false);
/** Whether padding and gap guides show on a selected auto layout container. */
export const useLayoutGuides = () => useStoredFlag("aegis.design.layoutGuides", false);
/** Whether comment pins are hidden on the canvas (visual only). */
export const useCommentsHidden = () => useStoredFlag("aegis.design.commentsHidden", false);
