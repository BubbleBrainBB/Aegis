import { Check } from "../icons";
import { authorName, initialOf, relativeTime } from "./design-ui";
import type { DesignComment, DesignDocument } from "../../../shared/design-types";

/** Comments, one by one. Clicking a row focuses its thread on the canvas. */
export function CommentsList({
  doc,
  user,
  activeId,
  queuedIds,
  editable,
  onOpen,
  onResolve,
}: {
  doc: DesignDocument;
  user: string;
  activeId?: string;
  queuedIds: Set<string>;
  editable: boolean;
  onOpen(comment: DesignComment): void;
  onResolve(comment: DesignComment): void;
}) {
  const open = doc.comments.filter((c) => c.status !== "resolved").reverse();
  if (!open.length) return <p className="design-empty-note">No comments</p>;
  return (
    <div className="design-comments">
      {open.map((c) => {
        const replies = c.messages.length - 1;
        const name = authorName(c.author, user);
        const status =
          c.status === "working"
            ? "Working on it…"
            : queuedIds.has(c.id)
              ? "Queued"
              : undefined;
        return (
          <div
            key={c.id}
            role="button"
            tabIndex={0}
            className={"design-comment-row" + (c.id === activeId ? " is-active" : "")}
            data-comment-id={c.id}
            onClick={() => onOpen(c)}
            onKeyDown={(e) => {
              // Keys on the Resolve button belong to the button.
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(c);
              }
            }}
          >
            <span className="design-comment-row-head">
              <span className="design-comment-avatar" aria-hidden>
                {initialOf(name)}
              </span>
              <strong>{name}</strong>
              <span className="design-comment-row-time">{relativeTime(c.updatedAt)}</span>
              <span className="design-spacer" />
              <button
                className="design-comment-resolve"
                aria-label="Resolve comment"
                title="Resolve"
                disabled={!editable}
                onClick={(e) => {
                  e.stopPropagation();
                  onResolve(c);
                }}
              >
                <Check size={12} />
              </button>
            </span>
            <span className="design-comment-row-text">{c.text}</span>
            {status ? (
              <span className={"design-comment-row-status" + (c.status === "working" ? " design-shimmer" : "")}>
                {status}
              </span>
            ) : (
              replies > 0 && (
                <span className="design-comment-replies">
                  {replies} repl{replies === 1 ? "y" : "ies"}
                </span>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
