// Codex's own inline visualizations. GPT models with OpenAI's bundled
// `visualize` plugin answer with an HTML fragment written to a file plus a
// content reference in the reply (`visualize{"path":…}`),
// which the Codex app renders inline. Aegis renders the same reference the
// same way: the fragment inside the plugin's own runtime (read from the
// user's Codex install at run time, never bundled here), in a sandboxed
// frame served from aegis-widget://codex/<token>/, with Aegis's theme, state
// and actions behind `window.openai`. The user's Codex setup is untouched.

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ipcMainHandle } from './util';
import { WIDGET_MESSAGE_SOURCE, WIDGET_PROMPT_MAX_CHARS, WIDGET_SCHEME } from '../shared/widget';

export const CODEX_VISUALIZATION_HOST = 'codex';
const FRAGMENT_PLACEHOLDER = '<!--__INLINE_VISUALIZATION_FRAGMENT__-->';
const MAX_FRAGMENT_BYTES = 1_000_000;
const MAX_STATE_BYTES = 16 * 1024;
const MAX_PREPARED = 200;
const DOCUMENT_MARKUP = /<!doctype\s|<\s*(?:html|head|body)(?:\s|>)/i;

// The plugin runtime's own policy: its CDN allowlist for scripts, styles and
// fonts; no fetch/XHR beyond blob:/data:.
const RESOURCE_SOURCES = [
  'blob:', 'data:',
  'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://esm.sh',
  'https://fonts.bunny.net', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://unpkg.com',
].join(' ');
export const CODEX_FRAME_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${RESOURCE_SOURCES}`,
  `style-src 'unsafe-inline' ${RESOURCE_SOURCES}`,
  `img-src ${RESOURCE_SOURCES}`,
  `font-src ${RESOURCE_SOURCES}`,
  `media-src ${RESOURCE_SOURCES}`,
  'worker-src blob:',
  'connect-src blob: data:',
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export interface PrepareCodexVisualizationInput {
  path: string;
  /** Folders the reference may point into (the session's project, worktree). */
  roots: string[];
  /** Host style variables (`--color-background-primary` …) and light/dark. */
  styleVariables: Record<string, string>;
  dark: boolean;
  /** Saved `window.openai.widgetState`, if any. */
  state: unknown;
  title?: string;
}

export type PrepareCodexVisualizationResult = { ok: true; url: string } | { ok: false; message: string };

interface Prepared {
  path: string;
  styleVariables: Record<string, string>;
  dark: boolean;
  state: unknown;
  title: string;
}

const prepared = new Map<string, Prepared>();

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The newest installed copy of the plugin's runtime assets, or null. */
export function findVisualizeRuntime(home = codexHome()): string | null {
  const base = path.join(home, 'plugins', 'cache', 'openai-bundled', 'visualize');
  let versions: string[];
  try {
    versions = fs.readdirSync(base).filter((name) => /^\d+(?:\.\d+)*$/.test(name));
  } catch {
    return null;
  }
  for (const version of versions.sort(compareVersions).reverse()) {
    const assets = path.join(base, version, 'skills', 'visualize', 'assets');
    if (fs.existsSync(path.join(assets, 'visualize.css')) && fs.existsSync(path.join(assets, 'visualize.html'))) return assets;
  }
  return null;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realRoot(root: string): string | null {
  try {
    return fs.realpathSync(root);
  } catch {
    return null;
  }
}

/** The fragment a reference points at: an .html file in an allowed folder, ≤ 1 MB, a fragment. */
export function readFragment(filePath: string, roots: string[]): { ok: true; path: string; html: string } | { ok: false; message: string } {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !/\.html?$/i.test(filePath)) {
    return { ok: false, message: 'The visualization path is not an absolute .html file.' };
  }
  let real: string;
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) return { ok: false, message: 'The visualization file is a symbolic link.' };
    real = fs.realpathSync(filePath);
  } catch {
    return { ok: false, message: 'The visualization file no longer exists.' };
  }
  const allowed = [...roots, codexHome()].map(realRoot).filter((root): root is string => Boolean(root));
  if (!allowed.some((root) => isInside(real, root))) {
    return { ok: false, message: 'The visualization file is outside this session’s project.' };
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) return { ok: false, message: 'The visualization path is not a file.' };
  if (stat.size > MAX_FRAGMENT_BYTES) return { ok: false, message: 'The visualization is larger than 1 MB.' };
  const html = fs.readFileSync(real, 'utf8');
  if (DOCUMENT_MARKUP.test(html)) return { ok: false, message: 'The visualization is a full HTML document, not a fragment.' };
  return { ok: true, path: real, html };
}

export function prepareCodexVisualization(input: PrepareCodexVisualizationInput): PrepareCodexVisualizationResult {
  if (!findVisualizeRuntime()) {
    return { ok: false, message: 'Codex’s Visualize plugin is not installed, so this visualization can’t be shown.' };
  }
  const roots = Array.isArray(input?.roots) ? input.roots.filter((root) => typeof root === 'string' && path.isAbsolute(root)) : [];
  const fragment = readFragment(input?.path, roots);
  if (!fragment.ok) return fragment;
  let state: unknown = null;
  try {
    const serialized = JSON.stringify(input.state ?? null);
    if (serialized.length <= MAX_STATE_BYTES) state = JSON.parse(serialized);
  } catch {}
  const styleVariables: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.styleVariables ?? {})) {
    if (/^--[a-z0-9-]+$/i.test(name) && typeof value === 'string' && !/[;{}<>]/.test(value)) styleVariables[name] = value;
  }
  const token = randomUUID();
  prepared.set(token, {
    path: fragment.path,
    styleVariables,
    dark: input.dark === true,
    state,
    title: typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 200) : path.basename(fragment.path, path.extname(fragment.path)),
  });
  while (prepared.size > MAX_PREPARED) prepared.delete(prepared.keys().next().value!);
  return { ok: true, url: `${WIDGET_SCHEME}://${CODEX_VISUALIZATION_HOST}/${token}/index.html` };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function inlineScript(source: string): string {
  return `<script>${source.replace(/<\/script/gi, '<\\/script')}</script>`;
}

