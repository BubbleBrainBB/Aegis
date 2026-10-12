import { useRef, useState } from "react";
import { ChevronDown, EyeOff, MessageCircle } from "../icons";
import { DesignActionMenu } from "./DesignChrome";

/** Comment placement and list visibility are separate, like the artifact header. */
export function DesignCommentControls({ active, visible, count, disabled, onToggleMode, onShow, onHide }: {
  active: boolean;
  visible: boolean;
  count: number;
  disabled?: boolean;
  onToggleMode(): void;
  onShow(): void;
  onHide(): void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <div className="design-comment-controls" role="group" aria-label="Comments">
    <button aria-label={active ? "Done commenting" : "Comment"} title={active ? "Done commenting" : `Comment (C) · ${count} open comments`}
      aria-pressed={active} disabled={disabled} onClick={onToggleMode}>
      <MessageCircle size={16} />
      {active && <span>Done</span>}
      {!active && count > 0 && <span className="design-comment-count">{count}</span>}
    </button>
    <button ref={trigger} aria-label="More comment options" title="More comment options" aria-haspopup="menu" aria-expanded={open}
      disabled={disabled} onClick={() => setOpen(!open)}><ChevronDown size={12} /></button>
    {open && <DesignActionMenu trigger={trigger} onClose={() => setOpen(false)} label="Comment options" className="design-comment-options">
      <button role="menuitem" onClick={() => { setOpen(false); onShow(); }}><MessageCircle size={16} />Show all comments<span>{count}</span></button>
      {visible && <button role="menuitem" onClick={() => { setOpen(false); onHide(); }}><EyeOff size={16} />Hide comments<kbd>⇧C</kbd></button>}
    </DesignActionMenu>}
  </div>;
}
