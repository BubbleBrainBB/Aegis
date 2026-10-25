import { memo, useMemo, type CSSProperties } from "react";
import { designFrameHtml } from "../../../shared/design-frame";
import { staticDesignPreview } from "../../../shared/design-component";
import { useSandboxEpoch } from "../../utils/sandbox-frames";
import type { DesignSystemPack } from "../../../shared/design-system-pack";
import type { DesignBoard } from "../../../shared/design-types";

/**
 * A board drawn small and inert, scaled to fit, in a script-free frame: a
 * design component is drawn from its props without running any of its code
 * (thumbnails are everywhere; board logic runs only on the canvas and in Play).
 * For library rows and chat cards, never editing.
 */
export const BoardThumb = memo(function BoardThumb({
  board,
  width,
  height,
  className,
  style,
  system,
  slide,
}: {
  board: Pick<DesignBoard, "id" | "html" | "width" | "height" | "contentRevision">;
  width: number;
  height: number;
  className?: string;
  /** Extra placement, e.g. a position inside a design's cover. */
  style?: CSSProperties;
  /** The design system the board loads. */
  system?: DesignSystemPack | null;
  /** A deck's slide to draw. */
  slide?: number;
}) {
  const scale = Math.min(width / board.width, height / board.height);
  const sandboxEpoch = useSandboxEpoch();
  // Keyed by revision so a rewritten board repaints; no inspector script.
  const srcDoc = useMemo(
    () => designFrameHtml(staticDesignPreview(board.html), `thumb-${board.id.replace(/[^a-zA-Z0-9-]/g, "")}-${board.contentRevision}`, false, { mode: "static", system, slide }),
    [board.html, board.id, board.contentRevision, system, slide],
  );
  return (
    <div
      aria-hidden="true"
      className={className}
      style={{ width, height, overflow: "hidden", position: "relative", pointerEvents: "none", ...style }}
    >
      <iframe
        key={sandboxEpoch}
        title=""
        tabIndex={-1}
        sandbox=""
        srcDoc={srcDoc}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: board.width,
          height: board.height,
          border: 0,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
          background: "#fff",
        }}
      />
    </div>
  );
});
