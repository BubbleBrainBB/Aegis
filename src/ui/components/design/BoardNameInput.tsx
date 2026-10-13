import { useRef } from "react";
import { normalizeBoardName } from "../../../shared/design-names";

export function BoardNameInput({ name, onSave, onDone, autoFocus, disabled, className }: {
  name: string; onSave(name: string): void; onDone?(): void;
  autoFocus?: boolean; disabled?: boolean; className?: string;
}) {
  const cancelled = useRef(false);
  return <input aria-label="Artboard name" className={className} data-canvas-ui
    defaultValue={name} autoFocus={autoFocus} disabled={disabled}
    onFocus={e => { cancelled.current = false; if (autoFocus) e.currentTarget.select(); }}
    onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
    onKeyDown={e => {
      e.stopPropagation();
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Escape") { cancelled.current = true; e.currentTarget.value = name; e.currentTarget.blur(); }
      if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
    }}
    onBlur={e => {
      const next = normalizeBoardName(e.currentTarget.value);
      e.currentTarget.value = !cancelled.current && next ? next : name;
      if (!cancelled.current && next && next !== name) onSave(next);
      onDone?.();
    }} />;
}
