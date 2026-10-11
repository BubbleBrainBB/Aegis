// `aegis-widget://` serves generative-UI widgets: a fixed shell page the chat
// loads in a sandboxed iframe (allow-scripts only, so an opaque origin with no
// access to the app), and the chart libraries a widget may load. The widget's
// own HTML never travels in a URL: the chat posts it to the shell, which
// renders it under the shell's CSP (no network, no forms, no navigation).

import { app, clipboard, protocol, type WebContents } from 'electron';
import { ipcMainHandle } from './util';
import * as fs from 'fs';
import * as path from 'path';
import { WIDGET_DESIGN_CSS, WIDGET_SVG_DEFS } from './widget-design-system';
import { CODEX_FRAME_CSP, CODEX_VISUALIZATION_HOST, registerCodexVisualizationIpc, renderCodexVisualization } from './codex-visualization';
import { WIDGET_MESSAGE_SOURCE, WIDGET_PROMPT_MAX_CHARS, WIDGET_SCHEME, WIDGET_STATE_MAX_CHARS, type WidgetLibraryName } from '../shared/widget';

const LIBRARY_FILES: Record<WidgetLibraryName, [pkg: string, file: string]> = {
  'chart.js': ['chart.js', 'dist/chart.umd.min.js'],
  'd3.js': ['d3', 'dist/d3.min.js'],
  'echarts.js': ['echarts', 'dist/echarts.min.js'],
};

