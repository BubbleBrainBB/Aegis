import { useRef, useState } from "react";
import { Check, ChevronDown, Plus } from "../icons";
import { DesignActionMenu } from "./DesignChrome";
import { relativeTime } from "./design-ui";
import { useAppStore } from "../../store/useAppStore";
import { startDesignChat, useDesignLibrary, useDesignStore } from "../../store/useDesignStore";
import { PROVIDERS } from "../../utils/provider";

/**
 * The design's chats, in the dock's header: each keeps its own conversation
 * and works on the same design. Switch between them, or start a new one.
 */
export function DesignChatSwitcher({ sessionId, documentId }: { sessionId: string; documentId: string }) {
  const design = useDesignLibrary().find((d) => d.id === documentId);
  const sessions = useAppStore((s) => s.sessions);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // The design's chats that still exist, and the one on screen (a new chat
  // joins the list with its first message).
  const ids = [...new Set([sessionId, ...(design?.chats ?? [])])].filter((id) => id === sessionId || sessions[id]);
  const titleOf = (id: string) => {
    const session = sessions[id];
    return !session || session.isDraft ? "New chat" : session.title?.trim() || "Untitled chat";
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-design-chat-switcher
        aria-haspopup="menu"
        aria-expanded={open}
        title="Chats on this design"
        onClick={() => setOpen(!open)}
        className="inline-flex h-6 min-w-0 max-w-[280px] flex-shrink items-center gap-1 rounded-[6px] px-1.5 text-[12.5px] font-medium text-[var(--text-primary)] hover:bg-[var(--sidebar-item-hover)]"
      >
        <span className="truncate">{titleOf(sessionId)}</span>
        <ChevronDown className="h-3 w-3 flex-shrink-0 text-[var(--text-muted)]" />
      </button>
      {open ? (
        <DesignActionMenu trigger={trigger} onClose={() => setOpen(false)} label="Chats on this design" align="start" className="design-chat-menu">
          <div className="design-menu-label">Chats on this design</div>
          {ids.map((id) => {
            const session = sessions[id];
            const agent = PROVIDERS.find((p) => p.id === session?.provider)?.label;
            return (
              <button
                key={id}
                role="menuitemradio"
                aria-checked={id === sessionId}
                data-design-chat={id}
                onClick={() => {
                  setOpen(false);
                  if (id !== sessionId) useDesignStore.getState().setSection({ sessionId: id, documentId });
                }}
              >
                <span className="design-chat-check">{id === sessionId ? <Check size={13} /> : null}</span>
                <span className="design-chat-title">{titleOf(id)}</span>
                <span className="design-chat-meta">
                  {[agent, session && !session.isDraft && session.updatedAt ? relativeTime(session.updatedAt) : null].filter(Boolean).join(" · ")}
                </span>
              </button>
            );
          })}
          <div className="design-menu-divider" role="separator" />
          <button
            role="menuitem"
            data-design-new-chat
            onClick={() => {
              setOpen(false);
              startDesignChat({ id: documentId, project: design?.project ?? sessions[sessionId]?.projectCwd ?? sessions[sessionId]?.cwd ?? null });
            }}
          >
            <span className="design-chat-check"><Plus size={13} /></span>
            <span className="design-chat-title">New chat</span>
          </button>
        </DesignActionMenu>
      ) : null}
    </>
  );
}
