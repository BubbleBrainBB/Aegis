import { useEffect, useState } from "react";

/**
 * Board, widget and HTML-preview frames are sandboxed srcdoc iframes, which
 * Chromium runs out of process, all of a window's in one shared process. A
 * board whose logic never yields stalls every one of them; recovering ends
 * that process and remounts them all in a fresh one.
 */
const listeners = new Set<() => void>();
/** Board HTML whose logic hung: thumbnails and frames render it without logic. */
const hungBoards = new Set<string>();

export function markBoardHung(html: string) {
  hungBoards.add(html);
  if (hungBoards.size > 50) hungBoards.delete(hungBoards.values().next().value as string);
}
export function isBoardHung(html: string) {
  return hungBoards.has(html);
}

let recovering = false;
/** Ends the sandbox process the named frame runs in, then remounts every sandboxed frame. */
export async function recoverSandboxFrames(frameName: string): Promise<boolean> {
  if (recovering) return false;
  recovering = true;
  try {
    const result = await window.electron?.design?.recoverFrame?.({ frameName });
    if (!result?.recovered) return false;
    // Let the process go before frames ask for a new one.
    await new Promise((r) => setTimeout(r, 150));
    for (const listener of [...listeners]) listener();
    return true;
  } catch {
    return false;
  } finally {
    recovering = false;
  }
}

/** Changes after a recovery; use it in a sandboxed iframe's key so it remounts. */
export function useSandboxEpoch(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const bump = () => setEpoch((n) => n + 1);
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);
  return epoch;
}
