import type { ChangeRecord } from './change-records';
import { isWidgetEntry, isWorkflowEntry } from './turn-pins';
import { formatWorkstreamStageSummary, getWorkstreamStepLabel, summarizeWorkstreamEntries } from './workstream-stages';
import type { WorkstreamEntry } from './workstream';

type StepEntry = Extract<WorkstreamEntry, { type: 'tool' | 'task' | 'memory' }>;

export type TurnActivity =
  | { kind: 'waiting'; label: string }
  | { kind: 'step'; label: string; step: StepEntry }
  | { kind: 'agents'; label: string }
  | { kind: 'idle'; label: string };

/** Thinking this long without a new step reads as "Still thinking…", so a quiet turn doesn't look stuck. */
export const STILL_THINKING_MS = 15_000;

function isStep(entry: WorkstreamEntry): entry is StepEntry {
  return entry.type === 'tool' || entry.type === 'task' || entry.type === 'memory';
}

/** The one thing a running turn is doing now. */
export function getTurnActivity(entries: WorkstreamEntry[]): TurnActivity {
  if (entries.some((entry) => entry.type === 'approval' && entry.state === 'waiting')) {
    return { kind: 'waiting', label: 'Waiting for approval' };
  }
  const pending = entries.filter((entry): entry is StepEntry => isStep(entry) && entry.status === 'pending');
  const agents = pending.filter((entry) => entry.type === 'task').length;
  if (agents > 1) return { kind: 'agents', label: `Running ${agents} agents` };
  const step = pending.at(-1);
  if (step) return { kind: 'step', label: getWorkstreamStepLabel(step), step };
  if (entries.some((entry) => entry.type === 'compaction' && entry.state === 'inProgress')) {
    return { kind: 'idle', label: 'Compacting context…' };
  }
  const last = entries.at(-1);
  if (last?.type === 'note' && last.state === 'streaming') return { kind: 'idle', label: 'Writing…' };
  return { kind: 'idle', label: 'Thinking…' };
}

/**
 * What a running turn shows while its trace is folded: the agent's latest note,
 * anything waiting on the user, and widgets and workflows, which are part of the answer.
 */
export function getLiveTraceVisibleEntries(entries: WorkstreamEntry[]): WorkstreamEntry[] {
  const latestNote = [...entries].reverse().find((entry) => entry.type === 'note');
  return entries.filter((entry) =>
    entry === latestNote
    || (entry.type === 'approval' && entry.state === 'waiting')
    || isWidgetEntry(entry)
    || isWorkflowEntry(entry)
  );
}

/**
 * The folded row's label: what the folded steps did. A step still running is
 * the status line's, so it is left out. Null when nothing is folded.
 */
export function getLiveTraceSummary(
  entries: WorkstreamEntry[],
  visible: WorkstreamEntry[],
  changeRecordsByToolUseId?: Map<string, ChangeRecord[]>
): string | null {
  const shown = new Set(visible);
  const folded = entries.filter((entry) => !shown.has(entry));
  if (folded.length === 0) return null;
  const settled = folded.filter((entry) => !('status' in entry) || entry.status !== 'pending');
  const stages = summarizeWorkstreamEntries(settled, { changeRecordsByToolUseId });
  if (stages.length > 0) return formatWorkstreamStageSummary(stages);
  return folded.some((entry) => entry.type === 'thinking') ? 'Reasoning' : 'Show activity';
}
