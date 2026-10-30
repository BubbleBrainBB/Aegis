import { ClaudeGoalWithdrawnError } from './claude-goal-manager';

/**
 * One exit for every host prompt that will never get a turn — the CLI
 * cancelled it before it started (Stop), it was still queued when the runner
 * went away, or it never reached the CLI at all (Stop while it was still
 * being prepared, the runner aborted, preparing it failed).
 *
 * - A prompt the /goal controller already counted as submitted stops
 *   counting as work (a never-submitted one was never counted).
 * - A /goal prompt ends its goal-start wait now, as withdrawn — never left
 *   to the 30s timeout, which would abort whatever runtime is live by then
 *   and stop the session again.
 * - The host hears about it once (settlement there is idempotent by id).
 */
export function createPromptHandBack(deps: {
  goal: { withdrawn(count: number, goalSet: boolean): void };
  rejectGoalStart(error: Error): void;
  report(promptIds: string[]): void;
}) {
  return (promptId: string, prompt: { submitted: boolean; goalSet: boolean }): void => {
    if (prompt.submitted) deps.goal.withdrawn(1, prompt.goalSet);
    if (prompt.goalSet) deps.rejectGoalStart(new ClaudeGoalWithdrawnError());
    deps.report([promptId]);
  };
}

/** Whether a prompt sets a goal (its start is awaited by the goal UI). */
export function isGoalSetPrompt(text: string): boolean {
  return /^\s*\/goal\s+\S/i.test(text);
}
