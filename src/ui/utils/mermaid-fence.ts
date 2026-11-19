import { defaultSchema } from 'rehype-sanitize';

/** The attribute a ```mermaid fence carries on its `<code>` once its closing fence is there. */
export const MERMAID_FENCE_ATTRIBUTE = 'data-mermaid-fence';

export function isMermaidLanguage(language: string | undefined): boolean {
  return language?.toLowerCase() === 'mermaid';
}

interface MdNode {
  type: string;
  lang?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
  children?: MdNode[];
}

// Fenced code ends at its closing fence or, without one, at the end of what
// holds it. So the last line of the node tells the two apart. The prefix
// allows the markers of a list or quote the fence sits in.
const CLOSING_FENCE = /(?:^|\n)[ \t>]*(`{3,}|~{3,})[ \t]*$/;

/** Whether the source of a fenced code node has both its fences. */
export function isClosedFence(source: string): boolean {
  const firstBreak = source.indexOf('\n');
  if (firstBreak < 0) return false;
  const opening = /^(`{3,}|~{3,})/.exec(source);
  const closing = CLOSING_FENCE.exec(source.slice(firstBreak));
  if (!opening || !closing) return false;
  return closing[1][0] === opening[1][0] && closing[1].length >= opening[1].length;
}

function markClosedFences(node: MdNode, source: string) {
  if (node.type === 'code' && isMermaidLanguage(node.lang ?? undefined)) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined && isClosedFence(source.slice(start, end))) {
      node.data = {
        ...node.data,
        hProperties: { ...node.data?.hProperties, dataMermaidFence: 'closed' },
      };
    }
  }
  node.children?.forEach((child) => markClosedFences(child, source));
}

/**
 * Marks ```mermaid fences that have their closing fence. While an answer
 * streams, the fence it is writing is still open and its text is half a
 * diagram: that one stays source code until it is whole.
 */
export function remarkMermaidFences() {
  return (tree: unknown, file: { value?: unknown }) => {
    markClosedFences(tree as MdNode, String(file.value ?? ''));
  };
}

/** The sanitize schema for markdown with HTML, which keeps the mark above. */
export const mermaidSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), 'dataMermaidFence'],
  },
};
