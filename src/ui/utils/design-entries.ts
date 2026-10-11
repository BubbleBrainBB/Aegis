import { DESIGN_CREATE_TOOL, DESIGN_UPDATE_TOOL, designToolNameOf } from '../../shared/design-tools';
import type { WorkstreamEntry } from './workstream';

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('');
}

/** The design a successful design_create / design_update call wrote, if any. */
export function designDocumentIdOf(entry: WorkstreamEntry): string | null {
  if (entry.type !== 'tool' || entry.status !== 'success' || entry.result?.is_error) return null;
  const tool = designToolNameOf(entry.toolName);
  if (tool === DESIGN_UPDATE_TOOL) {
    const id = (entry.block.input as { documentId?: unknown } | undefined)?.documentId;
    return typeof id === 'string' && id ? id : null;
  }
  if (tool === DESIGN_CREATE_TOOL) {
    try {
      const id = (JSON.parse(resultText(entry.result?.content)) as { id?: unknown }).id;
      return typeof id === 'string' && id ? id : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Designs a turn wrote, in the order it last touched them. */
export function designDocumentIdsOf(entries: WorkstreamEntry[]): string[] {
  const order: string[] = [];
  for (const entry of entries) {
    const id = designDocumentIdOf(entry);
    if (!id) continue;
    const at = order.indexOf(id);
    if (at >= 0) order.splice(at, 1);
    order.push(id);
  }
  return order;
}
