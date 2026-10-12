import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Rect } from "./canvas-geometry";

/** Menus own arrows/Escape so they never reach the canvas selection shortcuts. */
export function useDesignMenu(open: boolean, menu: RefObject<HTMLElement | null>, trigger: RefObject<HTMLElement | null>, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const el = menu.current;
    const items = () => Array.from(el?.querySelectorAll<HTMLElement>('button:not(:disabled), [role="option"]:not([aria-disabled="true"])') ?? []);
    const frame = requestAnimationFrame(() => {
      const rows = items();
      (rows.find(row => row.getAttribute("aria-selected") === "true" || row.getAttribute("aria-checked") === "true") ?? rows[0])?.focus();
    });
    const dismiss = (restore: boolean) => {
      closeRef.current();
      if (restore) trigger.current?.focus({ preventScroll: true });
    };
    const outside = (event: PointerEvent) => {
      if (!el?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) dismiss(false);
    };
    const key = (event: KeyboardEvent) => {
      if (!el?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) return;
      // Keep Enter, Space and letter shortcuts away from the canvas too.
      // Native button activation still runs because its default is not prevented.
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); dismiss(true); }
      // Start normal tab navigation at the trigger, not a detached portal item.
      else if (event.key === "Tab") dismiss(true);
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const rows = items();
        const current = rows.indexOf(document.activeElement as HTMLElement);
        const index = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
        rows[index]?.focus();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", key, true); };
  }, [open, menu, trigger]);
}

/** Portal menus escape the selection strip's horizontal scrolling boundary. */
export function DesignActionMenu({ trigger, onClose, children, label, align = "end", className = "" }: {
  trigger: RefObject<HTMLElement | null>;
  onClose(): void;
  children: ReactNode;
  label?: string;
  align?: "start" | "end";
  className?: string;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useDesignMenu(true, menu, trigger, onClose);
  useLayoutEffect(() => {
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const popup = menu.current;
      if (!anchor || !popup) return;
      const left = Math.max(8, Math.min(window.innerWidth - popup.offsetWidth - 8, align === "start" ? anchor.left : anchor.right - popup.offsetWidth));
      const top = anchor.bottom + 6 + popup.offsetHeight <= window.innerHeight - 8
        ? anchor.bottom + 6 : Math.max(8, anchor.top - popup.offsetHeight - 6);
      setPosition({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [trigger, align]);
  return createPortal(<div ref={menu} role="menu" aria-label={label} className={`design-surface design-action-menu ${className}`} data-canvas-ui style={position}
    onPointerDown={event => event.stopPropagation()}>{children}</div>, document.body);
}

/** CDS-style tooltip and separate button paint: pressing never scales the glyph. */
export function DesignToolButton({ title, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const id = useId();
  const host = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState<DOMRect>();
  const hide = () => { clearTimeout(timer.current); setPosition(undefined); };
  const show = (delay = 300) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const rect = host.current?.getBoundingClientRect();
      if (rect) setPosition(rect);
    }, delay);
  };
  useEffect(() => { window.addEventListener("scroll", hide, true); window.addEventListener("blur", hide); return () => { clearTimeout(timer.current); window.removeEventListener("scroll", hide, true); window.removeEventListener("blur", hide); }; }, []);
  return <span ref={host} className="design-tool-wrap" onPointerEnter={e => { if (e.pointerType !== "touch" && title) show(); }} onPointerLeave={hide} onPointerDown={hide} onFocus={e => { if (e.target.matches(":focus-visible") && title) show(0); }} onBlur={hide}>
    <button {...props} className={`design-tool-button ${className}`} aria-describedby={position ? id : undefined}>
      <span className="design-button-paint" aria-hidden="true" />
      <span className="design-button-content">{children}</span>
    </button>
    {position && title && <DesignTooltip id={id} anchor={position}>{title}</DesignTooltip>}
  </span>;
}

function DesignTooltip({ id, anchor, children }: { id: string; anchor: DOMRect; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const half = node.offsetWidth / 2;
    setPosition({
      left: Math.max(8 + half, Math.min(window.innerWidth - 8 - half, anchor.left + anchor.width / 2)),
      top: anchor.bottom + 4 + node.offsetHeight <= window.innerHeight - 8
        ? anchor.bottom + 4 : Math.max(8, anchor.top - node.offsetHeight - 4),
    });
  }, [anchor, children]);
  return createPortal(<div ref={ref} id={id} role="tooltip" className="design-surface design-tooltip"
    style={position ?? { left: 0, top: 0, visibility: "hidden" }}>{children}</div>, document.body);
}

/** Measured, screen-space strip: stays inside the canvas even at its edges. */
export function DesignFloatingToolbar({ rect, viewport, children }: { rect: Rect; viewport: { width: number; height: number }; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 36 });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setSize({ width: node.offsetWidth, height: node.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const left = Math.max(8, Math.min(viewport.width - size.width - 8, rect.x + rect.width / 2 - size.width / 2));
  const top = Math.max(8, Math.min(viewport.height - size.height - 8, rect.y - size.height - 8));
  return <div ref={ref} role="toolbar" aria-label="Selection actions" className="design-float-bar" data-canvas-ui style={{ left, top, maxWidth: Math.max(0, viewport.width - 16), visibility: size.width ? undefined : "hidden" }} onPointerDown={e => e.stopPropagation()}>{children}</div>;
}

/** Viewer-only layers divider; it never writes to the design document. */
export function DesignLayersSection({ children }: { children: ReactNode }) {
  const [height, setHeight] = useState(168);
  const drag = useRef<{ y: number; height: number } | undefined>(undefined);
  return <>
    <div className="design-inspector-layers" style={{ height }}>{children}</div>
    <div className="design-layers-resizer" role="separator" aria-label="Resize layers list" aria-orientation="horizontal" aria-valuemin={72} aria-valuemax={480} aria-valuenow={height} tabIndex={0}
      onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); drag.current = { y: e.clientY, height }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { if (drag.current) setHeight(Math.min(480, Math.max(72, drag.current.height + e.clientY - drag.current.y))); }}
      onPointerUp={e => { drag.current = undefined; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
      onLostPointerCapture={() => { drag.current = undefined; }}
      onDoubleClick={() => setHeight(168)}
      onKeyDown={e => { if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) { e.preventDefault(); setHeight(e.key === "Home" ? 72 : e.key === "End" ? 480 : Math.min(480, Math.max(72, height + (e.key === "ArrowDown" ? 16 : -16)))); } }} />
  </>;
}
