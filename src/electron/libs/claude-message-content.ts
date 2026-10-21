import type { ContentBlock } from '../types';

/**
 * The Claude SDK sends some user messages (slash-command output such as
 * `/compact`, compact summaries) with a plain string body. StreamMessage
 * promises a block array, so normalize at the boundary.
 */
export function toClaudeContentBlocks(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) return content as ContentBlock[];
  if (typeof content === 'string' && content.trim()) return [{ type: 'text', text: content }];
  return [];
}
