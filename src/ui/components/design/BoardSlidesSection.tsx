import { useMemo } from "react";
import type { DesignBoard, DesignOperation } from "../../../shared/design-types";
import { designSlides, isDesignDeck, setDesignSlideNotes } from "../../../shared/design-deck";

/** A deck board's slides: go to one on the canvas, and edit its speaker notes. */
export function BoardSlidesSection({
  board,
  can,
  onUpdate,
  onShowSlide,
}: {
  board: DesignBoard;
  can: boolean;
  onUpdate(ops: DesignOperation[]): Promise<unknown>;
  onShowSlide(index: number): void;
}) {
  const slides = useMemo(() => (isDesignDeck(board.html) ? designSlides(board.html) : []), [board.html]);
  if (!slides.length) return null;
  return (
    <section className="design-section design-slides-section">
      <h4>Slides · {slides.length}</h4>
      <ol className="design-slides">
        {slides.map((s) => (
          <li key={`${s.id}:${board.contentRevision}`}>
            <button className="design-slide-go" onClick={() => onShowSlide(s.index)} title="Show on the canvas">
              <span>{s.index + 1}</span>
              <span>{s.title}</span>
            </button>
            <textarea
              aria-label={`Speaker notes for slide ${s.index + 1}`}
              placeholder="Speaker notes"
              defaultValue={s.notes}
              disabled={!can || !s.id}
              rows={2}
              onBlur={(e) => {
                if (e.target.value === s.notes) return;
                void onUpdate([{ type: "content", boardId: board.id, expectedRevision: board.contentRevision, html: setDesignSlideNotes(board.html, s.id, e.target.value) }]);
              }}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}
