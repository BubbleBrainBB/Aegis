import type { StreamMessage } from './types';

/**
 * Whether a message opens a turn. A user prompt does — unless it was steered
 * into a turn that was already running (`steer`): that one joins the live
 * turn, which still ends with a single result. Use this, not
 * `type === 'user_prompt'`, wherever the transcript is split into turns.
 */
export function opensTurn(message: StreamMessage | undefined): boolean {
  return message?.type === 'user_prompt' && message.steer !== true;
}
