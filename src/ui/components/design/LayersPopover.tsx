import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff, Lock, Unlock, X } from "../icons";
import type { DesignAnchor, DesignBoard } from "../../../shared/design-types";
import {
  designLayerPath,
  editDesignLayer,
  readDesignLayers,
  type DesignLayer,
} from "../../../shared/design-layers";

/**
 * Layers named like components ("Card/Plus", "Button/Primary") grouped by
 * their family, plus any layer name used more than once: the design's
 * reusable pieces, as a design tool lists them.
 */
export function designComponents(boards: DesignBoard[]) {
  const groups = new Map<string, { name: string; uses: { board: DesignBoard; node: DesignLayer }[] }[]>();
  const all: { board: DesignBoard; node: DesignLayer }[] = [];
  const walk = (board: DesignBoard, nodes: DesignLayer[]) => {
    for (const node of nodes) {
      all.push({ board, node });
      walk(board, node.children);
    }
  };
  for (const board of boards) walk(board, readDesignLayers(board.html));
  const byName = new Map<string, { board: DesignBoard; node: DesignLayer }[]>();
  for (const use of all) {
    if (!use.node.named) continue;
    const name = use.node.name.split(" · ")[0];
    byName.set(name, [...(byName.get(name) ?? []), use]);
  }
  for (const [name, uses] of byName) {
    const slash = name.indexOf("/");
    if (slash <= 0 && uses.length < 2) continue;
    const family = slash > 0 ? name.slice(0, slash).trim() : name;
    const variants = groups.get(family) ?? [];
    variants.push({ name: slash > 0 ? name.slice(slash + 1).trim() || name : name, uses });
    groups.set(family, variants);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

type LayersTab = "layers" | "components";

/** The full layer tree, floating over the canvas (⌥L), and the design's components. */
export function LayersPopover({
  boards,
  selectedBoardId,
  selection,
  editable,
  onBoardSelect,
  onSelect,
  onChange,
  onClose,
  onOpenHistory,
  embedded = false,
}: {
  embedded?: boolean;
  boards: DesignBoard[];
  selectedBoardId?: string;
  selection?: { boardId: string; revision: number; anchor: DesignAnchor };
  editable: boolean;
  onBoardSelect(id: string): void;
  onSelect(board: DesignBoard, node: DesignLayer): void;
  onChange(board: DesignBoard, html: string): Promise<unknown>;
  onClose(): void;
  /** History lives in its own column; its tab opens it. */
  onOpenHistory?(): void;
}) {
  const [tab, setTab] = useState<LayersTab>("layers");
  const components = useMemo(() => (tab === "components" ? designComponents(boards) : []), [boards, tab]);
  const trees = useMemo(
    () => new Map(boards.map((b) => [b.id, readDesignLayers(b.html)])),
    [boards],
  );
  // Focus the selected board's tree; with nothing selected, show everything.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const focus = selection?.boardId ?? selectedBoardId;
    return new Set(focus ? boards.filter((b) => b.id !== focus).map((b) => b.id) : []);
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = selection?.anchor.nodeId;
    const board = selection?.boardId;
    if (!id || !board) return;
    const path = [board, ...(designLayerPath(trees.get(board) ?? [], id) ?? []).map((n) => board + ":" + n.id)];
    setCollapsed((old) => new Set([...old].filter((x) => !path.includes(x))));
    requestAnimationFrame(() =>
      panel.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }),
    );
  }, [selection?.boardId, selection?.anchor.nodeId]);
  const toggle = (id: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  async function change(b: DesignBoard, transform: () => string) {
    if (!editable || pending) return;
    setPending(true);
    setError("");
    try {
      await onChange(b, transform());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }
  function row(b: DesignBoard, n: DesignLayer, depth: number, locked = false): React.ReactNode {
    const key = b.id + ":" + n.id;
    const selected = selection?.boardId === b.id && selection.anchor.nodeId === n.id;
    return (
      <div key={n.id} role="none">
        <div
          className={
            "design-layer-row" +
            (n.hidden ? " is-hidden" : "") +
            (n.hidden || n.locked ? " has-flags" : "")
          }
          role="treeitem"
          aria-selected={selected}
          aria-expanded={n.children.length ? !collapsed.has(key) : undefined}
          aria-level={depth + 2}
          data-layer-id={n.id}
          style={{ paddingLeft: 6 + depth * 14 }}
        >
          <button
            className="design-layer-disclosure"
            aria-label={(collapsed.has(key) ? "Expand " : "Collapse ") + n.name}
            disabled={!n.children.length}
            onClick={() => toggle(key)}
          >
            {n.children.length ? (
              collapsed.has(key) ? <ChevronRight size={12} /> : <ChevronDown size={12} />
            ) : (
              <span />
            )}
          </button>
          <button className="design-layer-name" title={n.name} onClick={() => onSelect(b, n)}>
            <span className="design-layer-kind">
              {n.textEditable ? "T" : n.tag === "img" ? "▣" : "#"}
            </span>
            <span>{n.name}</span>
          </button>
          <button
            className={"design-layer-flag" + (n.hidden ? " is-on" : "")}
            aria-label={(n.hidden ? "Show " : "Hide ") + n.name}
            title={n.hidden ? "Show layer" : "Hide layer"}
            disabled={!editable || pending || n.locked || locked}
            onClick={() =>
              void change(b, () => editDesignLayer(b.html, n.id, { type: "hidden", value: !n.hidden }))
            }
          >
            {n.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
          <button
            className={"design-layer-flag" + (n.locked ? " is-on" : "")}
            aria-label={(n.locked ? "Unlock " : "Lock ") + n.name}
            title={n.locked ? "Unlock layer" : "Lock layer"}
            disabled={!editable || pending || locked}
            onClick={() =>
              void change(b, () => editDesignLayer(b.html, n.id, { type: "locked", value: !n.locked }))
            }
          >
            {n.locked ? <Lock size={12} /> : <Unlock size={12} />}
          </button>
        </div>
        {!collapsed.has(key) && n.children.length > 0 && (
          <div role="group">{n.children.map((c) => row(b, c, depth + 1, locked || n.locked))}</div>
        )}
      </div>
    );
  }
  return (
    <div
      ref={panel}
      className="design-layers-popover"
      data-canvas-ui
      aria-label="Layers"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <div className="design-layers-tabs" role="tablist" aria-label="Layers panel">
          {(["layers", "components"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === "layers" ? "Layers" : "Components"}
            </button>
          ))}
          {!embedded && onOpenHistory && (
            <button role="tab" aria-selected={false} onClick={onOpenHistory}>
              History
            </button>
          )}
        </div>
        <span />
        {!embedded && <button className="design-icon-button" aria-label="Close layers" title="Close (⌥L)" onClick={onClose}>
          <X size={12} />
        </button>}
      </header>
      {tab === "components" ? (
        <div className="design-layer-tree" aria-label="Design components">
          {components.length === 0 && (
            <p className="design-empty-note">
              Name layers like “Card/Plus” or reuse a layer name, and they show up here as components.
            </p>
          )}
          {components.map(([family, variants]) => (
            <section key={family} className="design-component-family">
              <h4>{family}</h4>
              {variants.map((v) => (
                <button
                  key={v.name}
                  className="design-layer-row design-component-row"
                  title={`${v.uses.length} use${v.uses.length === 1 ? "" : "s"}`}
                  onClick={() => onSelect(v.uses[0].board, v.uses[0].node)}
                >
                  <span className="design-component-mark" aria-hidden="true" />
                  <span className="design-component-name">{v.name}</span>
                  <span className="design-component-count">{v.uses.length}×</span>
                </button>
              ))}
            </section>
          ))}
        </div>
      ) : (
      <div className="design-layer-tree" role="tree" aria-label="Design layers">
        {boards.map((b) => (
          <div key={b.id} role="none">
            <div
              className="design-layer-row design-layer-board"
              role="treeitem"
              aria-expanded={!collapsed.has(b.id)}
              aria-selected={selectedBoardId === b.id && !selection?.anchor.nodeId}
            >
              <button
                className="design-layer-disclosure"
                aria-label={(collapsed.has(b.id) ? "Expand " : "Collapse ") + b.name}
                onClick={() => toggle(b.id)}
              >
                {collapsed.has(b.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </button>
              <button className="design-layer-name" onClick={() => onBoardSelect(b.id)}>
                <span className="design-layer-kind">▢</span>
                <span>{b.name}</span>
              </button>
            </div>
            {!collapsed.has(b.id) && (
              <div role="group">{(trees.get(b.id) ?? []).map((n) => row(b, n, 0))}</div>
            )}
          </div>
        ))}
      </div>
      )}
      {error && (
        <div className="design-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
