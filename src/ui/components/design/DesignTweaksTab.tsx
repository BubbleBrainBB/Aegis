import { useEffect, useMemo, useRef, useState } from "react";
import type { DesignBoard } from "../../../shared/design-types";
import { applyDesignTweaks, equalTweakValue, readDesignTweaks, type AegisTweakControl, type DesignTweakValue } from "./design-tweaks";
import "./design-tweaks.css";

export function DesignTweaksTab({ board, editable = false, onChange, onPreview }: {
  board?: DesignBoard;
  editable?: boolean;
  onChange?(board: DesignBoard, html: string): Promise<unknown>;
  /** Preview this board only; null restores its saved HTML. No source write. */
  onPreview?(html: string | null): void;
}) {
  const [base, setBase] = useState(() => ({ id: board?.id, revision: board?.contentRevision, html: board?.html ?? "" }));
  const [draft, setDraft] = useState<Record<string, DesignTweakValue>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const preview = useRef(onPreview); preview.current = onPreview;
  const target = useRef(board?.id); target.current = board?.id;
  const dirty = Object.keys(draft).length > 0;
  const stale = board?.id !== base.id || board?.contentRevision !== base.revision;
  const source = useMemo(() => readDesignTweaks(base.html), [base.html]);
  const canEdit = !!(editable && board && onChange && !pending && !stale);
  const reset = () => { setDraft({}); setError(""); setBase({ id: board?.id, revision: board?.contentRevision, html: board?.html ?? "" }); };
  useEffect(() => { reset(); }, [board?.id]);
  useEffect(() => {
    if (!dirty) setBase({ id: board?.id, revision: board?.contentRevision, html: board?.html ?? "" });
  }, [board?.contentRevision, board?.html, dirty]);
  useEffect(() => () => preview.current?.(null), []);
  useEffect(() => {
    if (!dirty || stale || !editable) { preview.current?.(null); return; }
    try {
      const html = applyDesignTweaks(base.html, draft, (property, value) => CSS.supports(property, value));
      const timer = setTimeout(() => preview.current?.(html), 120);
      setError("");
      return () => clearTimeout(timer);
    } catch (e) { preview.current?.(null); setError(e instanceof Error ? e.message : String(e)); }
  }, [base.html, draft, stale, editable]);
  const change = (control: AegisTweakControl, value: DesignTweakValue) => {
    setDraft((old) => {
      const next = { ...old };
      if (equalTweakValue(control.value, value)) delete next[control.name];
      else next[control.name] = value;
      return next;
    });
  };
  async function save() {
    if (!board || !canEdit || !dirty || !onChange) return;
    const id = board.id;
    setPending(true); setError("");
    try {
      const html = applyDesignTweaks(base.html, draft, (property, value) => CSS.supports(property, value));
      await onChange(board, html);
      if (target.current === id) { setDraft({}); preview.current?.(null); }
    } catch (e) { if (target.current === id) setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  }
  if (!board) return <div className="design-tweaks-empty"><strong>Nothing selected</strong><span>Select a board to see its tweaks.</span></div>;
  if (source.status === "invalid") return <div className="design-tweaks-empty" role="status"><strong>Tweaks unavailable</strong><span>{source.message}</span></div>;
  if (!source.controls.length) return <div className="design-tweaks-empty"><strong>No tweaks defined</strong><span>This board has no authored tweak controls. You can edit its elements in Properties or add inline overrides in Code.</span></div>;
  const sections = [...new Set(source.controls.map((c) => c.section ?? ""))].sort((a, b) => a === "" ? -1 : b === "" ? 1 : 0);
  function controlInput(control: AegisTweakControl) {
    const value = Object.hasOwn(draft, control.name) ? draft[control.name] : control.value;
    const disabled = !canEdit || !!control.unavailable;
    const label = control.name;
    if (control.editor === "boolean") return <input aria-label={label} type="checkbox" role="switch" disabled={disabled} checked={value === true} onChange={(e) => change(control, e.target.checked)} />;
    if (control.editor === "enum") return <select aria-label={label} disabled={disabled} value={control.options?.findIndex((o) => equalTweakValue(o.value, value)) ?? -1} onChange={(e) => { const option = control.options?.[Number(e.target.value)]; if (option) change(control, option.value); }}>
      <option value={-1} disabled>Not set</option>{control.options?.map((o, index) => <option key={index} value={index}>{o.label}</option>)}
    </select>;
    if (["range", "int", "float"].includes(control.editor)) return <div className="design-tweak-number">
      {control.editor === "range" && typeof value === "number" && <input aria-label={`${label} slider`} type="range" disabled={disabled} min={control.min ?? 0} max={control.max ?? 100} step={control.step ?? 1} value={typeof value === "number" ? value : control.min ?? 0} onChange={(e) => change(control, Number(e.target.value))} />}
      <input aria-label={label} type="number" disabled={disabled} min={control.min ?? (control.editor === "range" ? 0 : undefined)} max={control.max ?? (control.editor === "range" ? 100 : undefined)} step={control.step ?? (control.editor === "float" ? "any" : 1)} placeholder="Not set" value={typeof value === "number" ? value : ""} onChange={(e) => { if (e.target.value !== "" && Number.isFinite(e.target.valueAsNumber)) change(control, e.target.valueAsNumber); }} />
      {control.unit && <span>{control.unit}</span>}
    </div>;
    return <div className="design-tweak-text">
      {control.editor === "color" && typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) && <input aria-label={`${label} color`} type="color" disabled={disabled} value={typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} onChange={(e) => change(control, e.target.value)} />}
      <input aria-label={label} type="text" disabled={disabled} value={typeof value === "string" ? value : ""} placeholder="Not set" onChange={(e) => change(control, e.target.value)} />
    </div>;
  }
  return <div className="design-tab-body design-tweaks-tab">
    <p className="design-tweaks-caption">{onPreview ? "Preview changes on this board, then save." : "Changes apply when you save."}</p>
    <div className="design-tweaks-controls">{sections.map((section) => <section key={section}>
      {section && <h3>{section}</h3>}
      {source.controls.filter((c) => (c.section ?? "") === section).map((control) => <div className="design-tweak-row" key={control.name} title={control.unavailable}>
        <label>{control.name}</label>{controlInput(control)}
        {control.unavailable && <small>{control.unavailable}</small>}
        {control.value === undefined && control.editor === "boolean" && <small>No matching inline value is set.</small>}
      </div>)}
    </section>)}</div>
    {stale && dirty && <p className="design-tweaks-error" role="status">The board changed. Reload its controls before saving.</p>}
    {error && <p className="design-tweaks-error" role="alert">{error}</p>}
    <div className="design-tweaks-actions">
      <button type="button" disabled={pending || (!dirty && !stale)} onClick={reset}>{stale ? "Reload" : "Reset"}</button>
      <button type="button" disabled={!canEdit || !dirty || !!error} onClick={() => void save()}>{pending ? "Saving…" : "Save changes"}</button>
    </div>
  </div>;
}
