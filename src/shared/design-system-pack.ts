import type { DesignComponentSource } from "./design-frame";
import { readBoardTokens, type DesignToken } from "./design-tokens";

/**
 * A design system as boards load it: one stylesheet (tokens, fonts and
 * component classes, with every font and image inlined as a data URL),
 * components in the board format (template, logic, props), and named
 * assets boards refer to as `aegis-asset:name`. Built by the main process
 * from a project's design-system/ folder or a built-in style.
 */
export interface DesignSystemPack {
  /** "project" or a built-in style id. */
  id: string;
  name: string;
  css: string;
  components: Record<string, DesignComponentSource & { summary?: string }>;
  /** Asset name → data URL. */
  assets: Record<string, string>;
  /** Font families its stylesheet registers with @font-face. */
  fonts: string[];
  /** Changes whenever any of it does. */
  signature: string;
}

/** The custom properties a system's stylesheet declares at its root. */
export function designSystemTokens(css: string): DesignToken[] {
  return readBoardTokens(`<style>${css}</style>`);
}

/** Families declared by @font-face in a stylesheet. */
export function declaredFontFamilies(css: string): string[] {
  const out = new Set<string>();
  for (const face of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const family = /font-family\s*:\s*(['"]?)([^;'"]+)\1/i.exec(face[1])?.[2]?.trim();
    if (family) out.add(family);
  }
  return [...out];
}

/**
 * A board's assets as a frame shows them: resolved, and an image the frame
 * doesn't have yet (just added, still on its way) left blank instead of
 * requesting a URL the frame's policy blocks; checks still see it unloaded.
 */
export function resolveFrameAssets(html: string, assets: Record<string, string> | undefined): string {
  return resolveDesignAssets(html, assets).replace(/(<img\b[^>]*?\s)src="aegis-asset:([\w.-]{1,80})"/g, '$1src="" data-aegis-missing-asset="$2"');
}

/** `aegis-asset:name` references in a board, resolved to the pack's data URLs (unknown names stay). */
export function resolveDesignAssets(html: string, assets: Record<string, string> | undefined): string {
  if (!assets || !Object.keys(assets).length) return html;
  return html.replace(/aegis-asset:([\w.-]{1,80})/g, (all, name: string) => assets[name] ?? assets[name.replace(/\.[a-z0-9]+$/i, "")] ?? all);
}
