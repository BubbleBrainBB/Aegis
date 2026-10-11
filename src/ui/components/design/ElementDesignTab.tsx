import { useMemo, useState } from "react";
import type { DesignAnchor, DesignBoard } from "../../../shared/design-types";
import { ColorSwatch } from "./ColorSwatch";
import { Dropdown, Icons, Row, Section, icon, type Option } from "./InspectorControls";
import { ChevronDown, ChevronRight, Plus, X } from "../icons";
import {
  designLayerPath,
  editDesignLayer,
  findDesignLayer,
  readDesignLayers,
  replaceDesignLayerStyle,
  type DesignLayer,
  type LayerEdit,
} from "../../../shared/design-layers";

type Sizing = "fixed" | "hug" | "fill";
const px = (v: string | undefined) => {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? `${Math.round(n * 10) / 10}` : "";
};
/** "24" → "24px"; anything CSS already understands passes through. */
const withUnit = (v: string) => (/^-?\d+(\.\d+)?$/.test(v.trim()) ? `${v.trim()}px` : v.trim());
const WEIGHTS: Option<string>[] = [
  { value: "300", label: "Light" },
  { value: "400", label: "Regular" },
  { value: "500", label: "Medium" },
  { value: "600", label: "Semibold" },
  { value: "700", label: "Bold" },
];
// Advanced stays open across selections once a person opens it.
let advancedOpen = false;