export const WIDGET_FRAME_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${WIDGET_SCHEME}:`,
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  'worker-src blob:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

// dist-electron/electron/ sits two levels under the app root, in dev and in
// the packaged app.asar alike; the app path is a fallback.
async function readLibrary(pkg: string, file: string): Promise<Buffer> {
  const roots = [path.join(__dirname, '..', '..'), app.getAppPath()];
  let lastError: unknown = null;
  for (const base of roots) {
    try {
      return await fs.promises.readFile(path.join(base, 'node_modules', pkg, file));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Widget actions that need the main process: copying (the page clipboard
 * needs document focus, which may sit in a widget frame) and preparing Codex
 * visualizations.
 */
export function registerWidgetIpc(): void {
  ipcMainHandle('widget:copy-text', (_event, text: unknown) => {
    clipboard.writeText(String(text ?? '').slice(0, 1_000_000));
    return true;
  });
  registerCodexVisualizationIpc();
}

/** Must run before `app` is ready. */
export function registerWidgetSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: WIDGET_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

export function installWidgetProtocol(): void {
  protocol.handle(WIDGET_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host === 'frame') {
      return new Response(WIDGET_SHELL_HTML, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': WIDGET_FRAME_CSP,
          'Cache-Control': 'no-store',
        },
      });
    }
    if (url.host === CODEX_VISUALIZATION_HOST) {
      const token = url.pathname.split('/').filter(Boolean)[0] ?? '';
      const document = renderCodexVisualization(token);
      if (document) {
        return new Response(document, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': CODEX_FRAME_CSP,
            'Cache-Control': 'no-store',
          },
        });
      }
    }
    if (url.host === 'lib') {
      const name = url.pathname.replace(/^\//, '') as WidgetLibraryName;
      const entry = LIBRARY_FILES[name];
      if (entry) {
        try {
          const body = await readLibrary(entry[0], entry[1]);
          return new Response(new Uint8Array(body), {
            headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=86400' },
          });
        } catch (error) {
          console.warn(`[widget] failed to load library ${name}:`, error);
        }
      }
    }
    return new Response('Not found', { status: 404 });
  });
}

/**
 * A widget frame stays on its shell: a script setting `location` (or a link
 * the shell didn't catch) must not turn the chat into an arbitrary web page.
 */
export function guardWidgetFrameNavigation(contents: WebContents): void {
  contents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return;
    const current = details.frame?.url ?? '';
    if (current.startsWith(`${WIDGET_SCHEME}:`) && !details.url.startsWith(`${WIDGET_SCHEME}:`)) {
      details.preventDefault();
    }
  });
}

// ── Shell ───────────────────────────────────────────────────────────────────

const BOOTSTRAP = String.raw`
(() => {
  const SOURCE = ${JSON.stringify(WIDGET_MESSAGE_SOURCE)};
  const PROMPT_MAX = ${WIDGET_PROMPT_MAX_CHARS};
  const STATE_MAX = ${WIDGET_STATE_MAX_CHARS};
  const root = document.getElementById('aegis-root');
  const post = (message) => parent.postMessage(Object.assign({ source: SOURCE }, message), '*');
  let state = null;
  let rendered = false;
  let previewing = false;

  // Actions that leave the widget need a real click or key press, so a widget
  // can't send messages or open pages on its own.
  const activated = () => !navigator.userActivation || navigator.userActivation.isActive;

  const aegis = {
    sendPrompt(text) {
      if (!activated()) { console.warn('aegis.sendPrompt needs a user click.'); return false; }
      const value = String(text ?? '').trim().slice(0, PROMPT_MAX);
      if (!value) return false;
      post({ type: 'prompt', text: value });
      return true;
    },
    openLink(url) {
      if (!activated()) { console.warn('aegis.openLink needs a user click.'); return false; }
      const value = String(url ?? '');
      if (!/^https?:\/\//i.test(value)) return false;
      post({ type: 'open-link', url: value });
      return true;
    },
    copy(text) {
      post({ type: 'copy', text: String(text ?? '') });
      return true;
    },
    getState() { return state; },
    setState(value) {
      let json;
      try { json = JSON.stringify(value ?? null); } catch { return false; }
      if (json.length > STATE_MAX) { console.warn('aegis.setState: state too large.'); return false; }
      state = JSON.parse(json);
      post({ type: 'state', state });
      return true;
    },
  };
  Object.defineProperty(window, 'aegis', { value: Object.freeze(aegis) });

  // The sandbox blocks the page clipboard; widgets often write the standard
  // calls anyway, so route them through the app.
  const copyThroughApp = (text) => { aegis.copy(text); return Promise.resolve(); };
  try {
    if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { value: copyThroughApp, configurable: true });
    else Object.defineProperty(navigator, 'clipboard', { value: { writeText: copyThroughApp }, configurable: true });
  } catch {}
  const execCommand = document.execCommand.bind(document);
  document.execCommand = (command, ...rest) => {
    if (String(command).toLowerCase() !== 'copy') return execCommand(command, ...rest);
    const active = document.activeElement;
    const text = active && (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)
      ? active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? active.value.length)
      : String(window.getSelection() || '');
    if (!text) return false;
    aegis.copy(text);
    return true;
  };
  // Common spelling in generative-UI prompts.
  window.sendPrompt = aegis.sendPrompt;

  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#')) return;
    event.preventDefault();
    aegis.openLink(link.href);
  }, true);

  const applyTheme = (theme) => {
    if (!theme) return;
    const style = document.documentElement.style;
    for (const [name, value] of Object.entries(theme.variables || {})) style.setProperty(name, value);
    document.documentElement.classList.toggle('dark', !!theme.dark);
    document.documentElement.style.colorScheme = theme.dark ? 'dark' : 'light';
    if (rendered) window.dispatchEvent(new CustomEvent('aegis-theme', { detail: { dark: !!theme.dark } }));
  };

  let lastHeight = -1;
  const reportSize = () => {
    // The empty shell's 0px would overwrite the widget's remembered height.
    if (!rendered && !previewing) return;
    // The root contains its absolutely positioned content (tooltips, labels),
    // so scrollHeight counts what spills out of the normal flow; missing it
    // leaves a few pixels to scroll, i.e. a scrollbar beside the widget.
    const height = Math.ceil(Math.max(root.scrollHeight, root.getBoundingClientRect().height));
    // A rendered widget never measures 0 except while its frame is torn down.
    if (height <= 0) return;
    if (height !== lastHeight) { lastHeight = height; post({ type: 'size', height }); }
  };
  new ResizeObserver(reportSize).observe(root);
  // Absolutely positioned content (a tooltip appearing, a label moving) changes
  // the page height without resizing the root.
  let sizeFrame = 0;
  new MutationObserver(() => {
    cancelAnimationFrame(sizeFrame);
    sizeFrame = requestAnimationFrame(reportSize);
  }).observe(root, { childList: true, subtree: true, attributes: true, characterData: true });

  const report = (message) => post({ type: 'error', message: String(message).slice(0, 500) });
  window.addEventListener('error', (event) => report(event.message || 'Script error'));
  window.addEventListener('unhandledrejection', (event) => report(event.reason && event.reason.message || event.reason || 'Unhandled rejection'));

  // The bundled libraries, and how a widget can need one without loading it:
  // models often forget the tag or point it at a CDN (blocked here).
  const LIBRARIES = {
    chart: { src: ${JSON.stringify(`${WIDGET_SCHEME}://lib/chart.js`)}, url: /(?:^|\/)chart(?:\.umd)?(?:\.min)?\.js(?:$|[?#])|\/chart\.js(?:@|\/|$)/, use: /\bnew\s+Chart\s*\(|\bChart\s*\.\s*(?:register|defaults|getChart)\b/ },
    d3: { src: ${JSON.stringify(`${WIDGET_SCHEME}://lib/d3.js`)}, url: /(?:^|\/)d3(?:@[^/]*)?(?:\/|\.min\.js|\.js|$)/, use: /\bd3\s*\.\s*[a-zA-Z]/ },
    echarts: { src: ${JSON.stringify(`${WIDGET_SCHEME}://lib/echarts.js`)}, url: /echarts/, use: /\becharts\s*\.\s*[a-zA-Z]/ },
  };
  const libraryForUrl = (src) => {
    const value = String(src || '').toLowerCase();
    if (!value || value.startsWith(${JSON.stringify(`${WIDGET_SCHEME}:`)})) return null;
    for (const [name, library] of Object.entries(LIBRARIES)) if (library.url.test(value)) return name;
    return null;
  };
  const load = (src) => new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => { report('Failed to load ' + src); resolve(); };
    document.head.appendChild(script);
  });

  // innerHTML leaves scripts inert; re-create them in order, waiting for each
  // library to load before the scripts that use it.
  const runScripts = async () => {
    const scripts = Array.from(root.querySelectorAll('script'));
    const loaded = new Set();
    for (const script of scripts) {
      const name = libraryForUrl(script.getAttribute('src'));
      if (name) script.setAttribute('src', LIBRARIES[name].src);
      if (script.getAttribute('src')) for (const [key, library] of Object.entries(LIBRARIES)) if (script.getAttribute('src') === library.src) loaded.add(key);
    }
    const inline = scripts.filter((script) => !script.getAttribute('src')).map((script) => script.textContent || '').join('\n');
    for (const [name, library] of Object.entries(LIBRARIES)) {
      if (!loaded.has(name) && library.use.test(inline)) await load(library.src);
    }
    for (const old of scripts) {
      const script = document.createElement('script');
      for (const attr of Array.from(old.attributes)) script.setAttribute(attr.name, attr.value);
      script.textContent = old.textContent;
      const pending = script.src ? new Promise((resolve) => { script.onload = resolve; script.onerror = () => { report('Failed to load ' + script.src); resolve(); }; }) : null;
      old.replaceWith(script);
      if (pending) await pending;
    }
  };

  window.addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const message = event.data;
    if (!message || message.source !== SOURCE) return;
    if (message.type === 'theme') { applyTheme(message.theme); return; }
    if (message.type === 'preview' && !rendered) {
      // Markup still being written: draw what has arrived, inert — scripts
      // and inline handlers wait for the finished call's render.
      if (!previewing) applyTheme(message.theme);
      previewing = true;
      const template = document.createElement('template');
      template.innerHTML = String(message.html || '');
      for (const script of Array.from(template.content.querySelectorAll('script'))) script.remove();
      for (const element of Array.from(template.content.querySelectorAll('*'))) {
        for (const attr of Array.from(element.attributes)) if (/^on/i.test(attr.name)) element.removeAttribute(attr.name);
      }
      // SVG labels and dots the script will place have no position yet and
      // would pile up in the corner at 0,0; they appear when it runs.
      for (const element of Array.from(template.content.querySelectorAll('svg text, svg circle, svg ellipse'))) {
        const [a, b] = element.localName === 'text' ? ['x', 'y'] : ['cx', 'cy'];
        if (element.hasAttribute(a) || element.hasAttribute(b) || element.querySelector('textPath')) continue;
        if (element.closest('[transform], defs, symbol, marker, pattern, clipPath, mask')) continue;
        element.setAttribute('visibility', 'hidden');
      }
      root.replaceChildren(template.content);
      reportSize();
      return;
    }
    if (message.type === 'render' && !rendered) {
      rendered = true;
      state = message.state ?? null;
      applyTheme(message.theme);
      root.innerHTML = String(message.html || '');
      reportSize();
      runScripts().then(() => {
        document.dispatchEvent(new Event('DOMContentLoaded'));
        window.dispatchEvent(new Event('load'));
        requestAnimationFrame(reportSize);
      });
    }
  });

  post({ type: 'ready' });
})();
`;

const WIDGET_SHELL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  /* The chat sizes the frame to the content; only a widget taller than the
     cap scrolls, and nothing scrolls sideways. */
  html { overflow-x: hidden; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--text-primary, #888) 25%, transparent) transparent; }
  body {
    color: var(--text-primary, #1f2328);
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif);
    font-size: 14px;
    line-height: 1.6;
    overflow-wrap: anywhere;
    -webkit-font-smoothing: antialiased;
  }
  /* The positioning container for absolutely positioned content, so its
     scrollHeight (what the chat sizes the frame to) includes it. */
  #aegis-root { display: flow-root; position: relative; }
  a { color: var(--accent, #2563eb); }
  code, pre { font-family: var(--font-mono, ui-monospace, Menlo, monospace); }
  svg { max-width: 100%; }
  canvas { max-width: 100%; }
</style>
<style>${WIDGET_DESIGN_CSS}</style>
</head>
<body>
${WIDGET_SVG_DEFS}
<div id="aegis-root"></div>
<script>${BOOTSTRAP}</script>
</body>
</html>`;
