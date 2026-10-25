import { isStartWorkflowToolName } from '../../shared/workflow';
import { isStartSessionToolName } from '../../shared/follow-up';
import { isShowWidgetToolName, widgetFromToolInput } from '../../shared/widget';
import type { WorkstreamEntry } from './workstream';
import { stripLeakedContextTags } from './leaked-context-tags';

export type WidgetEntry = Extract<WorkstreamEntry, { type: 'tool' | 'memory' }>;
export type TaskEntry = Extract<WorkstreamEntry, { type: 'task' }>;
export type NoteEntry = Extract<WorkstreamEntry, { type: 'note' }>;

export function isWidgetEntry(entry: WorkstreamEntry): entry is WidgetEntry {
  return entry.type === 'tool' && isShowWidgetToolName(entry.toolName) && widgetFromToolInput(entry.block.input) !== null;
}

/**
 * A widget the tool refused (its scripts don't parse) disappears, so the
 * agent's corrected call is the one that shows. Until the tool answers, the
 * chat draws the markup without running scripts.
 */
export function isRejectedWidget(entry: WidgetEntry): boolean {
  return entry.status === 'error' || entry.result?.is_error === true;
}

/** A start_workflow board or a start_session row: part of the answer, kept outside a collapsed trace. */
export function isWorkflowEntry(entry: WorkstreamEntry): entry is TaskEntry {
  return entry.type === 'task' && (isStartWorkflowToolName(entry.toolName) || isStartSessionToolName(entry.toolName));
}

function hasVisibleText(entry: NoteEntry): boolean {
  return stripLeakedContextTags(entry.detail || entry.summary || '').trim().length > 0;
}

/**
 * What a finished turn shows outside its collapsed trace, in order: workflow
 * boards, the widgets it drew, and — from the first widget on — the reply
 * text between and after them, so an explanation told as visual → text →
 * visual reads the same once the turn is done. Text before the first widget
 * (working notes) stays in the trace.
 */
export function pinnedTurnEntries(entries: WorkstreamEntry[]): WorkstreamEntry[] {
  const firstWidget = entries.findIndex((entry) => isWidgetEntry(entry) && !isRejectedWidget(entry));
  return entries.filter((entry, index) => {
    if (isWorkflowEntry(entry)) return true;
    if (isWidgetEntry(entry)) return !isRejectedWidget(entry);
    return firstWidget >= 0 && index > firstWidget && entry.type === 'note' && hasVisibleText(entry);
  });
}