/** Properties of the selected layer: label column + controls, like Claude Design. */
export function ElementDesignTab({
  board,
  selection,
  editable,
  onChange,
  onSelectLayer,
  onSelectBoard,
  live,
}: {
  /** Rect of the layer while it is being resized or moved on the canvas. */
  live?: { x: number; y: number; width: number; height: number };
  board: DesignBoard;
  selection: { boardId: string; revision: number; anchor: DesignAnchor };
  editable: boolean;
  onChange(board: DesignBoard, html: string): Promise<unknown>;
  onSelectLayer(node: DesignLayer): void;
  onSelectBoard(): void;
}) {
  const tree = useMemo(() => readDesignLayers(board.html), [board.html]);
  const node = findDesignLayer(tree, selection.anchor.nodeId);
  const path = node ? designLayerPath(tree, node.id) ?? [] : [];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [advanced, setAdvanced] = useState(advancedOpen);
  const [sides, setSides] = useState(false);
  if (!node) return <p className="design-empty-note">Layer no longer exists</p>;
  const current = selection.revision === board.contentRevision;
  const inheritedLock = path.some((n) => n.locked);
  const canEdit = editable && !pending && !node.locked && !inheritedLock && current;
  const inline = document.createElement("div").style;
  inline.cssText = node.styles.cssText;
  const own = (p: string) => inline.getPropertyValue(p);
  const computed = (p: string) => (current ? selection.anchor.computedStyles?.[p] : undefined);
  const value = (p: string) => own(p) || computed(p) || "";

  async function change(transform: () => string) {
    if (!canEdit) return;
    setPending(true);
    setError("");
    try {
      await onChange(board, transform());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }
  const edit = (e: LayerEdit) => void change(() => editDesignLayer(board.html, node.id, e));
  /** Several inline properties in one version; "" removes a property. */
  const styles = (values: Record<string, string>) =>
    void change(() => {
      const el = document.createElement("div");
      el.style.cssText = node.styles.cssText;
      for (const [k, v] of Object.entries(values)) {
        if (!v) el.style.removeProperty(k);
        else if (!CSS.supports(k, v)) throw new Error(`Invalid ${k}: ${v}`);
        else el.style.setProperty(k, v, "important");
      }
      return replaceDesignLayerStyle(board.html, node.id, el.style.cssText);
    });

  /** A text field for one CSS property; the placeholder shows the rendered value. */
  const field = (
    property: string,
    opts: { unit?: string; prefix?: string; format?: (v: string) => string; parse?: (v: string) => string; label?: string; live?: number } = {},
  ) => {
    if (opts.live !== undefined)
      return (
        <label className="iv-in">
          {opts.prefix && <span className="iv-prefix">{opts.prefix}</span>}
          <input aria-label={`Layer ${opts.label ?? property}`} value={Math.round(opts.live)} readOnly />
          {opts.unit && <span className="iv-unit">{opts.unit}</span>}
        </label>
      );
    const shown = opts.format ? opts.format(own(property)) : own(property);
    const placeholder = (opts.format ? opts.format(computed(property) ?? "") : computed(property)) || "Auto";
    return (
      <label className="iv-in">
        {opts.prefix && <span className="iv-prefix">{opts.prefix}</span>}
        <input
          key={`${board.contentRevision}:${property}`}
          aria-label={`Layer ${opts.label ?? property}`}
          defaultValue={shown}
          placeholder={placeholder}
          disabled={!canEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next === shown) return;
            styles({ [property]: next ? (opts.parse ?? withUnit)(next) : "" });
          }}
        />
        {opts.unit && <span className="iv-unit">{opts.unit}</span>}
      </label>
    );
  };

  const parentLayout = computed("parent-layout");
  const absolute = ["absolute", "fixed"].includes(computed("position") ?? "");
  const display = computed("display") ?? "";
  const autoLayout = /flex|grid/.test(display);
  const direction = (computed("flex-direction") ?? "row").startsWith("column") ? "column" : "row";
  const rect = selection.anchor.rect;

  // Per-dimension sizing: Fixed writes a length, Hug fits content, Fill takes the free space.
  const sizing = (axis: "width" | "height"): Sizing => {
    const v = own(axis);
    const flex = own("flex");
    const mainAxis = parentLayout === "column" ? "height" : "width";
    if (v === "100%" || (axis === mainAxis && flex.startsWith("1 1 0"))) return "fill";
    if (v && v !== "auto" && v !== "fit-content") return "fixed";
    return "hug";
  };
  const setSizing = (axis: "width" | "height", mode: Sizing) => {
    const measured = Math.round((axis === "width" ? rect?.width : rect?.height) ?? 0) || 100;
    const mainAxis = parentLayout === "column" ? "height" : "width";
    const next: Record<string, string> = {};
    if (mode === "fixed") next[axis] = `${measured}px`;
    if (mode === "hug") next[axis] = axis === "width" ? "fit-content" : "";
    if (mode === "fill") {
      if (axis === mainAxis && (parentLayout === "row" || parentLayout === "column")) {
        next[axis] = "";
        next.flex = "1 1 0%";
      } else next[axis] = "100%";
    }
    if (mode !== "fill" && axis === mainAxis && own("flex")) next.flex = "";
    styles(next);
  };
  const sizingOptions = (axis: "width" | "height"): Option<Sizing>[] => [
    { value: "fixed", label: "Fixed", hint: `${Math.round((axis === "width" ? rect?.width : rect?.height) ?? 0)}px` },
    { value: "hug", label: "Hug", hint: "Fit content" },
    { value: "fill", label: "Fill", hint: "Fill container" },
  ];

  const hAlignProp = direction === "row" ? "justify-content" : "align-items";
  const vAlignProp = direction === "row" ? "align-items" : "justify-content";
  const alignValue = (p: string) => {
    const v = computed(p) ?? "";
    return v.includes("center") ? "center" : v.includes("end") ? "end" : v.includes("start") || v === "normal" || v === "stretch" ? "start" : undefined;
  };
  const toAlign = (v: "start" | "center" | "end") => (v === "center" ? "center" : `flex-${v}`);
  const borderStyle = (computed("border-top-style") ?? computed("border")?.split(" ")[1] ?? "none") as string;
  const hasShadow = !!own("box-shadow") && own("box-shadow") !== "none";
  const isText = node.textEditable && !!node.text;

  return (
    <div className="design-tab-body iv-body" key={`${board.id}:${node.id}`}>
      <nav className="design-breadcrumb" aria-label="Layer path">
        <button onClick={onSelectBoard}>{board.name}</button>
        {path.map((n) => (
          <span key={n.id}>
            <span aria-hidden>›</span>
            <button onClick={() => onSelectLayer(n)}>{n.name.split(" · ")[0]}</button>
          </span>
        ))}
        <span>
          <span aria-hidden>›</span>
          <strong>{node.name.split(" · ")[0]}</strong>
        </span>
      </nav>
      {(node.locked || inheritedLock) && (
        <p className="design-empty-note">Locked{inheritedLock ? " by its parent" : ""}</p>
      )}

      <Section title="Size">
        {(["width", "height"] as const).map((axis) => (
          <Row key={axis} label={axis === "width" ? "Width" : "Height"}>
            {field(axis, { unit: "px", format: px, live: live?.[axis] })}
            <Dropdown
              label={`${axis === "width" ? "Width" : "Height"} sizing`}
              value={sizing(axis)}
              options={sizingOptions(axis)}
              disabled={!canEdit}
              onChange={(m) => setSizing(axis, m)}
            />
          </Row>
        ))}
        <Row label="Position">
          <Dropdown
            wide
            label="Position"
            value={absolute ? "absolute" : "flow"}
            options={[
              {
                value: "flow",
                label: parentLayout === "row" || parentLayout === "column" ? "In auto layout" : "In flow",
              },
              { value: "absolute", label: "Absolute" },
            ]}
            disabled={!canEdit}
            onChange={(v) =>
              styles(
                v === "absolute"
                  ? // Offsets stay auto, so the layer stays where it rendered in flow.
                    { position: "absolute", width: `${Math.round(rect?.width ?? 0) || 100}px` }
                  : { position: "", left: "", top: "", right: "", bottom: "" },
              )
            }
          />
        </Row>
        {absolute && (
          <>
            <Row label="Pin">
              {field("top", { prefix: "↑", format: px })}
              {field("right", { prefix: "→", format: px })}
            </Row>
            <Row label="">
              {field("bottom", { prefix: "↓", format: px })}
              {field("left", { prefix: "←", format: px })}
            </Row>
          </>
        )}
      </Section>

      {autoLayout && (
        <Section title="Layout">
          <Row label="Layout">
            <Dropdown
              wide
              label="Layout type"
              value={display.includes("grid") ? "grid" : "flex"}
              options={[
                { value: "flex", label: "Flex" },
                { value: "grid", label: "Grid" },
              ]}
              disabled={!canEdit}
              onChange={(v) => styles({ display: v })}
            />
          </Row>
          {!display.includes("grid") && (
            <Row label="Direction">
              <Icons
                label="Direction"
                value={computed("flex-wrap") === "wrap" ? "wrap" : direction}
                disabled={!canEdit}
                options={[
                  { value: "row", icon: icon.row, title: "Row" },
                  { value: "column", icon: icon.column, title: "Column" },
                  { value: "wrap", icon: icon.wrap, title: "Wrap" },
                ]}
                onChange={(v) =>
                  styles(v === "wrap" ? { "flex-direction": "row", "flex-wrap": "wrap" } : { "flex-direction": v, "flex-wrap": "" })
                }
              />
            </Row>
          )}
          <Row label="Align">
            <Icons
              label="Horizontal alignment"
              value={alignValue(hAlignProp)}
              disabled={!canEdit}
              options={[
                { value: "start", icon: icon.hStart, title: "Left" },
                { value: "center", icon: icon.hCenter, title: "Center" },
                { value: "end", icon: icon.hEnd, title: "Right" },
              ]}
              onChange={(v) => styles({ [hAlignProp]: toAlign(v) })}
            />
            <Icons
              label="Vertical alignment"
              value={alignValue(vAlignProp)}
              disabled={!canEdit}
              options={[
                { value: "start", icon: icon.vStart, title: "Top" },
                { value: "center", icon: icon.vCenter, title: "Middle" },
                { value: "end", icon: icon.vEnd, title: "Bottom" },
              ]}
              onChange={(v) => styles({ [vAlignProp]: toAlign(v) })}
            />
          </Row>
          <Row label="Gap">{field("gap", { unit: "px", format: px })}</Row>
          <Row label="Padding">
            {sides ? (
              <div className="iv-sides">
                {field("padding-top", { prefix: "↑", format: px })}
                {field("padding-right", { prefix: "→", format: px })}
                {field("padding-bottom", { prefix: "↓", format: px })}
                {field("padding-left", { prefix: "←", format: px })}
              </div>
            ) : (
              field("padding", { unit: "px", format: px })
            )}
            <button
              type="button"
              className="iv-in iv-square"
              aria-label="Padding per side"
              aria-pressed={sides}
              onClick={() => setSides((v) => !v)}
            >
              {icon.sides}
            </button>
          </Row>
        </Section>
      )}

      {isText && (
        <Section title="Text">
          <Row label="Font">{field("font-family", { format: (v) => v.split(",")[0].replace(/["']/g, "").trim(), parse: (v) => v })}</Row>
          <Row label="Size">
            {field("font-size", { unit: "px", format: px })}
            <Dropdown
              label="Font weight"
              value={value("font-weight") || "400"}
              options={WEIGHTS.some((w) => w.value === value("font-weight")) ? WEIGHTS : [...WEIGHTS, { value: value("font-weight"), label: value("font-weight") }]}
              disabled={!canEdit}
              onChange={(v) => styles({ "font-weight": v })}
            />
          </Row>
          <Row label="Line">
            {field("line-height", { prefix: "↕", format: px, parse: (v) => v })}
            {field("letter-spacing", { prefix: "|A|", format: px })}
          </Row>
          <Row label="Color">
            <label className="iv-in">
              <ColorSwatch
                label="Color color picker"
                value={value("color")}
                disabled={!canEdit}
                onCommit={(hex) => styles({ color: hex })}
              />
              <input
                key={`${board.contentRevision}:color`}
                aria-label="Layer color"
                defaultValue={own("color")}
                placeholder={computed("color") || "Auto"}
                disabled={!canEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                onBlur={(e) => {
                  if (e.target.value.trim() !== own("color")) styles({ color: e.target.value.trim() });
                }}
              />
            </label>
          </Row>
          <Row label="Align">
            <Icons
              label="Text alignment"
              value={(computed("text-align") ?? "start").replace("start", "left").replace("end", "right") as "left" | "center" | "right"}
              disabled={!canEdit}
              options={[
                { value: "left", icon: icon.textLeft, title: "Left" },
                { value: "center", icon: icon.textCenter, title: "Center" },
                { value: "right", icon: icon.textRight, title: "Right" },
              ]}
              onChange={(v) => styles({ "text-align": v })}
            />
          </Row>
        </Section>
      )}

      <Section title="Appearance">
        <Row label="Fill">
          <label className="iv-in">
            <ColorSwatch
              label="Fill color picker"
              value={value("background-color")}
              disabled={!canEdit}
              onCommit={(hex) => styles({ "background-color": hex })}
            />
            <input
              key={`${board.contentRevision}:fill`}
              aria-label="Layer background-color"
              defaultValue={own("background-color")}
              placeholder={
                !computed("background-color") || computed("background-color") === "rgba(0, 0, 0, 0)"
                  ? "None"
                  : computed("background-color")
              }
              disabled={!canEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              onBlur={(e) => {
                if (e.target.value.trim() !== own("background-color"))
                  styles({ "background-color": e.target.value.trim() });
              }}
            />
          </label>
        </Row>
        <Row label="Opacity">
          {field("opacity", {
            unit: "%",
            format: (v) => (v === "" ? "" : `${Math.round(parseFloat(v) * 100)}`),
            parse: (v) => `${Math.max(0, Math.min(100, parseFloat(v) || 0)) / 100}`,
          })}
        </Row>
        <Row label="Radius">{field("border-radius", { unit: "px", format: px })}</Row>
        <Row label="Border">
          <Icons
            label="Border style"
            value={(["none", "solid", "dashed", "dotted"].includes(borderStyle) ? borderStyle : "none") as "none" | "solid" | "dashed" | "dotted"}
            disabled={!canEdit}
            options={[
              { value: "none", icon: icon.borderNone, title: "No border" },
              { value: "solid", icon: icon.borderSolid, title: "Solid" },
              { value: "dashed", icon: icon.borderDashed, title: "Dashed" },
              { value: "dotted", icon: icon.borderDotted, title: "Dotted" },
            ]}
            onChange={(v) =>
              styles(
                v === "none"
                  ? { border: "", "border-style": "none" }
                  : {
                      "border-style": v,
                      "border-width": parseFloat(computed("border-top-width") ?? "0") > 0 ? computed("border-top-width")! : "1px",
                      "border-color": computed("border-top-color") || "currentColor",
                    },
              )
            }
          />
        </Row>
      </Section>

      <Section
        title="Effects"
        action={
          !hasShadow && (
            <button
              type="button"
              className="iv-add"
              aria-label="Add shadow"
              disabled={!canEdit}
              onClick={() => styles({ "box-shadow": "0 4px 12px rgba(0, 0, 0, 0.12)" })}
            >
              <Plus size={14} />
            </button>
          )
        }
      >
        {hasShadow && (
          <Row label="Shadow">
            {field("box-shadow", { parse: (v) => v })}
            <button
              type="button"
              className="iv-in iv-square"
              aria-label="Remove shadow"
              disabled={!canEdit}
              onClick={() => styles({ "box-shadow": "" })}
            >
              <X size={12} />
            </button>
          </Row>
        )}
      </Section>

      <section className="iv-sec iv-adv">
        <button
          type="button"
          className="iv-h iv-adv-toggle"
          aria-expanded={advanced}
          onClick={() => {
            advancedOpen = !advanced;
            setAdvanced(!advanced);
          }}
        >
          <h4>Advanced</h4>
          {advanced ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        </button>
        {advanced && (
          <>
            <Row label="Name">
              <label className="iv-in">
                <input
                  key={`${board.contentRevision}:name`}
                  aria-label="Layer name"
                  defaultValue={node.name}
                  disabled={!canEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  onBlur={(e) => {
                    if (e.target.value !== node.name) edit({ type: "name", value: e.target.value });
                  }}
                />
              </label>
            </Row>
            {node.textEditable && (
              <Row label="Content">
                <label className="iv-in iv-area">
                  <textarea
                    key={`${board.contentRevision}:text`}
                    aria-label="Layer text"
                    defaultValue={node.text}
                    disabled={!canEdit}
                    onBlur={(e) => {
                      if (e.target.value !== node.text) edit({ type: "text", value: e.target.value });
                    }}
                  />
                </label>
              </Row>
            )}
            <Row label="Margin">{field("margin", { format: (v) => v, parse: (v) => v })}</Row>
            <Row label="Display">{field("display", { format: (v) => v, parse: (v) => v })}</Row>
            <div className="design-layer-actions">
              <button disabled={!canEdit} onClick={() => edit({ type: "up" })} title="Move earlier in parent">
                ↑
              </button>
              <button disabled={!canEdit} onClick={() => edit({ type: "down" })} title="Move later in parent">
                ↓
              </button>
              <button disabled={!canEdit} onClick={() => edit({ type: "duplicate" })}>
                Duplicate layer
              </button>
              <button disabled={!canEdit} onClick={() => edit({ type: "remove" })}>
                Delete layer
              </button>
            </div>
          </>
        )}
      </section>
      {error && (
        <div className="design-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
