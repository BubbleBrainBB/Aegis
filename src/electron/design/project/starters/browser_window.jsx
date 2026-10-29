/**
 * browser_window.jsx: a desktop browser window for presenting websites and web apps.
 *
 * Load after React, ReactDOM and Babel:
 *   <script type="text/babel" src="browser_window.jsx"></script>
 * Exports BrowserWindow to window.
 *
 *   <BrowserWindow url="acme.com/pricing" tabs={["Pricing · Acme"]} width={1280} height={820}>
 *     <MyPage />
 *   </BrowserWindow>
 *
 * - Draws the window: traffic lights, tabs, back / forward / reload, the address bar with a lock, and
 *   the page area. Your page goes in children and scrolls inside the page area.
 * - Props: url (shown without the protocol), tabs (titles; the first is active; default one tab named
 *   after the url), width / height (the whole window, default 1280 × 820), dark (dark browser chrome),
 *   background (page color).
 * - Lay your page out fluidly inside it, as a real page would be.
 * - Never draw your own browser toolbar, tabs or address bar.
 */
(() => {
  const browserWindowCss = `
.bw-window{position:relative;flex:none;display:flex;flex-direction:column;overflow:hidden;border-radius:12px;background:#dee1e6;box-shadow:0 0 0 .5px rgba(0,0,0,.22),0 22px 70px rgba(0,0,0,.26);font:12.5px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1f1f1f}
.bw-window.is-dark{background:#202124;color:#e8eaed}
.bw-tabs{flex:none;height:40px;display:flex;align-items:flex-end;gap:2px;padding:0 10px 0 84px;position:relative}
.bw-lights{position:absolute;left:14px;top:14px;display:flex;gap:8px}
.bw-lights span{width:12px;height:12px;border-radius:50%;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.18)}
.bw-lights span:nth-child(1){background:#ff5f57}.bw-lights span:nth-child(2){background:#febc2e}.bw-lights span:nth-child(3){background:#28c840}
.bw-tab{position:relative;display:flex;align-items:center;gap:8px;width:220px;max-width:220px;height:32px;padding:0 12px;box-sizing:border-box;border-radius:9px 9px 0 0;white-space:nowrap;overflow:hidden;color:inherit;opacity:.8}
.bw-tab.is-active{background:#fff;opacity:1}
.bw-window.is-dark .bw-tab.is-active{background:#35363a}
.bw-tab-title{flex:1;overflow:hidden;text-overflow:ellipsis}
.bw-favicon{flex:none;width:14px;height:14px;border-radius:4px;background:linear-gradient(135deg,#9aa0a6,#5f6368)}
.bw-toolbar{flex:none;height:42px;display:flex;align-items:center;gap:6px;padding:0 10px;background:#fff;border-bottom:1px solid rgba(0,0,0,.08)}
.bw-window.is-dark .bw-toolbar{background:#35363a;border-bottom-color:rgba(255,255,255,.06)}
.bw-button{width:28px;height:28px;display:grid;place-items:center;border-radius:50%;color:#5f6368}
.bw-window.is-dark .bw-button{color:#9aa0a6}
.bw-address{flex:1;height:30px;display:flex;align-items:center;gap:8px;padding:0 14px;border-radius:15px;background:#f1f3f4;color:#202124;font-size:13.5px;white-space:nowrap;overflow:hidden}
.bw-window.is-dark .bw-address{background:#202124;color:#e8eaed}
.bw-page{position:relative;flex:1;min-height:0;overflow:auto;background:var(--bw-page-bg,#fff)}
`;

  function useBrowserWindowStyles() {
    React.useEffect(() => {
      if (document.getElementById("browser-window-styles")) return;
      const tag = document.createElement("style");
      tag.id = "browser-window-styles";
      tag.textContent = browserWindowCss;
      document.head.appendChild(tag);
    }, []);
  }

  const bwIcon = (d) => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );

  function BrowserWindow({ url = "example.com", tabs, children, width = 1280, height = 820, dark = false, background }) {
    useBrowserWindowStyles();
    const shown = url.replace(/^https?:\/\//, "");
    const titles = tabs && tabs.length ? tabs : [shown.split("/")[0]];
    return (
      <div className={`bw-window${dark ? " is-dark" : ""}`} style={{ width, height, "--bw-page-bg": background }}>
        <div className="bw-tabs" aria-hidden="true">
          <div className="bw-lights">
            <span />
            <span />
            <span />
          </div>
          {titles.map((t, i) => (
            <div key={i} className={`bw-tab${i === 0 ? " is-active" : ""}`}>
              <span className="bw-favicon" />
              <span className="bw-tab-title">{t}</span>
            </div>
          ))}
        </div>
        <div className="bw-toolbar" aria-hidden="true">
          <span className="bw-button">{bwIcon("M15 18l-6-6 6-6")}</span>
          <span className="bw-button">{bwIcon("M9 18l6-6-6-6")}</span>
          <span className="bw-button">{bwIcon("M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5")}</span>
          <div className="bw-address">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
            <span>{shown}</span>
          </div>
          <span className="bw-button">{bwIcon("M12 5v.01M12 12v.01M12 19v.01")}</span>
        </div>
        <div className="bw-page">{children}</div>
      </div>
    );
  }

  Object.assign(window, { BrowserWindow });
})();
