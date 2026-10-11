// widget_guide: the design guidance for show_widget, loaded on demand so the
// always-present tool description stays short. The core section always comes
// back; topics add depth for the kind of widget being drawn. Every class and
// variable named here exists in widget-design-system.ts.

import { WIDGET_RAMPS, WIDGET_SERIES } from '../widget-design-system';
import { WIDGET_LIBRARIES, WIDGET_SCHEME } from '../../shared/widget';

export const WIDGET_GUIDE_TOPICS = ['chart', 'diagram', 'interactive', 'mockup'] as const;
export type WidgetGuideTopic = (typeof WIDGET_GUIDE_TOPICS)[number];

const ramps = Object.keys(WIDGET_RAMPS).join(', ');
const series = WIDGET_SERIES.map(([name], index) => `${index + 1} ${name}`).join(', ');
const libraries = Object.entries(WIDGET_LIBRARIES)
  .map(([name, label]) => `\`<script src="${WIDGET_SCHEME}://lib/${name}"></script>\` (${label})`)
  .join('; ');

const CORE = `# Widget guide

How to make a show_widget widget look and read like part of the reply.

## Principles
- Part of the reply, not a page inside it: transparent background, no outer card, no title banner. The chat's prose carries the explanation — headings, intros, captions and conclusions go in your reply text, not inside the widget.
- Flat and quiet: no gradients, shadows, glows, textures or emoji. Two font weights only (400 and 500). Sentence case for labels and buttons. Text no smaller than 12px (11px only for dense axis ticks).
- Restraint: one accent for the thing that matters, everything else neutral. At most two color ramps in one visual. Color carries meaning — a category, an intensity, a status — never decoration, never a rainbow sequence. When unsure, choose the quieter option.
- One idea per widget. To explain something in steps, draw several widgets with a short paragraph of reply text between each (show_widget → paragraph → show_widget); the chat keeps that text beside the widgets. Prefer this to one widget with tabs. Never promise a visual you don't draw.
- Compact: show the essential on first render; details come on hover, click or in your text.
- Round every number that reaches the screen (toFixed, Math.round, Intl.NumberFormat), including slider readouts and tooltips.
- Fluid width: the widget is as wide as the chat column (about 680px; down to 320px). Use %, flex and grid; SVG uses viewBox="0 0 680 H" with width="100%" so 1 unit = 1px.

## Already styled — write plain tags
- Controls: <button> (outlined; class "primary" for the single main action; aria-pressed="true" or class "selected" for an active toggle; class "ghost" for a borderless one), text/number inputs, <select>, <textarea>, range sliders, checkboxes, color inputs. Don't restyle them; set only width or layout.
- Text: h1–h3 (500 weight; use one short heading at most, often none), p, .small, .secondary, .muted, .tabular (aligned digits), .mono.
- Layout: .row (wrapping flex row), .stack (vertical gap), .grid (auto-fit columns), .panel (quiet filled area), .card (raised: hairline border, 12px radius — only for a bounded object like a record or an option).
- Numbers: .metrics containing .metric elements, each with .label, .value and optional .delta — a row of headline figures.
- Charts: .chart (relative wrapper, 280px tall — size the wrapper, never the canvas), .legend with .swatch squares, .tooltip.
- .badge for a small status or category chip; .tint-{ramp} for a tinted chip or cell.
- A table of data belongs in your reply as Markdown; use <table> inside a widget only when it is part of the interaction.

## Tokens (CSS variables; all follow the app's light/dark theme)
- Text: --text-primary, --text-secondary (supporting copy), --text-muted (captions, ticks); roles --text-accent, --text-success, --text-warning, --text-danger.
- Surfaces: --surface-0 (the chat background), --surface-1 (quiet fill), --surface-2 (raised); role tints --bg-accent, --bg-success, --bg-warning, --bg-danger.
- Lines: --border (hairline), --border-strong, --border-accent; for charts --grid and --axis.
- Shape: --radius (8px; 12px for cards), --gap-sm / --gap-md / --gap-lg, --font-sans, --font-mono.
- Color ramps ${ramps}, stops 50, 100, 200, 400, 600, 800, 900 (light → dark) as --{ramp}-{stop}. These are fixed colors: use them through the ramp classes, which switch for dark mode:
  - .c-{ramp} on an SVG rect/circle/ellipse/polygon, or on the <g> that directly holds them and their text: 50 fill, 600 stroke, text at 800 (.t, .th) or 600 (.ts). Dark mode uses 800 fill, 200 stroke, 100/200 text.
  - .tint-{ramp} on HTML: tinted background with matching dark text.
  - Text on a colored fill always uses the same ramp's dark stop — never black or gray.
- Chart series: --series-1 … --series-8 (${series}). Use them in this fixed order; color follows the entity, so filtering or sorting never repaints a series.

## Runtime
- Write a fragment: <style> (short) → markup → <script> last. The chat draws the markup while you are still writing it, so the reader watches the widget take shape; scripts run in order once the call is complete. Put the structure, labels and numbers in the markup (styled with the design-system classes) rather than building them from script, and give SVG shapes and labels their starting coordinates in the markup even when the script moves them, so the widget reads well before the script runs.
- No network. Bundled libraries: ${libraries}. A missing tag is added automatically, but include it. Hand-written SVG is often clearer than a library for simple visuals.
- aegis.sendPrompt(text) — only from a click; include the selected values; mark the control with ↗ (e.g. "Explain this step ↗").
- aegis.openLink(url), aegis.copy(text) (navigator.clipboard also works), aegis.getState() / aegis.setState(json) to restore UI state.
- Theme: CSS variables update by themselves. Canvas libraries can't read variables — resolve them when drawing (getComputedStyle(document.documentElement).getPropertyValue('--series-1').trim()) and redraw on window's 'aegis-theme' event.
- Never position: fixed (the frame sizes to its content), no nested scrolling, no fullscreen APIs.

## Before you call show_widget
- Every label fits its space and nothing overlaps or clips; numbers are rounded; units are shown.
- The script has no undefined identifiers, every element it queries exists, and the main interaction updates the visual.
- Interactive elements are native controls with visible labels; the visual has an accessible name (aria-label, or SVG <title>).`;

