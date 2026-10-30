/**
 * The runner's view of the prompts it sent the Claude CLI: which are still
 * waiting in the CLI's command queue and which a turn already took.
 *
 * The host's prompts carry their own uuids. `command_lifecycle` reports a
 * prompt `started` when a turn opens with it or folds it in between tool
 * rounds; a result names the prompts it answered (`user_message_uuids`).
 * Anything sent but neither started nor answered still sits queued behind the
 * live turn — exactly what Stop may withdraw (cancel_async_message). Between
 * turns nothing is offered: a queued prompt may already be parked as the next
 * turn's batch, where cancelling by uuid is unreliable, so the interrupt
 * stops it like the turn it opens.
 *
 * Pure (feed wire frames in, read decisions out) so it is unit-testable
 * without the CLI. Feed every raw SDK message before anything consumes it.
 */

type WireMessage = {
  type?: string;
  subtype?: string;
  state?: string;
  command_uuid?: string;
  parent_tool_use_id?: string | null;
  user_message_uuids?: unknown;
};

export class ClaudePromptQueue {
  private readonly pending = new Set<string>();
  private readonly started = new Set<string>();
  /** Between a top-level init and its result. */
  private turnActive = false;

  /** A host prompt was pushed to the CLI. */
  sent(uuid: string): void {
    this.pending.add(uuid);
  }

  /**
   * Observe one raw SDK message.
   * - `answered`: on a top-level result, how many of the host's prompts it
   *   answered (undefined when the CLI does not say).
   * - `opened`: a host prompt that opens a turn of its own — reported
   *   `started` while no turn runs. A prompt sent as a steer that lands here
   *   arrived too late to join the turn it was sent into.
   */
  observe(message: WireMessage): { answered?: number; opened?: string } {
    if (message.parent_tool_use_id) return {};
    if (message.type === 'command_lifecycle') {
      const uuid = message.command_uuid;
      if (message.state !== 'started' || !uuid || !this.pending.has(uuid) || this.started.has(uuid)) return {};
      this.started.add(uuid);
      return this.turnActive ? {} : { opened: uuid };
    }
    if (message.type === 'system' && message.subtype === 'init') {
      this.turnActive = true;
      return {};
    }
    if (message.type !== 'result') return {};
    this.turnActive = false;
    const answered = message.user_message_uuids;
    if (!Array.isArray(answered)) return {};
    return {
      answered: answered.filter((uuid) => {
        if (typeof uuid !== 'string') return false;
        this.started.delete(uuid);
        return this.pending.delete(uuid);
      }).length,
    };
  }

  /** Host prompts still queued behind a live turn: what Stop may withdraw. */
  withdrawable(): string[] {
    if (!this.turnActive) return [];
    return [...this.pending].filter((uuid) => !this.started.has(uuid));
  }

  /**
   * The CLI confirmed these were cancelled. Returns the ones this queue still
   * counted (a result may have answered one meanwhile — it is not withdrawn).
   */
  withdrawn(uuids: string[]): string[] {
    return uuids.filter((uuid) => {
      this.started.delete(uuid);
      return this.pending.delete(uuid);
    });
  }
}

/**
 * Withdraw the host prompts still queued behind the live turn: one
 * cancel_async_message per prompt. Every cancel is written before this
 * returns its promise — a caller that interrupts right after has the
 * interrupt reach the CLI behind them, and ahead of anything sent later.
 * Resolves with the prompts the CLI confirmed cancelled (and the queue still
 * counted). A prompt being folded in right now refuses the cancel and rides
 * the turn; transport errors count as not cancelled.
 */
export function withdrawQueued(
  queue: ClaudePromptQueue,
  cancel: ((uuid: string) => Promise<boolean>) | undefined
): Promise<string[]> {
  const queued = cancel ? queue.withdrawable() : [];
  if (queued.length === 0) return Promise.resolve([]);
  const outcomes = queued.map((uuid) => cancel!(uuid).then((cancelled) => cancelled === true, () => false));
  return Promise.all(outcomes).then((done) => queue.withdrawn(queued.filter((_, index) => done[index])));
}

/**
 * Stop's withdrawal is in flight until the CLI answers every cancel. Until
 * then the host's turn ledger still counts the prompts being withdrawn, so a
 * result that leaves "stopped" turns behind cannot tell a withdrawn steer
 * from one that will still run — re-interrupting then could stop the turn
 * the user sent after Stop. Such a re-interrupt waits for the withdrawal to
 * settle; the ledger is accurate again by then.
 */
export class StopWithdrawalGate {
  private inFlight: Promise<unknown> | null = null;
  private deferred = false;

  /** Stop started a withdrawal; `settled` runs once it is answered, told whether a re-interrupt waited. */
  begin(withdrawal: Promise<unknown>, settled: (reinterrupt: boolean) => void): void {
    // A second Stop while one is out keeps the re-interrupt it may owe.
    if (!this.inFlight) this.deferred = false;
    this.inFlight = withdrawal;
    const finish = () => {
      if (this.inFlight !== withdrawal) return;
      this.inFlight = null;
      const reinterrupt = this.deferred;
      this.deferred = false;
      settled(reinterrupt);
    };
    withdrawal.then(finish, finish);
  }

  /** True when the re-interrupt must wait for the withdrawal (it has been noted). */
  deferReinterrupt(): boolean {
    if (!this.inFlight) return false;
    this.deferred = true;
    return true;
  }
}
