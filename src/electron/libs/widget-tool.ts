import { z } from 'zod';
import * as vm from 'vm';
import { WIDGET_GUIDE_DESCRIPTION, WIDGET_GUIDE_TOPICS, widgetGuideText } from './widget-guide';
import {
  SHOW_WIDGET_TOOL,
  WIDGET_GUIDE_TOOL,
  WIDGET_HTML_MAX_CHARS,
  WIDGET_LIBRARIES,
  WIDGET_SCHEME,
  type ShowWidgetInput,
} from '../../shared/widget';

const libraryLines = Object.entries(WIDGET_LIBRARIES)
  .map(([name, label]) => `  <script src="${WIDGET_SCHEME}://lib/${name}"></script>  — ${label}`)
  .join('\n');

export const SHOW_WIDGET_DESCRIPTION = `Draw an interactive visual inline in this conversation: a chart, diagram, timeline, comparison, simulation or small working tool, written as an HTML fragment. The user sees and uses it right where your reply is.

Use it proactively — the user doesn't need to ask for a chart. Reach for it when seeing or playing with something explains the answer better than prose:
- quantities, trends, distributions, rankings, parts of a whole;
- how something works: a process, a sequence of states, a lifecycle, an algorithm stepping through data;
- structure and relationships: architecture, dependencies, hierarchies, flows between parts;
- "what if": an estimate or model whose inputs the user can change (loan, growth, capacity, pricing);
- side-by-side options the user is choosing between;
- a small tool the user wants to use now — a calculator, converter, generator, picker or checklist. When the user asks you to "make" such a tool without asking for files, build it here rather than in the project.

Don't use it when:
- a sentence, a list, a code block or a Markdown table already says it (a plain table request gets a Markdown table);
- the user wants a deliverable: a file, page, site, app, component or change to the project. Build that in the project instead; you may then show a preview here if it helps;
- it would only decorate the answer.
Never write files or start a server just to show something in the chat — this tool is the way to show it.

Before your first widget in a conversation, call widget_guide with the topics you need (chart, diagram, interactive, mockup) and follow it. Widgets come with a design system — pre-styled buttons, inputs and sliders; layout classes (.row, .grid, .metrics, .panel, .card); SVG classes (.t, .ts, .th, .box, .arr, .c-{ramp}); chart colors --series-1 to --series-8 — so write plain tags and use those rather than styling from scratch. Keep it flat and quiet: no gradients, shadows or emoji.

Content:
- One widget per idea, focused on the visual itself. To explain something in steps, draw several widgets with a short paragraph of your reply between them, rather than one widget with tabs. Put explanation, caveats and conclusions in your reply, not as paragraphs inside the widget, and don't announce the widget ("here is an interactive chart…") — refer to what it shows.
- Data must come from this conversation, your tools, or clearly labelled assumptions; never invent figures. Label estimates as estimates.
- Nothing appears until the whole call is written, so keep it compact: inline only the data the visual needs.

How it renders:
- A sandboxed frame as wide as the chat column (about 640–760px, narrower when a side panel is open, down to 320px). Lay out with %, flex or grid and size SVG/canvas from their container (redraw on resize); never a fixed page width.
- Height follows the content; very tall widgets are capped (about one screen) and scroll inside.
- Write a fragment, not a document (no <html>/<head>/<body>): a short <style>, markup, then <script> last. The chat draws the markup as you write it; scripts run in order once the call is complete.
- No network: fetch, external images, fonts and CDNs are blocked. Put data inline. Only these bundled libraries load:
${libraryLines}
  Hand-written SVG is often enough for simple charts and diagrams.

Theme — keep the background transparent and color everything with the app's variables, which follow light/dark:
- text: --text-primary, --text-secondary, --text-muted; surfaces: --bg-secondary, --bg-tertiary; lines: --border;
- emphasis: --accent (with --accent-foreground on it); status: --success, --warning, --error;
- type: --font-sans, --font-mono.
Libraries that draw on canvas can't read CSS variables: resolve them with getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), and redraw on the window's 'aegis-theme' event. Never hard-code a light or dark palette.

Interaction:
- Keep presentation interactions local: sliders, toggles, tabs, hover details, sorting and filtering run inside the widget.
- aegis.sendPrompt(text) sends text as the user's next message, for steps that need you (drill into a selection, explain a point, recalculate something you must look up). Include the selected values in the text, label the control clearly, and call it only from a user's click.
- aegis.openLink(url) opens an http(s) link in the app's browser. aegis.copy(text) copies (navigator.clipboard also works).
- aegis.getState() / aegis.setState(value) keep small JSON (selected tab, slider values) across scrolling away and reloads; restore it when the widget starts.

Quality:
- Label axes, units and the important values directly; keep text at 11px or larger and never let labels overlap or clip.
- Use native buttons, inputs and selects with visible labels; give charts an accessible name (aria-label or SVG <title>).
- Check the script before sending: no undefined identifiers, every element it queries exists, and the main interaction updates the visual.
- At most ${WIDGET_HTML_MAX_CHARS.toLocaleString('en-US')} characters.`;

