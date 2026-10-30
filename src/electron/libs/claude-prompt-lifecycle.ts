/**
 * The host's prompts as the Claude CLI reports them, frame by frame.
 *
 * Every uuid-stamped command goes through `command_lifecycle` frames on the
 * SDK stream: `queued` when the CLI takes it, `started` when a turn opens
 * with it or folds it in between tool rounds, then `completed` — or
 * `cancelled`, both for a turn the interrupt stopped and for a command
 * cancel_async_message took out of the queue before it ever started. A
 * result names the prompts it answered (`user_message_uuids`).
 *
 * Every decision here follows from those frames in stream order, never from
 * control-request responses (which reach the host on their own schedule):
 *
 * - `withdrawn`: cancelled before it started. The frame lands in the stream
 *   when the CLI processes the cancel — ahead of the stopped turn's result
 *   and of anything sent after Stop — so the host settles it before any later
 *   turn's output arrives.
 * - `opened` / `joined`: a prompt that starts while no turn runs opens one;
 *   prompts started after it before the turn's init joined that same batch.
 * - Stop: every queued host prompt is cancelled, then the interrupt follows
 *   (both written in one tick). The interrupt stops whatever turn is running
 *   when the CLI processes it. Its receipt lists the stopped prompts it could
 *   not reach (`still_queued`: a batch already parked for the next turn) —
 *   those, and only those, are interrupted again when their turn opens.
 *   Prompts sent after Stop are never stopped: they reach the CLI behind it.
 *
 * Without lifecycle frames (older CLIs) nothing is tracked and nothing is
 * withdrawn: the host's count-based stop handling applies unchanged.
 *
 * Pure (feed frames in, read decisions out) so it is unit-testable without
 * the CLI.
 */

type WireMessage = {
  type?: string;
  subtype?: string;
  state?: string;
  command_uuid?: string;
  parent_tool_use_id?: string | null;
  user_message_uuids?: unknown;
};

export interface PromptFrame {
  /** On a top-level result: how many host prompts it answered (undefined when the CLI does not say). */
  answered?: number;
  /** A host prompt opened a turn of its own. */
  opened?: string;
  /** A host prompt started in the batch another prompt opened (before the turn's init). */
  joined?: { promptId: string; openerId: string };
  /** A host prompt the CLI cancelled before it ever started (Stop withdrew it). */
  withdrawn?: string;
  /** The turn just opened carries a prompt Stop could not reach: interrupt it now. */
  interrupt?: boolean;
}

export class ClaudePromptLifecycle {
  /** Sent, neither answered nor withdrawn (insertion order = send order). */
  private readonly pending = new Set<string>();
  /** Of those, the ones Stop may withdraw (the host knows them by id). */
  private readonly withdrawable = new Set<string>();
  private readonly started = new Set<string>();
  private lifecycleSeen = false;
  private turnActive = false;
  /** The prompt that opened the current batch, between its `started` and the turn's init. */
  private batchOpener: string | null = null;
  /** Host prompts of the turn now running (opener and batch), until its result. */
  private readonly runningTurn = new Set<string>();
  /**
   * The running turn already got its interrupt: a second one could land
   * after it ended, on whatever runs next.
   */
  private runningTurnInterrupted = false;
  /** Pending when a Stop was pressed. */
  private readonly stopped = new Set<string>();
  /** Stopped prompts the Stop's interrupt could not reach. */
  private readonly survivors = new Set<string>();
  private awaitingStopReceipt = false;

  /** Lifecycle frames seen: prompt identity is tracked and Stop can withdraw. */
  get tracksIdentity(): boolean {
    return this.lifecycleSeen;
  }

  /** A host prompt was pushed to the CLI; `withdrawable` when the host knows it by this id. */
  sent(uuid: string, withdrawable: boolean): void {
    this.pending.add(uuid);
    if (withdrawable) this.withdrawable.add(uuid);
  }

  observe(message: WireMessage): PromptFrame {
    if (message.parent_tool_use_id) return {};
    if (message.type === 'command_lifecycle') {
      this.lifecycleSeen = true;
      const uuid = message.command_uuid;
      if (!uuid || !this.pending.has(uuid)) return {};
      if (message.state === 'started') return this.onStarted(uuid);
      if (message.state === 'cancelled' && !this.started.has(uuid)) {
        this.forget(uuid);
        return { withdrawn: uuid };
      }
      return {};
    }
    if (message.type === 'system' && message.subtype === 'init') {
      this.turnActive = true;
      this.batchOpener = null;
      return {};
    }
    if (message.type !== 'result') return {};
    this.turnActive = false;
    this.batchOpener = null;
    this.runningTurn.clear();
    this.runningTurnInterrupted = false;
    const answered = message.user_message_uuids;
    if (!Array.isArray(answered)) return {};
    return { answered: answered.filter((uuid) => typeof uuid === 'string' && this.forget(uuid)).length };
  }

  /**
   * Stop was pressed: every pending prompt is now stopped. Returns the ones
   * to cancel by uuid — all still queued (not started) — to be written
   * before the interrupt. Nothing without lifecycle frames.
   */
  beginStop(): string[] {
    for (const uuid of this.pending) this.stopped.add(uuid);
    this.awaitingStopReceipt = true;
    if (!this.lifecycleSeen) return [];
    return [...this.pending].filter((uuid) => this.withdrawable.has(uuid) && !this.started.has(uuid));
  }

  /**
   * The Stop's interrupt receipt. Records the stopped prompts it could not
   * reach; true when one of them already opened the turn now running (it
   * must be interrupted at once). Receipts of other interrupts are ignored.
   */
  stopReceipt(stillQueued: readonly unknown[] | undefined): boolean {
    if (!this.awaitingStopReceipt) return false;
    this.awaitingStopReceipt = false;
    if (!this.lifecycleSeen || !stillQueued) return false;
    for (const uuid of stillQueued) {
      if (typeof uuid === 'string' && this.stopped.has(uuid) && this.pending.has(uuid)) this.survivors.add(uuid);
    }
    let runningNow = false;
    for (const uuid of this.runningTurn) if (this.survivors.delete(uuid)) runningNow = true;
    if (!runningNow || this.runningTurnInterrupted) return false;
    this.runningTurnInterrupted = true;
    return true;
  }

  private onStarted(uuid: string): PromptFrame {
    if (this.started.has(uuid)) return {};
    this.started.add(uuid);
    // Folded into the running turn between tool rounds.
    if (this.turnActive) return {};
    const frame: PromptFrame = {};
    if (this.batchOpener === null) {
      this.batchOpener = uuid;
      this.runningTurn.clear();
      this.runningTurnInterrupted = false;
      frame.opened = uuid;
    } else {
      frame.joined = { promptId: uuid, openerId: this.batchOpener };
    }
    this.runningTurn.add(uuid);
    // A survivor opens its turn now that the interrupt has passed: stop it
    // (once per turn; the batch shares it).
    if (this.survivors.delete(uuid) && !this.runningTurnInterrupted) {
      this.runningTurnInterrupted = true;
      frame.interrupt = true;
    }
    return frame;
  }

  /** Drop a prompt that got its answer or was withdrawn; true when it was pending. */
  private forget(uuid: string): boolean {
    this.started.delete(uuid);
    this.stopped.delete(uuid);
    this.survivors.delete(uuid);
    this.withdrawable.delete(uuid);
    this.runningTurn.delete(uuid);
    return this.pending.delete(uuid);
  }
}
