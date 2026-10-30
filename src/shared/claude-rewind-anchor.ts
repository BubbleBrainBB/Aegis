import type { StreamMessage } from './types';

/**
 * The Claude checkpoint a user prompt rewinds to: the uuid of its SDK user
 * message — the host echo right behind it (or, in resumed history, the CLI's
 * own text user message) — before the next prompt. Null when there is none.
 */
export function findClaudeRewindAnchor(messages: readonly StreamMessage[], userPromptIndex: number): string | null {
  for (let index = userPromptIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.type === 'user_prompt') break;
    if (message.type !== 'user') continue;
    const uuid = (message as { uuid?: unknown }).uuid;
    if (typeof uuid !== 'string' || !uuid) continue;
    const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
    if (blocks.some((block) => block?.type === 'text')) return uuid;
  }
  return null;
}
