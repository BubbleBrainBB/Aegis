import { useEffect, useRef, useState } from "react";
import { MainSheet } from "../MainSheet";
import { DesignPanel } from "./DesignPanel";
import { DesignAgentDock } from "./DesignAgentDock";
import { liveDesignChat, startDesignChat, startNewDesign, useDesignLibrary, useDesignStore } from "../../store/useDesignStore";
import { useAppStore } from "../../store/useAppStore";
import { SquarePen } from "../icons";
import type { CodexModelConfig } from "../../types";

const leaf = (path: string | null | undefined) => (path ? path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path : "");

/**
 * The Design section: the whole main area is the canvas, its toolbar sits in
 * the title bar, and the design's conversation floats over it as a small
 * dock the user can move, open into a chat, or tuck away.
 */
export function DesignSection({ codexModelConfig }: { codexModelConfig: CodexModelConfig }) {
  const library = useDesignLibrary();
  const section = useDesignStore((s) => s.section);
  const newest = library[0];
  // With nothing picked, the newest design and its latest chat (a new chat if
  // every chat that worked on it is gone).
  const newestChat = useAppStore((s) => (newest ? liveDesignChat(newest) : undefined) ?? (newest && s.sessionsLoaded ? null : undefined));
  const target = section ?? (newest && newestChat ? { sessionId: newestChat, documentId: newest.id } : null);
  useEffect(() => {
    if (!section && newest && newestChat === null) startDesignChat(newest);
  }, [section, newest, newestChat]);
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const project = useAppStore((s) => (target ? s.sessions[target.sessionId]?.projectCwd ?? s.sessions[target.sessionId]?.cwd : null));

  return (
    <MainSheet
      header={
        target?.documentId ? (
          <div ref={setToolbarHost} className="flex h-full min-w-0 flex-1 items-center" data-design-titlebar />
        ) : (
          <div className="flex min-w-0 items-baseline gap-2 text-[13.5px]">
            <span className="font-semibold text-[var(--text-primary)]">{target ? "New design" : "Design"}</span>
            {project ? <span className="truncate text-[var(--text-muted)]">{leaf(project)}</span> : null}
          </div>
        )
      }
    >
      <div ref={stage} className="relative min-h-0 flex-1" data-design-section>
        {!target ? (
          newest ? null : <DesignSectionEmpty />
        ) : target.documentId ? (
          <DesignPanel
            // One canvas per design: switching its chat keeps the view.
            key={target.documentId}
            sessionId={target.sessionId}
            documentId={target.documentId}
            hidden={false}
            chrome="section"
            toolbarHost={toolbarHost}
            canvasOverlay={(canvas) => (
              <DesignAgentDock
                key={target.sessionId}
                sessionId={target.sessionId}
                documentId={target.documentId}
                stage={canvas}
                codexModelConfig={codexModelConfig}
              />
            )}
          />
        ) : (
          <>
            <DesignStartCanvas />
            <DesignAgentDock key={target.sessionId} sessionId={target.sessionId} stage={stage} codexModelConfig={codexModelConfig} />
          </>
        )}
      </div>
    </MainSheet>
  );
}

/** A new design before its first board: the canvas waits for the first message. */
function DesignStartCanvas() {
  return (
    <div className="absolute inset-0 flex" data-design-start>
      <div className="design-viewport flex h-full items-center justify-center">
      <div className="max-w-[360px] -translate-y-10 text-center">
        <h2 className="text-[19px] font-medium text-[var(--text-primary)]">What should we design?</h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--text-muted)]">
          Describe a page, a screen or a flow. The agent draws the boards here, and you can edit them by hand or comment on them.
        </p>
      </div>
      </div>
    </div>
  );
}

function DesignSectionEmpty() {
  return (
    <div className="absolute inset-0 flex">
      <div className="design-viewport flex h-full items-center justify-center">
      <div className="max-w-[360px] -translate-y-6 text-center">
        <h2 className="text-[19px] font-medium text-[var(--text-primary)]">No designs yet</h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--text-muted)]">
          Start one here, or ask for a design in any chat; it shows up in this list.
        </p>
        <button
          type="button"
          onClick={() => startNewDesign()}
          className="mt-4 inline-flex items-center gap-2 rounded-[9px] bg-[var(--text-primary)] px-3.5 py-2 text-[13px] text-[var(--bg-primary)]"
        >
          <SquarePen className="h-[14px] w-[14px]" />
          New design
        </button>
      </div>
      </div>
    </div>
  );
}
