/**
 * How a send reaches a kept-alive Claude runner.
 *
 * Claude Code folds a streaming-input prompt pushed while a turn runs into
 * that turn between tool rounds, so a send into a live turn steers it. A
 * steer must never kill the turn it joins, and must never change it either:
 * composer config drift (model, betas, modes, effort) is deferred — the
 * runner is marked staleConfig, retires once drained, and the next turn
 * respawns with the new config — and the live turn keeps the model it
 * started with. A doomed runner (poisoned context, stale environment) is
 * never fed, live turn or not.
 *
 * Pure (plain fields in, decision out) so it is unit-testable without
 * Electron.
 */

export interface ClaudeSendEntry {
  inFlightTurns?: number;
  stoppedTurns?: number;
  doomed?: boolean;
  staleConfig?: boolean;
  autoApprove?: boolean;
  /** The model the runner was last handed (spawn or warm send). */
  claudeModel?: string;
}

export interface ClaudeSendPlan {
  /** A live (not user-stopped) turn is in flight. */
  midTurn: boolean;
  /** Abort the runner and spawn a fresh one for this send. */
  respawn: boolean;
  /** Mark the kept runner staleConfig: the send carries config it cannot apply. */
  markStaleConfig: boolean;
  /** The model to hand the kept runner with this send. */
  sendModel: string | undefined;
}

export function planClaudeSend(
  entry: ClaudeSendEntry,
  next: { configDrift: boolean; hadInvalidThinking: boolean; model: string | undefined }
): ClaudeSendPlan {
  const midTurn = (entry.inFlightTurns ?? 0) > (entry.stoppedTurns ?? 0);
  const respawn =
    (!midTurn && (next.configDrift || entry.staleConfig === true)) ||
    entry.doomed === true ||
    entry.autoApprove === true ||
    // The live context may still hold the invalid thinking blocks the stored
    // history was sanitized against.
    next.hadInvalidThinking;
  return {
    midTurn,
    respawn,
    markStaleConfig: midTurn && !respawn && next.configDrift,
    // Handing a new model would switch the CLI mid-turn (setModel).
    sendModel: midTurn ? entry.claudeModel : next.model,
  };
}
