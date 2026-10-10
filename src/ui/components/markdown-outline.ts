import type { EditorState } from '@codemirror/state';

export type MarkdownOutlineItem = {
  id: string;
  level: number;
  text: string;
  pos: number;
};

/**
 * The document's ATX headings, skipping frontmatter and fenced code blocks
 * (a `# comment` in a shell or Python block is not a heading).
 */
export function collectOutlineItemsFromDoc(state: EditorState): MarkdownOutlineItem[] {
  const items: MarkdownOutlineItem[] = [];
  let inFrontmatter = false;
  // The open fence's character and length; a closing fence uses the same
  // character, at least as many, and nothing after it (CommonMark).
  let fence: { char: string; length: number } | null = null;
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const text = line.text;
    if (lineNumber === 1 && text.trim() === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (text.trim() === '---') inFrontmatter = false;
      continue;
    }
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) {
        fence = null;
      }
      continue;
    }
    // A backtick fence's info string can't contain a backtick.
    if (fenceMatch && !(fenceMatch[1][0] === '`' && fenceMatch[2].includes('`'))) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(text);
    if (!match) continue;
    const rawText = match[2]
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*_~]/g, '')
      .trim();
    items.push({
      id: `heading-${line.from}`,
      level: match[1].length,
      text: rawText || 'Untitled',
      pos: line.from,
    });
  }
  return items;
}