/** The frame document for a prepared token (the fragment read fresh), or null. */
export function renderCodexVisualization(token: string): string | null {
  const entry = prepared.get(token);
  const assets = findVisualizeRuntime();
  if (!entry || !assets) return null;
  const fragment = readFragment(entry.path, [path.dirname(entry.path)]);
  if (!fragment.ok) return null;
  const stylesheet = fs.readFileSync(path.join(assets, 'visualize.css'), 'utf8');
  const kit = fs.readFileSync(path.join(assets, 'visualize.html'), 'utf8');
  const calendarFile = path.join(assets, 'calendar.js');
  const calendar = /\bviz-calendar\b/i.test(fragment.html) && fs.existsSync(calendarFile)
    ? inlineScript(fs.readFileSync(calendarFile, 'utf8'))
    : '';
  const rootStyle = Object.entries(entry.styleVariables).map(([name, value]) => `${name}:${value}`).join(';');
  const initial = JSON.stringify({ state: entry.state, dark: entry.dark, styleVariables: entry.styleVariables }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en" data-theme="${entry.dark ? 'dark' : 'light'}" style="${escapeHtml(rootStyle)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(entry.title)}</title>
<style>${stylesheet}
html>body{padding:0;position:relative}html{overflow-x:hidden}</style>
</head>
<body>
<script type="application/json" id="aegis-codex-initial">${initial}</script>
${inlineScript(CODEX_BRIDGE)}
${kit.replace(FRAGMENT_PLACEHOLDER, () => calendar + fragment.html)}
</body>
</html>`;
}

export function registerCodexVisualizationIpc(): void {
  ipcMainHandle('widget:prepare-codex-visualization', (_event, input: PrepareCodexVisualizationInput) => prepareCodexVisualization(input));
}

// `window.openai` for the plugin runtime, wired to Aegis over the widget
// bridge (see shared/widget.ts). Runs before the fragment.
const CODEX_BRIDGE = String.raw`
(() => {
  const SOURCE = ${JSON.stringify(WIDGET_MESSAGE_SOURCE)};
  const PROMPT_MAX = ${WIDGET_PROMPT_MAX_CHARS};
  const STATE_MAX = ${MAX_STATE_BYTES};
  const root = document.documentElement;
  const initialElement = document.getElementById('aegis-codex-initial');
  const initial = JSON.parse(initialElement?.textContent || '{}');
  initialElement?.remove();
  const post = (message) => parent.postMessage(Object.assign({ source: SOURCE }, message), '*');
  const activated = () => !navigator.userActivation || navigator.userActivation.isActive;
  let state = initial.state && typeof initial.state === 'object' ? initial.state : null;
  let styleVariables = initial.styleVariables || {};
  let theme = initial.dark ? 'dark' : 'light';

  const openExternal = ({ href } = {}) => {
    if (!activated() || !/^https?:\/\//i.test(String(href || ''))) return;
    post({ type: 'open-link', url: String(href) });
  };
  const sendFollowUpMessage = ({ prompt } = {}) => {
    const text = String(prompt || '').trim().slice(0, PROMPT_MAX);
    if (activated() && text) post({ type: 'prompt', text });
    return Promise.resolve();
  };
  const setWidgetState = async (next) => {
    const value = typeof next === 'function' ? next(state) : next;
    if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Widget state must be a JSON object');
    const stored = Object.assign({ modelContent: null, privateContent: null }, JSON.parse(JSON.stringify(value)));
    const serialized = JSON.stringify(stored);
    if (new TextEncoder().encode(serialized).length > STATE_MAX) throw new TypeError('Widget state must be a JSON object of at most 16 KiB');
    state = stored;
    window.openai.widgetState = state;
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { widgetState: state } } }));
    post({ type: 'state', state });
  };
  const publish = () => {
    window.openai = Object.assign(window.openai || {}, {
      openExternal, sendFollowUpMessage, setWidgetState,
      theme, visualizationTheme: theme, visualizationStyleVariables: styleVariables,
      widgetState: state, statePersistence: 'persistent', stateModelContext: 'none',
    });
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: window.openai } }));
  };
  const applyTheme = (next) => {
    if (!next) return;
    theme = next.dark ? 'dark' : 'light';
    styleVariables = next.styleVariables || styleVariables;
    root.dataset.theme = theme;
    for (const [name, value] of Object.entries(styleVariables)) root.style.setProperty(name, value);
    publish();
  };
  publish();

  // The sandbox blocks the page clipboard; route the standard calls through the app.
  const copy = (text) => { post({ type: 'copy', text: String(text ?? '') }); return Promise.resolve(); };
  try {
    if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { value: copy, configurable: true });
    else Object.defineProperty(navigator, 'clipboard', { value: { writeText: copy }, configurable: true });
  } catch {}
  const execCommand = document.execCommand.bind(document);
  document.execCommand = (command, ...rest) => {
    if (String(command).toLowerCase() !== 'copy') return execCommand(command, ...rest);
    const active = document.activeElement;
    const text = active && (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)
      ? active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? active.value.length)
      : String(window.getSelection() || '');
    if (!text) return false;
    copy(text);
    return true;
  };

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link || (link.getAttribute('href') || '').startsWith('#')) return;
    event.preventDefault();
    openExternal({ href: link.href });
  }, true);

  const report = (message) => post({ type: 'error', message: String(message).slice(0, 500) });
  window.addEventListener('error', (event) => { if (event.message) report(event.message); });
  window.addEventListener('unhandledrejection', (event) => report((event.reason && event.reason.message) || event.reason || 'Unhandled rejection'));

  let lastHeight = -1;
  const reportSize = () => {
    const body = document.body;
    if (!body) return;
    const height = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height));
    if (height !== lastHeight) { lastHeight = height; post({ type: 'size', height }); }
  };
  const observe = () => { reportSize(); new ResizeObserver(reportSize).observe(document.body); };
  if (document.body) observe(); else document.addEventListener('DOMContentLoaded', observe);

  window.addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const message = event.data;
    if (!message || message.source !== SOURCE) return;
    if (message.type === 'codex-theme') applyTheme(message.theme);
  });
  post({ type: 'ready' });
})();
`;
