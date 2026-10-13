import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { PromptInput } from "../PromptInput";
import { ChatPane } from "../ChatPane";
import { ArrowUpRight, ChevronDown, ChevronUp, GripVertical, Minus } from "../icons";
import { useAppStore } from "../../store/useAppStore";
import { openDesign } from "../../store/useDesignStore";
import { PROVIDERS } from "../../utils/provider";
import { useDesignDraftStatus } from "./design-draft-status";
import { DesignComposerControls } from "./DesignComposerControls";
import { DesignChatSwitcher } from "./DesignChatSwitcher";
import type { CodexModelConfig } from "../../types";

type DockMode = "composer" | "chat" | "pill";
type Corner = "br" | "bl" | "tr" | "tl";
const PREFS_KEY = "aegis.design.dock";
const INSET = 16;
/** Top corners sit below the canvas toolbars. */
const TOP_INSET = 72;

function loadPrefs(): { mode: DockMode; corner: Corner } {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return {
      mode: raw.mode === "chat" || raw.mode === "pill" ? raw.mode : "composer",
      corner: ["br", "bl", "tr", "tl"].includes(raw.corner) ? raw.corner : "br",
    };
  } catch {
    return { mode: "composer", corner: "br" };
  }
}
function savePrefs(prefs: { mode: DockMode; corner: Corner }) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}
const cornerStyle = (corner: Corner) => ({
  ...(corner[0] === "b" ? { bottom: INSET } : { top: TOP_INSET }),
  ...(corner[1] === "r" ? { right: INSET } : { left: INSET }),
});

/**
 * The design's conversation, floating over the canvas. By default only the
 * composer shows, with a status line for the run; "Show chat" lifts the
 * conversation above it; minimized it is a pill. Drag it by its grip and it
 * snaps to the nearest corner.
 */
