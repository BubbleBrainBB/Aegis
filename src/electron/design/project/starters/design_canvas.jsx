/**
 * design_canvas.jsx: a pannable, zoomable canvas for comparing design options side by side.
 *
 * Load after React, ReactDOM and Babel:
 *   <script type="text/babel" src="design_canvas.jsx"></script>
 * Exports DesignCanvas, DCSection, DCArtboard to window.
 *
 *   <DesignCanvas title="Checkout · Round 1">
 *     <DCSection title="Layouts" subtitle="Same content, three structures">
 *       <DCArtboard label="A · Single column" width={390} height={844}><CheckoutA /></DCArtboard>
 *       <DCArtboard label="B · Two step" width={390} height={844}><CheckoutB /></DCArtboard>
 *     </DCSection>
 *   </DesignCanvas>
 *
 * - DesignCanvas fills the viewport (put it straight in your root; no wrapper with its own size).
 *   Drag the background or hold space and drag to pan; scroll to pan; pinch or ⌘/Ctrl + scroll to zoom;
 *   the corner buttons zoom, fit everything and reset. Pan, zoom and artboard order persist per page.
 * - DCSection is a row of artboards with a title (and optional subtitle) above it. Sections stack vertically.
 * - DCArtboard is one fixed-size design frame. Give it an explicit width and height and size its
 *   content to fit; it is a static frame, not a scroll region (no height:100% + overflow:auto inside).
 *   Its label sits above it. Drag the label to reorder within its section. The expand button (or a
 *   double-click on the label) focuses one artboard full screen; ← → move between artboards, Esc closes.
 * - Optional props: DCArtboard background (default white), note (a one-line caption beside the label);
 *   DCSection id (keeps its artboard order when the title changes); DesignCanvas background (default a warm grey).
 */
