import { isProposeFollowUpToolName } from '../../shared/follow-up';
import type { StreamMessage } from '../types';
import { getMessageContentBlocks, normalizeToolUseBlock } from './message-content';
import type { ToolResultBlock } from './workstream';

export interface FollowUpCall {
  toolUseId: string;
  input: unknown;
  resultText: string | null;
  failed: boolean;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('');
}

/**
 * The follow-up tasks a turn proposed, in order: suggestions for after the
 * work, shown at the end of the turn rather than where the call was made.
 */
export function followUpCallsInMessages(messages: StreamMessage[], results: Map<string, ToolResultBlock>): FollowUpCall[] {
  const calls: FollowUpCall[] = [];
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    for (const block of getMessageContentBlocks(message)) {
      const use = normalizeToolUseBlock(block);
      if (!use || !isProposeFollowUpToolName(use.name)) continue;
      const result = results.get(use.id);
      calls.push({
        toolUseId: use.id,
        input: use.input,
        resultText: result ? resultText(result.content) : null,
        failed: result?.is_error === true,
      });
    }
  }
  return calls;
}
