import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bold, Italic, MessageSquare, MoreVertical, Pencil, ChevronDown } from "../icons";
import { DesignToolButton } from "./DesignChrome";
import { Dropdown, icon } from "./InspectorControls";
import { toHex } from "./ColorSwatch";
import { readBoardTokens } from "../../../shared/design-tokens";
import { designLayerPath, findDesignLayer, readDesignLayers, replaceDesignLayerStyle } from "../../../shared/design-layers";
import type { DesignAnchor, DesignBoard } from "../../../shared/design-types";

/** Local style edits share the inspector's lock, revision, CSS and persistence rules. */
export function selectionStyleEdit(board: DesignBoard, revision: number, nodeId: string, values: Record<string, string>) {
  if (board.contentRevision !== revision) throw new Error("The layer changed. Select it again before editing.");
  const tree = readDesignLayers(board.html);
  const node = findDesignLayer(tree, nodeId);
  if (!node) throw new Error("Layer no longer exists.");
  if (node.locked || designLayerPath(tree, nodeId)?.some(parent => parent.locked)) throw new Error("Unlock this layer or its parent before editing.");
  const style = document.createElement("div").style;
  style.cssText = node.styles.cssText;
  for (const [property, value] of Object.entries(values)) {
    if (!value) style.removeProperty(property);
    else if (!CSS.supports(property, value)) throw new Error(`Invalid ${property}: ${value}`);
    else style.setProperty(property, value, "important");
  }
  return replaceDesignLayerStyle(board.html, nodeId, style.cssText);
}

/** Form popovers use a portal so a narrow, scrollable strip cannot clip them. */
function FormPopover({ label, face, children, disabled }: { label: string; face: ReactNode; children: ReactNode; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = trigger.current?.getBoundingClientRect(), p = popup.current;
      if (!r || !p) return;
      setPosition({ left: Math.max(8, Math.min(window.innerWidth - p.offsetWidth - 8, r.left)), top: r.bottom + p.offsetHeight + 6 < window.innerHeight ? r.bottom + 6 : Math.max(8, r.top - p.offsetHeight - 6) });
    };
    place();
    popup.current?.querySelector<HTMLElement>("input,button,select")?.focus();
    const outside = (e: PointerEvent) => {
      if (popup.current?.contains(e.target as Node) || trigger.current?.contains(e.target as Node)) return;
      // Commit an edited field before unmounting it; Escape remains a cancel.
      if (document.activeElement instanceof HTMLElement && popup.current?.contains(document.activeElement)) document.activeElement.blur();
      setOpen(false);
    };
    const scroll = (e: Event) => { if (!popup.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", place); window.removeEventListener("scroll", scroll, true); };
  }, [open]);
  return <>
    <button ref={trigger} type="button" className="design-selection-chip" aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>{face}<ChevronDown size={12}/></button>
    {open && createPortal(<div ref={popup} role="dialog" aria-label={label} className="design-surface design-selection-popover" data-canvas-ui style={position}
      onPointerDown={e => e.stopPropagation()} onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); setOpen(false); trigger.current?.focus(); } }}
      onBlur={e => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node) && !trigger.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <strong>{label}</strong>{children}
    </div>, document.body)}
  </>;
}

