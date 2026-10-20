import type { StreamMessage } from '../types';
import type { BackgroundTaskOutcome } from '../../shared/types';

export type BackgroundTaskEndedMessage = Extract<StreamMessage, {
  type: 'system'; subtype: 'background_task_ended';
}>;

/** A background task that ended mid-turn, drawn in the trace where it happened. */
export interface BackgroundTaskEndedEntry {
  id: string;
  type: 'backgroundTaskEnded';
  summary: string;
  detail?: never;
  outcome: BackgroundTaskOutcome;
}

export function isBackgroundTaskEndedMessage(message: StreamMessage): message is BackgroundTaskEndedMessage {
  return message.type === 'system' && message.subtype === 'background_task_ended';
}

export function backgroundTaskEndedEntry(message: BackgroundTaskEndedMessage): BackgroundTaskEndedEntry {
  return {
    id: `background-task-ended:${message.uuid}`,
    type: 'backgroundTaskEnded',
    summary: message.outcome.description || message.outcome.summary,
    outcome: message.outcome,
  };
}
