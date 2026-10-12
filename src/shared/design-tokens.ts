/** A design token a board declares: a custom property on :root, html or body. */
export interface DesignToken {
  name: string;
  value: string;
}

const ROOT_SELECTOR = /^(?::root|html|body)$/i;

/**
 * The tokens a board's own stylesheet declares at its root (`:root { --accent: … }`),
 * in source order, the last declaration of a name winning. Other selectors'
 * custom properties are local to their elements and are not tokens.
 */
export function readBoardTokens(html: string): DesignToken[] {
  const tokens = new Map<string, string>();
  for (const style of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = style[1].replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = rule[1].split(",").map((s) => s.trim());
      if (!selectors.some((s) => ROOT_SELECTOR.test(s))) continue;
      for (const decl of rule[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) tokens.set(decl[1], decl[2].trim());
    }
  }
  return [...tokens].map(([name, value]) => ({ name, value }));
}

/** The token a value refers to: `var(--x)` or a bare `--x`. */
export function tokenReference(value: string): string | undefined {
  return /^\s*var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)\s*$/.exec(value)?.[1] ?? /^\s*(--[\w-]+)\s*$/.exec(value)?.[1];
}

/**
 * What to write for a value the user entered: a reference to a token when
 * they named one or the value is exactly a token's, else the value itself.
 * `same` compares two CSS values (the UI passes a color comparison).
 */
export function preferToken(value: string, tokens: DesignToken[], same: (a: string, b: string) => boolean): string {
  const named = tokenReference(value);
  if (named && tokens.some((t) => t.name === named)) return `var(${named})`;
  const match = tokens.find((t) => !tokenReference(t.value) && same(t.value, value));
  return match ? `var(${match.name})` : value;
}
