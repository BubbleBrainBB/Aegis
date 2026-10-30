/**
 * Strictly increasing history sort keys for what a Claude session stores.
 *
 * Stored history is ordered by its sort key (by default the message's
 * createdAt), and a millisecond tie falls back to row ids — arbitrary.
 * Messages of one session that land within the same millisecond (a result
 * and the prompt the CLI takes next, a prompt and its host echo) could then
 * reload in a different order than they arrived. Storing every Claude
 * message with a key from here keeps the stored order the arrival order;
 * the messages' own timestamps stay wall-clock time. Across restarts the
 * wall clock has moved on.
 */
const lastKey = new Map<string, number>();

export function claudeSortKey(sessionId: string, at: number = Date.now()): number {
  const key = Math.max(at, (lastKey.get(sessionId) ?? 0) + 1);
  lastKey.set(sessionId, key);
  return key;
}
