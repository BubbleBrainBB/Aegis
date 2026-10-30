import { ClaudeGoalWithdrawnError } from './claude-goal-manager';

/**
 * One exit for every prompt that will never get a turn — the CLI cancelled
 * it before it started (Stop), it was still queued when the runner went
 * away, or it never reached the CLI at all (Stop while it was still being
 * prepared, the runner aborted, preparing it failed).
 *
 * - A prompt the /goal controller already counted as submitted stops
 *   counting as work (a never-submitted one was never counted).
 * - A /goal prompt ends its goal-start wait now, as withdrawn — whether or
 *   not the host knows it by id — never left to the 30s timeout, which would
 *   abort whatever runtime is live by then and stop the session again.
 * - A prompt the host knows by id is reported once (settlement there is
 *   idempotent by id); one it does not know was stored at send and stays.
 */
export function createPromptHandBack(deps: {
  goal: { withdrawn(count: number, goalSet: boolean): void };
  rejectGoalStart(error: Error, goalSend: number): void;
  report(promptIds: string[]): void;
}) {
  /** `goalSend`: the /goal prompt's send number (nextClaudeGoalSend), absent for other prompts. */
  return (promptId: string | undefined, prompt: { submitted: boolean; goalSend?: number }): void => {
    const goalSet = prompt.goalSend !== undefined;
    if (prompt.submitted) deps.goal.withdrawn(1, goalSet);
    if (goalSet) deps.rejectGoalStart(new ClaudeGoalWithdrawnError(), prompt.goalSend!);
    if (promptId) deps.report([promptId]);
  };
}

/** Whether a prompt sets a goal (its start is awaited by the goal UI). */
export function isGoalSetPrompt(text: string): boolean {
  return /^\s*\/goal\s+\S/i.test(text);
}
