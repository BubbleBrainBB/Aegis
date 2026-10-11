// The design system every show_widget widget starts with, so a widget looks
// like part of the chat without the agent styling anything: semantic tokens
// mapped onto the app theme, pre-styled native controls, a few layout
// classes, SVG text/shape classes and color ramps that flip for dark mode.
// widget_guide documents the same names.

/** Nine color ramps, seven stops each (generated in OKLCH: one lightness and
 * chroma curve for every hue, so stops line up across ramps). */
export const WIDGET_RAMPS = {
  gray: ['#f8f7f4', '#eae8e3', '#d4d1c9', '#a39e93', '#706b62', '#45423c', '#282622'],
  blue: ['#f2f7fe', '#d9eafe', '#b0d5fe', '#58a2f2', '#296eb4', '#154473', '#0a2745'],
  teal: ['#e9fcf7', '#caf2e8', '#9de1d1', '#3ab59e', '#077e6c', '#004e42', '#022e26'],
  green: ['#f0fbec', '#d8f0d0', '#b7deab', '#76b161', '#477b34', '#2a4d1d', '#172d0f'],
  amber: ['#fef5eb', '#ffe3c2', '#f6c88f', '#d38e22', '#935f05', '#5c3a01', '#372101'],
  coral: ['#fef4f1', '#fee1d7', '#fec0ad', '#e77c5b', '#a94c2e', '#6b2d19', '#40190d'],
  red: ['#fef4f3', '#fee0dd', '#febfb9', '#ec7671', '#ad4543', '#6e2827', '#421615'],
  pink: ['#fef4f7', '#fedee9', '#febbd4', '#de79a3', '#a1496f', '#662b45', '#3d1828'],
  purple: ['#f7f6fe', '#e8e4fe', '#d1c9fe', '#a18dee', '#6f5bb0', '#443770', '#281f43'],
} as const;
export const WIDGET_RAMP_STOPS = [50, 100, 200, 400, 600, 800, 900] as const;

/** Categorical chart series, fixed order: [name, light, dark]. */
export const WIDGET_SERIES = [
  ['blue', '#2f82d6', '#58a2f2'],
  ['coral', '#c95a37', '#e77c5b'],
  ['teal', '#039580', '#3ab59e'],
  ['amber', '#ae7102', '#d38e22'],
  ['pink', '#bf5784', '#de79a3'],
  ['green', '#55923d', '#76b161'],
  ['purple', '#846cd1', '#a18dee'],
  ['red', '#cd5250', '#ec7671'],
] as const;

const rampVariables = Object.entries(WIDGET_RAMPS)
  .flatMap(([name, values]) => values.map((value, index) => `--${name}-${WIDGET_RAMP_STOPS[index]}:${value};`))
  .join('');
const seriesLight = WIDGET_SERIES.map(([, light], index) => `--series-${index + 1}:${light};`).join('');
const seriesDark = WIDGET_SERIES.map(([, , dark], index) => `--series-${index + 1}:${dark};`).join('');

const SHAPES = ['rect', 'circle', 'ellipse', 'polygon'];
const rampClasses = Object.keys(WIDGET_RAMPS)
  .map((name) => {
    const shape = (stop: number) => [...SHAPES.map((tag) => `.c-${name}>${tag}`), ...SHAPES.map((tag) => `${tag}.c-${name}`)].join(',') + `{fill:var(--${name}-${stop})`;
    return [
      `${shape(50)};stroke:var(--${name}-600)}`,
      `.c-${name}>.t,.c-${name}>.th{fill:var(--${name}-800)}.c-${name}>.ts{fill:var(--${name}-600)}`,
      `.tint-${name}{background:var(--${name}-50);color:var(--${name}-800)}`,
      `html.dark ${shape(800).replace(/,(?=[.a-z])/g, `,html.dark `)};stroke:var(--${name}-200)}`,
      `html.dark .c-${name}>.t,html.dark .c-${name}>.th{fill:var(--${name}-100)}html.dark .c-${name}>.ts{fill:var(--${name}-200)}`,
      `html.dark .tint-${name}{background:var(--${name}-800);color:var(--${name}-100)}`,
    ].join('');
  })
  .join('\n');

