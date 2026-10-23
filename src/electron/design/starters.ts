/**
 * Starter frames: device bezels and window chrome the agent drops into a
 * board instead of drawing them by hand. Static HTML/CSS that passes the
 * board sanitizer; chrome is locked and marked data-aegis-starter="chrome",
 * the slot for the screen's own UI data-aegis-starter="content".
 */
export const DESIGN_STARTER_KINDS = ['ios-phone', 'android-phone', 'browser-window', 'macos-window'] as const;
export type DesignStarterKind = (typeof DESIGN_STARTER_KINDS)[number];

export interface DesignStarterOptions {
  theme?: 'light' | 'dark';
  width?: number;
  height?: number;
  url?: string;
  title?: string;
  sidebar?: number;
  fullBleed?: boolean;
}

export interface DesignStarter {
  kind: DesignStarterKind;
  label: string;
  html: string;
  width: number;
  height: number;
  slot: string;
  notes: string[];
}

const SANS = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', system-ui, sans-serif";
const ANDROID_SANS = "Roboto, 'Google Sans', 'Noto Sans SC', 'PingFang SC', system-ui, -apple-system, sans-serif";
const PAD = 48;

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function size(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return value;
}

const chrome = (name: string) => `data-aegis-layer-name="${name}" data-aegis-starter="chrome" data-aegis-locked="true"`;
const slot = (name: string) => `data-aegis-layer-name="${name}" data-aegis-starter="content"`;

const trafficLights = `<span style="display:flex;gap:8px;flex:none"><span style="width:12px;height:12px;border-radius:50%;background:#ff5f57;box-shadow:inset 0 0 0 0.5px rgba(0,0,0,0.18)"></span><span style="width:12px;height:12px;border-radius:50%;background:#febc2e;box-shadow:inset 0 0 0 0.5px rgba(0,0,0,0.18)"></span><span style="width:12px;height:12px;border-radius:50%;background:#28c840;box-shadow:inset 0 0 0 0.5px rgba(0,0,0,0.18)"></span></span>`;

function iosPhone(o: DesignStarterOptions): DesignStarter {
  const w = size('width', o.width, 390, 320, 440);
  const h = size('height', o.height, 844, 568, 956);
  const dark = o.theme === 'dark';
  const ink = dark ? '#ffffff' : '#000000';
  const over = o.fullBleed ? 'position:absolute;left:0;right:0;z-index:2;' : 'position:relative;';
  const html = `<div data-aegis-layer-name="iPhone" data-aegis-starter="frame" style="box-sizing:border-box;width:${w + 24}px;padding:12px;border-radius:68px;background:#111113;box-shadow:0 0 0 1px #2c2c30, inset 0 0 0 1px rgba(255,255,255,0.08), 0 32px 64px -24px rgba(17,17,26,0.45), 0 10px 24px -12px rgba(17,17,26,0.3)">
  <div data-aegis-layer-name="Screen" style="position:relative;display:flex;flex-direction:column;width:${w}px;height:${h}px;border-radius:56px;overflow:hidden;background:${dark ? '#000000' : '#ffffff'};color:${ink};font-family:${SANS}">
    <div ${chrome('Status bar')} style="${over}top:0;flex:none;display:flex;align-items:center;height:54px;padding:0 10px;color:${ink}">
      <span style="flex:1;text-align:center;font-size:17px;font-weight:600;letter-spacing:-0.2px;font-variant-numeric:tabular-nums">9:41</span>
      <span data-aegis-layer-name="Dynamic Island" style="flex:none;width:125px;height:37px;border-radius:19px;background:#000000"></span>
      <span style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px">
        <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="0.8"/><rect x="5" y="5.5" width="3" height="6.5" rx="0.8"/><rect x="10" y="3" width="3" height="9" rx="0.8"/><rect x="15" y="0" width="3" height="12" rx="0.8"/></svg>
        <svg width="16" height="12" viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M1.6 4.3a9.4 9.4 0 0 1 12.8 0"/><path d="M4.2 7a5.6 5.6 0 0 1 7.6 0"/><circle cx="8" cy="10.2" r="1.4" fill="currentColor" stroke="none"/></svg>
        <svg width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x="0.5" y="0.5" width="23" height="12" rx="3.8" stroke="currentColor" opacity="0.4"/><rect x="2" y="2" width="20" height="9" rx="2.5" fill="currentColor"/><path d="M25 4.5v4c0.8-0.3 1.4-1.1 1.4-2s-0.6-1.7-1.4-2z" fill="currentColor" opacity="0.45"/></svg>
      </span>
    </div>
    <div ${slot('Screen content')} style="flex:1;min-height:0;overflow:hidden">
    </div>
    <div ${chrome('Home indicator')} style="${over}bottom:0;flex:none;display:flex;align-items:flex-end;justify-content:center;height:34px;padding-bottom:8px;box-sizing:border-box">
      <span style="width:139px;height:5px;border-radius:3px;background:${ink}"></span>
    </div>
  </div>
</div>`;
  return {
    kind: 'ios-phone', label: 'iOS phone', html, width: w + 24, height: h + 24, slot: 'Screen content',
    notes: [
      `Screen ${w} × ${h}; the status bar (54px) and home indicator (34px) ${o.fullBleed ? 'float over the content, so keep text clear of the top 54px and bottom 34px' : 'sit above and below "Screen content", which fills the space between them'}.`,
      'Set the app background on "Screen" so it runs behind the status bar; the status bar text follows theme (light = dark text).',
    ],
  };
}

