import { useEffect, useRef, useState } from 'react';
import { Popover } from '@base-ui-components/react/popover';
import {
  isRemovedLineComment,
  reviewCommentLines,
  reviewCommentLocation,
  reviewCommentTitle,
  REVIEW_COMMENT_LIMITS,
  type ReviewComment,
} from '../../shared/review-comments';
import { isImeComposing } from '../utils/ime';
import { MessageSquare, Pencil, Trash2, X } from './icons';

function linesLabel(comment: Pick<ReviewComment, 'startLine' | 'endLine' | 'startSide' | 'endSide'>): string {
  const label = `${comment.startLine === comment.endLine ? 'Line' : 'Lines'} ${reviewCommentLines(comment)}`;
  return isRemovedLineComment(comment) ? `${label} · removed` : label;
}

/** The editor that opens under the selected diff lines. */
export function ReviewCommentEditor({
  anchor,
  initialText = '',
  onSubmit,
  onCancel,
}: {
  anchor: Pick<ReviewComment, 'startLine' | 'endLine' | 'startSide' | 'endSide'>;
  initialText?: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const trimmed = text.trim();

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  // Grows with its text, up to a few lines.
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [text]);

  return (
    <div data-review-comment-editor className="aegis-review-annotation">
      <div className="flex flex-col rounded-[10px] border border-[var(--accent)] bg-[var(--bg-primary)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_14%,transparent)]">
        <textarea
          ref={fieldRef}
          value={text}
          rows={1}
          maxLength={REVIEW_COMMENT_LIMITS.textChars}
          placeholder="Comment for the agent"
          aria-label="Comment for the agent"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (trimmed) onSubmit(trimmed);
            }
          }}
          className="w-full resize-none bg-transparent px-3 pb-1.5 pt-2.5 font-sans text-[13px] leading-[1.55] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
        <div className="flex items-center gap-2 pb-2 pl-3 pr-2 pt-1 font-sans text-[12px] text-[var(--text-muted)]">
          <span>{linesLabel(anchor)}</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-[26px] items-center rounded-[7px] px-2.5 text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!trimmed}
            onClick={() => onSubmit(trimmed)}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] bg-[var(--accent)] px-2.5 text-[12px] font-medium text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Comment
            <span aria-hidden="true" className="text-[11px] opacity-70">↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** A saved comment, shown under its lines until it is sent. */
export function ReviewCommentCard({
  comment,
  onEdit,
  onRemove,
}: {
  comment: ReviewComment;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div data-review-comment={comment.id} className="aegis-review-annotation">
      <div className="group/comment flex flex-col gap-1 rounded-[10px] border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 shadow-sm">
        <div className="flex min-h-[22px] items-center gap-1.5 font-sans text-[11px] text-[var(--text-muted)]">
          <MessageSquare className="h-3.5 w-3.5 shrink-0" />
          <span>{linesLabel(comment)}</span>
          <span className="ml-auto flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/comment:opacity-100">
            <button
              type="button"
              onClick={onEdit}
              title="Edit comment"
              aria-label="Edit comment"
              className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-[5px] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onRemove}
              title="Delete comment"
              aria-label="Delete comment"
              className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-[5px] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
        <p className="m-0 whitespace-pre-wrap break-words font-sans text-[13px] leading-[1.55] text-[var(--text-primary)]">
          {comment.text}
        </p>
      </div>
    </div>
  );
}

function fileCount(comments: readonly ReviewComment[]): number {
  return new Set(comments.map((comment) => comment.filePath)).size;
}

/**
 * The composer's one chip for every unsent comment. With one comment it reads
 * as that comment; with several it counts them, and the list opens on click.
 */
