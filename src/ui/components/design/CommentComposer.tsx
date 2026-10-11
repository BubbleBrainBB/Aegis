import { useDesignAgentName } from "./design-ui";
import { useEffect, useRef, useState } from "react";
import { Paperclip, X } from "../icons";
import type { Attachment } from "../../types";

/**
 * One comment input. Mentioning the agent is on by default: sending hands the
 * comment to it. Removing the chip keeps it as a plain note on the canvas.
 */
export function CommentComposer({
  canMention,
  placeholder = "Add a comment",
  submitLabel = "Comment",
  busy,
  autoFocus = true,
  onSubmit,
  onCancel,
}: {
  canMention: boolean;
  placeholder?: string;
  submitLabel?: string;
  busy?: boolean;
  autoFocus?: boolean;
  onSubmit(input: { text: string; toAgent: boolean; attachments: Attachment[] }): Promise<unknown> | void;
  onCancel?(): void;
}) {
  const agent = useDesignAgentName();
  const [text, setText] = useState("");
  const [mention, setMention] = useState(canMention);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setMention(canMention), [canMention]);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(140, el.scrollHeight) + "px";
  }, [text]);
  const submit = async () => {
    if (!text.trim() || busy) return;
    await onSubmit({ text: text.trim(), toAgent: mention, attachments });
    setText("");
    setAttachments([]);
    setMention(canMention);
  };
  return (
    <div
      className="design-composer"
      data-canvas-ui
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="design-composer-field">
        {mention && (
          <span className="design-mention" aria-label={`Sends to ${agent}`}>
            @{agent}
          </span>
        )}
        <textarea
          ref={input}
          rows={1}
          aria-label="Comment"
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel?.();
            }
            if (
              e.key === "Backspace" &&
              mention &&
              e.currentTarget.selectionStart === 0 &&
              e.currentTarget.selectionEnd === 0
            ) {
              e.preventDefault();
              setMention(false);
            }
          }}
        />
      </div>
      {attachments.length > 0 && (
        <div className="design-composer-files">
          {attachments.map((a) => (
            <span key={a.id}>
              {a.name}
              <button
                aria-label={"Remove " + a.name}
                onClick={() => setAttachments((all) => all.filter((x) => x.id !== a.id))}
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="design-composer-actions">
        <button
          className="design-icon-button"
          aria-label="Attach files"
          title="Attach files"
          disabled={busy}
          onClick={async () => {
            const picked = await window.electron.selectAttachments?.();
            if (picked?.length) setAttachments((all) => [...all, ...picked].slice(0, 6));
          }}
        >
          <Paperclip size={14} />
        </button>
        <span className="design-spacer" />
        <button
          className="design-primary design-send"
          aria-label={submitLabel}
          title={`${submitLabel} (↵)`}
          disabled={!text.trim() || busy}
          onClick={() => void submit()}
        >
          {/* Same arrow as the chat composer's send button. */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0l-6 6m6-6l6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
