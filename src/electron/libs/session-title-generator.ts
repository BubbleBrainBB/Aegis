import { generateSessionTitleLocally, parseGeneratedTitle, sessionTitlePrompt } from '../../shared/session-title';

/** How long a task waits for its agent to name it before its first sentence does. */
export const SESSION_TITLE_TIMEOUT_MS = 30_000;

/**
 * Name a task with the agent that runs it. A live session that can title
 * itself without a turn answers first (Claude Code does); otherwise the agent
 * gets the request in a conversation of its own, which the adapter keeps off
 * the agent's history where it can. Whatever fails or takes too long, the
 * request's first sentence names the task. Empty only for an empty request.
 */
export async function generateTaskTitle(params: {
  request: string;
  live?: (description: string) => Promise<string | undefined>;
  oneShot: (prompt: string, signal: AbortSignal) => Promise<string>;
  timeoutMs?: number;
}): Promise<string> {
  const fallback = generateSessionTitleLocally(params.request);
  if (!params.request.trim()) return fallback;
  // Ends the one-shot once a title is in, or once it is too late to use one.
  const controller = new AbortController();
  const attempt = async (): Promise<string | null> => {
    if (params.live) {
      try {
        const title = parseGeneratedTitle((await params.live(params.request)) ?? '');
        if (title) return title;
      } catch {
        // The session cannot title itself: ask in a conversation of its own.
      }
    }
    return parseGeneratedTitle(await params.oneShot(sessionTitlePrompt(params.request), controller.signal));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), params.timeoutMs ?? SESSION_TITLE_TIMEOUT_MS);
  });
  try {
    return (await Promise.race([attempt(), late])) || fallback;
  } catch (error) {
    console.warn('[SessionTitle] the agent could not name the task:', error);
    return fallback;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
