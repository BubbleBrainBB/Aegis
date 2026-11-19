// Starting a session for the main bot.

/** What the bot reads as the report of a task whose agent never started. */
export const STARTUP_FAILED = 'Its agent could not start, so it did no work. That agent may need setting up under Settings > Providers; the work can go to another agent.';

/**
 * Start a session for the bot. The answer is the session's id as soon as it
 * exists, and the agent's startup follows. A startup that fails after that
 * ends no turn, and the bot waits on the task by then: `failed` hears of it,
 * so the bot gets a report instead of waiting until the app starts again.
 */
export function startTaskSession(
  start: (onCreated: (sessionId: string) => void) => Promise<string | null>,
  failed: (sessionId: string, error: string) => void,
): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    let created: string | null = null;
    start((sessionId) => {
      created = sessionId;
      resolve(sessionId);
    }).then(
      (sessionId) => {
        if (created && !sessionId) failed(created, STARTUP_FAILED);
        resolve(sessionId);
      },
      (failure) => {
        if (created) failed(created, `${STARTUP_FAILED} (${failure instanceof Error ? failure.message : String(failure)})`);
        reject(failure);
      },
    );
  });
}
