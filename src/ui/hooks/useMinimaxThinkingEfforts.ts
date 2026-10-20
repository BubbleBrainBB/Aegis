import { useEffect, useState } from 'react';
import type { MinimaxThinkingEfforts } from '../types';

// Levels are per model and each first read is an ACP round trip in the main
// process, so share one request per model across every mounted composer.
const requests = new Map<string, Promise<MinimaxThinkingEfforts>>();
const resolved = new Map<string, MinimaxThinkingEfforts>();

function requestLevels(key: string): Promise<MinimaxThinkingEfforts> {
  let request = requests.get(key);
  if (!request) {
    request = window.electron.getMinimaxThinkingEfforts(key || null).then((levels) => {
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

/** Thinking efforts for a MiniMax Code model ('' / null = the Default row); null while loading. */
export function useMinimaxThinkingEfforts(model: string | null, enabled = true): MinimaxThinkingEfforts | null {
  const key = model?.trim() || '';
  const [levels, setLevels] = useState<MinimaxThinkingEfforts | null>(() => resolved.get(key) ?? null);

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
