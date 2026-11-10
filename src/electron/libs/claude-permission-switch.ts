import type { PermissionMode as ClaudeSdkPermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeAccessMode, ClaudeExecutionMode } from '../../shared/types';

export function normalizeClaudeSdkPermissionMode(
  accessMode?: ClaudeAccessMode,
  executionMode?: ClaudeExecutionMode
): ClaudeSdkPermissionMode {
  if (executionMode === 'plan') {
    return 'plan';
  }
  switch (accessMode) {
    case 'fullAccess':
    case 'bypassPermissions':
      return 'bypassPermissions';
    case 'acceptEdits':
    case 'plan':
    case 'dontAsk':
    case 'auto':
      return accessMode;
    default:
      return 'default';
  }
}

export function executionModeForClaudePermissionMode(
  permissionMode: ClaudeSdkPermissionMode
): ClaudeExecutionMode {
  return permissionMode === 'plan' ? 'plan' : 'execute';
}

export interface ClaudePermissionSwitcherOptions {
  accessMode?: ClaudeAccessMode;
  executionMode?: ClaudeExecutionMode;
  /** A read-only workflow member: always 'default', whatever is asked. */
  readOnly?: boolean;
  /**
   * Tells the live SDK query the new mode; resolves once the CLI confirmed
   * it. Resolve at once when no query is live yet (the next one starts in
   * `mode`).
   */
  apply: (mode: ClaudeSdkPermissionMode) => Promise<void>;
  /**
   * The mode the runner is now in, after the last of a run of requests was
   * confirmed. Not called for a request that a later one superseded while
   * it was still at the CLI, so the host never sees the stale mode win.
   */
  onChanged: (executionMode: ClaudeExecutionMode, accessMode: ClaudeAccessMode) => void;
}

export interface ClaudePermissionSwitcher {
  /** The mode the CLI confirmed (what canUseTool decides by). */
  readonly mode: ClaudeSdkPermissionMode;
  /** The latest mode asked for; equals `mode` once nothing is in flight. */
  readonly target: ClaudeSdkPermissionMode;
  /** The access mode a plan exit returns to, even while plan hides it. */
  readonly accessMode: ClaudeAccessMode;
  /** The composer's picker: an access mode with the current execution mode. */
  set: (accessMode: ClaudeAccessMode, executionMode: ClaudeExecutionMode) => Promise<void>;
  /** An SDK mode directly (plan exit, hidden control sends). */
  switchTo: (mode: ClaudeSdkPermissionMode) => Promise<void>;
  /** ExitPlanMode approved: back to the remembered access mode, executing. */
  exitPlan: () => Promise<void>;
}

/**
 * Serializes permission-mode switches of one Claude runner.
 *
 * setPermissionMode is a round trip to the CLI, so a second request can
 * arrive while the first is still unconfirmed. Switches run one at a time,
 * each applying the newest target when its turn comes: a request superseded
 * before it ran is skipped, and one superseded while at the CLI is confirmed
 * but not reported, so the final mode is always the last one asked for and
 * the host hears exactly that. A failed switch leaves the confirmed mode
 * where it was, rejects its caller, and lets the next request through. The
 * composer's picker and ExitPlanMode share this one queue.
 */
export function createClaudePermissionSwitcher(
  options: ClaudePermissionSwitcherOptions
): ClaudePermissionSwitcher {
  const { apply, onChanged, readOnly } = options;
  let mode: ClaudeSdkPermissionMode = readOnly
    ? 'default'
    : normalizeClaudeSdkPermissionMode(options.accessMode, options.executionMode);
  let target: ClaudeSdkPermissionMode = mode;
  let accessMode: ClaudeAccessMode = 'default';
  if (options.accessMode && options.accessMode !== 'plan') {
    accessMode = options.accessMode;
  }
  let chain: Promise<void> = Promise.resolve();

  const switchTo = (next: ClaudeSdkPermissionMode): Promise<void> => {
    if (readOnly) return Promise.resolve();
    target = next;
    const step = chain.then(async () => {
      const wanted = target;
      if (wanted === mode) return;
      try {
        await apply(wanted);
      } catch (error) {
        // Nothing newer asked meanwhile: the confirmed mode is the target again.
        if (target === wanted) target = mode;
        throw error;
      }
      mode = wanted;
      if (executionModeForClaudePermissionMode(mode) === 'execute') {
        accessMode = mode;
      }
      // A newer request is waiting: it reports when it lands.
      if (target !== mode) return;
      onChanged(executionModeForClaudePermissionMode(mode), accessMode);
    });
    chain = step.catch(() => {});
    return step;
  };

  return {
    get mode() {
      return mode;
    },
    get target() {
      return target;
    },
    get accessMode() {
      return accessMode;
    },
    set: (nextAccessMode, executionMode) => {
      if (readOnly) return Promise.resolve();
      if (nextAccessMode && nextAccessMode !== 'plan') {
        accessMode = nextAccessMode;
      }
      return switchTo(normalizeClaudeSdkPermissionMode(nextAccessMode, executionMode));
    },
    switchTo,
    exitPlan: () => switchTo(normalizeClaudeSdkPermissionMode(accessMode, 'execute')),
  };
}
