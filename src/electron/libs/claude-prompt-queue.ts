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
   * Observe one raw SDK message. On a top-level result, returns how many of
   * the host's prompts it answered (undefined when the CLI does not say).
   */
  observe(message: WireMessage): number | undefined {
    if (message.parent_tool_use_id) return undefined;
    if (message.type === 'command_lifecycle') {
      if (message.state === 'started' && message.command_uuid && this.pending.has(message.command_uuid)) {
        this.started.add(message.command_uuid);
      }
      return undefined;
    }
    if (message.type === 'system' && message.subtype === 'init') {
      this.turnActive = true;
      return undefined;
    }
    if (message.type !== 'result') return undefined;
    this.turnActive = false;
    const answered = message.user_message_uuids;
    if (!Array.isArray(answered)) return undefined;
    return answered.filter((uuid) => {
      if (typeof uuid !== 'string') return false;
      this.started.delete(uuid);
      return this.pending.delete(uuid);
    }).length;
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