const CHART = `## Charts

Pick the form before any color:
- One or a few headline numbers → a .metrics row, not a chart. A ratio against a limit → a bar meter.
- Compare sizes → bars (horizontal when labels are long). Trend over time → a line (an area for a single series). Part of a whole → a stacked bar. Before → after → a dumbbell. One series is the point → highlight it in --series-1 and draw the rest in --text-muted.
- More than 8 series → fold the tail into "Other" or use small multiples. Never two y-axes; never a pie with many slices.

Chart.js recipe:
\`\`\`html
<div class="legend" id="legend"></div>
<div class="chart"><canvas id="c" role="img" aria-label="GDP 2024 by city, trillion yuan"></canvas></div>
<script src="${WIDGET_SCHEME}://lib/chart.js"></script>
<script>
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let chart;
function draw() {
  chart?.destroy();
  chart = new Chart(document.getElementById('c'), {
    type: 'bar',
    data: { labels: ['Shanghai', 'Beijing'], datasets: [{ data: [5.39, 4.98], backgroundColor: css('--series-1'), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 32 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.parsed.y.toFixed(2) + ' trillion' } } },
      scales: {
        x: { grid: { display: false }, border: { color: css('--axis') }, ticks: { color: css('--text-secondary'), font: { family: css('--font-sans'), size: 12 } } },
        y: { grid: { color: css('--grid') }, border: { display: false }, ticks: { color: css('--text-muted'), font: { size: 11 } }, title: { display: true, text: 'Trillion yuan', color: css('--text-muted') } },
      },
    },
  });
}
draw();
addEventListener('aegis-theme', draw);
</script>
\`\`\`
- Turn the built-in legend off; for 2+ series build an HTML .legend (swatch + name + value) above the chart. A single series needs no legend — the axis title names it.
- Marks: bars ≤ 32px thick with rounded value ends; lines 2px with no point dots until hover; areas at ~12% opacity of their series color.
- Gridlines horizontal only, in --grid; no vertical gridlines on a time axis. Ticks in --text-muted at 11–12px.
- Values, labels and legend text stay in text colors; only the marks and swatches carry series colors.
- Label the important values directly (end of a line, top of a bar) when there are few of them.
- ≤ 12 categories: show every label (ticks.autoSkip: false, maxRotation: 0 or 45).
- Negative currency is "-$5M", not "$-5M".

D3 or SVG charts: measure the container, set viewBox from its width, redraw on resize (ResizeObserver) and on 'aegis-theme'. Keep axes in --axis, gridlines in --grid, labels in .ts. Reserve at least 48px for y-axis labels.`;

