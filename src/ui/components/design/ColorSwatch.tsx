import { useEffect, useRef } from "react";

/** #rrggbb for a CSS color, via the browser's own parser; undefined if not opaque-representable. */
export function toHex(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return undefined;
  ctx.fillStyle = "#000";
  ctx.fillStyle = color;
  const v = ctx.fillStyle;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(v);
  if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return undefined;
  return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

/**
 * Native color picker. It commits once when the picker closes (the change
 * event), not on every drag step, so one pick is one version.
 */
export function ColorSwatch({
  value,
  label,
  disabled,
  onCommit,
}: {
  value: string | undefined;
  label: string;
  disabled?: boolean;
  onCommit(hex: string): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const hex = toHex(value);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const change = () => commit.current(el.value);
    el.addEventListener("change", change);
    return () => el.removeEventListener("change", change);
  }, [hex]);
  return (
    <span
      className={"design-swatch" + (hex ? "" : " is-empty")}
      style={hex ? { background: hex } : undefined}
    >
      <input
        ref={input}
        type="color"
        aria-label={label}
        disabled={disabled}
        defaultValue={hex ?? "#ffffff"}
        key={hex ?? "none"}
      />
    </span>
  );
}
