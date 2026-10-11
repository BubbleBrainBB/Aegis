import { Check, X } from "../icons";
import { CommentComposer } from "./CommentComposer";
import { DesignAvatar, authorName, relativeTime, useDesignAgentName } from "./design-ui";
import type { DesignComment } from "../../../shared/design-types";
import type { Attachment } from "../../types";

/** A comment thread beside its pin: messages, the agent's replies, and a reply box. */
export function CommentThread({
  comment,
  user,
  boardName,
  canMention,
  editable,
  busy,
  onReply,
  onResolve,
  onClose,
  onCompare,
}: {
  comment: DesignComment;
  user: string;
  boardName: string;
  canMention: boolean;
  editable: boolean;
  busy?: boolean;
  onReply(input: { text: string; toAgent: boolean; attachments: Attachment[] }): Promise<unknown>;
  onResolve(): void;
  onClose(): void;
  onCompare(from: number, to: number): void;
}) {
  const agent = useDesignAgentName();
  const working = comment.status === "working";
  return (
    <div
      className="design-thread"
      data-canvas-ui
      role="dialog"
      aria-label="Comment thread"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="design-thread-actions">
        <button
          className="design-icon-button"
          aria-label="Resolve comment"
          title="Resolve"
          disabled={!editable || busy}
          onClick={onResolve}
        >
          <Check size={14} />
        </button>
        <button
          className="design-icon-button"
          aria-label="Close thread"
          title="Close"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      <div className="design-thread-messages">
        {comment.messages.map((m) => (
          <div className="design-message" key={m.id}>
            <div className="design-message-head">
              <DesignAvatar author={m.author} user={user} />
              <strong>{authorName(m.author, user)}</strong>
              <span className="design-message-time">{relativeTime(m.createdAt)}</span>
            </div>
            <p>
              {m.toAgent && m.author.kind === "user" && (
                <span className="design-mention">@{agent}</span>
              )}
              {m.text}
            </p>
            {m.revision && (
              <button
                className="design-link"
                onClick={() => onCompare(m.revision!.from, m.revision!.to)}
              >
                v{m.revision.from} → v{m.revision.to} · Compare
              </button>
            )}
          </div>
        ))}
        {working && (
          <div className="design-message is-working">
            <div className="design-message-head">
              <DesignAvatar author={{ kind: "agent", name: agent }} user={user} />
              <strong>{agent}</strong>
              <span className="design-message-time">now</span>
            </div>
            <p className="design-shimmer">Updating {boardName}…</p>
          </div>
        )}
      </div>
      {editable && (
        <CommentComposer
          canMention={canMention}
          placeholder="Reply…"
          submitLabel="Reply"
          busy={busy}
          autoFocus={false}
          onSubmit={onReply}
          onCancel={onClose}
        />
      )}
    </div>
  );
}
