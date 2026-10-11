import { useState } from "react";
import { LayoutGrid, Palette } from "../icons";
import { DesignStylesDialog } from "./DesignStylesDialog";
import { DEFAULT_COMPOSER_CHOICE, useDesignStore } from "../../store/useDesignStore";
import { useAppStore } from "../../store/useAppStore";

const MAX_VARIANTS = 4;
const control =
  "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]";

/**
 * The design composer's own controls, beside the attach button: a style
 * guide for the agent to follow, and how many distinct directions to draw
 * (1× is one).
 */
export function DesignComposerControls({ sessionId }: { sessionId: string }) {
  const choice = useDesignStore((s) => s.composer[sessionId]) ?? DEFAULT_COMPOSER_CHOICE;
  const setChoice = useDesignStore((s) => s.setComposerChoice);
  const cwd = useAppStore((s) => s.sessions[sessionId]?.projectCwd ?? s.sessions[sessionId]?.cwd ?? null);
  const [picking, setPicking] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`${control} ${choice.styleId ? "text-[var(--text-primary)]" : ""}`}
        onClick={() => setPicking(true)}
        title={choice.styleName ? `Style: ${choice.styleName}` : "Choose a style guide"}
        data-design-style-button
      >
        <Palette className="h-[15px] w-[15px]" strokeWidth={1.6} />
        <span className="max-w-[120px] truncate">{choice.styleName ?? "Styles"}</span>
      </button>
      <button
        type="button"
        className={control}
        onClick={() => setChoice(sessionId, { ...choice, variants: (choice.variants % MAX_VARIANTS) + 1 })}
        title={choice.variants > 1 ? `${choice.variants} directions for each new board` : "One direction (click for more)"}
        aria-label={`Variations: ${choice.variants}`}
        data-design-variants
      >
        <LayoutGrid className="h-[14px] w-[14px]" strokeWidth={1.6} />
        <span className="tabular-nums">{choice.variants}×</span>
      </button>
      {picking ? (
        <DesignStylesDialog
          sessionId={sessionId}
          cwd={cwd}
          value={choice.styleId}
          onClose={() => setPicking(false)}
          onPick={(style) => {
            setChoice(sessionId, { ...choice, styleId: style?.id, styleName: style?.name });
            setPicking(false);
          }}
        />
      ) : null}
    </>
  );
}