function ValueField({ label, value, disabled, onCommit }: { label: string; value: string; disabled: boolean; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(value);
  const canceled = useRef(false);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (!canceled.current && draft.trim() !== value) onCommit(draft.trim()); canceled.current = false; };
  return <label className="design-selection-field"><span>{label}</span><input aria-label={label} value={draft} disabled={disabled}
    onChange={e => { canceled.current = false; setDraft(e.target.value); }} onBlur={commit}
    onKeyDown={e => { if (e.key === "Escape") { canceled.current = true; setDraft(value); } if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}/></label>;
}

const px = (v: string) => /^-?\d+(\.\d+)?$/.test(v) ? `${v}px` : v;
const visiblePaint = (v: string) => !!v && !["none", "transparent", "rgba(0, 0, 0, 0)"].includes(v);

export function SelectionTools({ board, anchor, revision, editable, onChange, onEditText, onComment, onProperties }: {
  board: DesignBoard; anchor: DesignAnchor; revision: number; editable: boolean;
  onChange(board: DesignBoard, html: string): Promise<unknown>;
  onEditText?(): void; onComment(): void; onProperties(): void;
}) {
  const tree = useMemo(() => readDesignLayers(board.html), [board.html]);
  const node = findDesignLayer(tree, anchor.nodeId);
  const tokens = useMemo(() => readBoardTokens(board.html).filter(token => CSS.supports("color", token.value) && !token.value.includes("var(") && toHex(token.value)), [board.html]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const valid = !!node && !anchor.area && board.contentRevision === revision;
  const canEdit = editable && valid && !pending && !node.locked && !designLayerPath(tree, node.id)?.some(parent => parent.locked);
  const style = document.createElement("div").style;
  style.cssText = node?.styles.cssText ?? "";
  // The rendered value resolves tokens, relative units and inherited styles.
  const value = (p: string) => (valid ? anchor.computedStyles?.[p] : undefined) || style.getPropertyValue(p) || "";
  const text = !!node?.textEditable && (!!node.text || /^(p|h[1-6]|span|a|button|label|li)$/.test(node.tag));
  const image = node?.tag === "img";
  const vector = !!node && /^(svg|path|rect|circle|ellipse|polygon|polyline|line)$/.test(node.tag);
  const line = node?.tag === "line" || node?.tag === "polyline";
  const surface = !!node && !image && !vector && (!text || node.tag === "button" || visiblePaint(value("background-color")) || visiblePaint(value("background-image")) || parseFloat(value("border-top-width")) > 0);
  const apply = async (values: Record<string, string>) => {
    if (!canEdit || !node || saving.current) return;
    saving.current = true; setPending(true); setError("");
    try { await onChange(board, selectionStyleEdit(board, revision, node.id, values)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { saving.current = false; setPending(false); }
  };
  const change = (p: string, v: string) => void apply({ [p]: v,
    ...(p === "background-color" && v && visiblePaint(value("background-image")) ? { "background-image": "none" } : {}),
    ...(p === "color" && v ? { "-webkit-text-fill-color": "currentColor" } : {}),
  });
  const field = (p: string, label: string, unit = false) => <ValueField key={p} label={label} value={value(p)} disabled={!canEdit} onCommit={v => change(p, unit ? px(v) : v)}/>;
  const color = (p: string, label: string) => <FormPopover label={label} face={<span className="design-selection-color" style={{ background: value(p) || "transparent" }}/>} disabled={!canEdit}>
    <div className="design-selection-palette">{[...new Set([value(p), ...tokens.map(t => t.value), "#ffffff", "#171717", "#6b7280", "#4f5bd5", "#ef4444", "#f59e0b", "#22c55e", "transparent"])].filter(Boolean).map(c =>
      <button key={c} type="button" aria-label={`${label}: ${c}`} title={c} disabled={!canEdit} onClick={() => change(p, c)}><span style={{ background: c }}/></button>)}</div>
    {field(p, label + " value")}
  </FormPopover>;
  const action = (label: string, glyph: ReactNode, run: () => void, pressed?: boolean, disabled = !canEdit) => <DesignToolButton type="button" title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={run}>{glyph}</DesignToolButton>;
  const weight = value("font-weight");
  const bold = weight === "bold" || parseInt(weight) >= 600;
  const underline = value("text-decoration-line").includes("underline");
  return <div className="design-selection-tools" data-kind={image ? "image" : vector ? "vector" : surface ? "surface" : text ? "text" : "other"}
    onKeyDown={e => { const undo = (e.metaKey || e.ctrlKey) && ["z", "y"].includes(e.key.toLowerCase()); if (e.key !== "Escape" && !undo) e.stopPropagation(); }}>
    {node && !anchor.area && <>
      {text && <div className="design-selection-group">
        <FormPopover label="Text style" disabled={!canEdit} face={<span>{parseFloat(value("font-size")) || "Text"}<span className="design-selection-weight">{parseInt(weight) >= 700 || weight === "bold" ? "Bold" : bold ? "Semibold" : "Regular"}</span></span>}>
          {field("font-family", "Font family")}{field("font-size", "Font size", true)}
          {field("font-weight", "Font weight")}{field("line-height", "Line height")}{field("letter-spacing", "Letter spacing", true)}
        </FormPopover>
        {color("color", "Text color")}
        {!surface && <>
          {action("Bold", <Bold size={16}/>, () => change("font-weight", bold ? "400" : "700"), bold)}
          {action("Italic", <Italic size={16}/>, () => change("font-style", value("font-style") === "italic" ? "normal" : "italic"), value("font-style") === "italic")}
          {action("Underline", <span className="design-underline-icon" aria-hidden="true">U</span>, () => {
            const parts = value("text-decoration-line").split(/\s+/).filter(v => v && v !== "none" && v !== "underline");
            change("text-decoration-line", [...parts, ...underline ? [] : ["underline"]].join(" ") || "none");
          }, underline)}
          <FormPopover label="Text alignment" face={value("text-align") === "center" ? icon.textCenter : value("text-align") === "right" ? icon.textRight : icon.textLeft} disabled={!canEdit}>
            <div className="design-selection-align">{["left", "center", "right", "justify"].map(align => <button type="button" key={align} aria-label={`Align ${align}`} aria-pressed={value("text-align") === align} disabled={!canEdit} onClick={() => change("text-align", align)}>{align}</button>)}</div>
          </FormPopover>
        </>}
      </div>}
      {surface && <div className="design-selection-group">
        {color("background-color", "Fill")}
        <FormPopover label="Border" disabled={!canEdit} face={<span className="design-border-icon" aria-hidden="true"/>}>
          {field("border-color", "Border color")}{field("border-width", "Border width", true)}
          <label className="design-selection-field"><span>Style</span><select aria-label="Border style" value={value("border-style") || "none"} disabled={!canEdit} onChange={e => change("border-style", e.target.value)}>{["none", "solid", "dashed", "dotted"].map(v => <option key={v}>{v}</option>)}</select></label>
        </FormPopover>
        <FormPopover label="Corner radius" disabled={!canEdit} face={<span className="design-radius-icon" aria-hidden="true"/>}>{field("border-radius", "Corner radius value", true)}</FormPopover>
      </div>}
      {vector && <div className="design-selection-group">{!line && color("fill", "Fill")}{color("stroke", "Stroke")}<FormPopover label="Stroke width" disabled={!canEdit} face={<span>{parseFloat(value("stroke-width")) || 0}px</span>}>{field("stroke-width", "Stroke width value", true)}</FormPopover></div>}
      {image && <div className="design-selection-group"><Dropdown label="Image fit" value={value("object-fit") || "fill"} options={[{ value: "fill", label: "Stretch" }, { value: "contain", label: "Fit" }, { value: "cover", label: "Fill" }, { value: "none", label: "Original" }, { value: "scale-down", label: "Scale down" }]} disabled={!canEdit} onChange={v => change("object-fit", v)}/><FormPopover label="Corner radius" disabled={!canEdit} face={<span className="design-radius-icon" aria-hidden="true"/>}>{field("border-radius", "Corner radius value", true)}</FormPopover></div>}
    </>}
    <div className="design-selection-group">
      {text && onEditText && action("Edit text", <Pencil size={16}/>, onEditText)}
      {action("Comment", <MessageSquare size={16}/>, onComment, undefined, !editable)}
      {action("Properties", <MoreVertical size={16}/>, onProperties, undefined, false)}
    </div>
    {error && <span role="alert" className="design-selection-error" title={error}>{error}</span>}
  </div>;
}