function androidPhone(o: DesignStarterOptions): DesignStarter {
  const w = size('width', o.width, 412, 320, 480);
  const h = size('height', o.height, 915, 640, 1000);
  const dark = o.theme === 'dark';
  const ink = dark ? '#ffffff' : '#1b1b1f';
  const over = o.fullBleed ? 'position:absolute;left:0;right:0;z-index:2;' : 'position:relative;';
  const html = `<div data-aegis-layer-name="Android phone" data-aegis-starter="frame" style="box-sizing:border-box;width:${w + 20}px;padding:10px;border-radius:46px;background:#18181b;box-shadow:0 0 0 1px #2e2e33, inset 0 0 0 1px rgba(255,255,255,0.07), 0 32px 64px -24px rgba(17,17,26,0.45), 0 10px 24px -12px rgba(17,17,26,0.3)">
  <div data-aegis-layer-name="Screen" style="position:relative;display:flex;flex-direction:column;width:${w}px;height:${h}px;border-radius:36px;overflow:hidden;background:${dark ? '#121316' : '#fdfbff'};color:${ink};font-family:${ANDROID_SANS}">
    <div ${chrome('Status bar')} style="${over}top:0;flex:none;display:flex;align-items:center;height:40px;padding:0 24px;color:${ink}">
      <span style="flex:1;font-size:14px;font-weight:500;font-variant-numeric:tabular-nums">9:41</span>
      <span data-aegis-layer-name="Camera" style="flex:none;width:20px;height:20px;border-radius:50%;background:#0b0b0d;box-shadow:inset 0 0 0 3px #1f1f24"></span>
      <span style="flex:1;display:flex;align-items:center;justify-content:flex-end;gap:5px">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5 1.2 7.4A17 17 0 0 1 12 3.5c4.1 0 7.9 1.5 10.8 3.9z"/></svg>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M2 22h20V2z"/></svg>
        <svg width="9" height="15" viewBox="0 0 10 16" fill="currentColor"><rect x="3" y="0" width="4" height="2" rx="0.5"/><rect x="0.5" y="1.5" width="9" height="14.5" rx="1.8"/></svg>
      </span>
    </div>
    <div ${slot('Screen content')} style="flex:1;min-height:0;overflow:hidden">
    </div>
    <div ${chrome('Navigation bar')} style="${over}bottom:0;flex:none;display:flex;align-items:center;justify-content:center;height:28px">
      <span style="width:108px;height:4px;border-radius:2px;background:${ink};opacity:0.9"></span>
    </div>
  </div>
</div>`;
  return {
    kind: 'android-phone', label: 'Android phone', html, width: w + 20, height: h + 20, slot: 'Screen content',
    notes: [
      `Screen ${w} × ${h}; the status bar (40px) and gesture bar (28px) ${o.fullBleed ? 'float over the content, so keep text clear of them' : 'sit above and below "Screen content"'}.`,
      'Set the app background on "Screen"; the status bar text follows theme (light = dark text).',
    ],
  };
}

