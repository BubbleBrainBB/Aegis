import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Copy } from "../icons";
import { designLayerPath, findDesignLayer, readDesignLayers, replaceDesignLayerStyle, type DesignLayer } from "../../../shared/design-layers";
import type { DesignAnchor, DesignBoard } from "../../../shared/design-types";
import { cssText, formatInlineCss, inlineCssText, parseInlineCss, hexColors, swatchColor, type LayerCss } from "./design-css";

import "./design-code.css";
import { isImeComposing } from "../../utils/ime";

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
 * Only the selected layer’s inline declarations can be changed here.
 * The frame’s merged matched/inherited styles remain read-only.
 */
export function CodeTab({
  board,
  selection,
  loadStyles,
  onBoardSelect,
  onSelect,
  hideTree = false,
  editable = false,
  onChange,
}: {
  hideTree?: boolean;
  editable?: boolean;
  onChange?(board: DesignBoard, html: string): Promise<unknown>;
  board?: DesignBoard;
  selection?: { boardId: string; revision?: number; anchor: DesignAnchor };
  loadStyles(boardId: string, nodeId?: string): Promise<LayerCss | null>;
  onBoardSelect(board: DesignBoard): void;
  onSelect(board: DesignBoard, layer: DesignLayer): void;
}) {
  const nodeId = selection?.boardId === board?.id ? selection?.anchor.nodeId : undefined;
  const tree = useMemo(() => (board ? readDesignLayers(board.html) : []), [board?.html]);
  const node = findDesignLayer(tree, nodeId);
  const inline = node?.styles.cssText ?? "";
  const [draft, setDraft] = useState(() => formatInlineCss(inline));
  const [base, setBase] = useState(inline);
  const [baseRevision, setBaseRevision] = useState(board?.contentRevision);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const editingTarget = useRef("");
  editingTarget.current = `${board?.id ?? ""}:${nodeId ?? ""}`;
  const dirty = draft !== formatInlineCss(base);
  useEffect(() => {
    setDraft(formatInlineCss(inline)); setBase(inline); setBaseRevision(board?.contentRevision); setError("");
  }, [board?.id, nodeId]);
  useEffect(() => {
    if (!dirty) { setDraft(formatInlineCss(inline)); setBase(inline); setBaseRevision(board?.contentRevision); }
  }, [inline, board?.contentRevision, dirty]);
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
  const stale = baseRevision !== board.contentRevision;
  const locked = nodeId && (designLayerPath(tree, nodeId) ?? []).some((n) => n.locked);
  const canEdit = !!(editable && onChange && node && !locked && !pending &&
    (selection?.revision === undefined || selection.revision === board.contentRevision));
  const resetDraft = () => { setDraft(formatInlineCss(inline)); setBase(inline); setBaseRevision(board.contentRevision); setError(""); };
  async function saveInline() {
    if (!canEdit || !node || !onChange || stale) return;
    const target = editingTarget.current;
    setError(""); setPending(true);
    try {
      const declarations = parseInlineCss(draft);
      for (const { property, value } of declarations) {
        if (!CSS.supports(property, value)) throw new Error(`Invalid ${property}: ${value}`);
      }
      await onChange(board!, replaceDesignLayerStyle(board!.html, node.id, inlineCssText(declarations)));
      if (editingTarget.current === target) { setBase(inlineCssText(declarations)); setDraft(inlineCssText(declarations)); }
    } catch (e) {
      if (editingTarget.current === target) setError(e instanceof Error ? e.message : String(e));
    } finally { setPending(false); }
  }
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
      {!hideTree && <div className="cx-tree" role="tree" aria-label="Board layers" ref={list}>
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
      </div>}
      <section className="cx-inline-editor" aria-label="Inline CSS overrides">
        <div className="cx-source-title">Inline overrides <span>Editable source</span></div>
        <p className="cx-source-note">{node
          ? "Only declarations on this layer. Remove an override to use the stylesheet again."
          : "Select a layer to edit its inline CSS."}</p>
        {node && <>
          <textarea aria-label="Inline CSS" spellCheck={false} value={draft} readOnly={!canEdit}
            onChange={(e) => setDraft(e.target.value)} placeholder="color: #333;"
            onKeyDown={(e) => { if (!isImeComposing(e) && (e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void saveInline(); } }} />
          {stale && dirty && <p className="cx-source-warning" role="status">This board changed while you were editing. Reload its current inline CSS before saving.</p>}
          {error && <p className="cx-source-warning" role="alert">{error}</p>}
          <div className="cx-inline-actions">
            <button type="button" disabled={pending || (!dirty && !stale)} onClick={resetDraft}>{stale ? "Reload source" : "Discard"}</button>
            <button type="button" disabled={!canEdit || !dirty || stale} onClick={() => void saveInline()}>{pending ? "Saving…" : "Apply overrides"}</button>
          </div>
        </>}
      </section>
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
          <div className="cx-source-title">Matched styles <span>Read only · stylesheet + inline</span></div>
          <div className="cx-css" aria-label="Matched layer CSS">
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
