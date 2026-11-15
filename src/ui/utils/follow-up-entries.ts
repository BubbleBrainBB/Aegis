import { isProposeFollowUpToolName, isStartSessionToolName } from '../../shared/follow-up';
import { isMainBotLookupToolName, isMainBotTaskActionToolName } from '../../shared/main-bot';
import { isReportStatusToolName } from '../../shared/turn-report';
import type { WorkstreamMessage } from './compaction';
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

export interface TaskCardCall extends FollowUpCall {
  toolName: string;
}

/**
 * The work a turn handed to sessions, in order: sessions it started
 * (start_session) and what the main bot did to tasks. Shown at the end of the
 * turn, after its answer: the answer says what was handed out, the rows under
 * it show how that work stands, and its result arrives right below them.
 */
export function taskCardCallsInMessages(messages: StreamMessage[], results: Map<string, ToolResultBlock>): TaskCardCall[] {
  const calls: TaskCardCall[] = [];
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    for (const block of getMessageContentBlocks(message)) {
      const use = normalizeToolUseBlock(block);
      if (!use || !(isStartSessionToolName(use.name) || isMainBotTaskActionToolName(use.name))) continue;
      const result = results.get(use.id);
      calls.push({
        toolUseId: use.id,
        toolName: use.name,
        input: use.input,
        resultText: result ? resultText(result.content) : null,
        failed: result?.is_error === true,
      });
    }
  }
  return calls;
}

/**
 * Work in the main bot's conversation that only handed tasks out (looking the
 * projects or tasks up on the way): the chips and lines the chat draws for
 * those calls say all of it, so a finished turn shows no trace row for it.
 * A lookup that failed keeps the trace, where its error can be read.
 */
export function isMainBotDispatchWork(messages: readonly WorkstreamMessage[], results: Map<string, ToolResultBlock>): boolean {
  let handedOut = false;
  for (const message of messages) {
    if (message.type !== 'assistant') return false;
    for (const block of getMessageContentBlocks(message)) {
      const use = normalizeToolUseBlock(block);
      if (!use) continue;
      if (isMainBotTaskActionToolName(use.name)) {
        handedOut = true;
        continue;
      }
      if (isReportStatusToolName(use.name)) continue;
      if (isMainBotLookupToolName(use.name) && results.get(use.id)?.is_error !== true) continue;
      return false;
    }
  }
  return handedOut;
}