function browserWindow(o: DesignStarterOptions): DesignStarter {
  const w = size('width', o.width, 1280, 480, 2560);
  const h = size('height', o.height, 800, 320, 1600);
  const dark = o.theme === 'dark';
  const url = escape((o.url ?? 'example.com').trim().slice(0, 120) || 'example.com');
  const bar = dark ? '#2a2a2c' : '#f3f3f3';
  const line = dark ? '#3a3a3c' : '#e1e1e1';
  const muted = dark ? '#a1a1a6' : '#6e6e73';
  const icon = `fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;
  const html = `<div data-aegis-layer-name="Browser window" data-aegis-starter="frame" style="width:${w}px;border-radius:12px;overflow:hidden;background:${bar};box-shadow:0 0 0 1px ${dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)'}, 0 28px 60px -24px rgba(17,17,26,0.35), 0 4px 12px -6px rgba(17,17,26,0.12);font-family:${SANS}">
  <div ${chrome('Browser toolbar')} style="box-sizing:border-box;display:flex;align-items:center;gap:16px;height:52px;padding:0 16px;border-bottom:1px solid ${line};color:${muted}">
    <span style="flex:1;display:flex;align-items:center;gap:20px">
      ${trafficLights}
      <span style="display:flex;gap:14px"><svg width="16" height="16" viewBox="0 0 16 16" ${icon}><path d="M10 3 5 8l5 5"/></svg><svg width="16" height="16" viewBox="0 0 16 16" ${icon} opacity="0.45"><path d="m6 3 5 5-5 5"/></svg></span>
    </span>
    <span data-aegis-layer-name="Address bar" style="flex:0 1 560px;min-width:0;display:flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;background:${dark ? '#1c1c1e' : '#ffffff'};box-shadow:0 0 0 1px ${line};font-size:13px;color:${dark ? '#e5e5ea' : '#3a3a3c'}">
      <svg width="11" height="12" viewBox="0 0 11 12" fill="${muted}"><rect x="1" y="5" width="9" height="7" rx="1.5"/><path d="M3 5V3.6a2.5 2.5 0 0 1 5 0V5" fill="none" stroke="${muted}" stroke-width="1.4"/></svg>
      <span style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${url}</span>
    </span>
    <span style="flex:1;display:flex;justify-content:flex-end;gap:16px">
      <svg width="16" height="16" viewBox="0 0 16 16" ${icon}><path d="M8 2v8M5 5l3-3 3 3M3 9v4h10V9"/></svg>
      <svg width="16" height="16" viewBox="0 0 16 16" ${icon}><path d="M8 3v10M3 8h10"/></svg>
    </span>
  </div>
  <div ${slot('Page')} style="height:${h}px;overflow:hidden;background:${dark ? '#121212' : '#ffffff'}">
  </div>
</div>`;
  return {
    kind: 'browser-window', label: 'Browser window', html, width: w, height: h + 52, slot: 'Page',
    notes: [
      `Viewport ${w} × ${h} below a 52px toolbar. Put the website inside "Page"; change the address text to the page's URL.`,
      'For a page longer than one screen, raise height (the viewport grows) rather than letting "Page" clip it.',
    ],
  };
}