export const WIDGET_DESIGN_CSS = `
:root{${rampVariables}${seriesLight}
--surface-0:var(--bg-primary,#fff);--surface-1:var(--bg-secondary,#f6f6f4);--surface-2:var(--popover-bg,#fff);
--border-strong:color-mix(in srgb,var(--text-primary,#1f2328) 22%,transparent);
--text-accent:var(--accent,#2f6fdb);--bg-accent:color-mix(in srgb,var(--accent,#2f6fdb) 12%,transparent);--border-accent:var(--accent,#2f6fdb);
--text-success:var(--success,#3b7d2b);--bg-success:color-mix(in srgb,var(--success,#3b7d2b) 12%,transparent);
--text-warning:var(--warning,#9a6400);--bg-warning:color-mix(in srgb,var(--warning,#9a6400) 14%,transparent);
--text-danger:var(--error,#c0392b);--bg-danger:color-mix(in srgb,var(--error,#c0392b) 12%,transparent);
--ring:color-mix(in srgb,var(--accent,#2f6fdb) 45%,transparent);
--radius:8px;--gap-sm:8px;--gap-md:12px;--gap-lg:16px;
--grid:color-mix(in srgb,var(--text-primary,#1f2328) 8%,transparent);--axis:color-mix(in srgb,var(--text-primary,#1f2328) 25%,transparent);}
html.dark{${seriesDark}}
h1,h2,h3{font-weight:500;color:var(--text-primary);margin:0 0 .5rem;line-height:1.3}
h1{font-size:20px}h2{font-size:17px}h3{font-size:15px}
p{margin:0 0 .75rem}
small,.small{font-size:12px;color:var(--text-secondary)}
.muted{color:var(--text-muted)}.secondary{color:var(--text-secondary)}
.tabular{font-variant-numeric:tabular-nums}.mono{font-family:var(--font-mono)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
button{font:inherit;font-size:13px;line-height:1.2;padding:7px 12px;border-radius:var(--radius);border:.5px solid var(--border-strong);background:transparent;color:var(--text-primary);cursor:pointer;transition:background-color .15s,transform .1s}
button:hover{background:var(--surface-1)}button:active{transform:scale(.98)}
button:disabled{opacity:.5;cursor:default;transform:none}
button.primary{background:var(--text-primary);color:var(--surface-0);border-color:transparent}
button.primary:hover{opacity:.9;background:var(--text-primary)}
button[aria-pressed="true"],button[aria-selected="true"],button.selected{background:var(--bg-accent);color:var(--text-accent);border-color:var(--border-accent)}
button.ghost{border-color:transparent}
input:not([type]),input[type=text],input[type=number],input[type=search],input[type=email],input[type=date],input[type=time],select,textarea{font:inherit;font-size:13px;height:32px;padding:0 10px;border:.5px solid var(--border-strong);border-radius:var(--radius);background:var(--surface-2);color:var(--text-primary);min-width:0}
textarea{height:auto;padding:8px 10px;line-height:1.5}
input[type=range]{accent-color:var(--text-accent);height:18px;margin:0;cursor:pointer}
input[type=checkbox],input[type=radio]{accent-color:var(--text-accent);margin:0 6px 0 0;cursor:pointer}
input[type=color]{width:36px;height:28px;padding:0;border:.5px solid var(--border-strong);border-radius:6px;background:none}
:focus-visible{outline:none;box-shadow:0 0 0 2px var(--ring)}
label{font-size:13px;color:var(--text-secondary)}
hr{border:0;border-top:.5px solid var(--border);margin:1rem 0}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:6px 8px;border-bottom:.5px solid var(--border);text-align:left;vertical-align:top}
th{font-weight:500;color:var(--text-secondary)}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--gap-sm) var(--gap-md)}
.stack{display:flex;flex-direction:column;gap:var(--gap-md)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:var(--gap-md)}
.card{background:var(--surface-2);border:.5px solid var(--border);border-radius:12px;padding:1rem 1.25rem}
.panel{background:var(--surface-1);border-radius:12px;padding:1rem 1.25rem}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:var(--gap-md)}
.metric{background:var(--surface-1);border-radius:var(--radius);padding:.75rem 1rem}
.metric .label{display:block;font-size:12px;color:var(--text-secondary)}
.metric .value{display:block;font-size:22px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--text-primary);line-height:1.3}
.metric .delta{font-size:12px;color:var(--text-secondary)}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:12px;line-height:1.4;padding:2px 8px;border-radius:999px;background:var(--surface-1);color:var(--text-secondary)}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--text-secondary)}
.legend .swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.chart{position:relative;width:100%;height:280px}
.tooltip{position:absolute;pointer-events:none;background:var(--surface-2);border:.5px solid var(--border);border-radius:6px;padding:6px 8px;font-size:12px;color:var(--text-primary);white-space:nowrap}
svg text{font-family:var(--font-sans,system-ui,sans-serif)}
.t{font-size:14px;fill:var(--text-primary)}.ts{font-size:12px;fill:var(--text-secondary)}.th{font-size:14px;font-weight:500;fill:var(--text-primary)}
.box{fill:var(--surface-1);stroke:var(--border-strong);stroke-width:.5}
.arr{stroke:var(--text-secondary);stroke-width:1.5;fill:none;marker-end:url(#arrow)}
.leader{stroke:var(--text-muted);stroke-width:.75;stroke-dasharray:3 3;fill:none}
.grid-line{stroke:var(--grid);stroke-width:1}.axis-line{stroke:var(--axis);stroke-width:1}
.node{cursor:pointer}.node:hover{opacity:.85}
${rampClasses}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}
`;

/** Shared SVG defs: the open-chevron arrow every `.arr` line uses. */
export const WIDGET_SVG_DEFS = `<svg aria-hidden="true" width="0" height="0" style="position:absolute"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs></svg>`;
