import type { PermissionResult, QuestionAnswerSelection } from './types';

/** One question's answer as the user gave it: picked option labels and their own text. */
export interface ResolvedQuestionAnswer {
  /** Option labels exactly as the provider listed them, in the order picked. */
  selected: string[];
  /** The user's own ("Other") text, trimmed; '' when none. */
  other: string;
}

interface MatchOptions {
  /** Match labels regardless of case (some agents compare that way). */
  ignoreCase?: boolean;
}

function findLabel(labels: readonly string[], candidate: string, options: MatchOptions): string | undefined {
  const wanted = options.ignoreCase ? candidate.toLowerCase() : candidate;
  return labels.find((label) => (options.ignoreCase ? label.toLowerCase() : label) === wanted);
}

/**
 * A comma-joined answer (the question card's `answers` string, or a caller
 * that only sends that, e.g. the phone) split back into option labels and the
 * user's own text. Labels may contain commas: whole labels are matched first,
 * longest first, at comma boundaries; anything else is the user's text, with
 * its commas and spacing kept.
 */
export function splitJoinedAnswer(
  raw: string,
  labels: readonly string[],
  options: MatchOptions = {}
): ResolvedQuestionAnswer {
  const byLength = [...labels].sort((left, right) => right.length - left.length);
  const source = options.ignoreCase ? raw.toLowerCase() : raw;
  const selected: string[] = [];
  const custom: string[] = [];
  let index = 0;
  while (index < raw.length) {
    // Spaces are skipped to match a label, but kept in the user's own text.
    const segmentStart = index;
    while (raw[index] === ' ') index += 1;
    if (index >= raw.length) break;
    const label = byLength.find((candidate) => {
      const wanted = options.ignoreCase ? candidate.toLowerCase() : candidate;
      return source.startsWith(wanted, index) && /^\s*(,|$)/.test(raw.slice(index + candidate.length));
    });
    if (label) {
      if (!selected.includes(label)) selected.push(label);
      index += label.length;
    } else {
      const end = raw.indexOf(',', index);
      custom.push(raw.slice(segmentStart, end < 0 ? raw.length : end));
      index = end < 0 ? raw.length : end;
    }
    while (raw[index] === ' ') index += 1;
    if (raw[index] === ',') index += 1;
  }
  return { selected, other: custom.join(',').trim() };
}

/**
 * The answer to one question from a question-card decision. The card's
 * structured `questionAnswers` (exact labels, "Other" text apart) wins; a
 * decision without it falls back to splitting the joined `answers` string.
 * Labels the provider does not list count as the user's own text.
 */
export function resolveQuestionAnswer(
  decision: Pick<PermissionResult, 'updatedInput' | 'questionAnswers'>,
  question: string,
  labels: readonly string[],
  options: MatchOptions = {}
): ResolvedQuestionAnswer {
  const structured: QuestionAnswerSelection | undefined = decision.questionAnswers?.[question];
  if (structured) {
    const selected: string[] = [];
    const unlisted: string[] = [];
    for (const picked of structured.selected) {
      const label = findLabel(labels, picked, options);
      if (label === undefined) unlisted.push(picked);
      else if (!selected.includes(label)) selected.push(label);
    }
    const other = [...unlisted, ...(structured.other?.trim() ? [structured.other.trim()] : [])].join(', ');
    return { selected, other };
  }
  const answers = decision.updatedInput?.answers;
  const raw =
    answers && typeof answers === 'object' && typeof (answers as Record<string, unknown>)[question] === 'string'
      ? ((answers as Record<string, string>)[question] ?? '').trim()
      : '';
  return raw ? splitJoinedAnswer(raw, labels, options) : { selected: [], other: '' };
}

/** The answer as one flat list (picked labels, then the user's own text), for agents that take strings. */
export function questionAnswerValues(answer: ResolvedQuestionAnswer): string[] {
  return [...answer.selected, ...(answer.other ? [answer.other] : [])];
}
