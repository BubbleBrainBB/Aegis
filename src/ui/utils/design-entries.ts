import { DESIGN_CREATE_TOOL, DESIGN_UPDATE_TOOL, designToolNameOf } from '../../shared/design-tools';
import type { StreamMessage } from '../types';
import { getMessageContentBlocks, normalizeToolUseBlock } from './message-content';
import type { ToolResultBlock } from './workstream';

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('');
}

function designIdOfCall(toolName: string, input: unknown, resultContent: unknown): string | null {
  const tool = designToolNameOf(toolName);
  if (tool === DESIGN_UPDATE_TOOL) {
    const id = (input as { documentId?: unknown } | undefined)?.documentId;
    return typeof id === 'string' && id ? id : null;
  }
  if (tool === DESIGN_CREATE_TOOL) {
    try {
      const id = (JSON.parse(resultText(resultContent)) as { id?: unknown }).id;
      return typeof id === 'string' && id ? id : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Designs written by the tool calls in a turn's messages, in the order it last
 * touched them: the turn's result, shown at its end.
 */
export function designDocumentIdsInMessages(
  messages: StreamMessage[],
  results: Map<string, ToolResultBlock>,
): string[] {
  const order: string[] = [];
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    for (const block of getMessageContentBlocks(message)) {
      const use = normalizeToolUseBlock(block);
      if (!use || !designToolNameOf(use.name)) continue;
      const result = results.get(use.id);
      if (!result || result.is_error) continue;
      const id = designIdOfCall(use.name, use.input, result.content);
      if (!id) continue;
      const at = order.indexOf(id);
      if (at >= 0) order.splice(at, 1);
      order.push(id);
    }
  }
  return order;
}