export function DesignAgentDock({
  sessionId,
  documentId,
  stage,
  codexModelConfig,
}: {
  sessionId: string;
  documentId?: string;
  stage: RefObject<HTMLDivElement | null>;
  codexModelConfig: CodexModelConfig;
}) {
  const [{ mode, corner }, setPrefs] = useState(loadPrefs);
  const update = useCallback((next: Partial<{ mode: DockMode; corner: Corner }>) => {
    setPrefs((prev) => {
      const merged = { ...prev, ...next };
      savePrefs(merged);
      return merged;
    });
  }, []);
  const session = useAppStore((s) => s.sessions[sessionId]);
  const isDraft = !session || session.isDraft;
  const running = session?.status === "running";
  const agent = PROVIDERS.find((p) => p.id === session?.provider)?.label ?? "Agent";
  const status = useDesignDraftStatus(sessionId, running);
  // The agent waits on an approval: the chat opens until it is answered,
  // then the dock goes back to how the user left it (the preference is kept).
  const waiting = !isDraft && (session?.permissionRequests?.length ?? 0) > 0;
  // A new design has no chat to show yet.
  const shownMode: DockMode = waiting ? "chat" : isDraft && mode === "chat" ? "composer" : mode;

  const dock = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const startDrag = (event: ReactPointerEvent) => {
    if (event.button !== 0 || !dock.current || !stage.current) return;
    const box = dock.current.getBoundingClientRect();
    const host = stage.current.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ x: box.left - host.left, y: box.top - host.top, dx: event.clientX - box.left, dy: event.clientY - box.top });
    event.preventDefault();
  };
  const moveDrag = (event: ReactPointerEvent) => {
    if (!drag || !stage.current) return;
    const host = stage.current.getBoundingClientRect();
    setDrag({ ...drag, x: event.clientX - host.left - drag.dx, y: event.clientY - host.top - drag.dy });
  };
  const endDrag = (event: ReactPointerEvent) => {
    if (!drag || !stage.current || !dock.current) return;
    const host = stage.current.getBoundingClientRect();
    const box = dock.current.getBoundingClientRect();
    const cx = box.left + box.width / 2 - host.left;
    const cy = box.top + box.height / 2 - host.top;
    update({ corner: `${cy > host.height / 2 ? "b" : "t"}${cx > host.width / 2 ? "r" : "l"}` as Corner });
    setDrag(null);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const dragHandlers = { onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag };
  useEffect(() => {
    if (!drag) return;
    const cancel = (e: KeyboardEvent) => e.key === "Escape" && setDrag(null);
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [drag]);

  const position = drag ? { left: drag.x, top: drag.y } : cornerStyle(corner);
  const openAsChat = () => {
    if (documentId) openDesign({ sessionId, documentId, where: "pane" });
  };

  const statusLine = (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] text-[var(--text-muted)]" data-design-dock-status>
      {running ? <span aria-hidden="true" className="design-dock-spinner" /> : null}
      <span className="truncate">
        {waiting ? "Waiting for your approval" : status ?? (running ? "Working…" : shownMode === "pill" ? "Ready" : isDraft && !documentId ? "New design" : agent)}
      </span>
    </span>
  );
  const iconButton = "inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-[6px] text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]";

  return (
    <>
      {drag ? <DockSnapTargets /> : null}
      <div
        ref={dock}
        role="complementary"
        aria-label="Design conversation"
        data-design-dock={shownMode}
        data-design-dock-attention={waiting ? "approval" : undefined}
        data-design-dock-corner={corner}
        className={`design-dock absolute z-30 flex flex-col overflow-hidden ${shownMode === "pill" ? "rounded-full" : "rounded-[16px]"} ${drag ? "is-dragging" : ""}`}
        style={{
          ...position,
          width: shownMode === "pill" ? undefined : shownMode === "chat" ? 460 : 440,
          height: shownMode === "chat" ? "min(620px, calc(100% - 32px))" : undefined,
        }}
      >
        {shownMode === "pill" ? (
          <div className="flex items-center gap-2 py-1.5 pl-1.5 pr-2">
            <span className={`${iconButton} cursor-grab`} {...dragHandlers} aria-label="Move" role="button" tabIndex={-1}>
              <GripVertical className="h-3.5 w-3.5" />
            </span>
            <span className="flex min-w-0 flex-col pr-1">
              <span className="text-[12.5px] font-medium text-[var(--text-primary)]">{agent}</span>
              {statusLine}
            </span>
            <button type="button" className={iconButton} onClick={() => update({ mode: "composer" })} aria-label="Expand">
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <>
            <div className="flex h-9 flex-shrink-0 items-center gap-1.5 border-b border-[var(--panel-soft-divider)] pl-1.5 pr-2">
              <span className={`${iconButton} cursor-grab`} {...dragHandlers} aria-label="Move" role="button" tabIndex={-1}>
                <GripVertical className="h-3.5 w-3.5" />
              </span>
              {documentId ? <DesignChatSwitcher sessionId={sessionId} documentId={documentId} /> : null}
              {statusLine}
              {!isDraft && documentId ? (
                <button type="button" className={iconButton} onClick={openAsChat} aria-label="Open as a chat" title="Open as a chat">
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </button>
              ) : null}
              {!isDraft && !waiting ? (
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[12px] text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                  onClick={() => update({ mode: shownMode === "chat" ? "composer" : "chat" })}
                  aria-expanded={shownMode === "chat"}
                >
                  {shownMode === "chat" ? "Hide chat" : "Show chat"}
                  {shownMode === "chat" ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
                </button>
              ) : null}
              {!waiting ? (
                <button type="button" className={iconButton} onClick={() => update({ mode: "pill" })} aria-label="Minimize">
                  <Minus className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            {shownMode === "chat" ? (
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-design-dock-chat>
                <ChatPane
                  paneId={`design-dock:${sessionId}`}
                  sessionId={sessionId}
                  isActive
                  onActivate={() => {}}
                  codexModelConfig={codexModelConfig}
                  showHeader={false}
                />
              </div>
            ) : (
              <div className="design-dock-composer" data-design-dock-composer>
                <PromptInput
                  sessionId={sessionId}
                  leadingControls={<DesignComposerControls sessionId={sessionId} />}
                  idlePlaceholder={documentId ? "Describe a change, or ask for a new board…" : "Design anything…"}
                />
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** Where the dock can land: one dashed target per corner while dragging. */
function DockSnapTargets() {
  return (
    <>
      {(["tl", "tr", "bl", "br"] as Corner[]).map((corner) => (
        <div key={corner} aria-hidden="true" className="design-dock-snap pointer-events-none absolute z-20" style={cornerStyle(corner)} />
      ))}
    </>
  );
}
