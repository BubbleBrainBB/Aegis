import type { PermissionRequestPayload, PermissionResult, QuestionAnswerSelection } from "../../shared/types";
import type { RemotePermission, RemoteQuestion, RemoteQuestionAnswers } from "../../shared/remote/protocol";

/** Longer plans are shown cut off and approved on the Mac. */
export const PLAN_LIMIT = 48000;
const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 30;
const MAX_TEXT = 2000;

/** The plan approval card's two answers, as the Claude runner and the Bubble adapter list them. */
const APPROVE = "Approve and execute";
const STAY = "Stay in plan mode";

/** What a phone may answer for a permission beyond allow/deny. */
export type RemotePrompt =
  | { kind: "question"; questions: RemoteQuestion[] }
  | { kind: "plan"; approve: string; stay?: string };

/**
 * The desktop question card's input (every provider's questions and plan
 * approvals use it), when it is small enough to answer from a phone.
 */
function questionsOf(p: PermissionRequestPayload): RemoteQuestion[] | null {
  const raw = (p.input as unknown as Record<string, unknown> | undefined)?.questions;
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_QUESTIONS) return null;
  const questions: RemoteQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const q = item as Record<string, unknown>;
    if (typeof q.question !== "string" || !q.question.trim() || q.question.length > MAX_TEXT) return null;
    const options = q.options === undefined ? [] : q.options;
    if (!Array.isArray(options) || options.length > MAX_OPTIONS) return null;
    const parsed: RemoteQuestion["options"] = [];
    for (const option of options) {
      const o = option as Record<string, unknown> | null;
      if (!o || typeof o.label !== "string" || o.label.length > MAX_TEXT) return null;
      const description = typeof o.description === "string" ? o.description.slice(0, MAX_TEXT) : "";
      parsed.push({ label: o.label, ...(description ? { description } : {}) });
    }
    const header = typeof q.header === "string" ? q.header.slice(0, 200) : "";
    questions.push({
      question: q.question,
      ...(header ? { header } : {}),
      options: parsed,
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  // Answers are keyed by question text, so two equal questions can't be told apart.
  if (new Set(questions.map((q) => q.question)).size !== questions.length) return null;
  return questions;
}

export function remotePrompt(p: PermissionRequestPayload): RemotePrompt | null {
  const questions = questionsOf(p);
  if (!questions) return null;
  if (p.toolName === "ExitPlanMode") {
    const labels = questions.length === 1 ? questions[0].options.map((o) => o.label) : [];
    if (!labels.includes(APPROVE)) return null;
    return { kind: "plan", approve: APPROVE, ...(labels.includes(STAY) ? { stay: STAY } : {}) };
  }
  return { kind: "question", questions };
}

/** The plan text: the request's own (Bubble) or the latest ExitPlanMode call's (Claude). */
export function planOf(p: PermissionRequestPayload, streamed?: string): string {
  const own = (p.input as unknown as Record<string, unknown>).plan;
  return typeof own === "string" ? own : streamed ?? "";
}

/** The fields a phone needs to answer the prompt. */
export function promptFields(
  p: PermissionRequestPayload,
  prompt: RemotePrompt | null,
  streamedPlan?: string,
): Pick<RemotePermission, "questions" | "plan"> {
  if (prompt?.kind === "question") return { questions: prompt.questions };
  if (prompt?.kind === "plan") {
    const markdown = planOf(p, streamedPlan);
    return markdown.length > PLAN_LIMIT
      ? { plan: { markdown: markdown.slice(0, PLAN_LIMIT), truncated: true } }
      : { plan: { markdown } };
  }
  return {};
}

export type RemoteResolution = { behavior: "allow" | "deny" } & Pick<PermissionResult, "updatedInput" | "questionAnswers">;

/**
 * The permission result for a phone's decision, built like the desktop's
 * question card builds it. Throws INVALID_ANSWER for answers the card
 * couldn't have produced.
 */
export function resolvePrompt(
  p: PermissionRequestPayload,
  prompt: RemotePrompt,
  decision: "allow" | "deny",
  answers?: RemoteQuestionAnswers,
): RemoteResolution {
  const input = p.input as unknown as Record<string, unknown>;
  if (prompt.kind === "plan") {
    if (answers) throw new Error("INVALID_ANSWER");
    // Keep planning is the card's "Stay in plan mode", not a bare denial.
    const label = decision === "allow" ? prompt.approve : prompt.stay;
    if (!label) return { behavior: "deny" };
    const question = (input.questions as Array<{ question: string }>)[0].question;
    return {
      behavior: "allow",
      updatedInput: { ...input, answers: { [question]: label } },
      questionAnswers: { [question]: { selected: [label] } },
    };
  }
  if (decision === "deny") {
    if (answers) throw new Error("INVALID_ANSWER");
    return { behavior: "deny" };
  }
  if (!answers) throw new Error("INVALID_ANSWER");
  const known = new Map(prompt.questions.map((q) => [q.question, q]));
  if (Object.keys(answers).some((key) => !known.has(key))) throw new Error("INVALID_ANSWER");
  const joined: Record<string, string> = {};
  const questionAnswers: Record<string, QuestionAnswerSelection> = {};
  for (const q of prompt.questions) {
    const answer = answers[q.question];
    const selected = answer?.selected ?? [];
    const other = answer?.other?.trim() ?? "";
    const labels = new Set(q.options.map((o) => o.label));
    // Every question is answered, with listed options only, and one of them unless multi-select.
    if (!selected.length && !other) throw new Error("INVALID_ANSWER");
    if (selected.some((label) => !labels.has(label)) || new Set(selected).size !== selected.length)
      throw new Error("INVALID_ANSWER");
    if (!q.multiSelect && selected.length + (other ? 1 : 0) > 1) throw new Error("INVALID_ANSWER");
    joined[q.question] = [...selected, ...(other ? [other] : [])].join(",");
    questionAnswers[q.question] = { selected, ...(other ? { other } : {}) };
  }
  return { behavior: "allow", updatedInput: { ...input, answers: joined }, questionAnswers };
}
