import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { MAX_MARK_TEXT, MARK_PALETTE, MARK_STROKE_WIDTHS, markArrowHead, markPath, moveDesignMarkEndpoint, resizeDesignMark, styleDesignMark, translateDesignMark, type DesignMark, type MarkChangeReason } from "./design-marks";
import "./CanvasMarks.css";
import { isImeComposing } from "../../utils/ime";

export interface CanvasMarksProps {
  /** Filter to the current page before rendering, in document stacking order. */
  marks: DesignMark[];
  selectedIds: string[];
  zoom: number;
  editable: boolean;
  /** False during Hand/pan, commenting, creation or presentation. */
  interactive?: boolean;
  onSelect(id: string, additive: boolean): void;
  /** Only changed marks; commit once after a gesture (preview is local). */
  onChange(marks: DesignMark[], reason: MarkChangeReason): void | Promise<unknown>;
  onDelete?(ids: string[]): void;
  onGestureChange?(active: boolean): void;
  /** Parent can announce a newly inserted note for immediate editing. */
  editId?: string;
  onEditEnd?(): void;
}
type Gesture = { pointerId: number; clientX: number; clientY: number; marks: DesignMark[]; edge?: string; endpoint?: 0 | 1; element: HTMLElement; zoom: number; moved: boolean; preview: DesignMark[] };
const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const handlePosition: Record<string, [number, number]> = { nw: [0, 0], n: [50, 0], ne: [100, 0], e: [100, 50], se: [100, 100], s: [50, 100], sw: [0, 100], w: [0, 50] };
const NOTE_COLORS = ["#fff3b0", "#f9d9d9", "#deebd3", "#d7e8fa", "#e9ddf5"];