function macosWindow(o: DesignStarterOptions): DesignStarter {
  const w = size('width', o.width, 960, 480, 2560);
  const h = size('height', o.height, 600, 320, 1600);
  const side = o.sidebar ? size('sidebar', o.sidebar, 220, 160, 360) : 0;
  if (side && side > w - 240) throw new Error('sidebar leaves too little room: make the window wider or the sidebar narrower.');
  const dark = o.theme === 'dark';
  const title = escape((o.title ?? 'Untitled').trim().slice(0, 80) || 'Untitled');
  const line = dark ? '#3a3a3c' : '#e3e3e3';
  const text = dark ? '#e5e5ea' : '#2c2c2e';
  const surface = dark ? '#1e1e1e' : '#ffffff';
  const ring = `0 0 0 1px ${dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.16)'}, 0 28px 60px -24px rgba(17,17,26,0.35), 0 4px 12px -6px rgba(17,17,26,0.12)`;
  const html = side
    ? `<div data-aegis-layer-name="macOS window" data-aegis-starter="frame" style="display:flex;width:${w}px;height:${h + 52}px;border-radius:12px;overflow:hidden;background:${surface};box-shadow:${ring};font-family:${SANS};color:${text}">
  <div data-aegis-layer-name="Sidebar" style="flex:none;display:flex;flex-direction:column;width:${side}px;background:${dark ? '#262628' : '#efeff1'};border-right:1px solid ${line}">
    <div ${chrome('Window controls')} style="flex:none;display:flex;align-items:center;height:52px;padding:0 20px">${trafficLights}</div>
    <div ${slot('Sidebar content')} style="flex:1;min-height:0;overflow:hidden">
    </div>
  </div>
  <div data-aegis-layer-name="Main" style="flex:1;min-width:0;display:flex;flex-direction:column">
    <div ${chrome('Title bar')} style="box-sizing:border-box;flex:none;display:flex;align-items:center;height:52px;padding:0 20px;border-bottom:1px solid ${line}">
      <span style="font-size:15px;font-weight:700;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${title}</span>
    </div>
    <div ${slot('Window content')} style="flex:1;min-height:0;overflow:hidden">
    </div>
  </div>
</div>`
    : `<div data-aegis-layer-name="macOS window" data-aegis-starter="frame" style="width:${w}px;border-radius:12px;overflow:hidden;background:${surface};box-shadow:${ring};font-family:${SANS};color:${text}">
  <div ${chrome('Title bar')} style="box-sizing:border-box;display:flex;align-items:center;height:38px;padding:0 14px;background:${dark ? '#2b2b2d' : '#f6f6f6'};border-bottom:1px solid ${line}">
    <span style="flex:1;display:flex">${trafficLights}</span>
    <span style="flex:0 1 auto;min-width:0;font-size:13px;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${title}</span>
    <span style="flex:1"></span>
  </div>
  <div ${slot('Window content')} style="height:${h}px;overflow:hidden">
  </div>
</div>`;
  return {
    kind: 'macos-window', label: 'macOS window', html, width: w, height: h + (side ? 52 : 38), slot: 'Window content',
    notes: side
      ? [`Window ${w} × ${h + 52}: a ${side}px sidebar ("Sidebar content") and a main area with a 52px title bar above "Window content" (${h}px tall). Change the title to the app's current view.`]
      : [`Content ${w} × ${h} below a 38px title bar. Put the app's UI inside "Window content"; change the title to the document or app name.`],
  };
}

const builders: Record<DesignStarterKind, (o: DesignStarterOptions) => DesignStarter> = {
  'ios-phone': iosPhone,
  'android-phone': androidPhone,
  'browser-window': browserWindow,
  'macos-window': macosWindow,
};

export function designStarter(kind: DesignStarterKind, options: DesignStarterOptions = {}): DesignStarter {
  const build = builders[kind];
  if (!build) throw new Error(`Unknown starter "${kind}". Use one of: ${DESIGN_STARTER_KINDS.join(', ')}.`);
  return build(options);
}

export const DESIGN_STARTER_DESCRIPTION =
  'Ready-made device frames and window chrome for boards: ios-phone, android-phone, browser-window, macos-window (light or dark). Returns markup to paste into a board, its size, and the layer that holds the screen’s own UI. Use these instead of drawing phone bezels, status bars, browser toolbars or window title bars by hand. Frame a screen when it should read as a real device or app window (flows, concepts, presentations); a plain board at the device size is fine when the user just wants the bare screen.';

/** Tool text: the frame's size, how to place it, then the markup. */
export function designStarterText(kind: DesignStarterKind, options: DesignStarterOptions = {}): string {
  const s = designStarter(kind, options);
  return [
    `# ${s.label} frame (${options.theme === 'dark' ? 'dark' : 'light'})`,
    `Frame ${s.width} × ${s.height}. For one framed screen, make the board ${s.width + PAD * 2} × ${s.height + PAD * 2} and center the frame with ${PAD}px around it; for a flow, put several frames in one flex row with a gap of 48–64px and size the board to fit. Leave the board itself white (or the design's own near-white page color): the canvas around boards already sets them off, so a grey or tinted backdrop only muddies the frame.`,
    ...s.notes.map((n) => `- ${n}`),
    `- Put the screen's UI inside the "${s.slot}" layer (data-aegis-starter="content"). It is a plain block with a fixed height that clips at the frame's edge: sections stack at their natural size, and a cut-off warning there means the content is too tall for one screen.`,
    '- For something pinned to the bottom (a tab bar, an action bar), make one root inside the slot with height:100%; display:flex; flex-direction:column, give the scrolling part flex:1; min-height:0; overflow:hidden and keep it a plain block (not a flex column) so its cards keep their natural height, and give the bar flex:none.',
    '- Keep the frame as it is: its layer names, data-aegis-starter marks and the locked chrome. Edit only the content layers, the status bar time, address or title text.',
    '',
    '```html',
    s.html,
    '```',
  ].join('\n');
}
