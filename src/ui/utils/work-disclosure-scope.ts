import { opensTurn } from '../../shared/turn-boundary';
import type { StreamMessage } from '../types';

/**
 * Where a work group's expand/collapse choices are stored: the run of the
 * agent that produced it. A run starts at a user prompt, or right after the
 * previous run's result when the agent starts one itself (Claude woken by a
 * finished background task), so a woken run never shares choices with the
 * turn before it.
 *
 * History arrives a page at a time and a page can cut a run anywhere, so a
 * run is named by whichever of these is loaded, most stable first:
 * - its start: the prompt, or the first message after the previous result;
 * - its end: the result that closed it;
 * - each of the group's own messages.
 * The scope is the first of these; the rest are aliases whose stored choices
 * still count. Whatever a group was named on an earlier, shorter page stays
 * among its names when older history arrives (its messages stay loaded), so
 * no choice is lost. Each name is a specific message, never a position, so no
 * run can pick up another's.
 */
export interface WorkDisclosureScope {
  scope: string;
  aliases: string[];
}

/** A message's lasting name; none for one with neither a uuid nor a time. */
function messageIdentity(message: StreamMessage | undefined): string | null {
  if (!message) return null;
  const uuid = (message as { uuid?: unknown }).uuid;
  if (typeof uuid === 'string' && uuid.length > 0) return `uuid:${uuid}`;
  const createdAt = message.createdAt;
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) return `${message.type}@${createdAt}`;
  return null;
}

export function workDisclosureScope(
  sessionId: string | null | undefined,
  messages: StreamMessage[],
  groupIndices: readonly number[]
): WorkDisclosureScope {
  const ordered = [...groupIndices].sort((a, b) => a - b);
  const first = ordered[0] ?? 0;
  const last = ordered[ordered.length - 1] ?? 0;

  let start: string | null = null;
  for (let cursor = first; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (opensTurn(message)) {
      start = messageIdentity(message!);
      break;
    }
    if (message?.type === 'result' && cursor < first) {
      // The run opened with the first message after the previous result.
      for (let next = cursor + 1; next <= first && !start; next += 1) start = messageIdentity(messages[next]);
      break;
    }
  }

  let end: string | null = null;
  for (let cursor = last + 1; cursor < messages.length; cursor += 1) {
    const message = messages[cursor];
    if (opensTurn(message)) break;
    if (message?.type === 'result') {
      end = messageIdentity(message);
      break;
    }
  }

  const members = ordered
    .map((index) => messageIdentity(messages[index]))
    .filter((name): name is string => Boolean(name))
    .map((name) => `message:${name}`);

  const names = [start && `start:${start}`, end && `end:${end}`, ...members].filter(
    (name): name is string => Boolean(name)
  );
  const prefix = `${sessionId ?? ''}:`;
  // Only a group whose every message lacks both a uuid and a time gets here.
  if (names.length === 0) return { scope: `${prefix}group:${first}`, aliases: [] };
  return { scope: prefix + names[0], aliases: [...new Set(names.slice(1))].map((name) => prefix + name) };
}
