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

// The tool's JSON reply. A result stored as content parts arrives here as
// those parts stringified (`[{"type":"text","text":"{…}"}]`): unwrap them.
function resultJson(content: unknown): Record<string, unknown> | null {
  try {
    let parsed: unknown = JSON.parse(resultText(content));
    if (Array.isArray(parsed)) parsed = JSON.parse(resultText(parsed));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function designIdOfCall(toolName: string, input: unknown, resultContent: unknown): string | null {
  const tool = designToolNameOf(toolName);
  if (tool === DESIGN_UPDATE_TOOL) {
    const id = (input as { documentId?: unknown } | undefined)?.documentId;
    return typeof id === 'string' && id ? id : null;
  }
  if (tool === DESIGN_CREATE_TOOL) {
    const id = resultJson(resultContent)?.id;
    return typeof id === 'string' && id ? id : null;
  }
  return null;
}

/** What a turn did to one design: boards it added and boards it rewrote. */
export interface DesignTurnChange {
  documentId: string;
  added: string[];
  changed: string[];
}

function resultBoardIds(resultContent: unknown): string[] {
  const boards = resultJson(resultContent)?.boards;
  return Array.isArray(boards)
    ? boards.map((board) => (board as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string')
    : [];
}

function boardChangesOfCall(toolName: string, input: unknown, resultContent: unknown): { added: string[]; changed: string[] } {
  if (designToolNameOf(toolName) === DESIGN_CREATE_TOOL) return { added: resultBoardIds(resultContent), changed: [] };
  const operations = (input as { operations?: unknown } | undefined)?.operations;
  if (!Array.isArray(operations)) return { added: [], changed: [] };
  let newBoards = 0;
  const changed: string[] = [];
  for (const op of operations as Array<{ type?: unknown; boardId?: unknown }>) {
    if (op?.type === 'add' || op?.type === 'duplicate') newBoards += 1;
    else if ((op?.type === 'patch' || op?.type === 'content') && typeof op.boardId === 'string') changed.push(op.boardId);
  }
  // New boards are appended to the design, so they end its board list.
  const added = newBoards > 0 ? resultBoardIds(resultContent).slice(-newBoards) : [];
  return { added, changed };
}

/**
 * Designs written by the tool calls in a turn's messages, in the order it last
 * touched them, with the boards the turn added and rewrote: the turn's
 * result, shown at its end.
 */
export function designChangesInMessages(
  messages: StreamMessage[],
  results: Map<string, ToolResultBlock>,
): DesignTurnChange[] {
  const order: DesignTurnChange[] = [];
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    for (const block of getMessageContentBlocks(message)) {
      const use = normalizeToolUseBlock(block);
      if (!use || !designToolNameOf(use.name)) continue;
      const result = results.get(use.id);
      if (!result || result.is_error) continue;
      const id = designIdOfCall(use.name, use.input, result.content);
      if (!id) continue;
      const at = order.findIndex((entry) => entry.documentId === id);
      const entry = at >= 0 ? order.splice(at, 1)[0] : { documentId: id, added: [], changed: [] };
      const calls = boardChangesOfCall(use.name, use.input, result.content);
      for (const boardId of calls.added) if (!entry.added.includes(boardId)) entry.added.push(boardId);
      for (const boardId of calls.changed) {
        if (!entry.added.includes(boardId) && !entry.changed.includes(boardId)) entry.changed.push(boardId);
      }
      order.push(entry);
    }
  }
  return order;
}
