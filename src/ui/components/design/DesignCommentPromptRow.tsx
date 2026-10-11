import { useState } from 'react';
import { ChevronDown, ChevronRight } from '../icons';
import { useDesignStore } from '../../store/useDesignStore';
import type { Attachment, DesignPromptRef } from '../../../shared/types';
import './design-chat-comment.css';

/**
 * A chat message sent from a design comment thread: a compact row instead of a
 * user bubble, linking back to the thread on the canvas.
 */
export function DesignCommentPromptRow({
  prompt,
  design,
  sessionId,
  attachments,
}: {
  prompt: string;
  design: DesignPromptRef;
  sessionId?: string | null;
  attachments?: Attachment[];
}) {
  const [open, setOpen] = useState(true);
  const location = [design.boardName, design.layerName].filter(Boolean).join(' · ');
  return (
    <div className="design-chat-comment" data-design-comment={design.commentId}>
      <button
        type="button"
        className="design-chat-comment-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {design.reply ? 'Reply' : 'Comment'} on {design.documentTitle} · sent to the agent
        <ChevronDown size={12} style={{ transform: open ? undefined : 'rotate(-90deg)' }} />
      </button>
      {open && (
        <>
          <div className="design-chat-comment-body">{prompt}</div>
          {location && <div className="design-chat-comment-location">{location}</div>}
          {attachments && attachments.length > 1 && (
            <div className="design-chat-comment-location">{attachments.length - 1} attachment{attachments.length > 2 ? 's' : ''}</div>
          )}
          <button
            type="button"
            className="design-chat-comment-view"
            disabled={!sessionId}
            onClick={() =>
              sessionId &&
              useDesignStore.getState().requestFocus({
                sessionId,
                documentId: design.documentId,
                boardId: design.boardId,
                commentId: design.commentId,
              })
            }
          >
            View thread
            <ChevronRight size={12} />
          </button>
        </>
      )}
    </div>
  );
}
