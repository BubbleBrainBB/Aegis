/**
 * Strictly increasing timestamps for what a Claude session stores.
 *
 * Stored history is ordered by createdAt, and a millisecond tie falls back to
 * row ids — arbitrary. Messages of one session that land within the same
 * millisecond (a result and the prompt that opens the next turn, a prompt
 * and its host echo) could then reload in a different order than they
 * arrived. Stamping every stored Claude message through here keeps the stored
 * order the arrival order. Across restarts the wall clock has moved on.
 */
const lastStamp = new Map<string, number>();

export function claudeTimestamp(sessionId: string, at: number = Date.now()): number {
  const stamp = Math.max(at, (lastStamp.get(sessionId) ?? 0) + 1);
  lastStamp.set(sessionId, stamp);
  return stamp;
}

export function forgetClaudeTimestamps(sessionId: string): void {
  lastStamp.delete(sessionId);
}
