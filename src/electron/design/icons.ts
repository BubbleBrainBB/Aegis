import { readFileSync } from "fs";
import { join } from "path";

/**
 * The design canvas's icon library (Tabler Icons, MIT; data built by
 * scripts/build-design-assets.mjs). Boards write
 *
 *   <aegis-icon name="search" size="20" stroke-width="1.75" variant="filled">
 *
 * and every write expands it to inline SVG, so a saved board needs nothing to
 * render. design_icons searches the library.
 */
interface IconData {
  /** Outline path data. */
  o: string[];
  /** Filled path data, when the icon has a filled style. */
  f?: string[];
  /** Category and tags, lowercase, for search. */
  s: string;
}
let library: Record<string, IconData> | null = null;
function icons(): Record<string, IconData> {
  if (!library) {
    try {
      library = JSON.parse(readFileSync(join(__dirname, "icons.json"), "utf8")).icons as Record<string, IconData>;
    } catch {
      library = {};
    }
  }
  return library;
}

const ICON_TAG = /<aegis-icon\b([^>]*?)\/?>(?:\s*<\/aegis-icon>)?/gi;
const ATTR = /([a-zA-Z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const num = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Close names for a missing icon. */
function similar(name: string): string[] {
  const words = name.toLowerCase().split(/[-\s]+/).filter(Boolean);
  return Object.keys(icons())
    .map((n) => [n, words.filter((w) => n.includes(w)).length] as const)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, 6)
    .map(([n]) => n);
}

/** One icon as inline SVG; throws for a name the library doesn't have. */
export function designIconSvg(attrs: Record<string, string>): string {
  const name = (attrs.name ?? "").trim().toLowerCase();
  const icon = icons()[name];
  if (!icon) {
    const near = similar(name);
    throw new Error(`Unknown icon "${name}".${near.length ? ` Similar: ${near.join(", ")}.` : ""} Search the library with design_icons.`);
  }
  const filled = attrs.variant === "filled" && icon.f;
  const size = num(attrs.size, 20, 8, 512);
  const stroke = num(attrs["stroke-width"], 1.75, 0.5, 4);
  const keep = ["class", "style", "data-aegis-node-id", "data-aegis-layer-name", "data-aegis-hidden", "data-aegis-locked", "data-aegis-if", "data-aegis-else", "data-aegis-for", "data-aegis-key"]
    .filter((k) => attrs[k] !== undefined)
    .map((k) => ` ${k}="${esc(attrs[k])}"`)
    .join("");
  const label = attrs["aria-label"] ? ` role="img" aria-label="${esc(attrs["aria-label"])}"` : ' aria-hidden="true"';
  const paint = filled
    ? 'fill="currentColor" stroke="none"'
    : `fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"`;
  return `<svg data-aegis-icon="${name}${filled ? ":filled" : ""}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${paint}${keep}${label}>${(filled ? icon.f! : icon.o).map((d) => `<path d="${esc(d)}"/>`).join("")}</svg>`;
}

/** Every <aegis-icon> in a board (or component) as inline SVG. */
export function expandDesignIcons(html: string): string {
  if (!/<aegis-icon\b/i.test(html)) return html;
  return html.replace(ICON_TAG, (_, raw: string) => {
    const attrs: Record<string, string> = {};
    for (const m of raw.matchAll(ATTR)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
    return designIconSvg(attrs);
  });
}

/** design_icons: the best matches for a query, by name, then category and tags. */
export function searchDesignIcons(query: string, limit = 30): { name: string; filled: boolean; terms: string }[] {
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!words.length) return [];
  return Object.entries(icons())
    .map(([name, icon]) => {
      let score = 0;
      for (const w of words) {
        if (name === w) score += 10;
        else if (name.split("-").includes(w)) score += 6;
        else if (name.includes(w)) score += 3;
        if (icon.s.includes(w)) score += 2;
      }
      return { name, icon, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
    .slice(0, Math.min(Math.max(limit, 1), 80))
    .map(({ name, icon }) => ({ name, filled: !!icon.f, terms: icon.s.slice(0, 120) }));
}

export function iconCount(): number {
  return Object.keys(icons()).length;
}
