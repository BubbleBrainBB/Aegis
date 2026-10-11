import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Copy } from "../icons";
import { designLayerPath, readDesignLayers, type DesignLayer } from "../../../shared/design-layers";
import type { DesignAnchor, DesignBoard } from "../../../shared/design-types";
import { cssText, hexColors, swatchColor, type LayerCss } from "./design-css";

const svg = (path: ReactNode) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {path}
  </svg>
);
const kindIcon = {
  board: svg(<rect x="4" y="4" width="16" height="16" rx="2" />),
  text: svg(<path d="M6 6h12M12 6v13" />),
  image: svg(<><rect x="4" y="5" width="16" height="14" rx="2" /><path d="m4 16 5-5 4 4 3-3 4 4" /></>),
  frame: svg(<path d="M9 4v16M15 4v16M4 9h16M4 15h16" />),
};
const iconOf = (n: DesignLayer) =>
  n.tag === "img" || n.tag === "svg"
    ? kindIcon.image
    : n.textEditable && n.text
      ? kindIcon.text
      : kindIcon.frame;
/** Generated names repeat the tag and text; show the tag and quote the text instead. */
function labelOf(n: DesignLayer) {
  const generated = n.name === n.tag || n.name.startsWith(n.tag + " · ");
  const text = n.text.replace(/\s+/g, " ").trim();
  return { name: generated ? n.tag : n.name, quote: text ? `“${text.slice(0, 60)}”` : "" };
}

/**
 * The selection's place in the tree, its authored CSS and what it inherits.
 * Read-only: edits go through the Design tab or the agent.
 */
export function CodeTab({
  board,
  selection,
  loadStyles,
  onBoardSelect,
  onSelect,
}: {
  board?: DesignBoard;
  selection?: { boardId: string; anchor: DesignAnchor };
  loadStyles(boardId: string, nodeId?: string): Promise<LayerCss | null>;
  onBoardSelect(board: DesignBoard): void;
  onSelect(board: DesignBoard, layer: DesignLayer): void;
}) {
  const nodeId = selection?.boardId === board?.id ? selection?.anchor.nodeId : undefined;
  const tree = useMemo(() => (board ? readDesignLayers(board.html) : []), [board?.html]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [css, setCss] = useState<{ key: string; value: LayerCss } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const key = board ? `${board.id}:${board.contentRevision}:${nodeId ?? ""}` : "";

  // Expand down to the selection and keep its row in view.
  useEffect(() => {
    if (!nodeId) return;
    const path = new Set((designLayerPath(tree, nodeId) ?? []).map((n) => n.id));
    setCollapsed((old) => new Set([...old].filter((id) => !path.has(id))));
    requestAnimationFrame(() =>
      list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }),
    );
  }, [board?.id, nodeId]);

  // The frame may still be loading a new revision; retry briefly until it answers.
  useEffect(() => {
    if (!board) return;
    let live = true;
    void (async () => {
      for (let i = 0; i < 6 && live; i++) {
        const value = await loadStyles(board.id, nodeId);
        if (!live) return;
        if (value) return setCss({ key, value });
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    return () => {
      live = false;
    };
  }, [key]);

  if (!board) return <p className="design-empty-note">Select a board or layer</p>;
  // Keep the last answer for the same layer across revisions, so edits don't flash.
  const same = (a: string) => a.split(":").filter((_, i) => i !== 1).join(":");
  const current = css && same(css.key) === same(key) ? css.value : null;
  const toggle = (id: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const row = (n: DesignLayer, depth: number): ReactNode => {
    const { name, quote } = labelOf(n);
    const open = !collapsed.has(n.id);
    return (
      <div key={n.id} role="none">
        <div
          className="cx-row"
          role="treeitem"
          aria-selected={n.id === nodeId}
          aria-expanded={n.children.length ? open : undefined}
          data-layer-id={n.id}
          style={{ paddingLeft: 4 + depth * 16 }}
        >
          <button
            className="cx-chev"
            aria-label={(open ? "Collapse " : "Expand ") + name}
            tabIndex={-1}
            disabled={!n.children.length}
            onClick={() => toggle(n.id)}
          >
            {n.children.length > 0 && (open ? <ChevronDown size={11} /> : <ChevronRight size={11} />)}
          </button>
          <button className="cx-name" title={n.name} onClick={() => onSelect(board, n)}>
            <span className="cx-kind">{iconOf(n)}</span>
            <span>{name}</span>
            {quote && <span className="cx-quote">{quote}</span>}
          </button>
        </div>
        {open && n.children.length > 0 && (
          <div role="group">{n.children.map((c) => row(c, depth + 1))}</div>
        )}
      </div>
    );
  };
  return (
    <div className="design-tab-body design-code-tab">
      <div className="cx-tree" role="tree" aria-label="Board layers" ref={list}>
        <div className="cx-row" role="treeitem" aria-selected={!nodeId} aria-expanded>
          <span className="cx-chev">
            <ChevronDown size={11} />
          </span>
          <button className="cx-name is-board" onClick={() => onBoardSelect(board)}>
            <span className="cx-kind">{kindIcon.board}</span>
            <span>{board.name}</span>
          </button>
        </div>
        <div role="group">{tree.map((n) => row(n, 1))}</div>
      </div>
      {current && (
        <>
          <div className="cx-head">
            <span>&lt;{current.tag}&gt;</span>
            {current.text && nodeId && <span className="cx-quote">“{current.text}”</span>}
            <button
              className="design-icon-button"
              aria-label="Copy CSS"
              title="Copy CSS"
              disabled={!current.own.length}
              onClick={() =>
                void navigator.clipboard
                  .writeText(cssText(current.own))
                  .then(() => toast.success("Copied CSS"))
              }
            >
              <Copy size={13} />
            </button>
          </div>
          <div className="cx-css" aria-label="Layer CSS">
            {current.own.length ? (
              current.own.map(([k, v]) => <div key={k}>{cssText([[k, v]])}</div>)
            ) : (
              <span className="cx-none">No styles of its own</span>
            )}
          </div>
          {current.inherited.map((g, i) => (
            <section key={i} className="cx-inherit" aria-label={`Inherited from ${g.label}`}>
              <div className="cx-from">
                From <code>{g.label}</code>
              </div>
              {g.decls.map(([k, v]) => {
                const color = swatchColor(k, v);
                return (
                  <div key={k} className="cx-decl">
                    <span className="cx-prop">{k}</span>
                    <span className="cx-value" title={hexColors(v)}>
                      {color && <i className="cx-swatch" style={{ background: color }} />}
                      {hexColors(v)}
                    </span>
                  </div>
                );
              })}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
