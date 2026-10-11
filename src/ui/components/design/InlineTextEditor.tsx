import { useEffect, useRef, type CSSProperties } from "react";

const px = (v: string | undefined, zoom: number) => {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? `${n * zoom}px` : undefined;
};
/** Padding shorthand from computed styles, scaled to the canvas zoom. */
function padding(value: string | undefined, zoom: number) {
  const parts = (value ?? "").split(/\s+/).filter(Boolean).map((p) => parseFloat(p) || 0);
  if (!parts.length) return undefined;
  const [t, r = t, b = t, l = r] = parts;
  return [t, r, b, l].map((n) => `${n * zoom}px`).join(" ");
}

/**
 * Edits a text layer in place, over the rendered element and in its own type
 * styles. The caret lands where the layer was double-clicked (else at the
 * end); nothing is preselected. Escape, ⌘↵ or clicking away commits.
 */
export function InlineTextEditor({
  rect,
  zoom,
  styles,
  text,
  caret,
  placeholder,
  grow,
  onCommit,
  onCancel,
}: {
  rect: { x: number; y: number; width: number; height: number };
  zoom: number;
  styles: Record<string, string>;
  text: string;
  /** Client point of the double-click that opened the editor. */
  caret?: { x: number; y: number };
  /** Shown while empty, for a new text layer. */
  placeholder?: string;
  /** Grow sideways with the text instead of wrapping (inline layers). */
  grow?: boolean;
  onCommit(value: string): void;
  onCancel(): void;
}) {
  const done = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.textContent = text;
    el.focus();
    const selection = window.getSelection();
    const range = caret && document.caretRangeFromPoint?.(caret.x, caret.y);
    if (selection && range && el.contains(range.startContainer)) {
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } else if (selection) {
      selection.selectAllChildren(el);
      selection.collapseToEnd();
    }
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const value = (box.current?.innerText ?? text).replace(/\n$/, "");
    if (commit && value !== text) onCommit(value);
    else onCancel();
  };
  const style: CSSProperties = {
    left: rect.x,
    top: rect.y,
    ...(grow ? { minWidth: Math.max(rect.width, 24), whiteSpace: "pre" } : { width: Math.max(rect.width, 24) }),
    minHeight: rect.height,
    padding: padding(styles.padding, zoom),
    fontFamily: styles["font-family"],
    fontSize: px(styles["font-size"], zoom),
    fontWeight: styles["font-weight"] as CSSProperties["fontWeight"],
    lineHeight: styles["line-height"] === "normal" ? "normal" : px(styles["line-height"], zoom),
    letterSpacing: styles["letter-spacing"] === "normal" ? "normal" : px(styles["letter-spacing"], zoom),
    textAlign: styles["text-align"] as CSSProperties["textAlign"],
    color: styles.color,
  };
  return (
    <div
      ref={box}
      className="design-inline-text"
      data-canvas-ui
      role="textbox"
      aria-multiline
      aria-label="Edit text"
      data-placeholder={placeholder}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          finish(true);
        }
      }}
    />
  );
}
