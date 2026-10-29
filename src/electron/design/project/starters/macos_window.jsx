/**
 * macos_window.jsx: a macOS (Tahoe) app window for presenting desktop app screens.
 *
 * Load after React, ReactDOM and Babel:
 *   <script type="text/babel" src="macos_window.jsx"></script>
 * Exports MacWindow to window.
 *
 *   <MacWindow title="Reader" width={1200} height={780} sidebar={<MySidebar />} toolbar={<MyToolbar />}>
 *     <MyContent />
 *   </MacWindow>
 *
 * - Draws the window: rounded corners, shadow, traffic lights, and a unified title bar. Your app's UI
 *   goes in children (the content area), sidebar (an optional translucent sidebar on the left, full
 *   height, with the traffic lights over it like macOS apps) and toolbar (optional controls in the
 *   title bar, right of the title).
 * - Props: title, width / height (the whole window, default 1200 × 760), sidebarWidth (default 240),
 *   dark (dark appearance), background (content color), inactive (grey traffic lights).
 * - The window has a fixed size; inside it, lay your UI out with flex or grid so it fills the content area.
 * - Never draw your own traffic lights or title bar.
 */
(() => {
  const macWindowCss = `
.mac-window{position:relative;flex:none;display:flex;overflow:hidden;border-radius:16px;background:var(--mac-content-bg,#fff);color:#1d1d1f;box-shadow:0 0 0 .5px rgba(0,0,0,.22),0 1px 1px rgba(0,0,0,.06),0 22px 70px rgba(0,0,0,.28);font:13px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
.mac-window.is-dark{color:#f5f5f7;background:var(--mac-content-bg,#1e1e1f);box-shadow:0 0 0 .5px rgba(255,255,255,.16),0 22px 70px rgba(0,0,0,.5)}
.mac-sidebar{flex:none;display:flex;flex-direction:column;padding-top:52px;box-sizing:border-box;background:rgba(236,236,238,.92);backdrop-filter:blur(30px) saturate(1.8);-webkit-backdrop-filter:blur(30px) saturate(1.8);border-right:.5px solid rgba(0,0,0,.1);overflow:auto}
.mac-window.is-dark .mac-sidebar{background:rgba(44,44,46,.9);border-right-color:rgba(255,255,255,.08)}
.mac-main{position:relative;flex:1;min-width:0;display:flex;flex-direction:column}
.mac-titlebar{flex:none;height:52px;display:flex;align-items:center;gap:12px;padding:0 14px 0 20px;box-sizing:border-box}
.mac-window.has-sidebar .mac-titlebar{padding-left:16px}
.mac-title{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mac-toolbar{margin-left:auto;display:flex;align-items:center;gap:8px}
.mac-body{position:relative;flex:1;min-height:0;overflow:hidden}
.mac-lights{position:absolute;top:19px;left:19px;display:flex;gap:8px;z-index:5}
.mac-lights span{width:13px;height:13px;border-radius:50%;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.18)}
.mac-lights span:nth-child(1){background:#ff5f57}.mac-lights span:nth-child(2){background:#febc2e}.mac-lights span:nth-child(3){background:#28c840}
.mac-window.is-inactive .mac-lights span{background:#d1d1d6}
.mac-window.is-dark.is-inactive .mac-lights span{background:#48484a}
`;

  function useMacWindowStyles() {
    React.useEffect(() => {
      if (document.getElementById("macos-window-styles")) return;
      const tag = document.createElement("style");
      tag.id = "macos-window-styles";
      tag.textContent = macWindowCss;
      document.head.appendChild(tag);
    }, []);
  }

  function MacWindow({ title, children, sidebar, toolbar, width = 1200, height = 760, sidebarWidth = 240, dark = false, background, inactive = false }) {
    useMacWindowStyles();
    const hasSidebar = sidebar != null;
    return (
      <div
        className={`mac-window${dark ? " is-dark" : ""}${hasSidebar ? " has-sidebar" : ""}${inactive ? " is-inactive" : ""}`}
        style={{ width, height, "--mac-content-bg": background }}
      >
        <div className="mac-lights" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        {hasSidebar ? (
          <aside className="mac-sidebar" style={{ width: sidebarWidth }}>
            {sidebar}
          </aside>
        ) : null}
        <div className="mac-main">
          <div className="mac-titlebar" style={hasSidebar ? undefined : { paddingLeft: 92 }}>
            {title ? <span className="mac-title">{title}</span> : null}
            {toolbar ? <div className="mac-toolbar">{toolbar}</div> : null}
          </div>
          <div className="mac-body">{children}</div>
        </div>
      </div>
    );
  }

  Object.assign(window, { MacWindow });
})();
