import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import {
  MERMAID_CANVAS_CLASS,
  cachedMermaidDiagram,
  mermaidThemeKey,
  mountableMermaidSvg,
  renderMermaidDiagram,
  type MermaidDiagram,
} from '../render/mermaid';
import { THEME_APPLIED_EVENT } from '../theme/themes';

/** A diagram shrinks to fit the message down to this share of its size, then scrolls sideways. */
const SMALLEST_FIT = 0.7;

export interface MermaidDiagramState {
  /** The last diagram drawn; it stays up while a newer one is on its way. */
  diagram: MermaidDiagram | null;
  /** Set when the text of the fence is not a diagram Mermaid can draw. */
  error: string | null;
}

function subscribeToTheme(onChange: () => void) {
  window.addEventListener(THEME_APPLIED_EVENT, onChange);
  return () => window.removeEventListener(THEME_APPLIED_EVENT, onChange);
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || 'Unknown error';
}

const NOTHING: MermaidDiagramState = { diagram: null, error: null };

/**
 * The diagram of a fence's text, redrawn when the app theme changes. Nothing
 * is drawn while `enabled` is off, which is how a fence that is still being
 * written stays source code.
 */
export function useMermaidDiagram(
  code: string,
  enabled: boolean,
  /** Called right before a drawing, or its failure, replaces what is shown. */
  beforeChange?: () => void,
): MermaidDiagramState {
  const themeKey = useSyncExternalStore(subscribeToTheme, mermaidThemeKey);
  const source = enabled ? code.trim() : '';
  const beforeChangeRef = useRef(beforeChange);
  beforeChangeRef.current = beforeChange;
  const [state, setState] = useState<MermaidDiagramState>(() => {
    const known = source ? cachedMermaidDiagram(source, themeKey) : undefined;
    return known ? { diagram: known, error: null } : NOTHING;
  });

  useEffect(() => {
    if (!source) {
      setState(NOTHING);
      return;
    }
    const known = cachedMermaidDiagram(source, themeKey);
    if (known) {
      setState((current) => (current.diagram === known ? current : { diagram: known, error: null }));
      return;
    }
    let cancelled = false;
    renderMermaidDiagram(source, themeKey).then(
      (diagram) => {
        if (cancelled) return;
        beforeChangeRef.current?.();
        setState({ diagram, error: null });
      },
      (error) => {
        if (cancelled) return;
        beforeChangeRef.current?.();
        setState({ diagram: null, error: errorText(error) });
      },
    );
    return () => { cancelled = true; };
  }, [source, themeKey]);

  return state;
}

/** The chat's scroller when the reader is at its end, where new content is followed. */
const CHAT_END_REACH_PX = 120;

export function chatScrollerAtEnd(element: HTMLElement | null): HTMLElement | null {
  const scroller = element?.closest<HTMLElement>('[data-chat-scroll-container]');
  if (!scroller) return null;
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < CHAT_END_REACH_PX ? scroller : null;
}

export function MermaidDiagramView({
  diagram,
  actualSize,
  onFitChange,
}: {
  diagram: MermaidDiagram;
  actualSize: boolean;
  /** Told whether the diagram is shown smaller than its own size. */
  onFitChange?: (shrunk: boolean) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const markup = useMemo(() => ({ __html: mountableMermaidSvg(diagram) }), [diagram]);
  const { width, height } = diagram;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !onFitChange) return;
    const measure = () => {
      const styles = getComputedStyle(viewport);
      const room = viewport.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
      onFitChange(width > room + 0.5);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [width, onFitChange]);

  // A diagram can link its nodes (`click A href "…"`). Followed in place, a
  // link would replace the app itself: web links go to the browser, and
  // nothing else is followed.
  const openLink = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element).closest?.('a');
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href') ?? '';
    if (/^https?:\/\//i.test(href)) void window.electron?.openExternalUrl(href);
  };

  return (
    <div ref={viewportRef} className="md-mermaid-viewport" data-actual-size={actualSize || undefined}>
      <div
        className={MERMAID_CANVAS_CLASS}
        role="img"
        aria-label="Diagram"
        onClick={openLink}
        onAuxClick={openLink}
        style={{
          width: actualSize ? width : `min(${width}px, max(100%, ${Math.round(width * SMALLEST_FIT)}px))`,
          aspectRatio: `${width} / ${height}`,
        }}
        dangerouslySetInnerHTML={markup}
      />
    </div>
  );
}
