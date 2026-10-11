import { useMemo } from "react";
import type { DesignBoard, DesignOperation } from "../../../shared/design-types";
import { readBoardBackground, setBoardBackground } from "../../../shared/design-layers";

export const DEVICES = [
  { name: "Desktop", width: 1440 },
  { name: "Laptop", width: 1280 },
  { name: "Tablet", width: 768 },
  { name: "Phone", width: 390 },
] as const;

/** Board-level properties: size, devices, background and export. */
export function BoardDesignTab({
  board,
  revision,
  editable,
  busy,
  onUpdate,
  onFitHeight,
  onExport,
}: {
  board: DesignBoard;
  revision: number;
  editable: boolean;
  busy: boolean;
  onUpdate(ops: DesignOperation[]): Promise<unknown>;
  onFitHeight(): void;
  onExport(): void;
}) {
  const background = useMemo(() => readBoardBackground(board.html) ?? "", [board.html]);
  const place = (patch: Partial<Pick<DesignBoard, "name" | "width" | "height">>) =>
    void onUpdate([
      { type: "placement", boardId: board.id, expectedRevision: board.placementRevision, ...patch },
    ]);
  const can = editable && !busy;
  return (
    <div className="design-tab-body" key={`${board.id}:${board.placementRevision}:${board.contentRevision}`}>
      <div className="design-board-title">
        <input
          aria-label="Board name"
          defaultValue={board.name}
          disabled={!can}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== board.name) place({ name });
          }}
        />
        <span>Board · v{revision}</span>
      </div>
      <section className="design-section">
        <h4>Size</h4>
        <div className="design-grid">
          {(["width", "height"] as const).map((key) => (
            <label className="design-field" key={key}>
              <span>{key === "width" ? "W" : "H"}</span>
              <input
                aria-label={`Board ${key}`}
                type="number"
                min={100}
                max={4096}
                defaultValue={board[key]}
                disabled={!can}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                onBlur={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (Number.isFinite(n) && n >= 100 && n <= 4096 && n !== board[key]) place({ [key]: n });
                }}
              />
            </label>
          ))}
        </div>
        <button className="design-text-button" disabled={!can} onClick={onFitHeight}>
          Height fits content
        </button>
      </section>
      <section className="design-section">
        <h4>Devices</h4>
        <div className="design-devices" role="radiogroup" aria-label="Devices">
          {DEVICES.map((d) => (
            <button
              key={d.name}
              role="radio"
              aria-checked={board.width === d.width}
              disabled={!can}
              onClick={() => board.width !== d.width && place({ width: d.width })}
            >
              <span>{d.name}</span>
              <span>{d.width}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="design-section">
        <h4>Background</h4>
        <div className="design-color">
          <input
            type="color"
            aria-label="Board background picker"
            value={/^#[0-9a-f]{6}$/i.test(background) ? background : "#ffffff"}
            disabled={!can}
            onChange={(e) =>
              void onUpdate([
                {
                  type: "content",
                  boardId: board.id,
                  expectedRevision: board.contentRevision,
                  html: setBoardBackground(board.html, e.target.value),
                },
              ])
            }
          />
          <input
            aria-label="Board background"
            defaultValue={background}
            placeholder="None"
            disabled={!can}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v === background || (v && !CSS.supports("background", v))) return;
              void onUpdate([
                {
                  type: "content",
                  boardId: board.id,
                  expectedRevision: board.contentRevision,
                  html: setBoardBackground(board.html, v),
                },
              ]);
            }}
          />
        </div>
      </section>
      <section className="design-section">
        <h4>Export</h4>
        <button className="design-secondary" disabled={busy} onClick={onExport}>
          Export {board.name} · PNG @2x
        </button>
      </section>
    </div>
  );
}
