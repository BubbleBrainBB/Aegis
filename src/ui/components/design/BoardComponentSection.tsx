import { useMemo, useState } from "react";
import type { DesignBoard, DesignOperation } from "../../../shared/design-types";
import {
  designLogicOf,
  designPropsOf,
  type DesignPropDef,
  type DesignPropsSpec,
} from "../../../shared/design-component";
import { isImeComposing } from "../../utils/ime";

/**
 * A design component's props, edited by hand: each value is what the canvas
 * renders ($preview when set, else the default). Its logic is shown read-only.
 */
export function BoardComponentSection({
  board,
  can,
  onUpdate,
}: {
  board: DesignBoard;
  can: boolean;
  onUpdate(ops: DesignOperation[]): Promise<unknown>;
}) {
  const spec = useMemo(() => designPropsOf(board.html), [board.html]);
  const logic = useMemo(() => designLogicOf(board.html), [board.html]);
  const [error, setError] = useState<string | null>(null);
  if (!spec && !logic) return null;
  const names = spec ? Object.keys(spec).filter((k) => k !== "$preview") : [];
  const valueOf = (name: string) =>
    spec?.$preview && name in spec.$preview ? spec.$preview[name] : (spec?.[name] as DesignPropDef | undefined)?.default;
  const write = (name: string, value: unknown) => {
    if (!spec) return;
    const next: DesignPropsSpec = { ...spec };
    if (spec.$preview && name in spec.$preview) next.$preview = { ...spec.$preview, [name]: value };
    else next[name] = { ...(spec[name] as DesignPropDef), default: value };
    setError(null);
    void onUpdate([{ type: "props", boardId: board.id, expectedRevision: board.contentRevision, props: next }]);
  };
  const commitOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !isImeComposing(e)) e.currentTarget.blur();
  };
  return (
    <section className="design-section design-component-section">
      <h4>Component</h4>
      {names.length ? (
        <div className="design-props" role="group" aria-label="Board props">
          {names.map((name) => {
            const def = spec![name] as DesignPropDef;
            const value = valueOf(name);
            const label = def.label || name;
            const control =
              def.type === "boolean" ? (
                <input type="checkbox" aria-label={`Prop ${name}`} checked={value === true} disabled={!can} onChange={(e) => write(name, e.target.checked)} />
              ) : def.type === "enum" ? (
                <select aria-label={`Prop ${name}`} value={String(value ?? "")} disabled={!can} onChange={(e) => {
                  const option = def.options?.find((o) => String(o) === e.target.value);
                  write(name, option ?? e.target.value);
                }}>
                  {(def.options ?? []).map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                </select>
              ) : def.type === "list" || def.type === "object" || def.type === "image" && typeof value === "object" ? (
                <textarea
                  aria-label={`Prop ${name}`}
                  defaultValue={JSON.stringify(value ?? (def.type === "list" ? [] : {}), null, 2)}
                  disabled={!can}
                  spellCheck={false}
                  rows={Math.min(8, Math.max(2, JSON.stringify(value ?? null, null, 2).split("\n").length))}
                  onBlur={(e) => {
                    try {
                      const parsed = JSON.parse(e.target.value);
                      if (JSON.stringify(parsed) !== JSON.stringify(value)) write(name, parsed);
                    } catch {
                      setError(`${label}: not valid JSON`);
                    }
                  }}
                />
              ) : def.type === "color" ? (
                <span className="design-color">
                  <input type="color" aria-label={`Prop ${name} picker`} value={/^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : "#000000"} disabled={!can} onChange={(e) => write(name, e.target.value)} />
                  <input aria-label={`Prop ${name}`} defaultValue={String(value ?? "")} disabled={!can} onKeyDown={commitOnEnter} onBlur={(e) => e.target.value !== String(value ?? "") && write(name, e.target.value)} />
                </span>
              ) : (
                <input
                  aria-label={`Prop ${name}`}
                  type={def.type === "number" ? "number" : "text"}
                  defaultValue={String(value ?? "")}
                  disabled={!can}
                  onKeyDown={commitOnEnter}
                  onBlur={(e) => {
                    const raw = e.target.value;
                    const next = def.type === "number" ? Number(raw) : raw;
                    if (def.type === "number" && !Number.isFinite(next)) return;
                    if (next !== value) write(name, next);
                  }}
                />
              );
            return (
              <label className="design-prop" key={`${name}:${board.contentRevision}`} title={def.description}>
                <span>{label}</span>
                {control}
              </label>
            );
          })}
        </div>
      ) : null}
      {error ? <p className="design-prop-error" role="alert">{error}</p> : null}
      {logic ? (
        <details className="design-logic">
          <summary>Logic · {logic.trim().split("\n").length} lines</summary>
          <pre>{logic.trim()}</pre>
        </details>
      ) : null}
    </section>
  );
}
