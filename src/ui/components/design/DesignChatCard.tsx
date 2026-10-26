import { useEffect, useState } from "react";
import { BoardThumb } from "./BoardThumb";
import { openDesign, useDesignStore } from "../../store/useDesignStore";
import type { DesignDocument } from "../../../shared/design-types";
import type { DesignTurnChange } from "../../utils/design-entries";
import { useDesignSystem } from "./use-design-system";

const MAX_CHIPS = 3;

function count(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * What a turn did to a design, shown after its trace: a one-line summary
 * (boards added and updated, and the design's title) and a chip per board it
 * touched. A chip shows that board on the canvas beside the chat.
 */
export function DesignChatCard({ sessionId, change }: { sessionId: string; change: DesignTurnChange }) {
  const { documentId } = change;
  const system = useDesignSystem(sessionId, documentId);
  const [doc, setDoc] = useState<DesignDocument | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      window.electron.design
        ?.read({ sessionId, documentId })
        .then((d) => alive && (setDoc(d), setMissing(false)))
        .catch(() => alive && setMissing(true));
    void load();
    const off = window.electron.design?.onChanged((event) => {
      if (event.documentId === documentId && event.scope !== "comments") void load();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [sessionId, documentId]);
  if (missing) return null;

  // Boards removed since then drop out; added ones lead.
  const byId = new Map((doc?.boards ?? []).map((board) => [board.id, board]));
  const added = change.added.filter((id) => byId.has(id));
  const changed = change.changed.filter((id) => byId.has(id));
  const touched = [...added.map((id) => ({ id, kind: "Added" })), ...changed.map((id) => ({ id, kind: "Updated" }))];
  const parts = [
    added.length ? `Added ${count(added.length, "board")}` : "",
    changed.length ? `Updated ${added.length ? changed.length : count(changed.length, "board")}` : "",
  ].filter(Boolean);
  const title = doc?.title ?? "Design";
  const showDesign = () => openDesign({ sessionId, documentId, where: "pane" });

  return (
    <div data-design-card={documentId} className="my-3 min-w-0">
      <button
        type="button"
        onClick={showDesign}
        className="flex max-w-full items-center gap-2 rounded-[6px] text-left text-[12.5px] text-[var(--text-muted)] outline-none hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        aria-label={`Show ${title} beside the chat`}
      >
        <span aria-hidden className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--accent)]" />
        <span className="truncate">
          {parts.length ? `${parts.join(" · ")} · ` : "Updated · "}
          <span className="text-[var(--text-secondary)]">{title}</span>
        </span>
      </button>
      {touched.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {touched.slice(0, MAX_CHIPS).map(({ id, kind }) => {
            const board = byId.get(id)!;
            return (
              <button
                key={id}
                type="button"
                data-design-board-chip={id}
                title={`${kind} · ${board.name}`}
                onClick={() => useDesignStore.getState().requestFocus({ sessionId, documentId, boardId: id })}
                className="flex min-w-0 max-w-[280px] items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-primary)] py-[3px] pl-1 pr-2.5 text-[12px] text-[var(--text-primary)] outline-none hover:bg-[var(--sidebar-item-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <BoardThumb
                system={system}
                  board={board}
                  width={24}
                  height={18}
                  className="flex-shrink-0 rounded-[4px] border border-[var(--border)] bg-white"
                />
                <span className="truncate">{board.name}</span>
              </button>
            );
          })}
          {touched.length > MAX_CHIPS && (
            <button
              type="button"
              onClick={showDesign}
              className="rounded-full border border-[var(--border)] px-2.5 py-[3px] text-[12px] text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)]"
              aria-label={`Show all ${touched.length} boards`}
            >
              +{touched.length - MAX_CHIPS}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