(() => {
  const { useState, useRef, useEffect, useCallback, useMemo, createContext, useContext, Children } = React;

  const designCanvasCss = `
.dc-root{position:fixed;inset:0;overflow:hidden;background:var(--dc-bg,#ecebe8);font:12px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;color:#1d1d1f;touch-action:none;user-select:none;-webkit-user-select:none}
.dc-root.is-panning,.dc-root.is-space{cursor:grab}.dc-root.is-panning{cursor:grabbing}
.dc-dots{position:absolute;inset:0;pointer-events:none;background-image:radial-gradient(circle,rgba(0,0,0,.09) 1px,transparent 1.2px)}
.dc-world{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
.dc-title{font-size:28px;font-weight:650;letter-spacing:-.01em;margin:0 0 56px}
.dc-section{margin-bottom:120px}
.dc-section-head{margin:0 0 28px}
.dc-section-head h2{margin:0;font-size:20px;font-weight:600;letter-spacing:-.005em}
.dc-section-head p{margin:4px 0 0;font-size:14px;color:#6e6e73}
.dc-row{display:flex;gap:80px;align-items:flex-start}
.dc-board{position:relative;flex:none}
.dc-board.is-dragging{opacity:.35}
.dc-label{display:flex;align-items:center;gap:6px;height:24px;margin-bottom:10px;font-size:13px;font-weight:500;color:#3a3a3c;cursor:grab;white-space:nowrap}
.dc-label small{font-weight:400;color:#8e8e93;overflow:hidden;text-overflow:ellipsis}
.dc-expand{margin-left:auto;display:grid;place-items:center;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:#8e8e93;cursor:pointer;opacity:0;transition:opacity .12s}
.dc-board:hover .dc-expand,.dc-expand:focus-visible{opacity:1}.dc-expand:hover{background:rgba(0,0,0,.06);color:#1d1d1f}
.dc-frame{position:relative;overflow:hidden;border-radius:4px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.07),0 1px 3px rgba(0,0,0,.06),0 10px 30px rgba(0,0,0,.06);user-select:text;-webkit-user-select:text}
.dc-board.drop-before::before,.dc-board.drop-after::after{content:"";position:absolute;top:34px;bottom:0;width:3px;border-radius:2px;background:#0a84ff}
.dc-board.drop-before::before{left:-41.5px}.dc-board.drop-after::after{right:-41.5px}
.dc-controls{position:fixed;right:14px;bottom:14px;display:flex;align-items:center;gap:2px;padding:3px;border-radius:10px;background:rgba(255,255,255,.86);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);box-shadow:0 0 0 1px rgba(0,0,0,.08),0 4px 16px rgba(0,0,0,.08);z-index:10}
.dc-controls button{height:28px;min-width:28px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:#1d1d1f;font:inherit;font-size:12px;cursor:pointer}
.dc-controls button:hover{background:rgba(0,0,0,.06)}
.dc-controls span{min-width:44px;text-align:center;font-variant-numeric:tabular-nums;color:#3a3a3c}
.dc-focus{position:fixed;inset:0;z-index:20;display:flex;flex-direction:column;background:rgba(24,24,26,.92);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);color:#fff}
.dc-focus-bar{display:flex;align-items:center;gap:12px;height:48px;padding:0 16px;font-size:13px}
.dc-focus-bar strong{font-weight:600}.dc-focus-bar small{color:rgba(255,255,255,.6)}
.dc-focus-bar button{height:28px;padding:0 10px;border:0;border-radius:7px;background:rgba(255,255,255,.1);color:#fff;font:inherit;cursor:pointer}
.dc-focus-bar button:hover{background:rgba(255,255,255,.18)}
.dc-focus-stage{position:relative;flex:1;min-height:0}
.dc-focus-stage>.dc-frame{position:absolute;left:50%;top:50%;transform-origin:center center}
`;

  function useDesignCanvasStyles() {
    useEffect(() => {
      if (document.getElementById("dc-styles")) return;
      const tag = document.createElement("style");
      tag.id = "dc-styles";
      tag.textContent = designCanvasCss;
      document.head.appendChild(tag);
    }, []);
  }

  const storageKey = (what) => `design_canvas:${location.pathname}:${what}`;
  const readStored = (what, fallback) => {
    try {
      const v = JSON.parse(localStorage.getItem(storageKey(what)));
      return v ?? fallback;
    } catch (e) {
      return fallback;
    }
  };
  const writeStored = (what, value) => {
    try {
      localStorage.setItem(storageKey(what), JSON.stringify(value));
    } catch (e) {}
  };

  const CanvasContext = createContext(null);
  const SectionContext = createContext(null);
  const PADDING = 80;

  function DesignCanvas({ title, background, children }) {
    useDesignCanvasStyles();
    const root = useRef(null);
    const world = useRef(null);
    const [view, setView] = useState(() => readStored("view", null));
    const [panning, setPanning] = useState(false);
    const [space, setSpace] = useState(false);
    const [focus, setFocus] = useState(null);
    const boards = useRef(new Map());
    const drag = useRef(null);

    const apply = useCallback((next) => {
      setView(next);
      writeStored("view", next);
    }, []);

    const fit = useCallback(() => {
      const el = root.current, w = world.current;
      if (!el || !w) return;
      const width = w.scrollWidth, height = w.scrollHeight;
      const scale = Math.min(1, (el.clientWidth - PADDING * 2) / width, (el.clientHeight - PADDING * 2) / height);
      const s = Math.max(0.05, scale);
      apply({ x: (el.clientWidth - width * s) / 2, y: Math.max(PADDING / 2, (el.clientHeight - height * s) / 2), scale: s });
    }, [apply]);

    useEffect(() => {
      if (!view) requestAnimationFrame(fit);
    }, [view, fit]);

    const zoomAt = useCallback((factor, cx, cy) => {
      setView((v) => {
        const current = v ?? { x: 0, y: 0, scale: 1 };
        const scale = Math.min(4, Math.max(0.05, current.scale * factor));
        const k = scale / current.scale;
        const next = { scale, x: cx - (cx - current.x) * k, y: cy - (cy - current.y) * k };
        writeStored("view", next);
        return next;
      });
    }, []);

    // Wheel: pan, or zoom with pinch / ⌘ / Ctrl. One decision per scroll burst, so a pan never turns into a zoom halfway.
    const burst = useRef({ zoom: false, until: 0 });
    useEffect(() => {
      const el = root.current;
      if (!el) return;
      const onWheel = (e) => {
        if (focus) return;
        e.preventDefault();
        const now = performance.now();
        if (now > burst.current.until) burst.current.zoom = e.ctrlKey || e.metaKey;
        burst.current.until = now + 160;
        if (burst.current.zoom) {
          const rect = el.getBoundingClientRect();
          zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), e.clientX - rect.left, e.clientY - rect.top);
        } else {
          setView((v) => {
            const current = v ?? { x: 0, y: 0, scale: 1 };
            const next = { ...current, x: current.x - e.deltaX, y: current.y - e.deltaY };
            writeStored("view", next);
            return next;
          });
        }
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      return () => el.removeEventListener("wheel", onWheel);
    }, [zoomAt, focus]);

    useEffect(() => {
      const down = (e) => {
        if (e.code === "Space" && !e.repeat && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && !e.target.isContentEditable) {
          setSpace(true);
          e.preventDefault();
        }
      };
      const up = (e) => e.code === "Space" && setSpace(false);
      window.addEventListener("keydown", down);
      window.addEventListener("keyup", up);
      return () => {
        window.removeEventListener("keydown", down);
        window.removeEventListener("keyup", up);
      };
    }, []);

    const onPointerDown = (e) => {
      const onBackground = e.target === root.current || e.target === world.current || e.target.classList?.contains("dc-dots");
      if (e.button !== 0 && e.button !== 1) return;
      if (!onBackground && !space && e.button !== 1) return;
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, view: view ?? { x: 0, y: 0, scale: 1 } };
      setPanning(true);
      const move = (m) => apply({ ...start.view, x: start.view.x + m.clientX - start.x, y: start.view.y + m.clientY - start.y });
      const done = () => {
        setPanning(false);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", done);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", done);
    };

    const v = view ?? { x: 0, y: 0, scale: 1 };
    const zoomBy = (factor) => {
      const el = root.current;
      if (el) zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2);
    };
    const context = useMemo(() => ({ boards, drag, setFocus }), []);
    // Focus mode walks artboards in the order they appear on the canvas.
    const ordered = () =>
      [...(world.current?.querySelectorAll("[data-dc-id]") ?? [])].map((el) => boards.current.get(el.dataset.dcId)).filter(Boolean);

    return (
      <CanvasContext.Provider value={context}>
        <div
          ref={root}
          className={`dc-root${panning ? " is-panning" : ""}${space ? " is-space" : ""}`}
          style={background ? { "--dc-bg": background } : undefined}
          onPointerDown={onPointerDown}
        >
          <div className="dc-dots" style={{ backgroundSize: `${24 * v.scale}px ${24 * v.scale}px`, backgroundPosition: `${v.x}px ${v.y}px` }} />
          <div ref={world} className="dc-world" style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.scale})`, padding: PADDING }}>
            {title ? <h1 className="dc-title">{title}</h1> : null}
            {children}
          </div>
          <div className="dc-controls" onPointerDown={(e) => e.stopPropagation()}>
            <button title="Zoom out" onClick={() => zoomBy(1 / 1.25)}>−</button>
            <span>{Math.round(v.scale * 100)}%</span>
            <button title="Zoom in" onClick={() => zoomBy(1.25)}>+</button>
            <button title="Fit everything" onClick={fit}>Fit</button>
            <button title="Actual size" onClick={() => apply({ ...v, scale: 1 })}>100%</button>
          </div>
          {focus ? <FocusView id={focus} ordered={ordered} onClose={() => setFocus(null)} onMove={setFocus} /> : null}
        </div>
      </CanvasContext.Provider>
    );
  }

  function DCSection({ id: sectionId, title, subtitle, children }) {
    const id = sectionId ?? title ?? "section";
    const items = Children.toArray(children).filter(Boolean);
    const keys = items.map((child, i) => String(child.props.label ?? child.key ?? i));
    const [order, setOrder] = useState(() => readStored(`order:${id}`, null));
    const [dropAt, setDropAt] = useState(null);
    const sorted = useMemo(() => {
      if (!order) return items.map((_, i) => i);
      const known = order.map((k) => keys.indexOf(k)).filter((i) => i >= 0);
      const rest = keys.map((_, i) => i).filter((i) => !known.includes(i));
      return [...known, ...rest];
    }, [order, keys.join("\u0000")]);
    const move = (from, to) => {
      const next = sorted.filter((i) => i !== from);
      next.splice(to > sorted.indexOf(from) ? to - 1 : to, 0, from);
      const keyed = next.map((i) => keys[i]);
      setOrder(keyed);
      writeStored(`order:${id}`, keyed);
    };
    const context = useMemo(() => ({ id, sorted, keys, move, setDropAt, dropAt }), [id, sorted, dropAt]);
    return (
      <SectionContext.Provider value={context}>
        <section className="dc-section">
          {title || subtitle ? (
            <header className="dc-section-head">
              {title ? <h2>{title}</h2> : null}
              {subtitle ? <p>{subtitle}</p> : null}
            </header>
          ) : null}
          <div className="dc-row">
            {sorted.map((i, position) =>
              React.cloneElement(items[i], { key: keys[i], __index: i, __position: position, __section: id, __count: sorted.length }),
            )}
          </div>
        </section>
      </SectionContext.Provider>
    );
  }

  function DCArtboard({ label, note, width = 1280, height = 800, background = "#fff", children, __index, __position, __section, __count }) {
    const canvas = useContext(CanvasContext);
    const section = useContext(SectionContext);
    const id = `${__section}::${label ?? __index}`;
    const box = useRef(null);
    const [dragging, setDragging] = useState(false);
    useEffect(() => {
      if (!canvas) return;
      canvas.boards.current.set(id, { id, label, note, width, height, background, children });
      return () => canvas.boards.current.delete(id);
    });

    const onLabelDown = (e) => {
      if (e.button !== 0 || !section || e.target.closest(".dc-expand")) return;
      e.stopPropagation();
      const startX = e.clientX;
      let started = false;
      const row = box.current.parentElement;
      const target = (clientX) => {
        const boardsInRow = [...row.querySelectorAll(":scope > .dc-board")];
        let at = boardsInRow.length;
        for (let i = 0; i < boardsInRow.length; i++) {
          const r = boardsInRow[i].getBoundingClientRect();
          if (clientX < r.left + r.width / 2) {
            at = i;
            break;
          }
        }
        return at;
      };
      const move = (m) => {
        if (!started && Math.abs(m.clientX - startX) < 4) return;
        started = true;
        setDragging(true);
        section.setDropAt(target(m.clientX));
      };
      const up = (u) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setDragging(false);
        section.setDropAt(null);
        if (started) {
          const to = target(u.clientX);
          if (to !== __position && to !== __position + 1) section.move(__index, to);
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };

    return (
      <div
        ref={box}
        className={`dc-board${dragging ? " is-dragging" : ""}${section?.dropAt === __position ? " drop-before" : ""}${section?.dropAt === __count && __position === __count - 1 ? " drop-after" : ""}`}
        style={{ width }}
        data-dc-id={id}
        data-dc-artboard={label}
      >
        <div className="dc-label" onPointerDown={onLabelDown} onDoubleClick={() => canvas?.setFocus(id)}>
          <span>{label}</span>
          {note ? <small>{note}</small> : null}
          <button className="dc-expand" title="Focus" aria-label={`Focus ${label ?? "artboard"}`} onClick={() => canvas?.setFocus(id)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
          </button>
        </div>
        <div className="dc-frame" style={{ width, height, background }}>
          {children}
        </div>
      </div>
    );
  }

  function FocusView({ id, ordered, onClose, onMove }) {
    const list = ordered();
    const index = Math.max(0, list.findIndex((b) => b.id === id));
    const board = list[index];
    const stage = useRef(null);
    const [scale, setScale] = useState(1);
    useEffect(() => {
      const measure = () => {
        const el = stage.current;
        if (!el || !board) return;
        setScale(Math.min(1, (el.clientWidth - 64) / board.width, (el.clientHeight - 64) / board.height));
      };
      measure();
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }, [board]);
    useEffect(() => {
      const key = (e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "ArrowRight" && index < list.length - 1) onMove(list[index + 1].id);
        if (e.key === "ArrowLeft" && index > 0) onMove(list[index - 1].id);
      };
      window.addEventListener("keydown", key);
      return () => window.removeEventListener("keydown", key);
    }, [index, list.length]);
    if (!board) return null;
    return (
      <div className="dc-focus" onPointerDown={(e) => e.stopPropagation()}>
        <div className="dc-focus-bar">
          <strong>{board.label}</strong>
          {board.note ? <small>{board.note}</small> : null}
          <small>{index + 1} / {list.length}</small>
          <span style={{ flex: 1 }} />
          <button disabled={index === 0} onClick={() => onMove(list[index - 1].id)}>←</button>
          <button disabled={index === list.length - 1} onClick={() => onMove(list[index + 1].id)}>→</button>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="dc-focus-stage" ref={stage}>
          <div className="dc-frame" style={{ width: board.width, height: board.height, background: board.background, transform: `translate(-50%, -50%) scale(${scale})` }}>
            {board.children}
          </div>
        </div>
      </div>
    );
  }

  Object.assign(window, { DesignCanvas, DCSection, DCArtboard });
})();
