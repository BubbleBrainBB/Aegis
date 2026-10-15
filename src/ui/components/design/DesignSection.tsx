import { useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { MainSheet } from "../MainSheet";
import { DesignPanel } from "./DesignPanel";
import { DesignAgentDock } from "./DesignAgentDock";
import { deleteDesign, openDesignInSection, startNewDesign, useDesignLibrary, useDesignStore } from "../../store/useDesignStore";
import { DesignCards } from "./DesignCards";
import { useAppStore } from "../../store/useAppStore";
import { Plus, SquarePen } from "../icons";
import type { CodexModelConfig } from "../../types";

const leaf = (path: string | null | undefined) => (path ? path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path : "");

/**
 * The Design section: a home of every design as cards, by project. Opening
 * one gives the whole main area to its canvas, the toolbar sits in the title
 * bar (← back home), and the design's conversation floats over it as a small
 * dock the user can move, open into a chat, or tuck away.
 */
export function DesignSection({ codexModelConfig }: { codexModelConfig: CodexModelConfig }) {
  const library = useDesignLibrary();
  const section = useDesignStore((s) => s.section);
  // Nothing picked: the home.
  const target = section;
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
            <span className="font-semibold text-[var(--text-primary)]">{target ? "New design" : "Designs"}</span>
            {target && project ? <span className="truncate text-[var(--text-muted)]">{leaf(project)}</span> : null}
          </div>
        )
      }
    >
      <div ref={stage} className="relative min-h-0 flex-1" data-design-section>
        {!target ? (
          library.length ? <DesignHome /> : <DesignSectionEmpty />
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

/** Every design as a card, grouped by its project; opening one shows its canvas. */
function DesignHome() {
  const designs = useDesignLibrary();
  const projects = useAppStore(
    useShallow((s) =>
      Object.fromEntries(
        designs.map((d) => [d.id, d.project ?? s.sessions[d.sessionId]?.projectCwd ?? s.sessions[d.sessionId]?.cwd ?? ""]),
      ),
    ),
  );
  const groups = useMemo(() => {
    const byProject = new Map<string, typeof designs>();
    for (const d of designs) byProject.set(projects[d.id] || "", [...(byProject.get(projects[d.id] || "") ?? []), d]);
    return [...byProject.entries()];
  }, [designs, projects]);
  return (
    <section className="design-panel design-library design-home" aria-label="Designs" data-design-home>
      <div className="design-library-heading">
        <div>
          <h2>Designs</h2>
          <p>{designs.length} {designs.length === 1 ? "design" : "designs"}</p>
        </div>
        <button type="button" className="design-library-new" onClick={() => startNewDesign()}>
          <Plus size={14} />
          New design
        </button>
      </div>
      {groups.map(([project, rows]) => (
        <div key={project || "none"} className="design-home-group" data-design-project={project || ""}>
          <h3>{leaf(project) || "No project"}</h3>
          <DesignCards designs={rows} onOpen={(d) => openDesignInSection(d)} onDelete={(d) => void deleteDesign(d)} />
        </div>
      ))}
    </section>
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
