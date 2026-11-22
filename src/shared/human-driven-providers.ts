/**
 * Agents whose terms only allow a session that a person drives directly.
 *
 * Google Antigravity (`agy acp`) with a personal Google sign-in: the
 * Antigravity Additional Terms (§6) and Google's answer in
 * google-antigravity/antigravity-cli#1493 allow "any interactive ACP v1
 * client ... when a human user is directly driving the session", and do not
 * allow agy as "a backend worker inside a third-party coding agent,
 * autonomous agent harness, or background orchestrator", nor "another agent,
 * autonomous loop, or background task queue" generating its prompts.
 *
 * So for these agents Aegis is default-deny: a prompt reaches the session only
 * when a person sent it from a composer on this machine. Everything else that
 * can start or continue a session (workflows, sub-sessions and their reports,
 * the main bot, automations, the Feishu and remote bridges, title one-shots,
 * handoff briefs) is refused, and the prompt goes out as typed, with nothing
 * of Aegis's added to it.
 */
const HUMAN_DRIVEN_ONLY_PROVIDERS: ReadonlySet<string> = new Set(['antigravity']);

export function isHumanDrivenOnlyProvider(provider: string | null | undefined): boolean {
  return Boolean(provider) && HUMAN_DRIVEN_ONLY_PROVIDERS.has(provider as string);
}

/**
 * Who sent a prompt. `user`: a person, from a composer in this app's own
 * window. `app`: anything else, which is also what a caller that says nothing
 * is taken to be.
 */
export type PromptOrigin = 'user' | 'app';

const LABELS: Record<string, string> = { antigravity: 'Antigravity' };

export function humanDrivenProviderLabel(provider: string): string {
  return LABELS[provider] ?? provider;
}

/** Why a prompt may not reach this agent; null when it may. */
export function humanDrivenOnlyRefusal(
  provider: string | null | undefined,
  origin: PromptOrigin,
  /** The prompt is marked as written by the app (a workflow, a report, a schedule). */
  machineWritten = false
): string | null {
  if (!isHumanDrivenOnlyProvider(provider)) return null;
  if (origin === 'user' && !machineWritten) return null;
  return `${humanDrivenProviderLabel(provider as string)} only takes messages you type in Aegis on this computer. Workflows, automations, other agents and remote devices cannot send to it.`;
}

/** Shown wherever a person sets Antigravity up or picks it. */
export const ANTIGRAVITY_USAGE_NOTES: readonly string[] = [
  'Aegis starts the unmodified `agy acp` in your project folder and talks ACP to it. You type every message; Aegis adds nothing to it.',
  'Workflows, automations, sub-tasks, Ask Aegis, Feishu and remote devices cannot send to an Antigravity task. With a personal Google sign-in, Google does not allow another agent or a schedule to drive agy.',
  'Sign-in is agy’s own (`agy acp --login`). Your Google credentials stay in agy’s storage; Aegis never reads, copies or stores them.',
  'Aegis reads nothing of agy’s but the ACP connection of the task you are in: no transcripts, no local state.',
  'Automation needs a Gemini API key or Vertex AI, which fall under Google’s API terms instead. Aegis does not offer that for Antigravity yet.',
];
