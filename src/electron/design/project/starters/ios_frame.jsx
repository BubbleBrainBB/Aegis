/**
 * ios_frame.jsx: an iPhone (iOS 26) device frame for presenting phone screens.
 *
 * Load after React, ReactDOM and Babel:
 *   <script type="text/babel" src="ios_frame.jsx"></script>
 * Exports IOSDevice, IOSStatusBar, IOSHomeIndicator, IOSKeyboard to window.
 *
 *   <IOSDevice>
 *     <MyScreen />
 *   </IOSDevice>
 *
 * - IOSDevice draws the titanium bezel, the screen (402 × 874 points, like iPhone 17 Pro), the Dynamic
 *   Island, the status bar and the home indicator. Your screen fills the whole display, under the status
 *   bar, the way iOS apps do: pad your content with var(--ios-safe-top) and var(--ios-safe-bottom)
 *   (set by the frame) instead of guessing.
 * - Props: dark (light status bar text for dark screens; default false), time ("9:41"), keyboard (show
 *   the keyboard at the bottom; default false), bezel (default true; false gives the bare screen with
 *   rounded corners), width / height (screen size in points), background (screen color), label (an
 *   accessible name). The frame's outer size is the screen plus 12px of bezel on every side.
 * - Use it to present screens (on a design canvas, in a flow, in a pitch). An installable phone
 *   prototype doesn't paint fake system chrome; see the mobile-prototype skill.
 * - Never draw your own status bar, notch or home indicator inside it.
 */
