import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDesignMenu } from "./DesignChrome";
import { Check } from "../icons";

/** Label column + control row, the inspector's basic unit. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="iv-row">
      <span className="iv-label">{label}</span>
      <div className="iv-ctl">{children}</div>
    </div>
  );
}

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="iv-sec">
      <div className="iv-h">
        <h4>{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

export type Option<T extends string> = { value: T; label: string; hint?: string };

/** Compact select with an inline menu; options may carry a short hint. */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
  wide,
}: {
  value: T;
  options: Option<T>[];
  onChange(value: T): void;
  disabled?: boolean;
  label: string;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useDesignMenu(open, menu, trigger, () => setOpen(false));
  useLayoutEffect(() => {
    if (!open || !root.current || !menu.current) return;
    const anchor = root.current.getBoundingClientRect();
    const box = menu.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(window.innerWidth - box.width - 8, anchor.right - box.width)), top: Math.max(8, anchor.bottom + box.height + 6 < window.innerHeight ? anchor.bottom + 6 : anchor.top - box.height - 6) });
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", scroll);
    return () => { window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", scroll); };
  }, [open]);
  const current = options.find((o) => o.value === value);
  return (
    <div ref={root} className={"iv-dd-wrap" + (wide ? " is-wide" : "")}>
      <button
        ref={trigger}
        type="button"
        className={"iv-in iv-dd" + (open ? " is-open" : "")}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      >
        <span>{current?.label ?? value}</span>
      </button>
      {open && createPortal(
        <div ref={menu} className="iv-menu design-surface design-inspector-menu" style={{ position: "fixed", ...position, right: "auto" }} role="listbox" aria-label={label}>
          {options.map((o) => (
            <button
              type="button"
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={o.value === value ? "is-on" : undefined}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                if (o.value !== value) onChange(o.value);
              }}
            >
              <span className="iv-menu-check">{o.value === value && <Check size={12} />}</span>
              <span>{o.label}</span>
              {o.hint && <small>{o.hint}</small>}
            </button>
          ))}
        </div>, document.body
      )}
    </div>
  );
}

/** Icon segmented control. */
export function Icons<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T | undefined;
  options: { value: T; icon: ReactNode; title: string }[];
  onChange(value: T): void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className="iv-icons" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          title={o.title}
          aria-label={o.title}
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => o.value !== value && onChange(o.value)}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}

const svg = (path: ReactNode) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
    {path}
  </svg>
);
export const icon = {
  row: svg(<path d="M5 12h14M14 7l5 5-5 5" />),
  column: svg(<path d="M12 5v14M7 14l5 5 5-5" />),
  wrap: svg(<path d="M5 8h11a3 3 0 0 1 0 6H8M11 11l-3 3 3 3" />),
  hStart: svg(<><path d="M5 4v16" /><rect x="9" y="7" width="10" height="4" rx="1" /><rect x="9" y="13" width="6" height="4" rx="1" /></>),
  hCenter: svg(<><path d="M12 4v16" /><rect x="6" y="7" width="12" height="4" rx="1" /><rect x="8" y="13" width="8" height="4" rx="1" /></>),
  hEnd: svg(<><path d="M19 4v16" /><rect x="5" y="7" width="10" height="4" rx="1" /><rect x="9" y="13" width="6" height="4" rx="1" /></>),
  vStart: svg(<><path d="M4 5h16" /><rect x="7" y="9" width="4" height="10" rx="1" /><rect x="13" y="9" width="4" height="6" rx="1" /></>),
  vCenter: svg(<><path d="M4 12h16" /><rect x="7" y="6" width="4" height="12" rx="1" /><rect x="13" y="8" width="4" height="8" rx="1" /></>),
  vEnd: svg(<><path d="M4 19h16" /><rect x="7" y="5" width="4" height="10" rx="1" /><rect x="13" y="9" width="4" height="6" rx="1" /></>),
  textLeft: svg(<path d="M4 6h16M4 12h10M4 18h13" />),
  textCenter: svg(<path d="M4 6h16M7 12h10M5.5 18h13" />),
  textRight: svg(<path d="M4 6h16M10 12h10M7 18h13" />),
  borderNone: svg(<><circle cx="12" cy="12" r="8" /><path d="M6.5 17.5 17.5 6.5" /></>),
  borderSolid: svg(<path d="M4 12h16" />),
  borderDashed: svg(<path d="M4 12h3M10.5 12h3M17 12h3" />),
  borderDotted: svg(<path d="M4 12h.5M8 12h.5M12 12h.5M16 12h.5M20 12h.5" strokeWidth="2.4" />),
  sides: svg(<path d="M4 9V5h4M16 5h4v4M20 15v4h-4M8 19H4v-4" />),
};
