import type { StreamMessage } from '../types';
import type { TranscriptTimelineItem } from './transcript-timeline';
import { getMessageContentBlocks, normalizeToolUseBlock } from './message-content';

function holdsToolCall(message: StreamMessage, toolUseId: string): boolean {
  return getMessageContentBlocks(message).some((block) => normalizeToolUseBlock(block)?.id === toolUseId);
}

/** The loaded message that made a tool call, newest first. */
export function findToolCallMessage(messages: readonly StreamMessage[], toolUseId: string): StreamMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (holdsToolCall(messages[index], toolUseId)) return messages[index];
  }
  return null;
}

/** The transcript work group whose own (top-level) messages made a tool call. */
export function findWorkGroupWithToolCall(
  items: readonly TranscriptTimelineItem[],
  toolUseId: string
): Extract<TranscriptTimelineItem, { type: 'work' }> | null {
  for (const item of items) {
    if (item.type === 'work' && item.group.messages.some((message) => holdsToolCall(message, toolUseId))) return item;
  }
  return null;
}

/** Any transcript item that shows a tool call: a work group, or a message with its inline work. */
export function findTimelineItemWithToolCall(
  items: readonly TranscriptTimelineItem[],
  toolUseId: string
): TranscriptTimelineItem | null {
  for (const item of items) {
    const messages = item.type === 'work'
      ? item.group.messages
      : [item.message, ...(item.inlineWorkGroup?.messages ?? [])];
    if (messages.some((message) => holdsToolCall(message, toolUseId))) return item;
  }
  return null;
}