const DIAGRAM = `## Diagrams (SVG)

Choose by what the user wants to do:
- Follow a process ("what are the steps") → flowchart: boxes in one direction (top-down or left-right), 4–5 nodes at most per diagram.
- See what contains what ("how is it organised") → structural: large rounded containers holding smaller regions.
- Get an intuition ("how does X work", "I don't get X") → illustrative: draw the mechanism itself — a tank with heat rising, a ball rolling down a slope, packets in flight. Prefer an interactive version when the real thing has a control.
- A cycle (event loop, Krebs cycle) → an HTML stepper with Next/Back and position dots, not stages around a ring.
Too many parts for one picture → an overview first, then one diagram per sub-flow, with reply text between them.

Setup:
\`\`\`html
<svg width="100%" viewBox="0 0 680 260" role="img">
  <title>Request flow</title>
  <g class="c-blue node" onclick="aegis.sendPrompt('Explain the load balancer step')">
    <rect x="40" y="40" width="160" height="56" rx="8" stroke-width="0.5"/>
    <text class="th" x="120" y="62" text-anchor="middle" dominant-baseline="central">Load balancer</text>
    <text class="ts" x="120" y="80" text-anchor="middle" dominant-baseline="central">Spreads traffic</text>
  </g>
  <line class="arr" x1="200" y1="68" x2="258" y2="68"/>
  <rect class="box" x="260" y="40" width="160" height="56" rx="8"/>
  <text class="t" x="340" y="68" text-anchor="middle" dominant-baseline="central">App server</text>
</svg>
\`\`\`
- The arrow marker is already defined: \`.arr\` lines get it automatically (or use marker-end="url(#arrow)"). Curved or bent connectors need fill="none".
- Text: only .t / .th (14px) and .ts (12px). Every <text> has a class. Use text-anchor="middle" and dominant-baseline="central" with y at the center of its slot.
- Box width comes from its longest label: about 8px per Latin character and 14px per CJK character at 14px, plus 24px padding each side. Two-line boxes are 56px tall, one-line 44px. Keep 40–60px between boxes.
- Lines stop at box edges and never cut through another box or label — route around with an L-shaped path. Arrow labels are rarely needed; put meaning in the box subtitle.
- Everything stays inside x 20–660; set the viewBox height to the lowest element plus 24px.
- Color by category with .c-{ramp} (gray for neutral steps), 2–3 ramps per diagram. Prefer purple, teal, coral and pink for categories; keep blue, green, amber and red for info, success, warning and error meanings.
- Containers: outer rx 16–20 in a 50-stop ramp class, inner regions rx 8–12 in a related ramp; 20px padding inside every container.
- Make nodes clickable (class "node" with aegis.sendPrompt) when there is more to say about them.

Illustrative scenes:
- Simple silhouettes from primitives (rects, circles, short paths) — a schematic, not a painting. If a path needs more than ~6 segments, simplify.
- Physical things (sky, grass, water, metal) use fixed, muted natural colors chosen once — low saturation, like a textbook figure — and don't flip in dark mode. Abstract things use the ramp classes.
- Use color for intensity: warm for heat or activity, cool for calm, gray for inert structure.
- Labels go in a clear margin (pick one side, usually the right) with .leader lines to what they name; a stroke never crosses text.
- One linear gradient is allowed, only for a continuous physical quantity (temperature through a tank). No other gradients.
- Motion: CSS transforms/opacity or requestAnimationFrame, short and purposeful (flow, rotation, falling) — it shows how the thing behaves.`;

