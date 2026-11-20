// Starting a session for the main bot.

import type { RemoteTaskSettings } from '../../../shared/remote/protocol';
import { REMOTE_PERMISSION_MODES } from '../../../shared/remote/agent-catalog';
import { resolveAgent } from '../../feishu/agent-settings';

/**
 * What a task the bot starts on another Mac runs with: the model the bot named,
 * and the permission mode this Mac's composer would start that agent with, as a
 * task started here gets. Without the mode that Mac starts the agent on its own
 * default, which asks before every command however the composer here is set.
 * Never plan: a dispatched task does the work. Model and effort are that Mac's
 * own unless the bot named a model: its catalog is not this one's.
 */
export function remoteStartSettings(
  provider: string,
  model: string | undefined,
  desktop: Record<string, string>,
): RemoteTaskSettings | undefined {
  const preferred = resolveAgent({ provider }, desktop).permissionMode;
  const modes: Record<string, string[]> = REMOTE_PERMISSION_MODES;
  // (Where plan is one of the agent's listed modes it is the composer's pick like any other, as it is for a task here.)
  const permissionMode = preferred && modes[provider]?.includes(preferred) ? preferred : undefined;
  if (!model && !permissionMode) return undefined;
  return { ...(model ? { model } : {}), ...(permissionMode ? { permissionMode } : {}) };
}

/** What the bot reads as the report of a task whose agent never started. */
export const STARTUP_FAILED = 'Its agent could not start, so it did no work. That agent may need setting up under Settings > Providers; the work can go to another agent.';

/**
 * Start a session for the bot. The answer is the session's id as soon as it
 * exists, and the agent's startup follows. A startup that fails after that
 * ends no turn, and the bot waits on the task by then: `failed` hears of it,
 * so the bot gets a report instead of waiting until the app starts again.
 */
export function startTaskSession(
  start: (onCreated: (sessionId: string) => void) => Promise<string | null>,
  failed: (sessionId: string, error: string) => void,
): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    let created: string | null = null;
    start((sessionId) => {
      created = sessionId;
      resolve(sessionId);
    }).then(
      (sessionId) => {
        if (created && !sessionId) failed(created, STARTUP_FAILED);
        resolve(sessionId);
      },
      (failure) => {
        if (created) failed(created, `${STARTUP_FAILED} (${failure instanceof Error ? failure.message : String(failure)})`);
        reject(failure);
      },
    );
  });
}