/** Render inside the canvas world transform, beside board wrappers; never covers blank canvas. */
export function CanvasMarks(props: CanvasMarksProps) {
  const { marks, selectedIds, zoom, editable, interactive = true, onSelect, onChange, onDelete } = props;
  const [preview, setPreview] = useState<DesignMark[]>([]);
  const [editing, setEditing] = useState<string>();
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const gesture = useRef<Gesture | undefined>(undefined);
  const current = useRef(props); current.current = props;
  const finishRef = useRef<(commit: boolean) => void>(() => {});
  const moveRef = useRef<(event: PointerEvent) => void>(() => {});
  const input = useRef<HTMLTextAreaElement>(null);
  const cancelledText = useRef(false);
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const active = editable && interactive;
  const emit = (changed: DesignMark[], reason: MarkChangeReason) => {
    if (!current.current.editable || current.current.interactive === false) return;
    setError(undefined);
    try { Promise.resolve(current.current.onChange(changed, reason)).catch(() => setError("Could not save canvas changes. Please try again.")); }
    catch { setError("Could not save canvas changes. Please try again."); }
  };
  const finish = (commit: boolean) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = undefined;
    if (g.element.hasPointerCapture?.(g.pointerId)) g.element.releasePointerCapture(g.pointerId);
    setPreview([]); current.current.onGestureChange?.(false);
    if (commit && g.moved) emit(g.preview, g.edge || g.endpoint !== undefined ? "resize" : "move");
  };
  finishRef.current = finish;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (gesture.current && (e.metaKey || e.ctrlKey) && ["z", "y"].includes(e.key.toLowerCase())) { finishRef.current(false); return; }
      if (e.key !== "Escape" || !gesture.current) return;
      e.preventDefault(); e.stopPropagation(); finishRef.current(false);
    };
    const blur = () => finishRef.current(false);
    // Electron can retarget release to the viewport after a handle moves.
    // Complete the active gesture even when element pointer capture is lost.
    const pointerMove = (e: PointerEvent) => { if (gesture.current?.pointerId === e.pointerId) moveRef.current(e); };
    const pointerUp = (e: PointerEvent) => {
      if (gesture.current?.pointerId !== e.pointerId) return;
      moveRef.current(e); finishRef.current(true);
    };
    const pointerCancel = (e: PointerEvent) => { if (gesture.current?.pointerId === e.pointerId) finishRef.current(false); };
    window.addEventListener("pointermove", pointerMove, true);
    window.addEventListener("pointerup", pointerUp, true);
    window.addEventListener("pointercancel", pointerCancel, true);
    window.addEventListener("keydown", key, true); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("pointermove", pointerMove, true); window.removeEventListener("pointerup", pointerUp, true); window.removeEventListener("pointercancel", pointerCancel, true); window.removeEventListener("keydown", key, true); window.removeEventListener("blur", blur); if (gesture.current) current.current.onGestureChange?.(false); };
  }, []);
  useEffect(() => { if (!active) { finishRef.current(false); setEditing(undefined); } }, [active]);
  useEffect(() => {
    if (!props.editId || !active || editing === props.editId) return;
    const mark = marks.find(m => m.id === props.editId && m.type === "note");
    if (mark) { cancelledText.current = false; setText(mark.text ?? ""); setEditing(mark.id); }
  }, [props.editId, active, marks, editing]);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
  useEffect(() => {
    if (editing && !marks.some(m => m.id === editing)) setEditing(undefined);
    if (gesture.current && gesture.current.marks.some(m => !marks.some(n => n.id === m.id))) finishRef.current(false);
  }, [marks, editing]);
  function start(e: ReactPointerEvent<HTMLDivElement | HTMLButtonElement>, mark: DesignMark, edge?: string, endpoint?: 0 | 1) {
    if (!active || e.button !== 0) return;
    if (editing === mark.id) { e.stopPropagation(); return; }
    e.stopPropagation(); e.preventDefault();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (!edge && endpoint === undefined && (additive || !selectedIds.includes(mark.id))) onSelect(mark.id, additive);
    if (additive && !edge && endpoint === undefined) return;
    e.currentTarget.focus({ preventScroll: true });
    const moving = edge || endpoint !== undefined || !selectedIds.includes(mark.id) ? [mark] : marks.filter(m => selectedIds.includes(m.id));
    gesture.current = { pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY, marks: moving, edge, endpoint, element: e.currentTarget, zoom: scale, moved: false, preview: moving };
    setPreview(moving);
    e.currentTarget.setPointerCapture(e.pointerId);
    current.current.onGestureChange?.(true);
  }
  function move(e: ReactPointerEvent | PointerEvent) {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    e.stopPropagation();
    const x = e.clientX - g.clientX, y = e.clientY - g.clientY;
    if (!g.moved && Math.hypot(x, y) < 3) return;
    g.moved = true;
    g.preview = g.marks.map(m => g.endpoint !== undefined ? moveDesignMarkEndpoint(m, g.endpoint, x / g.zoom, y / g.zoom, e.shiftKey) : g.edge ? resizeDesignMark(m, g.edge, x / g.zoom, y / g.zoom, e.shiftKey) : translateDesignMark(m, x / g.zoom, y / g.zoom));
    setPreview(g.preview);
  }
  moveRef.current = move;
  function edit(mark: DesignMark) {
    if (!active || mark.type !== "note") return;
    cancelledText.current = false; setText(mark.text ?? ""); setEditing(mark.id);
  }
  function commitText() {
    const mark = current.current.marks.find(m => m.id === editing);
    if (mark && !cancelledText.current && text !== (mark.text ?? "")) emit([{ ...mark, text: text.slice(0, MAX_MARK_TEXT) }], "text");
    setEditing(undefined); current.current.onEditEnd?.();
  }
  function commitStyle(mark: DesignMark, property: "fill" | "stroke" | "strokeWidth", value: string | number, control: HTMLSelectElement) {
    const next = styleDesignMark(mark, property, value);
    if (next === mark || next[property] === mark[property]) return;
    // Return document shortcuts (including undo) to the selected object after choosing a value.
    // DesignPanel deliberately leaves focused selects and text inputs to their native behavior.
    control.closest<HTMLElement>("[data-mark-id]")?.focus({ preventScroll: true });
    emit([next], "style");
  }
  const shown = marks.map(mark => preview.find(p => p.id === mark.id) ?? mark);
  return <div className="design-canvas-marks" data-design-marks="" style={{ "--mark-inverse-zoom": 1 / scale } as CSSProperties} onPointerMove={move}
    onPointerUp={e => { if (gesture.current?.pointerId === e.pointerId) { e.stopPropagation(); move(e); finish(true); } }}
    onPointerCancel={e => { if (gesture.current?.pointerId === e.pointerId) { e.stopPropagation(); finish(false); } }}
    onLostPointerCapture={e => { if (gesture.current?.pointerId === e.pointerId) finish(false); }}>
    {shown.map(mark => {
      const selected = selectedIds.includes(mark.id), typing = editing === mark.id;
      const shape = mark.type !== "note", path = markPath(mark);
      return <div key={mark.id} className={`design-canvas-mark${selected ? " selected" : ""}${typing ? " editing" : ""}`} data-mark-id={mark.id} data-mark-type={mark.type}
        role="group" aria-label={mark.type === "note" ? `Note: ${mark.text || "Empty note"}` : mark.type} tabIndex={active ? 0 : -1}
        style={{ left: mark.x, top: mark.y, width: mark.width, height: mark.height, pointerEvents: active ? (shape ? "none" : "auto") : "none" }}
        onPointerDown={e => start(e, mark)} onDoubleClick={e => { e.stopPropagation(); edit(mark); }}
        onKeyDown={e => {
          if (!active || typing || e.target !== e.currentTarget || e.defaultPrevented) return;
          const ids = selectedIds.length ? selectedIds : [mark.id];
          if (gesture.current && ["Delete", "Backspace", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); return; }
          if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); onDelete?.(ids); }
          else if (e.key === "Enter" && mark.type === "note") { e.preventDefault(); e.stopPropagation(); edit(mark); }
          else if (e.key.startsWith("Arrow") && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault(); e.stopPropagation(); const n = e.shiftKey ? 10 : 1;
            emit(marks.filter(m => ids.includes(m.id)).map(m => translateDesignMark(m, e.key === "ArrowLeft" ? -n : e.key === "ArrowRight" ? n : 0, e.key === "ArrowUp" ? -n : e.key === "ArrowDown" ? n : 0)), "move");
          }
        }}>
        {shape ? <svg className="design-mark-svg" width={mark.width} height={mark.height} viewBox={`0 0 ${mark.width} ${mark.height}`} overflow="visible" aria-hidden="true" style={{ pointerEvents: active ? "auto" : "none" }}>
          {mark.type === "rectangle" ? <rect width={mark.width} height={mark.height} rx={3} fill={mark.fill} stroke={mark.stroke} strokeWidth={mark.strokeWidth} /> : mark.type === "ellipse" ? <ellipse cx={mark.width / 2} cy={mark.height / 2} rx={mark.width / 2} ry={mark.height / 2} fill={mark.fill} stroke={mark.stroke} strokeWidth={mark.strokeWidth} /> : <>
            <path d={path} fill="none" stroke="transparent" strokeWidth={Math.max(mark.strokeWidth, 12 / scale)} pointerEvents={active ? "stroke" : "none"} />
            <path d={path} fill="none" stroke={mark.stroke} strokeWidth={mark.strokeWidth} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
            {mark.type === "arrow" && <polygon points={markArrowHead(mark)} fill={mark.stroke} pointerEvents={active ? "auto" : "none"} />}
          </>}
        </svg> : <div className="design-mark-note" style={{ background: mark.fill, color: mark.stroke, fontSize: mark.fontSize ?? 14 }}>
          {typing ? <textarea ref={input} value={text} maxLength={MAX_MARK_TEXT} aria-label="Note text" onChange={e => setText(e.target.value)} onBlur={commitText}
            onPointerDown={e => e.stopPropagation()} onKeyDown={e => { e.stopPropagation(); if (isImeComposing(e)) return; if (e.key === "Escape") { e.preventDefault(); cancelledText.current = true; setEditing(undefined); current.current.onEditEnd?.(); } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitText(); } }} /> : <span className={mark.text ? undefined : "placeholder"}>{mark.text || "Double-click to write a note"}</span>}
        </div>}
        {selected && active && !typing && <>
          <div className="design-mark-outline" />
          {mark.type === "line" || mark.type === "arrow" ? ([0, 1] as const).map(endpoint => <button key={endpoint} className="design-mark-handle design-mark-endpoint" data-mark-endpoint={endpoint} aria-label={`${endpoint === 0 ? "Start" : "End"} point of ${mark.type}`} title="Drag endpoint · Shift to constrain" style={{ left: mark.points?.[endpoint].x ?? 0, top: mark.points?.[endpoint].y ?? 0 }}
            onPointerDown={e => start(e, mark, undefined, endpoint)} onKeyDown={e => {
              if (e.metaKey || e.ctrlKey || e.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
              e.preventDefault(); e.stopPropagation();
              if (gesture.current) return;
              const step = e.shiftKey ? 10 : 1;
              emit([moveDesignMarkEndpoint(mark, endpoint, e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0)], "resize");
            }} />) : handles.map(edge => <button key={edge} className="design-mark-handle" data-edge={edge} aria-label={`Resize ${mark.type} ${edge}`} style={{ left: `${handlePosition[edge][0]}%`, top: `${handlePosition[edge][1]}%`, cursor: `${edge}-resize` }} onPointerDown={e => start(e, mark, edge)} />)}
          {selectedIds.length === 1 && !gesture.current && <div className="design-mark-actions" role="toolbar" aria-label="Canvas object actions" onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
            {mark.type === "note" && <><button onClick={() => edit(mark)}>Edit</button>{NOTE_COLORS.map(color => <button key={color} className="design-mark-color" aria-label={`Note color ${color}`} aria-pressed={mark.fill === color} style={{ background: color }} onClick={() => emit([{ ...mark, fill: color }], "style")} />)}</>}
            {shape && <div className="design-mark-style-controls">
              {(mark.type === "rectangle" || mark.type === "ellipse" ? ["fill", "stroke"] as const : ["stroke"] as const).map(property => <label key={property}>
                <span>{property === "fill" ? "Fill" : "Stroke"}</span>
                <select aria-label={`${mark.type} ${property}`} value={mark[property]} onChange={e => commitStyle(mark, property, e.target.value, e.currentTarget)}>
                  {!MARK_PALETTE.some(color => color.value === mark[property]) && <option value={mark[property]}>Current ({mark[property]})</option>}
                  {MARK_PALETTE.map(color => <option key={color.value} value={color.value}>{color.label}</option>)}
                </select>
                <span className="design-mark-swatch" aria-hidden="true" style={{ background: mark[property] === "none" ? "transparent" : mark[property] }} />
              </label>)}
              <label><span>Width</span><select aria-label={`${mark.type} stroke width`} value={mark.strokeWidth} onChange={e => commitStyle(mark, "strokeWidth", Number(e.target.value), e.currentTarget)}>
                {!(MARK_STROKE_WIDTHS as readonly number[]).includes(mark.strokeWidth) && <option value={mark.strokeWidth}>{mark.strokeWidth} px</option>}
                {MARK_STROKE_WIDTHS.map(width => <option key={width} value={width}>{width} px</option>)}
              </select></label>
            </div>}
            {onDelete && <button onClick={() => onDelete([mark.id])}>Delete</button>}
          </div>}
        </>}
      </div>;
    })}
    {error && <div className="design-mark-error" role="alert">{error}</div>}
  </div>;
}
