// Generative UI: an agent answers with a small interactive HTML widget that
// renders inline in the conversation (sandboxed, themed, no network).
//
// The agent calls `show_widget` with the widget's HTML. The tool itself only
// acknowledges; the chat renders the widget from the tool call's own input, so
// a widget replays from history exactly as it was drawn.

export const SHOW_WIDGET_TOOL = 'show_widget';
/** Companion tool: the design guide, loaded before drawing. */
export const WIDGET_GUIDE_TOOL = 'widget_guide';

/** Upper bound on one widget's HTML (the tool rejects anything larger). */
export const WIDGET_HTML_MAX_CHARS = 200_000;

/** Custom scheme serving the widget shell and the bundled libraries. */
export const WIDGET_SCHEME = 'aegis-widget';
export const WIDGET_FRAME_URL = `${WIDGET_SCHEME}://frame/index.html`;

/** Libraries a widget can load with `<script src="aegis-widget://lib/<name>">`. */
export const WIDGET_LIBRARIES = {
  'chart.js': 'Chart.js 4 (global `Chart`)',
  'd3.js': 'D3 7 (global `d3`)',
  'echarts.js': 'ECharts 6 (global `echarts`)',
} as const;
export type WidgetLibraryName = keyof typeof WIDGET_LIBRARIES;

export interface ShowWidgetInput {
  title?: string;
  html: string;
}

/** Tool names arrive bare (`show_widget`) or namespaced by the MCP server
 * (`mcp__aegis-sessions__show_widget`, `aegis-sessions_show_widget`, …). */
export function isShowWidgetToolName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const normalized = name.trim().toLowerCase();
  return normalized === SHOW_WIDGET_TOOL || /[_./:-]show_widget$/.test(normalized);
}

export function isWidgetGuideToolName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const normalized = name.trim().toLowerCase();
  return normalized === WIDGET_GUIDE_TOOL || /[_./:-]widget_guide$/.test(normalized);
}

/** The widget a show_widget call drew, or null when its input isn't one. */
export function widgetFromToolInput(input: unknown): ShowWidgetInput | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const html = typeof record.html === 'string' ? record.html : '';
  if (!html.trim()) return null;
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : undefined;
  return { html, ...(title ? { title } : {}) };
}

// ── Bridge between the chat and a widget frame (postMessage) ───────────────

export const WIDGET_MESSAGE_SOURCE = 'aegis-widget';

/** Chat → widget. */
export type WidgetHostMessage =
  | { source: typeof WIDGET_MESSAGE_SOURCE; type: 'render'; html: string; theme: WidgetTheme; state: unknown }
  /** The markup of a call still being written (or not yet accepted): drawn, scripts not run. Repeatable until `render`. */
  | { source: typeof WIDGET_MESSAGE_SOURCE; type: 'preview'; html: string; theme: WidgetTheme }
  | { source: typeof WIDGET_MESSAGE_SOURCE; type: 'theme'; theme: WidgetTheme }
  /** Codex visualizations: host style variables for OpenAI's plugin runtime. */
  | { source: typeof WIDGET_MESSAGE_SOURCE; type: 'codex-theme'; theme: CodexVisualizationTheme };

/** Widget → chat. */
export type WidgetFrameMessage =
  | { source: typeof WIDGET_MESSAGE_SOURCE; type: 'ready' }
  | { source: typeof WIDGET_MESSAGE_SOURCE; type: 'size'; height: number }
  | { source: typeof WIDGET_MESSAGE_SOURCE; type: 'prompt'; text: string }
  | { source: typeof WIDGET_MESSAGE_SOURCE; type: 'open-link'; url: string }
  | { source: typeof WIDGET_MESSAGE_SOURCE; type: 'copy'; text: string }
  | { source: typeof WIDGET_MESSAGE_SOURCE; type: 'state'; state: unknown }
  | { source: typeof WIDGET_MESSAGE_SOURCE; type: 'error'; message: string };

export interface CodexVisualizationTheme {
  dark: boolean;
  styleVariables: Record<string, string>;
}

/** A Codex `visualize` content reference in an assistant reply. */
export interface CodexVisualizationReference {
  path: string;
  title?: string;
  mode?: string;
}

export interface WidgetTheme {
  /** CSS custom properties (`--text-primary` …) as the app currently has them. */
  variables: Record<string, string>;
  dark: boolean;
}

/** Saved widget state (`aegis.setState`) is capped so one widget can't bloat storage. */
export const WIDGET_STATE_MAX_CHARS = 50_000;
/** Prompts a widget sends are capped, like anything a page could type. */
export const WIDGET_PROMPT_MAX_CHARS = 4_000;
