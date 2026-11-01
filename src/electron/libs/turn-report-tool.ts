// The report_status app tool: an agent states how its turn ends when that is
// not a finished result, so the sidebar and notifications need not guess from
// the reply's text. The caller is always bound by the runtime (closure, signed
// header or per-turn host tool), never taken from the model's input.

import { z } from 'zod';
import type { StreamMessage } from '../types';
import {
  REPORT_STATUS_TOOL,
  TURN_REPORT_LIMITS,
  TURN_REPORT_OUTCOMES,
  type TurnReport,
  type TurnReportOutcome,
} from '../../shared/turn-report';

/**
 * `in_progress` is offered only where the runtime wakes the agent when its
 * background work ends (Claude's background tasks); elsewhere nothing would
 * come back, and the session would claim to be running forever.
 */
export function reportStatusOutcomes(background: boolean): readonly TurnReportOutcome[] {
  return background ? TURN_REPORT_OUTCOMES : TURN_REPORT_OUTCOMES.filter((outcome) => outcome !== 'in_progress');
}

const OUTCOME_DESCRIPTIONS: Record<TurnReportOutcome, string> = {
  question: '"question": you need the user to answer or decide something before you can go on (put the question in `question`)',
  blocked: '"blocked": something only the user can fix stops you, such as a missing login, secret, permission or service',
  nothing_to_do: '"nothing_to_do": you checked and no change is needed, for example the problem does not reproduce or is already fixed',
  in_progress: '"in_progress": a background task you started is still running and you will be woken when it ends; nothing waits on the user',
};

export function reportStatusDescription(background: boolean): string {
  return [
    'Tell Aegis how this turn ends when it is not a finished result, so the user sees it in their sidebar and notifications',
    'without reading your reply first. Only the main agent of the conversation calls it, never a subagent.',
    'Call it once, as your last action before your final reply. Outcomes:',
    `${reportStatusOutcomes(background).map((outcome) => OUTCOME_DESCRIPTIONS[outcome]).join('; ')}.`,
    'Do not call it when you finished the work you were asked for, and do not use it instead of your reply: still write',
    'your answer or question in the chat as usual.',
  ].join(' ');
}

export interface ReportStatusArgs {
  outcome: TurnReportOutcome;
  summary: string;
  question?: string;
}

const SUMMARY_DESCRIPTION =
  'One short sentence the user sees in a notification, such as "Needs the staging API key to run the import".';
const QUESTION_DESCRIPTION = 'With "question": the one concrete question the user should answer.';

export function reportStatusSchema(background: boolean) {
  const outcomes = reportStatusOutcomes(background) as [TurnReportOutcome, ...TurnReportOutcome[]];
  return {
    outcome: z.enum(outcomes).describe('How this turn ends.'),
    summary: z.string().min(1).max(TURN_REPORT_LIMITS.summary).describe(SUMMARY_DESCRIPTION),
    question: z.string().max(TURN_REPORT_LIMITS.question).optional().describe(QUESTION_DESCRIPTION),
  };
}

/** JSON Schema for the native host tools (Bubble, Pi), which have no background wake. */
export const REPORT_STATUS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'summary'],
  properties: {
    outcome: { type: 'string', enum: [...reportStatusOutcomes(false)], description: 'How this turn ends.' },
    summary: { type: 'string', maxLength: TURN_REPORT_LIMITS.summary, description: SUMMARY_DESCRIPTION },
    question: { type: 'string', maxLength: TURN_REPORT_LIMITS.question, description: QUESTION_DESCRIPTION },
  },
};

export interface TurnReportEntry {
  /** Store the report for the caller's current turn; returns an error message when it cannot. */
  record(callerSessionId: string, report: TurnReport): string | null;
  history(sessionId: string): StreamMessage[];
}

let entry: TurnReportEntry | null = null;

export function setTurnReportEntry(next: TurnReportEntry | null): void {
  entry = next;
}

type ToolText = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const reply = (text: string, isError = false): ToolText => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });

