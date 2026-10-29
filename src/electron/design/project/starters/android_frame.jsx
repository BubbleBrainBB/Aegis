/**
 * android_frame.jsx: an Android (Material 3) device frame for presenting phone screens.
 *
 * Load after React, ReactDOM and Babel:
 *   <script type="text/babel" src="android_frame.jsx"></script>
 * Exports AndroidDevice, AndroidStatusBar, AndroidNavBar, AndroidKeyboard to window.
 *
 *   <AndroidDevice>
 *     <MyScreen />
 *   </AndroidDevice>
 *
 * - AndroidDevice draws the bezel, the screen (412 × 915 dp, like a Pixel), the punch-hole camera, the
 *   status bar and the gesture navigation bar. Your screen fills the display under the status bar:
 *   pad content with var(--android-safe-top) and var(--android-safe-bottom) (set by the frame).
 * - Props: dark (light system bar icons for dark screens; default false), time ("9:30"), keyboard (show
 *   the keyboard; default false), bezel (default true), width / height (screen size in dp), background
 *   (screen color), label (an accessible name). The outer size is the screen plus 10px of bezel per side.
 * - Never draw your own status bar, camera cutout or navigation bar inside it.
 */
(() => {
  const androidFrameCss = `
.and-device{position:relative;flex:none;box-sizing:border-box;border-radius:var(--and-outer-radius);padding:10px;background:linear-gradient(160deg,#2b2b2d,#101011 55%,#232325);box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.12),0 2px 4px rgba(0,0,0,.18),0 24px 60px rgba(0,0,0,.22)}
.and-device.is-bare{padding:0;background:none;box-shadow:0 0 0 1px rgba(0,0,0,.08),0 24px 60px rgba(0,0,0,.16)}
.and-screen{position:relative;overflow:hidden;border-radius:var(--and-screen-radius);background:var(--and-screen-bg,#fff);isolation:isolate}
.and-content{position:absolute;inset:0;overflow:hidden}
.and-camera{position:absolute;top:12px;left:50%;width:22px;height:22px;margin-left:-11px;border-radius:50%;background:radial-gradient(circle at 38% 38%,#2a3242 0 3px,#050506 4px);z-index:30}
.and-status{position:absolute;top:0;left:0;right:0;height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 22px 0 26px;box-sizing:border-box;z-index:20;pointer-events:none;color:#1d1b20;font:500 14px/1 "Roboto","Google Sans",system-ui,sans-serif;letter-spacing:.01em}
.and-status.is-dark{color:#e6e1e5}
.and-status-right{display:flex;align-items:center;gap:5px}
.and-nav{position:absolute;bottom:0;left:0;right:0;height:24px;display:grid;place-items:center;z-index:20;pointer-events:none}
.and-nav span{width:108px;height:4px;border-radius:2px;background:#1d1b20;opacity:.85}
.and-nav.is-dark span{background:#e6e1e5}
.and-keyboard{position:absolute;left:0;right:0;bottom:0;z-index:15;padding:10px 6px 34px;box-sizing:border-box;background:#eceff3;font:400 21px/1 "Roboto",system-ui,sans-serif;color:#1d1b20}
.and-keyboard.is-dark{background:#1f1f22;color:#e6e1e5}
.and-key-row{display:flex;justify-content:center;gap:6px;margin:0 0 10px}
.and-key{flex:0 0 auto;width:34px;height:46px;display:grid;place-items:center;border-radius:7px;background:#fff}
.and-keyboard.is-dark .and-key{background:#3a3a3e}
.and-key.is-wide{width:52px;font-size:15px;background:#d5dbe3}
.and-keyboard.is-dark .and-key.is-wide{background:#2c2c30}
.and-key.is-space{flex:1;font-size:15px}
.and-key.is-action{width:56px;border-radius:28px;background:#c2e7ff;font-size:18px}
.and-keyboard.is-dark .and-key.is-action{background:#004a77}
`;

  function useAndroidFrameStyles() {
    React.useEffect(() => {
      if (document.getElementById("android-frame-styles")) return;
      const tag = document.createElement("style");
      tag.id = "android-frame-styles";
      tag.textContent = androidFrameCss;
      document.head.appendChild(tag);
    }, []);
  }

  function AndroidStatusBar({ dark = false, time = "9:30" }) {
    return (
      <div className={`and-status${dark ? " is-dark" : ""}`} aria-hidden="true">
        <span>{time}</span>
        <span className="and-status-right">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21 1 9.4C4 6.3 7.8 4.5 12 4.5s8 1.8 11 4.9L12 21Z" /></svg>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2 22h20V2L2 22Z" /></svg>
          <svg width="10" height="16" viewBox="0 0 10 18" fill="currentColor"><path d="M3 0h4v2h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h2V0Z" /></svg>
        </span>
      </div>
    );
  }

  function AndroidNavBar({ dark = false }) {
    return (
      <div className={`and-nav${dark ? " is-dark" : ""}`} aria-hidden="true">
        <span />
      </div>
    );
  }

  const androidRows = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ];
  function AndroidKeyboard({ dark = false }) {
    return (
      <div className={`and-keyboard${dark ? " is-dark" : ""}`} aria-hidden="true">
        {androidRows.map((row, i) => (
          <div key={i} className="and-key-row">
            {row.map((k) => (
              <span key={k} className="and-key">{k}</span>
            ))}
          </div>
        ))}
        <div className="and-key-row">
          <span className="and-key is-wide">⇧</span>
          {["z", "x", "c", "v", "b", "n", "m"].map((k) => (
            <span key={k} className="and-key">{k}</span>
          ))}
          <span className="and-key is-wide">⌫</span>
        </div>
        <div className="and-key-row" style={{ margin: 0 }}>
          <span className="and-key is-wide">?123</span>
          <span className="and-key">,</span>
          <span className="and-key is-space" />
          <span className="and-key">.</span>
          <span className="and-key is-action">↵</span>
        </div>
      </div>
    );
  }

  function AndroidDevice({ children, dark = false, time = "9:30", keyboard = false, bezel = true, width = 412, height = 915, background, label = "Android phone" }) {
    useAndroidFrameStyles();
    const screenRadius = bezel ? 38 : 32;
    return (
      <div
        className={`and-device${bezel ? "" : " is-bare"}`}
        role="group"
        aria-label={label}
        style={{ "--and-outer-radius": `${screenRadius + (bezel ? 10 : 0)}px`, "--and-screen-radius": `${screenRadius}px`, width: width + (bezel ? 20 : 0) }}
      >
        <div
          className="and-screen"
          style={{ width, height, "--and-screen-bg": background, "--android-safe-top": "44px", "--android-safe-bottom": keyboard ? "0px" : "24px" }}
        >
          <div className="and-content">{children}</div>
          <AndroidStatusBar dark={dark} time={time} />
          <div className="and-camera" aria-hidden="true" />
          {keyboard ? <AndroidKeyboard dark={dark} /> : null}
          <AndroidNavBar dark={dark} />
        </div>
      </div>
    );
  }

  Object.assign(window, { AndroidDevice, AndroidStatusBar, AndroidNavBar, AndroidKeyboard });
})();