const INTERACTIVE = `## Interactive explainers and tools

Layout, top to bottom:
1. Controls in a .row: a label, the control, and its live value (\`<label>Rate</label> <input type="range" min="0" max="10" step="0.5"> <span class="tabular">4.5%</span>\`).
2. One dominant visual (chart, SVG scene or simulation).
3. A .metrics row for the two or three numbers that change — only when they are the point.
No card around the whole widget: whitespace is the container.

- The first render already shows something meaningful (sensible defaults, the interesting state).
- Only the controls the idea needs. One mechanism per state; no invented reset, search or filter controls.
- Interactions that only change the view (sliders, toggles, hover, sorting, filtering) run in the widget. Use aegis.sendPrompt only when the next step needs you, and label it with ↗.
- Step-throughs: a stepper — Back / Next buttons, a position indicator (● ○ ○) and one panel showing the current step — rather than tabs. Steps that should be read in order are better as separate widgets with your text between them.
- Animation and simulation: requestAnimationFrame with real elapsed time; animate transform and opacity; keep loops short; stop when finished. CSS animations are switched off automatically for users who ask for reduced motion; for requestAnimationFrame loops, check matchMedia('(prefers-reduced-motion: reduce)') and jump to the end state. Show physical quantities with units and rounded values.
- Validate input: when a control needs a value, show a short inline message in --text-danger next to it instead of proceeding.
- Restore what the user set with aegis.getState() on start; save it with aegis.setState() after meaningful changes (not on every frame).
- Buttons are verbs in sentence case ("Cut the stem", "Reset"). The main action may use class "primary"; everything else stays outlined.`;

const MOCKUP = `## UI mockups

- A mockup shows the user's product, not this chat: define its own colors, typography and surfaces at the mockup's root and don't use the widget classes or tokens inside it (no .card, .metric or --surface-* within the product UI). Follow the product's look when it's known from the conversation.
- Contained mockups (a dialog, a card, a phone screen) sit on a .panel so they don't float; full-width ones (a dashboard, a settings page) need no frame.
- Product surfaces are opaque; only the area around them stays transparent. Respect light and dark with light-dark(…) colors unless the product has a fixed theme.
- Realistic content and states; no lorem ipsum, no invented dashboards or filler cards.
- To compare alternatives, show them stacked with short names, or behind a small selector — one mechanism, not both.
- A modal is drawn inside a normal-flow backdrop (\`<div style="min-height:360px;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center">\`), never position: fixed.`;

const TOPIC_TEXT: Record<WidgetGuideTopic, string> = { chart: CHART, diagram: DIAGRAM, interactive: INTERACTIVE, mockup: MOCKUP };

export const WIDGET_GUIDE_DESCRIPTION = `Read the design guide for show_widget: the principles, the pre-styled controls and classes, the color ramps and chart palette, and how to build charts, diagrams, interactive explainers or UI mockups. Call it once before your first widget in a conversation (again for a new kind of widget), with the topics you need.`;

export function widgetGuideText(topics: readonly string[] = []): string {
  const chosen = WIDGET_GUIDE_TOPICS.filter((topic) => topics.includes(topic));
  const more = WIDGET_GUIDE_TOPICS.filter((topic) => !chosen.includes(topic));
  return [
    CORE,
    ...chosen.map((topic) => TOPIC_TEXT[topic]),
    more.length ? `More topics: ${more.join(', ')} (call widget_guide again with them if needed).` : '',
  ].filter(Boolean).join('\n\n');
}