/** Validates and records a report; the text is what the agent reads back. */
export function reportStatus(
  callerSessionId: string,
  args: ReportStatusArgs,
  options: { background?: boolean; now?: number } = {},
): ToolText {
  if (!entry) return reply('Status reports are not available right now.', true);
  const outcomes = reportStatusOutcomes(options.background === true);
  const outcome = args?.outcome;
  if (!outcomes.includes(outcome)) return reply(`outcome must be one of: ${outcomes.join(', ')}.`, true);
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (!summary) return reply('summary is required.', true);
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  if (outcome === 'question' && !question) return reply('A "question" report needs the question in `question`.', true);
  const report: TurnReport = {
    outcome,
    summary: summary.slice(0, TURN_REPORT_LIMITS.summary),
    ...(outcome === 'question' ? { question: question.slice(0, TURN_REPORT_LIMITS.question) } : {}),
    reportedAt: options.now ?? Date.now(),
  };
  try {
    const error = entry.record(callerSessionId, report);
    if (error) return reply(error, true);
  } catch (error) {
    return reply(error instanceof Error ? error.message : String(error), true);
  }
  return reply('Recorded. Now write your reply to the user as usual.');
}

/** Whether the tool_use with this id is a subagent's; null while history does not show it yet. */
export function isSubagentToolUse(history: StreamMessage[], toolUseId: string): boolean | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i] as { type?: string; parentToolUseId?: string | null; message?: { content?: unknown } };
    if (message.type !== 'assistant' || !Array.isArray(message.message?.content)) continue;
    const found = message.message.content.some((block: { type?: string; id?: string }) => block?.type === 'tool_use' && block.id === toolUseId);
    if (found) return Boolean(message.parentToolUseId);
  }
  return null;
}

/**
 * Claude's server: a Task subagent shares it, so the caller alone cannot tell
 * the two apart. The call's tool_use can, once history shows it. Waiting for it
 * also orders the report: history follows the stream, so a queued prompt's start
 * was handled before its turn's tool_use, and cannot clear this report later.
 * Unknown stays unrecorded (the turn falls back to the run status) rather than
 * trusted. Claude's background tasks wake the session, so it alone may report
 * "in_progress".
 */
export async function reportClaudeStatus(
  callerSessionId: string,
  args: ReportStatusArgs,
  extra?: unknown,
  options: { waitMs?: number } = {},
): Promise<ToolText> {
  const toolUseId = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.['claudecode/toolUseId'];
  if (!entry) return reportStatus(callerSessionId, args, { background: true });
  if (typeof toolUseId === 'string' && toolUseId) {
    const deadline = Date.now() + (options.waitMs ?? 3_000);
    for (;;) {
      const subagent = isSubagentToolUse(entry.history(callerSessionId), toolUseId);
      if (subagent) return reply('Only the main agent of the conversation reports its status.', true);
      if (subagent === false) return reportStatus(callerSessionId, args, { background: true });
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return reply('Aegis could not confirm this call yet. Try it once more; if it fails again, skip it and write your reply.', true);
}

/** Bubble host tool: tools are turn-scoped, so each carries its session. */
export function createNativeReportStatus(sessionId: string) {
  return {
    name: REPORT_STATUS_TOOL, description: reportStatusDescription(false),
    parameters: REPORT_STATUS_JSON_SCHEMA, readOnly: true, effect: 'read' as const,
    async execute(args: ReportStatusArgs) {
      const result = reportStatus(sessionId, args);
      return { content: result.content.map(item => item.text).join('\n'), isError: result.isError === true };
    },
  };
}

/** Pi custom tools are created per session, so the caller is known. */
export function createPiReportStatus(sessionId: string) {
  return {
    name: REPORT_STATUS_TOOL, label: 'Report status',
    description: reportStatusDescription(false),
    promptSnippet: 'Tell Aegis when a turn ends with a question, a blocker, or nothing to do.',
    parameters: REPORT_STATUS_JSON_SCHEMA,
    async execute(_callId: string, args: ReportStatusArgs) {
      const result = reportStatus(sessionId, args);
      if (result.isError) throw new Error(result.content[0].text);
      return { content: result.content, details: {} };
    },
  };
}
