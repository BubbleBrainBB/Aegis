import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useAppReducedMotion } from '../hooks/useAppReducedMotion';
import { useAppStore } from '../store/useAppStore';
import { createDotField } from '../theme/dot-field';
import { currentBackdrop, THEME_APPLIED_EVENT } from '../theme/themes';
import { isThemeBackdrop } from '../theme/theme-types';

/** Frames per second while the picture moves: it drifts slowly, so this is plenty. */
const FRAME_MS = 1000 / 12;

function subscribeTheme(onChange: () => void): () => void {
  window.addEventListener(THEME_APPLIED_EVENT, onChange);
  return () => window.removeEventListener(THEME_APPLIED_EVENT, onChange);
}
const backdropSnapshot = () => {
  const { kind, motion } = currentBackdrop();
  return kind ? `${kind}:${motion ? 'moving' : 'still'}` : '';
};

/**
 * The window's dot-matrix backdrop, under every panel. Renders nothing unless
 * the theme asks for one. It keeps still while the open task is running (an
 * answer is being written), while the window is hidden or in the background,
 * and when motion is turned off in the theme or reduced by the user.
 */
export function DotFieldBackdrop() {
  const host = useRef<HTMLDivElement>(null);
  // A boolean, so streaming text does not re-render this.
  const paused = useAppStore((s) => (s.activeSessionId ? s.sessions[s.activeSessionId]?.status === 'running' : false));
  const [kind, motion] = useSyncExternalStore(subscribeTheme, backdropSnapshot, () => '').split(':');
  const reducedMotion = useAppReducedMotion();
  const still = paused || reducedMotion || motion !== 'moving';
  const stillRef = useRef(still);
  stillRef.current = still;
  const wake = useRef<() => void>(() => {});

  useEffect(() => {
    const element = host.current;
    if (!element || !isThemeBackdrop(kind)) return;
    const field = createDotField(element, kind);
    let clock = 0; // seconds of motion shown so far; standing still does not advance it
    let last = 0;
    let frame = 0;
    let stale = true; // the canvas needs a paint even when nothing moves
    const moving = () => !stillRef.current && document.visibilityState === 'visible' && document.hasFocus();
    const tick = (now: number) => {
      frame = 0;
      const elapsed = last ? now - last : FRAME_MS;
      if (stale || elapsed >= FRAME_MS) {
        // A long gap (a hidden window) must not show as a jump.
        if (moving() && last) clock += Math.min(elapsed, 250) / 1000;
        last = now;
        stale = false;
        field.paint(clock);
      }
      if (moving()) frame = requestAnimationFrame(tick);
      else last = 0;
    };
    const run = () => {
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const refit = () => {
      field.resize();
      stale = true;
      run();
    };
    wake.current = run;
    const observer = new ResizeObserver(refit);
    observer.observe(element);
    document.addEventListener('visibilitychange', run);
    window.addEventListener('focus', run);
    run();
    return () => {
      wake.current = () => {};
      observer.disconnect();
      document.removeEventListener('visibilitychange', run);
      window.removeEventListener('focus', run);
      if (frame) cancelAnimationFrame(frame);
      field.destroy();
    };
  }, [kind]);

  // Motion was switched back on: pick the loop up again.
  useEffect(() => {
    if (!still) wake.current();
  }, [still]);

  if (!isThemeBackdrop(kind)) return null;
  return <div ref={host} aria-hidden className="aegis-dot-field" data-backdrop={kind} />;
}
