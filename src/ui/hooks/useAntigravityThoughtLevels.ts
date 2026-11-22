import { useEffect, useState } from 'react';
import type { AntigravityThoughtLevels } from '../types';

// Levels are per model and each first read is an ACP round trip in the main
// process, so share one request per model across every mounted composer.
const requests = new Map<string, Promise<AntigravityThoughtLevels>>();
const resolved = new Map<string, AntigravityThoughtLevels>();

function requestLevels(key: string): Promise<AntigravityThoughtLevels> {
  let request = requests.get(key);
  if (!request) {
    request = window.electron.getAntigravityThoughtLevels(key || null).then((levels) => {
      // A failed read (CLI missing, offline, probe timeout) must not stick for
      // the session; an empty list from a successful read is a real answer.
      if (!levels.failed && (levels.levels.length > 0 || levels.model)) resolved.set(key, levels);
      else requests.delete(key);
      return levels;
    });
    request.catch(() => requests.delete(key));
    requests.set(key, request);
  }
  return request;
}

/** Thinking levels for an Antigravity model ('' / null = the Default row); null while loading. */
export function useAntigravityThoughtLevels(model: string | null, enabled = true): AntigravityThoughtLevels | null {
  const key = model?.trim() || '';
  const [levels, setLevels] = useState<AntigravityThoughtLevels | null>(() => resolved.get(key) ?? null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLevels(resolved.get(key) ?? null);
    requestLevels(key)
      .then((next) => {
        if (!cancelled) setLevels(next);
      })
      .catch(() => {
        // Picker falls back to the models-only view.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, key]);

  return levels;
}
