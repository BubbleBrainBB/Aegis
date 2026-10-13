import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Search, SquarePen, Trash2, X } from "../icons";
import { BoardThumb } from "./BoardThumb";
import { relativeTime } from "./design-ui";
import { useAppStore } from "../../store/useAppStore";
import { deleteDesign, openDesignInSection, startNewDesign, useDesignLibrary, useDesignStore } from "../../store/useDesignStore";
import type { DesignDocument, DesignSummary } from "../../../shared/design-types";

const leaf = (path: string | null | undefined) => (path ? path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path : "");

/** The Design section's sidebar: every design, grouped by its project. */
export function DesignSidebarPanel() {
  const designs = useDesignLibrary();
  const section = useDesignStore((s) => s.section);
  const projects = useAppStore(
    useShallow((s) =>
      Object.fromEntries(
        designs.map((d) => [d.id, d.project ?? s.sessions[d.sessionId]?.projectCwd ?? s.sessions[d.sessionId]?.cwd ?? ""]),
      ),
    ),
  );
  const [query, setQuery] = useState<string | null>(null);
  const groups = useMemo(() => {
    const q = query?.trim().toLowerCase();
    const shown = q ? designs.filter((d) => d.title.toLowerCase().includes(q)) : designs;
    const byProject = new Map<string, DesignSummary[]>();
    for (const d of shown) {
      const key = projects[d.id] || "";
      byProject.set(key, [...(byProject.get(key) ?? []), d]);
    }
    return [...byProject.entries()];
  }, [designs, projects, query]);
  const activeId = section?.documentId ?? (section ? undefined : designs[0]?.id);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-design-library>
      <div className="flex items-center justify-between pb-1 pl-3.5 pr-2 pt-2.5">
        <div className="aegis-sidebar-brand font-semibold leading-none tracking-[-0.02em] text-[var(--text-primary)]">Design</div>
        <button
          type="button"
          onClick={() => setQuery((q) => (q === null ? "" : null))}
          aria-label={query === null ? "Search designs" : "Close search"}
          className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
        >
          {query === null ? <Search className="h-4 w-4" strokeWidth={1.4} /> : <X className="h-4 w-4" />}
        </button>
      </div>
      {query !== null && (
        <div className="px-2.5 pt-1.5">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery(null)}
            placeholder="Search designs"
            aria-label="Search designs"
            className="h-8 w-full rounded-[8px] border-0 bg-[var(--sidebar-item-hover)] px-3 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
        </div>
      )}
      <div className="px-2 pt-2">
        <button
          type="button"
          onClick={() => startNewDesign()}
          className="flex h-8 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13.5px] text-[var(--text-primary)] hover:bg-[var(--sidebar-item-hover)]"
        >
          <SquarePen className="h-[15px] w-[15px]" />
          New design
        </button>
      </div>
      <div className="sidebar-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-3">
        {groups.length === 0 && (
          <p className="px-2 py-6 text-center text-[12.5px] leading-relaxed text-[var(--text-muted)]">
            {query ? "No designs match." : "Designs you or the agent make show up here."}
          </p>
        )}
        {groups.map(([project, rows]) => (
          <section key={project || "none"} className="mb-3">
            <h3 className="px-2 pb-1 text-[12px] font-normal text-[var(--text-muted)]">{leaf(project) || "No project"}</h3>
            {rows.map((d) => (
              <DesignRow key={d.id} design={d} active={d.id === activeId} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function DesignRow({ design, active }: { design: DesignSummary; active: boolean }) {
  const [doc, setDoc] = useState<DesignDocument | null>(null);
  useEffect(() => {
    let alive = true;
    void window.electron.design
      ?.read({ sessionId: design.sessionId, documentId: design.id })
      .then((d) => alive && setDoc(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [design.sessionId, design.id, design.revision]);
  const cover = doc?.boards[0];
  return (
    <div className="group relative">
      <button
        type="button"
        data-design-row={design.id}
        aria-current={active ? "true" : undefined}
        onClick={() => openDesignInSection(design)}
        className={`flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 pr-8 text-left ${
          active ? "bg-[var(--sidebar-item-active)]" : "hover:bg-[var(--sidebar-item-hover)]"
        }`}
      >
        {cover ? (
          <BoardThumb board={cover} width={42} height={28} className="flex-shrink-0 rounded-[5px] border border-[var(--border)] bg-white" />
        ) : (
          <span className="h-[28px] w-[42px] flex-shrink-0 rounded-[5px] border border-dashed border-[var(--border)]" />
        )}
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13.5px] text-[var(--text-primary)]">{design.title}</span>
          <span className="truncate text-[12px] text-[var(--text-muted)]">
            {design.boardCount} {design.boardCount === 1 ? "board" : "boards"}
            {design.chats.length > 1 ? ` · ${design.chats.length} chats` : ""} · {relativeTime(design.updatedAt)}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label={`Delete ${design.title}`}
        title="Delete design"
        data-design-delete={design.id}
        onClick={() => void deleteDesign(design)}
        className="absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[6px] text-[var(--text-muted)] opacity-0 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
