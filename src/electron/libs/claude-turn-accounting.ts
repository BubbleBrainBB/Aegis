/**
 * What one Claude `result` settles in a kept-alive runner's turn ledger.
 *
 * The ledger counts in-flight obligations: one per prompt the host sent, plus
 * one for a turn the CLI started on its own (a finished background task wakes
 * the agent). Claude Code folds prompts queued during a turn into that turn,
 * so one result can close several obligations; `user_message_uuids` names the
 * host prompts it answers. Stopped obligations are the oldest in flight and
 * results close the oldest first, so a result settles stopped ones before any
 * live follow-up. A turn the CLI starts on its own while stopped obligations
 * remain is stopped too (Stop stops everything), so that order holds.
 *
 * Pure (plain counters in, counters out) so the accounting is unit-testable
 * without Electron.
 */

export interface ClaudeTurnLedger {
  /** Obligations without a result yet: sent prompts plus a self-started turn. */
  inFlightTurns: number;
  /** User-stopped obligations whose result has not landed (≤ inFlightTurns). */
  stoppedTurns: number;
  /** The oldest in-flight obligation is a turn the CLI started on its own. */
  selfStartedTurn: boolean;
}

export interface ClaudeResultSettlement {
  /** Host prompts this result answers: entries to shift off the prompt FIFO. */
  hostPrompts: number;
  /** In-flight obligations it closes. */
  settledTurns: number;
  inFlightTurns: number;
  stoppedTurns: number;
}

/**
 * `answeredPrompts` is the count of host prompts the result names, or
 * undefined when the CLI does not say. A prompted turn answers at least its
 * own prompt; a self-started turn may answer none.
 */
export function settleClaudeResult(
  ledger: ClaudeTurnLedger,
  answeredPrompts: number | undefined
): ClaudeResultSettlement {
  const hostPrompts = ledger.selfStartedTurn
    ? Math.max(0, answeredPrompts ?? 0)
    : Math.max(1, answeredPrompts ?? 1);
  const settledTurns = hostPrompts + (ledger.selfStartedTurn ? 1 : 0);
  const inFlightTurns = Math.max(0, ledger.inFlightTurns - settledTurns);
  const stoppedTurns = Math.min(Math.max(0, ledger.stoppedTurns - settledTurns), inFlightTurns);
  return { hostPrompts, settledTurns, inFlightTurns, stoppedTurns };
}

export interface ClaudeSelfStartedTurnOpening extends ClaudeTurnLedger {
  /**
   * Interrupt the turn now: the user pressed Stop and that stop has not
   * settled yet (a stopped prompt is still queued behind this turn).
   */
  interrupt: boolean;
}

/**
 * The CLI started a turn on its own (a finished background task woke the
 * agent). It opens between turns, ahead of anything still queued; with a stop
 * outstanding it is stopped as well, so stopped obligations stay the oldest
 * and settleClaudeResult never lets it consume a queued prompt's stop.
 */
export function openSelfStartedTurn(ledger: ClaudeTurnLedger): ClaudeSelfStartedTurnOpening {
  const interrupt = ledger.stoppedTurns > 0;
  return {
    inFlightTurns: ledger.inFlightTurns + 1,
    stoppedTurns: ledger.stoppedTurns + (interrupt ? 1 : 0),
    selfStartedTurn: true,
    interrupt,
  };
}