(() => {
  const iosFrameCss = `
.ios-device{position:relative;flex:none;box-sizing:border-box;border-radius:var(--ios-outer-radius);padding:12px;background:linear-gradient(145deg,#3a3a3c,#1c1c1e 40%,#2c2c2e);box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.18),inset 0 0 0 3px #0b0b0c,0 2px 4px rgba(0,0,0,.18),0 24px 60px rgba(0,0,0,.22)}
.ios-device.is-bare{padding:0;background:none;box-shadow:0 0 0 1px rgba(0,0,0,.08),0 24px 60px rgba(0,0,0,.16)}
.ios-screen{position:relative;overflow:hidden;border-radius:var(--ios-screen-radius);background:var(--ios-screen-bg,#fff);isolation:isolate}
.ios-content{position:absolute;inset:0;overflow:hidden}
.ios-island{position:absolute;top:11px;left:50%;width:126px;height:37px;margin-left:-63px;border-radius:20px;background:#000;z-index:30}
.ios-status{position:absolute;top:0;left:0;right:0;height:54px;display:flex;align-items:center;justify-content:space-between;padding:0 30px 0 44px;box-sizing:border-box;z-index:20;pointer-events:none;color:#000;font:600 17px/1 -apple-system,"SF Pro Text","SF Pro",system-ui,sans-serif;letter-spacing:-.01em}
.ios-status.is-dark{color:#fff}
.ios-status-right{display:flex;align-items:center;gap:6px}
.ios-home{position:absolute;bottom:8px;left:50%;width:139px;height:5px;margin-left:-69.5px;border-radius:3px;background:#000;z-index:20;pointer-events:none}
.ios-home.is-dark{background:#fff}
.ios-keyboard{position:absolute;left:0;right:0;bottom:0;z-index:15;padding:8px 4px 46px;box-sizing:border-box;background:rgba(209,211,217,.82);backdrop-filter:blur(30px) saturate(1.6);-webkit-backdrop-filter:blur(30px) saturate(1.6);border-top-left-radius:26px;border-top-right-radius:26px;font:400 22px/1 -apple-system,"SF Pro Text",system-ui,sans-serif;color:#000}
.ios-keyboard.is-dark{background:rgba(43,43,45,.86);color:#fff}
.ios-key-row{display:flex;justify-content:center;gap:6px;margin:0 0 11px}
.ios-key{flex:0 0 auto;width:34px;height:44px;display:grid;place-items:center;border-radius:8px;background:#fff;box-shadow:0 1px 0 rgba(0,0,0,.3)}
.ios-keyboard.is-dark .ios-key{background:#6b6b6e;box-shadow:none}
.ios-key.is-wide{width:46px;font-size:16px;background:#abb0ba}
.ios-keyboard.is-dark .ios-key.is-wide{background:#464648}
.ios-key.is-space{flex:1;font-size:16px}
.ios-key.is-return{width:92px;font-size:16px;background:#abb0ba}
.ios-keyboard.is-dark .ios-key.is-return{background:#464648}
`;

  function useIosFrameStyles() {
    React.useEffect(() => {
      if (document.getElementById("ios-frame-styles")) return;
      const tag = document.createElement("style");
      tag.id = "ios-frame-styles";
      tag.textContent = iosFrameCss;
      document.head.appendChild(tag);
    }, []);
  }

  function IOSStatusBar({ dark = false, time = "9:41" }) {
    return (
      <div className={`ios-status${dark ? " is-dark" : ""}`} aria-hidden="true">
        <span>{time}</span>
        <span className="ios-status-right">
          <svg width="19" height="12" viewBox="0 0 19 12" fill="currentColor"><rect x="0" y="8" width="3.2" height="4" rx="1" /><rect x="5.2" y="5.5" width="3.2" height="6.5" rx="1" /><rect x="10.4" y="3" width="3.2" height="9" rx="1" /><rect x="15.6" y="0" width="3.2" height="12" rx="1" /></svg>
          <svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor"><path d="M8.5 2.4c2.3 0 4.4.9 6 2.4l1.2-1.2A10.1 10.1 0 0 0 8.5.7 10.1 10.1 0 0 0 1.3 3.6l1.2 1.2a8.4 8.4 0 0 1 6-2.4Zm0 3.4c1.4 0 2.6.5 3.6 1.4l1.2-1.2a6.8 6.8 0 0 0-9.6 0l1.2 1.2c1-.9 2.2-1.4 3.6-1.4Zm0 3.4c.5 0 .9.2 1.3.5L8.5 11 7.2 9.7c.4-.3.8-.5 1.3-.5Z" /></svg>
          <svg width="28" height="13" viewBox="0 0 28 13" fill="none"><rect x=".5" y=".5" width="24" height="12" rx="3.8" stroke="currentColor" opacity=".35" /><rect x="2" y="2" width="21" height="9" rx="2.5" fill="currentColor" /><path d="M26 4.3v4.4c.9-.3 1.5-1.2 1.5-2.2s-.6-1.9-1.5-2.2Z" fill="currentColor" opacity=".4" /></svg>
        </span>
      </div>
    );
  }

  function IOSHomeIndicator({ dark = false }) {
    return <div className={`ios-home${dark ? " is-dark" : ""}`} aria-hidden="true" />;
  }

  const iosRows = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ];
  function IOSKeyboard({ dark = false, returnLabel = "return" }) {
    return (
      <div className={`ios-keyboard${dark ? " is-dark" : ""}`} aria-hidden="true">
        {iosRows.map((row, i) => (
          <div key={i} className="ios-key-row">
            {row.map((k) => (
              <span key={k} className="ios-key">{k}</span>
            ))}
          </div>
        ))}
        <div className="ios-key-row">
          <span className="ios-key is-wide">⇧</span>
          {["z", "x", "c", "v", "b", "n", "m"].map((k) => (
            <span key={k} className="ios-key">{k}</span>
          ))}
          <span className="ios-key is-wide">⌫</span>
        </div>
        <div className="ios-key-row" style={{ margin: 0 }}>
          <span className="ios-key is-wide">123</span>
          <span className="ios-key is-wide">☺</span>
          <span className="ios-key is-space">space</span>
          <span className="ios-key is-return">{returnLabel}</span>
        </div>
      </div>
    );
  }

  function IOSDevice({ children, dark = false, time = "9:41", keyboard = false, bezel = true, width = 402, height = 874, background, label = "iPhone" }) {
    useIosFrameStyles();
    const screenRadius = bezel ? 55 : 48;
    return (
      <div
        className={`ios-device${bezel ? "" : " is-bare"}`}
        role="group"
        aria-label={label}
        style={{ "--ios-outer-radius": `${screenRadius + (bezel ? 12 : 0)}px`, "--ios-screen-radius": `${screenRadius}px`, width: width + (bezel ? 24 : 0) }}
      >
        <div
          className="ios-screen"
          style={{ width, height, "--ios-screen-bg": background, "--ios-safe-top": "62px", "--ios-safe-bottom": keyboard ? "0px" : "34px" }}
        >
          <div className="ios-content" role="presentation">{children}</div>
          <IOSStatusBar dark={dark} time={time} />
          <div className="ios-island" aria-hidden="true" />
          {keyboard ? <IOSKeyboard dark={dark} /> : null}
          <IOSHomeIndicator dark={dark} />
        </div>
      </div>
    );
  }

  Object.assign(window, { IOSDevice, IOSStatusBar, IOSHomeIndicator, IOSKeyboard });
})();