export const showWidgetSchema = {
  title: z.string().max(120).optional().describe('Short name for the widget, e.g. "Monthly revenue by region".'),
  html: z.string().min(1).describe('The widget as an HTML fragment: <style>, markup and <script>, themed with the app CSS variables.'),
};

export const SHOW_WIDGET_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['html'],
  properties: {
    title: { type: 'string', maxLength: 120, description: 'Short name for the widget, e.g. "Monthly revenue by region".' },
    html: { type: 'string', description: 'The widget as an HTML fragment: <style>, markup and <script>, themed with the app CSS variables.' },
  },
};

export const showWidgetAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/**
 * The first syntax error in the widget's classic inline scripts, or null. A
 * broken script would leave a half-drawn widget the agent never hears about;
 * compiling here (without running) lets it fix the widget and call again.
 */
export function findWidgetScriptSyntaxError(html: string): string | null {
  let index = 0;
  for (const match of html.matchAll(SCRIPT_TAG)) {
    index += 1;
    const attributes = match[1] || '';
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1]?.toLowerCase();
    if (type && !/^(?:text|application)\/(?:javascript|ecmascript)$/.test(type)) continue;
    const filename = `script-${index}.js`;
    try {
      new vm.Script(match[2], { filename });
    } catch (error) {
      if (!(error instanceof SyntaxError)) continue;
      const line = new RegExp(`${filename.replace('.', '\\.')}:(\\d+)`).exec(error.stack ?? '')?.[1];
      return `script ${index}${line ? `, line ${line}` : ''}: ${error.message}`;
    }
  }
  return null;
}

/**
 * The chat draws the widget from this call's input; the tool validates it and
 * tells the agent it is on screen (or why it isn't).
 */
export async function showWidgetTool(args: Partial<ShowWidgetInput>): Promise<ToolResult> {
  const html = typeof args?.html === 'string' ? args.html : '';
  if (!html.trim()) {
    return { content: [{ type: 'text', text: 'The widget is empty: pass its HTML in `html`.' }], isError: true };
  }
  if (html.length > WIDGET_HTML_MAX_CHARS) {
    return {
      content: [{ type: 'text', text: `The widget is ${html.length} characters; the limit is ${WIDGET_HTML_MAX_CHARS}. Simplify it or move bulky data into a compact form.` }],
      isError: true,
    };
  }
  const syntaxError = findWidgetScriptSyntaxError(html);
  if (syntaxError) {
    return {
      content: [{ type: 'text', text: `The widget was not shown: ${syntaxError}. Fix the script and call show_widget again with the whole widget.` }],
      isError: true,
    };
  }
  const external = /<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i.exec(html);
  const note = external
    ? ' Note: it references an external URL, which the widget sandbox blocks (no network) — inline the data or use a bundled library.'
    : '';
  return { content: [{ type: 'text', text: `Widget shown to the user inline in the conversation.${note}` }] };
}

export { SHOW_WIDGET_TOOL };

// ── widget_guide ────────────────────────────────────────────────────────────

export { WIDGET_GUIDE_DESCRIPTION, WIDGET_GUIDE_TOOL };

export const widgetGuideSchema = {
  topics: z.array(z.enum(WIDGET_GUIDE_TOPICS)).optional()
    .describe('Which parts to include besides the core rules: chart, diagram, interactive, mockup.'),
};

export const WIDGET_GUIDE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    topics: {
      type: 'array',
      items: { type: 'string', enum: [...WIDGET_GUIDE_TOPICS] },
      description: 'Which parts to include besides the core rules: chart, diagram, interactive, mockup.',
    },
  },
};

export async function widgetGuideTool(args: { topics?: string[] } = {}): Promise<ToolResult> {
  const topics = Array.isArray(args?.topics) ? args.topics.filter((topic) => typeof topic === 'string') : [];
  return { content: [{ type: 'text', text: widgetGuideText(topics) }] };
}
