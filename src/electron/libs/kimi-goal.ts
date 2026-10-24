import {
  kimiGoalControlWord,
  kimiGoalStartPrompt,
  type GoalAction,
  type SessionGoalSnapshot,
  type ThreadGoal,
} from '../../shared/session-goal';

type GoalChange = { objective: string; replace: boolean } | { control: 'pause' | 'resume' | 'cancel' };

export interface KimiGoalDeps {
  adapter: {
    hasSession(threadId: string): boolean;
    changeGoal(kimiSessionId: string, change: GoalChange): Promise<void>;
    readGoal(kimiSessionId: string, threadId: string): Promise<ThreadGoal | null | undefined>;
  };
  cached(sessionId: string): SessionGoalSnapshot | undefined;
  publish(sessionId: string, goal: ThreadGoal | null): SessionGoalSnapshot;
  forget(sessionId: string): void;
  /** Sends a message on the task (starting its runner when none is live). */
  sendPrompt?: (prompt: string) => Promise<boolean>;
  describeFailure(error: unknown): string;
  /** Kimi's 40914 (`No current goal`): there is no goal to control. */
  isNoCurrentGoal(error: unknown): boolean;
  /** The task's stored Kimi session id now (a resume may rebind it). */
  kimiSessionId(sessionId: string): string | null | undefined;
  /** How long a resume waits for the task's runner to subscribe. */
  reconnectTimeoutMs?: number;
}

/**
 * A Goal action on a Kimi task. Kimi's goal API (session profile) controls a
 * goal, mid-turn too, and the goal itself arrives through goal.updated. A
 * task Kimi has not started has no server session: its goal starts with
 * Kimi's `/goal --` prompt.
 */
export async function changeKimiGoal(
  session: { id: string; kimi_session_id?: string | null },
  action: GoalAction,
  deps: KimiGoalDeps,
): Promise<SessionGoalSnapshot> {
  const sessionId = session.id;
  const current = deps.cached(sessionId)?.goal ?? null;
  const objective = action.type === 'set' ? action.objective?.trim() : undefined;
  if (action.type === 'set' && !objective && !action.status)
    throw new Error('Kimi goals do not support changing only the budget.');
  // Typed `/goal pause` and `/goal resume` are controls, not objectives.
  const word = kimiGoalControlWord(objective ?? '');
  const control = action.type === 'clear' ? 'cancel'
    : word ?? (objective ? null : action.status === 'paused' ? 'pause' : 'resume');
  const sendPrompt = deps.sendPrompt;

  const kimiSessionId = session.kimi_session_id;
  if (!kimiSessionId) {
    if (!objective || control) throw new Error('This Kimi task has no goal yet.');
    if (!sendPrompt) throw new Error('Kimi Goal mode is not available.');
    if (!(await sendPrompt(kimiGoalStartPrompt(objective)))) throw new Error('Kimi did not accept the goal. Try again.');
    return deps.cached(sessionId) ?? deps.publish(sessionId, current);
  }

  // Resolves false when Kimi has no goal to control (40914, by code).
  const call = async (change: GoalChange, target = kimiSessionId): Promise<boolean> => {
    try {
      await deps.adapter.changeGoal(target, change);
      return true;
    } catch (error) {
      if ('control' in change && deps.isNoCurrentGoal(error)) return false;
      throw new Error(deps.describeFailure(error));
    }
  };
  // Without a live, subscribed Kimi session (after Stop, a daemon exit or a
  // restart) Aegis would miss what the goal does: work Kimi continues runs
  // unseen, and goal.updated never arrives.
  const loaded = deps.adapter.hasSession(sessionId);
  // Unloaded, the goal is read back from Kimi rather than awaited.
  const settle = async () => {
    if (loaded) return deps.cached(sessionId) ?? deps.publish(sessionId, current);
    const goal = await deps.adapter.readGoal(kimiSessionId, sessionId).catch(() => undefined);
    return deps.publish(sessionId, goal === undefined ? current : goal);
  };

  if (control === 'resume' && !loaded) {
    // Bring the task's runner up (subscribed) with a message first, so the
    // work the resumed goal continues runs where Aegis shows it.
    if (!sendPrompt || !(await sendPrompt('Continue working on the goal.')))
      throw new Error('Kimi could not resume this task. Send a message to continue.');
    const deadline = Date.now() + (deps.reconnectTimeoutMs ?? 15_000);
    while (!deps.adapter.hasSession(sessionId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (!deps.adapter.hasSession(sessionId)) throw new Error('Kimi did not reconnect to this task. Try again.');
    // A resume that found the old Kimi session gone rebinds the task to a new one.
    if (!(await call({ control }, deps.kimiSessionId(sessionId) || kimiSessionId)))
      return deps.publish(sessionId, null);
    return deps.cached(sessionId) ?? deps.publish(sessionId, current);
  }
  if (control) {
    // No current goal (40914): the goal already ended, whatever the control.
    const applied = await call({ control });
    if (control === 'cancel' || !applied) {
      deps.forget(sessionId);
      return deps.publish(sessionId, null);
    }
    return settle();
  }
  // A new objective replaces any goal Kimi has, then starts the work (the
  // message also brings an unloaded task's runner up).
  await call({ objective: objective!, replace: true });
  const snapshot = await settle();
  if (sendPrompt && !(await sendPrompt(objective!)))
    throw new Error('Kimi set the goal but did not start working on it. Send a message to continue.');
  return deps.cached(sessionId) ?? snapshot;
}
