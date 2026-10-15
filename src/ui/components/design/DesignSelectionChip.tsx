import { MousePointer, X } from "../icons";

/** The canvas selection the next message is about ("Plus card · Pricing"). */
export function DesignSelectionChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span
      data-design-selection-chip
      className="inline-flex max-w-full items-center gap-1.5 rounded-[8px] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] py-1 pl-2 pr-1 text-[12.5px] text-[var(--accent)]"
    >
      <MousePointer size={13} aria-hidden="true" />
      <span className="truncate">
        {label} <span className="opacity-70">(selected on canvas)</span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Clear the canvas selection"
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[5px] hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]"
      >
        <X size={12} />
      </button>
    </span>
  );
}

/** The canvas selection a sent message carried; opens it on the canvas. */
export function DesignSelectionTag({ label, onOpen }: { label: string; onOpen?: () => void }) {
  return (
    <button
      type="button"
      data-design-selection-tag
      onClick={onOpen}
      disabled={!onOpen}
      title="Selected on canvas when this was sent"
      className="inline-flex max-w-full items-center gap-1.5 rounded-[8px] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] px-2 py-1 text-[12px] text-[var(--accent)] enabled:hover:bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] disabled:cursor-default"
    >
      <MousePointer size={12} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </button>
  );
}
