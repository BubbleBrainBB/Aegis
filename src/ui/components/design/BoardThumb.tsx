import { memo, useMemo } from "react";
import { designFrameHtml } from "../../../shared/design-frame";
import type { DesignBoard } from "../../../shared/design-types";

/**
 * A board drawn small and inert: its HTML in a script-free sandboxed frame,
 * scaled to fit. For library rows and chat cards, never for editing.
 */
export const BoardThumb = memo(function BoardThumb({
  board,
  width,
  height,
  className,
}: {
  board: Pick<DesignBoard, "id" | "html" | "width" | "height" | "contentRevision">;
  width: number;
  height: number;
  className?: string;
}) {
  const scale = Math.min(width / board.width, height / board.height);
  // Keyed by revision so a rewritten board repaints; no inspector script.
  const srcDoc = useMemo(
    () => designFrameHtml(board.html, `thumb-${board.id.replace(/[^a-zA-Z0-9-]/g, "")}-${board.contentRevision}`, false),
    [board.html, board.id, board.contentRevision],
  );
  return (
    <div
      aria-hidden="true"
      className={className}
      style={{ width, height, overflow: "hidden", position: "relative", pointerEvents: "none" }}
    >
      <iframe
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
