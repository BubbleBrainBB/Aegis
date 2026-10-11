import { useEffect, useState } from "react";
import { BoardThumb } from "./BoardThumb";
import { openDesign } from "../../store/useDesignStore";
import type { DesignDocument } from "../../../shared/design-types";

/**
 * The design a turn worked on, shown after its trace: a few board thumbnails,
 * the title and board count, and a way to open it.
 */
export function DesignChatCard({ sessionId, documentId }: { sessionId: string; documentId: string }) {
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
  const boards = doc?.boards ?? [];
  return (
    <div
      data-design-card={documentId}
      className="my-3 flex min-w-0 items-center gap-3 rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-2.5 pr-3"
    >
      <button
        type="button"
        onClick={() => openDesign({ sessionId, documentId, where: "pane" })}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-[10px] text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        aria-label={`Show ${doc?.title ?? "the design"} beside the chat`}
      >
        <span className="flex flex-shrink-0 gap-1.5">
          {boards.slice(0, 3).map((board) => (
            <BoardThumb
              key={board.id}
              board={board}
              width={56}
              height={44}
              className="rounded-[6px] border border-[var(--border)] bg-white"
            />
          ))}
          {boards.length === 0 && (
            <span className="h-[44px] w-[56px] rounded-[6px] border border-dashed border-[var(--border)]" />
          )}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">{doc?.title ?? "Design"}</span>
          <span className="text-[12px] text-[var(--text-muted)]">
            Design · {boards.length} {boards.length === 1 ? "board" : "boards"}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => openDesign({ sessionId, documentId, where: "section" })}
        className="flex-shrink-0 rounded-[8px] bg-[var(--sidebar-item-hover)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--sidebar-item-active)]"
      >
        Open in Design
      </button>
    </div>
  );
}
