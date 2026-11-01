// Turn reports: an agent says, in a structured field, how its turn ended when
// that is anything but a finished result. Without one the turn counts as done
// and the sidebar and notifications fall back to the run status. Free text is
// never read for this: "is it waiting on me?" needs a structured answer.

import { matchesTool } from './follow-up';

export const REPORT_STATUS_TOOL = 'report_status';

export const TURN_REPORT_OUTCOMES = ['question', 'blocked', 'nothing_to_do', 'in_progress'] as const;
export type TurnReportOutcome = (typeof TURN_REPORT_OUTCOMES)[number];

export const TURN_REPORT_LIMITS = { summary: 300, question: 1000 } as const;

export interface TurnReport {
  outcome: TurnReportOutcome;
  summary: string;
  question?: string;
  reportedAt: number;
}

export const isReportStatusToolName = (name: unknown) => matchesTool(name, REPORT_STATUS_TOOL);

/** The outcomes that leave the next step with the user. */
export function turnReportNeedsUser(report: TurnReport | null | undefined): boolean {
  return report?.outcome === 'question' || report?.outcome === 'blocked';
}

export function turnReportLabel(outcome: TurnReportOutcome): string {
  switch (outcome) {
    case 'question':
      return 'Needs your answer';
    case 'blocked':
      return 'Blocked';
    case 'nothing_to_do':
      return 'Nothing to change';
    case 'in_progress':
      return 'Still working';
  }
}

/** One line for a tooltip or notification: the label, then the question or summary. */
export function turnReportTitle(report: TurnReport): string {
  return `${turnReportLabel(report.outcome)}: ${report.question || report.summary}`;
}

export function parseTurnReport(value: unknown): TurnReport | null {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const outcome = record.outcome;
  if (typeof outcome !== 'string' || !(TURN_REPORT_OUTCOMES as readonly string[]).includes(outcome)) return null;
  if (typeof record.summary !== 'string' || typeof record.reportedAt !== 'number') return null;
  return {
    outcome: outcome as TurnReportOutcome,
    summary: record.summary,
    ...(typeof record.question === 'string' && record.question ? { question: record.question } : {}),
    reportedAt: record.reportedAt,
  };
}
