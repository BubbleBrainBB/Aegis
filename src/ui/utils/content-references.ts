import type { CodexVisualizationReference } from '../../shared/widget';

// OpenAI models mark content references with private-use characters:
// `<kind><payload>`. Codex's Visualize plugin emits
// `visualize` references (a JSON object naming an HTML fragment file). Other
// kinds (citations…) mean nothing outside their own app, so they're dropped
// rather than shown as boxes.
const OPEN = '';
const REFERENCE = /([a-z_]+)([^]*)/g;

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'visualize'; reference: CodexVisualizationReference; key: string };

function parseVisualize(payload: string): CodexVisualizationReference | null {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    if (!value || typeof value.path !== 'string' || !value.path.trim()) return null;
    return {
      path: value.path.trim(),
      ...(typeof value.title === 'string' && value.title.trim() ? { title: value.title.trim() } : {}),
      ...(typeof value.mode === 'string' ? { mode: value.mode } : {}),
    };
  } catch {
    return null;
  }
}

/** Text and visualization parts, in order; plain text comes back as one part. */
export function splitContentReferences(text: string): ContentPart[] {
  if (!text.includes(OPEN)) return [{ type: 'text', text }];
  const parts: ContentPart[] = [];
  let cursor = 0;
  let index = 0;
  const pushText = (value: string) => {
    if (value) parts.push({ type: 'text', text: value });
  };
  for (const match of text.matchAll(REFERENCE)) {
    pushText(text.slice(cursor, match.index));
    cursor = (match.index ?? 0) + match[0].length;
    if (match[1] === 'visualize') {
      const reference = parseVisualize(match[2]);
      if (reference) parts.push({ type: 'visualize', reference, key: `visualize-${index++}-${reference.path}` });
    }
  }
  let rest = text.slice(cursor);
  // A reference still streaming in (or never closed) is held back, not shown raw.
  const open = rest.indexOf(OPEN);
  if (open >= 0) rest = rest.slice(0, open);
  pushText(rest);
  return parts;
}

/** The reply as plain text, without content references (for copying). */
export function stripContentReferences(text: string): string {
  return splitContentReferences(text)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}