export function ReviewCommentsChip({
  comments,
  onOpen,
  onRemove,
  onRemoveAll,
}: {
  comments: ReviewComment[];
  onOpen: (comment: ReviewComment) => void;
  onRemove: (comment: ReviewComment) => void;
  onRemoveAll: () => void;
}) {
  if (comments.length === 0) return null;
  const single = comments.length === 1 ? comments[0] : null;
  const files = fileCount(comments);
  const title = single ? reviewCommentTitle(single) : `${comments.length} comments`;
  const subtitle = single ? reviewCommentLocation(single) : `${files} ${files === 1 ? 'file' : 'files'}`;

  return (
    <Popover.Root>
      <div data-review-comments-chip className="relative inline-flex max-w-[240px]">
        <Popover.Trigger
          aria-label={single ? `Comment on ${subtitle}` : `${title} on ${subtitle}`}
          className="inline-flex min-w-0 max-w-full items-center gap-2.5 rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] py-2 pl-2 pr-3 text-left shadow-sm transition-colors hover:bg-[var(--bg-secondary)] data-[popup-open]:border-[color-mix(in_srgb,var(--accent)_55%,transparent)] data-[popup-open]:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_12%,transparent)]"
        >
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] bg-[var(--bg-tertiary)]">
            <MessageSquare className="h-[18px] w-[18px] text-[var(--text-secondary)]" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium text-[var(--text-primary)]">{title}</span>
            <span className={`block truncate text-[10px] text-[var(--text-muted)] ${single ? 'font-mono' : ''}`}>{subtitle}</span>
          </span>
        </Popover.Trigger>
        <button
          type="button"
          onClick={onRemoveAll}
          title={single ? 'Remove comment' : 'Remove all comments'}
          aria-label={single ? 'Remove comment' : 'Remove all comments'}
          className="absolute -right-1.5 -top-1.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] shadow-[0_1px_4px_rgba(0,0,0,0.28)] transition-opacity hover:opacity-85"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      </div>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={8} className="z-[9998]">
          <Popover.Popup aria-label="Comments to send" className="popover-surface w-[320px] p-1.5 text-left" data-review-comments-list>
            <div className="flex max-h-[320px] flex-col gap-px overflow-y-auto">
              {comments.map((comment) => (
                <div key={comment.id} className="group/item flex items-start gap-1 rounded-lg focus-within:bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)]">
                  <Popover.Close
                    onClick={() => onOpen(comment)}
                    className="flex min-w-0 flex-1 flex-col gap-px px-2 py-1.5 text-left outline-none"
                  >
                    <span className="w-full truncate text-[12px] leading-[1.45] text-[var(--text-primary)]">{reviewCommentTitle(comment)}</span>
                    <span className="w-full truncate font-mono text-[10px] text-[var(--text-muted)]">{reviewCommentLocation(comment)}</span>
                  </Popover.Close>
                  <button
                    type="button"
                    onClick={() => onRemove(comment)}
                    title="Remove comment"
                    aria-label={`Remove comment on ${reviewCommentLocation(comment)}`}
                    className="mr-1 mt-1.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[5px] text-[var(--text-muted)] opacity-0 hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover/item:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            {comments.length > 1 ? (
              <>
                <div className="-mx-1.5 my-1 h-px bg-[var(--border)]" />
                <Popover.Close
                  onClick={onRemoveAll}
                  className="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-[12px] text-[var(--text-secondary)] outline-none hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--bg-tertiary)]"
                >
                  Remove all
                </Popover.Close>
              </>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

const MESSAGE_PILL_LIMIT = 3;

/** The comments a sent message carried: one pill each above its bubble. */
export function ReviewCommentPills({
  comments,
  onOpen,
}: {
  comments: ReviewComment[];
  onOpen?: (comment: ReviewComment) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (comments.length === 0) return null;
  const shown = expanded ? comments : comments.slice(0, MESSAGE_PILL_LIMIT);
  const hidden = comments.length - shown.length;
  // Never wider than the message column: the comment text gives way first, then the location.
  const pillClass = 'inline-flex min-w-0 max-w-[min(440px,100%)] items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-tertiary)] px-3 py-1.5 text-left';

  return (
    <div data-review-comment-pills className="flex w-full min-w-0 flex-col items-end gap-1.5">
      {shown.map((comment) => {
        const location = reviewCommentLocation(comment);
        const body = (
          <>
            <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
            {/* In a narrow column the file name gives way; the line number always shows. */}
            <span className="flex min-w-0 max-w-[62%] flex-shrink-0 font-mono text-[11px] text-[var(--text-primary)]">
              <span className="min-w-0 truncate">{location.slice(0, location.lastIndexOf(':'))}</span>
              <span className="flex-shrink-0">{location.slice(location.lastIndexOf(':'))}</span>
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-secondary)]">{reviewCommentTitle(comment)}</span>
          </>
        );
        return onOpen ? (
          <button
            key={comment.id}
            type="button"
            title={comment.text}
            onClick={() => onOpen(comment)}
            className={`${pillClass} transition-colors hover:border-[color-mix(in_srgb,var(--accent)_50%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]`}
          >
            {body}
          </button>
        ) : (
          <span key={comment.id} title={comment.text} className={pillClass}>{body}</span>
        );
      })}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="rounded-full px-2 py-0.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          +{hidden} more
        </button>
      ) : null}
    </div>
  );
}
