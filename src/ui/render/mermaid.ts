import type { Mermaid } from 'mermaid';
import { THEME_APPLIED_EVENT } from '../theme/themes';
import { mermaidThemeVariables, type MermaidPalette, type Rgb } from '../utils/mermaid-theme';

export interface MermaidDiagram {
  /** The diagram as SVG markup; its element ids all start with `id`. */
  svg: string;
  id: string;
  /** Size at which the diagram's own text is at its real size. */
  width: number;
  height: number;
}

/** The class chain the measuring host shares with where a diagram is shown, so both get the same CSS. */
export const MERMAID_CANVAS_CLASS = 'md-mermaid-canvas';

const CACHE_LIMIT = 60;
const LABEL_WRAP_PX = 200;
const cache = new Map<string, MermaidDiagram>();
let library: Promise<Mermaid> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let renderCount = 0;
let mountCount = 0;
let sandbox: HTMLElement | null = null;
let pixel: CanvasRenderingContext2D | null = null;
let themeKey: string | null = null;
let watchingTheme = false;

/** Mermaid ships as its own chunks, fetched when the first diagram is shown. */
function loadMermaid(): Promise<Mermaid> {
  library ??= import('mermaid').then((module) => module.default);
  library.catch(() => { library = null; });
  return library;
}

/** A CSS color of the page as opaque RGB: `var()`, `color-mix()` and alpha all resolve here. */
function resolveColor(probe: HTMLElement, value: string, backdrop: Rgb): Rgb {
  pixel ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!pixel) return backdrop;
  probe.style.color = '';
  probe.style.color = value;
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillStyle = `rgb(${backdrop.join(' ')})`;
  pixel.fillRect(0, 0, 1, 1);
  pixel.fillStyle = getComputedStyle(probe).color;
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

function readPalette(): MermaidPalette {
  const root = document.documentElement;
  const dark = root.classList.contains('dark');
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  try {
    // A see-through page background (window glass) sits over light or dark.
    const surface = resolveColor(probe, 'var(--bg-primary)', dark ? [24, 24, 27] : [255, 255, 255]);
    const token = (name: string, fallback: string) => resolveColor(probe, `var(${name}, ${fallback})`, surface);
    return {
      dark,
      surface,
      ink: token('--text-primary', dark ? '#f4f4f5' : '#1a1a1a'),
      subdued: token('--text-secondary', dark ? '#a1a1aa' : '#525252'),
      accent: token('--accent', '#4f46e5'),
      success: token('--success', '#16a34a'),
      warning: token('--warning', '#d97706'),
      error: token('--error', '#dc2626'),
      fontFamily: getComputedStyle(document.body).fontFamily || 'sans-serif',
    };
  } finally {
    probe.remove();
  }
}

/** Off screen, yet laid out: Mermaid measures its labels in here. */
function measuringHost(): HTMLElement {
  if (sandbox?.isConnected) return sandbox;
  const wrapper = document.createElement('div');
  wrapper.className = 'markdown-content md-mermaid-sandbox';
  wrapper.setAttribute('aria-hidden', 'true');
  sandbox = document.createElement('div');
  sandbox.className = MERMAID_CANVAS_CLASS;
  wrapper.appendChild(sandbox);
  document.body.appendChild(wrapper);
  return sandbox;
}

function naturalSize(svg: string): { width: number; height: number } | null {
  const viewBox = /<svg[^>]*\sviewBox="([^"]+)"/.exec(svg)?.[1].trim().split(/[\s,]+/).map(Number);
  if (!viewBox || viewBox.length !== 4 || !(viewBox[2] > 0) || !(viewBox[3] > 0)) return null;
  return { width: viewBox[2], height: viewBox[3] };
}

async function draw(code: string, themeVariables: Record<string, string | boolean>): Promise<MermaidDiagram> {
  const mermaid = await loadMermaid();
  const id = `aegis-mermaid-r${++renderCount}`;
  const host = measuringHost();
  mermaid.initialize({
    startOnLoad: false,
    // Diagram text comes from agents and files: no scripts, no click handlers, labels sanitized.
    securityLevel: 'strict',
    // A diagram that does not parse throws; the caller keeps showing its source.
    suppressErrorRendering: true,
    theme: 'base',
    // Flat shapes; the newer default look puts a drop shadow under every node.
    look: 'classic',
    darkMode: themeVariables.darkMode === true,
    fontFamily: String(themeVariables.fontFamily),
    themeVariables,
    // Mermaid 12 wraps labels at 120px, which strands a character or two of
    // Chinese text on its own line; 200px was the width before it.
    flowchart: { wrappingWidth: LABEL_WRAP_PX },
    state: { wrappingWidth: LABEL_WRAP_PX },
  });
  try {
    const { svg } = await mermaid.render(id, code, host);
    const size = naturalSize(svg);
    if (!size) throw new Error('The diagram came out empty.');
    return { svg, id, ...size };
  } finally {
    host.replaceChildren();
    // What Mermaid leaves on the page itself when a render throws half way.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/**
 * A signature of the app theme: diagrams drawn under another one are redrawn.
 * Read once per theme, as every diagram on the page asks on every render.
 */
export function mermaidThemeKey(): string {
  if (!watchingTheme) {
    watchingTheme = true;
    window.addEventListener(THEME_APPLIED_EVENT, () => { themeKey = null; });
  }
  themeKey ??= JSON.stringify(mermaidThemeVariables(readPalette()));
  return themeKey;
}

export function cachedMermaidDiagram(code: string, themeKey: string): MermaidDiagram | undefined {
  return cache.get(`${themeKey}\n${code}`);
}

/**
 * Draws a diagram for the theme of `themeKey`. Renders run one at a time:
 * Mermaid keeps its configuration and its parser state in module globals.
 * Rejects when the text is not a diagram Mermaid can draw.
 */
export function renderMermaidDiagram(code: string, themeKey: string): Promise<MermaidDiagram> {
  const key = `${themeKey}\n${code}`;
  const run = queue.then(async () => {
    const known = cache.get(key);
    if (known) return known;
    const diagram = await draw(code, JSON.parse(themeKey) as Record<string, string | boolean>);
    cache.set(key, diagram);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    return diagram;
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * The markup of a diagram for one place on the page. Arrowheads and styles
 * inside the SVG refer to its ids, so two copies of one drawing (the same
 * diagram in two messages) each need ids of their own.
 */
export function mountableMermaidSvg(diagram: MermaidDiagram): string {
  return diagram.svg.split(diagram.id).join(`aegis-mermaid-m${++mountCount}`);
}
