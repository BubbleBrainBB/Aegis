import { useEffect, useState } from "react";
import { ChevronRight, Palette } from "../icons";
import { openDesign, useDesignStore } from "../../store/useDesignStore";
import type { DesignDocument } from "../../../shared/design-types";
import type { DesignTurnChange } from "../../utils/design-entries";

/**
 * What a turn did to a design, shown after its trace: one row with what it
 * touched. One board opens that board on the canvas beside the chat;
 * several open the design, and the reply links to the ones it talks about.
 */
export function DesignChatCard({ sessionId, change }: { sessionId: string; change: DesignTurnChange }) {
  const { documentId } = change;
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

  // Boards removed since then drop out.
  const byId = new Map((doc?.boards ?? []).map((board) => [board.id, board]));
  const added = change.added.filter((id) => byId.has(id));
  const changed = change.changed.filter((id) => byId.has(id));
  const only = added.length + changed.length === 1 ? byId.get(added[0] ?? changed[0]) : undefined;
  const label = only?.name ?? doc?.title ?? "Design";
  const show = () => {
    if (only) useDesignStore.getState().requestFocus({ sessionId, documentId, boardId: only.id });
    else openDesign({ sessionId, documentId, where: "pane" });
  };

  return (
    <div data-design-card={documentId} className="my-3 min-w-0">
      <button
        type="button"
        onClick={show}
        aria-label={`Show ${label} beside the chat`}
        className="group/design flex w-full max-w-[360px] items-center gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-[7px] text-left text-[13px] text-[var(--text-primary)] outline-none hover:bg-[var(--sidebar-item-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <Palette aria-hidden className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-secondary)]" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="flex-shrink-0 text-[12px] text-[var(--text-muted)]">Published</span>
        <ChevronRight aria-hidden className="h-3 w-3 flex-shrink-0 text-[var(--text-muted)] group-hover/design:text-[var(--text-secondary)]" />
      </button>
    </div>
  );
}
