import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "../icons";
import { BoardThumb } from "./BoardThumb";
import type { DesignStyleSummary } from "../../../shared/design-types";

type Tab = "featured" | "all" | "project" | "templates";
type Template = { id: string; name: string; summary: string; html: string };
const SERIF = '"New York", Georgia, "Songti SC", serif';

/**
 * Choose a style guide for a design: built-in styles and the project's own
 * DESIGN.md. The guide goes to the agent with the next request and applies
 * to new boards.
 */
export function DesignStylesDialog({
  sessionId,
  cwd,
  value,
  templateValue,
  onPick,
  onPickTemplate,
  onClose,
}: {
  sessionId: string;
  cwd?: string | null;
  value?: string;
  /** The project template new boards start from, if any. */
  templateValue?: string;
  onPick(style: DesignStyleSummary | null): void;
  onPickTemplate?(template: Template | null): void;
  onClose(): void;
}) {
  const [styles, setStyles] = useState<DesignStyleSummary[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [tab, setTab] = useState<Tab>("featured");
  const [picked, setPicked] = useState<string | undefined>(value);
  const [pickedTemplate, setPickedTemplate] = useState<string | undefined>(templateValue);
  useEffect(() => {
    let alive = true;
    void window.electron.design
      ?.styles({ sessionId, cwd: cwd ?? undefined })
      .then((rows) => alive && setStyles(rows))
      .catch(() => alive && setStyles([]));
    void window.electron.design
      ?.templates({ sessionId, cwd: cwd ?? undefined })
      .then((rows) => alive && setTemplates(rows))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionId, cwd]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const shown = useMemo(
    () =>
      (styles ?? []).filter((s) =>
        tab === "featured" ? s.featured : tab === "project" ? s.source === "project" : s.source === "builtin",
      ),
    [styles, tab],
  );
  const choice = styles?.find((s) => s.id === picked) ?? null;
  const templateChoice = templates.find((t) => t.id === pickedTemplate) ?? null;
  const onTemplates = tab === "templates";

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[color-mix(in_srgb,var(--text-primary)_26%,transparent)] p-6" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose a style"
        data-design-styles
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-full w-[980px] max-w-full flex-col overflow-hidden rounded-[18px] bg-[var(--popover-bg,var(--bg-primary))] shadow-[0_30px_80px_rgba(20,24,40,0.25),0_0_0_1px_color-mix(in_srgb,var(--text-primary)_8%,transparent)]"
      >
        <div className="flex h-14 flex-shrink-0 items-center gap-3 border-b border-[var(--border)] pl-5 pr-3">
          <span className="text-[15px] font-semibold text-[var(--text-primary)]">Choose a style</span>
          <span className="flex-1" />
          <div role="tablist" className="flex gap-0.5 rounded-[10px] bg-[var(--sidebar-item-hover)] p-[3px]">
            {(
              [
                ["featured", "Featured"],
                ["all", "Styles"],
                ["project", "From this project"],
                ...(onPickTemplate ? ([["templates", "Templates"]] as const) : []),
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`h-7 rounded-[8px] px-3 text-[12.5px] ${
                  tab === id ? "bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-[0_0_0_1px_var(--border)]" : "text-[var(--text-muted)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <button type="button" aria-label="Close" onClick={onClose} className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid min-h-[300px] grid-cols-1 content-start gap-5 overflow-y-auto p-5 sm:grid-cols-2 lg:grid-cols-3">
          {onTemplates ? (
            templates.length === 0 ? (
              <p className="col-span-full max-w-[52ch] text-[13px] leading-relaxed text-[var(--text-muted)]">
                Put representative pages in the project's design-system/templates/ folder (one .html each, an optional .md saying what it is for), and new boards can start from them.
              </p>
            ) : (
              templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setPickedTemplate(t.id)}
                  aria-pressed={t.id === pickedTemplate}
                  data-template-id={t.id}
                  className="flex flex-col gap-2 text-left outline-none"
                >
                  <span
                    className="block overflow-hidden rounded-[10px] bg-white"
                    style={{ boxShadow: t.id === pickedTemplate ? "0 0 0 2px var(--accent)" : "0 0 0 1px var(--border)" }}
                  >
                    <BoardThumb board={{ id: `template-${t.id}`, html: t.html, width: 1440, height: 900, contentRevision: 1 }} width={280} height={175} />
                  </span>
                  <span className="text-[12.5px] text-[var(--text-primary)]">{t.name}</span>
                  <span className="line-clamp-2 text-[11.5px] leading-snug text-[var(--text-muted)]">{t.summary}</span>
                </button>
              ))
            )
          ) : styles === null ? (
            <p className="col-span-full text-[13px] text-[var(--text-muted)]">Loading styles…</p>
          ) : shown.length === 0 ? (
            <p className="col-span-full max-w-[52ch] text-[13px] leading-relaxed text-[var(--text-muted)]">
              {tab === "project"
                ? "Add a DESIGN.md at the project's root (colors, type, components, tone) and pick it here, so new boards follow it."
                : "No styles here yet."}
            </p>
          ) : (
            shown.map((style) => (
              <StyleCard key={style.id} style={style} selected={style.id === picked} onSelect={() => setPicked(style.id)} />
            ))
          )}
        </div>
        <div className="flex min-h-[54px] flex-shrink-0 flex-wrap items-center gap-2.5 border-t border-[var(--border)] px-5 py-2 text-[12.5px] text-[var(--text-muted)]">
          <span className="min-w-[240px] flex-1">
            {onTemplates
              ? "New boards start from the template's structure and components, with your content."
              : "The style guide goes to the agent with your next request and applies to new boards. Existing boards change only if you ask."}
          </span>
          {onTemplates && templateValue ? (
            <button type="button" onClick={() => onPickTemplate?.(null)} className="h-[30px] rounded-[8px] px-3 text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)]">
              No template
            </button>
          ) : null}
          {!onTemplates && value ? (
            <button type="button" onClick={() => onPick(null)} className="h-[30px] rounded-[8px] px-3 text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)]">
              No style
            </button>
          ) : null}
          <button type="button" onClick={onClose} className="h-[30px] rounded-[8px] px-3 text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)]">
            Cancel
          </button>
          {onTemplates ? (
            <button
              type="button"
              disabled={!templateChoice}
              onClick={() => templateChoice && onPickTemplate?.(templateChoice)}
              className="h-[30px] rounded-[8px] bg-[var(--text-primary)] px-3.5 text-[var(--bg-primary)] disabled:opacity-40"
            >
              {templateChoice ? `Start from ${templateChoice.name}` : "Use template"}
            </button>
          ) : (
            <button
              type="button"
              disabled={!choice}
              onClick={() => choice && onPick(choice)}
              className="h-[30px] rounded-[8px] bg-[var(--text-primary)] px-3.5 text-[var(--bg-primary)] disabled:opacity-40"
            >
              {choice ? `Use ${choice.name}` : "Use style"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function StyleCard({ style, selected, onSelect }: { style: DesignStyleSummary; selected: boolean; onSelect(): void }) {
  const [bg, ink, accent, line] = style.palette.length ? style.palette : ["#ffffff", "#1d1d1f", "#6b6b6b", "#e5e5e5"];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-style-id={style.id}
      className="flex flex-col gap-2 text-left outline-none focus-visible:[&>div:first-child]:ring-2 focus-visible:[&>div:first-child]:ring-[var(--accent)]"
    >
      <div
        className="flex h-[150px] gap-1.5 overflow-hidden rounded-[10px] p-2.5"
        style={{ background: bg, boxShadow: selected ? "0 0 0 2px var(--accent)" : "0 0 0 1px var(--border)" }}
      >
        <div className="flex flex-[2] flex-col gap-1.5" style={{ color: ink }}>
          <span style={{ fontFamily: style.serif ? SERIF : "inherit", fontSize: 18, lineHeight: 1.05 }}>
            {style.source === "project" ? "DESIGN.md" : "Ideas, given room."}
          </span>
          <span className="text-[9px] opacity-70">{style.source === "project" ? "Your project's own guide" : "A short line of body copy"}</span>
          <span className="w-[54px] rounded-full py-[3px] text-center text-[8px]" style={{ background: accent, color: bg }}>
            Start
          </span>
          <span className="flex-1 rounded-[6px] opacity-20" style={{ background: accent }} />
        </div>
        <div className="flex flex-1 flex-col gap-1 rounded-[8px] p-1.5 opacity-90" style={{ background: ink }}>
          <span className="h-1.5 w-[70%] rounded-[3px] opacity-70" style={{ background: bg }} />
          <span className="flex-1 rounded-[4px] opacity-60" style={{ background: accent }} />
        </div>
      </div>
      {style.palette.length ? (
        <div className="flex h-2.5 overflow-hidden rounded-[3px]">
          {[bg, ink, accent, line].map((c, i) => (
            <span key={i} className="flex-1" style={{ background: c }} />
          ))}
        </div>
      ) : null}
      <span className="flex items-center justify-between gap-2 text-[12.5px] text-[var(--text-primary)]">
        <span className="truncate">{style.name}</span>
        <span className="rounded-[4px] px-1.5 text-[10.5px] text-[var(--text-muted)] shadow-[0_0_0_1px_var(--border)]">.md</span>
      </span>
      <span className="line-clamp-2 text-[11.5px] leading-snug text-[var(--text-muted)]">{style.description}</span>
    </button>
  );
}
