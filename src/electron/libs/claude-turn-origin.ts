/**
 * Tells which Claude Code turns the CLI started on its own.
 *
 * When a background task finishes, the CLI wakes the agent with a turn no
 * prompt asked for. The stream marks prompt ownership explicitly: every
 * uuid-stamped command (a prompt the host sent, or a hidden /goal control
 * send) goes through `command_lifecycle` frames, and the command that opens a
 * turn reports `started` before that turn's `system/init`. A command folded
 * into a running turn reports `started` between that turn's init and result.
 * Task notifications are uuid-less: their turn opens with an init that no
 * `started` preceded.
 *
 * Feed every raw SDK message, before anything consumes it (the /goal
 * controller swallows its control turns' lifecycle and result frames).
 * Pure, so the frame rules are unit-testable without the CLI.
 */

type WireMessage = {
  type?: string;
  subtype?: string;
  state?: string;
  command_uuid?: string;
  parent_tool_use_id?: string | null;
};

export class ClaudeTurnOriginTracker {
  /** Between a turn's init and its result. */
  private turnActive = false;
  /** A command reported `started` outside a turn: the next turn is its. */
  private startedCommand: string | null = null;
  /** CLIs without lifecycle frames can't tell a woken turn from a prompted one. */
  private lifecycleSeen = false;

  /** Returns true when this message opens a turn the CLI started on its own. */
  observe(message: WireMessage): boolean {
    if (message.parent_tool_use_id) return false;
    if (message.type === 'command_lifecycle') {
      this.lifecycleSeen = true;
      const uuid = typeof message.command_uuid === 'string' ? message.command_uuid : null;
      if (this.turnActive || !uuid) return false;
      if (message.state === 'started') {
        this.startedCommand = uuid;
      } else if (
        (message.state === 'completed' || message.state === 'cancelled') &&
        this.startedCommand === uuid
      ) {
        // Settled without opening a turn (a local command, or cancelled).
        this.startedCommand = null;
      }
      return false;
    }
    if (message.type === 'system' && message.subtype === 'init') {
      if (this.turnActive) return false;
      this.turnActive = true;
      const selfStarted = this.lifecycleSeen && this.startedCommand === null;
      this.startedCommand = null;
      return selfStarted;
    }
    if (message.type === 'result') {
      this.turnActive = false;
    }
    return false;
  }
}
